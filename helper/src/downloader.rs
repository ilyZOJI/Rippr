use crate::{
    error::RipprError,
    models::{
        DownloadProgress, DownloadRequest, DownloadStarted, HistoryEntry, MediaFormat,
        MediaMetadata, RpcEvent,
    },
    platform::{folder_status, resolve_tool},
    store::{ConfigStore, HistoryStore},
};
use chrono::Utc;
use dashmap::DashMap;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{Notify, broadcast, mpsc},
    time::{sleep, timeout},
};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
pub struct Downloader {
    config: ConfigStore,
    history: HistoryStore,
    jobs: Arc<DashMap<String, CancellationToken>>,
    events: broadcast::Sender<String>,
    gate: Arc<JobGate>,
}

impl Downloader {
    pub fn new(
        config: ConfigStore,
        history: HistoryStore,
        events: broadcast::Sender<String>,
    ) -> Self {
        Self {
            config,
            history,
            jobs: Arc::new(DashMap::new()),
            events,
            gate: Arc::new(JobGate::default()),
        }
    }

    pub async fn analyze(&self, raw_url: &str) -> Result<MediaMetadata, RipprError> {
        validate_url(raw_url)?;
        let settings = self.config.get().await;
        let executable = resolve_tool("yt-dlp", settings.yt_dlp_path.as_deref())?;
        let retry_count = settings.retry_count.to_string();
        let output = timeout(
            Duration::from_secs(120),
            Command::new(executable)
                .args([
                    "--dump-single-json",
                    "--no-playlist",
                    "--no-warnings",
                    "--skip-download",
                    "--no-color",
                    "--retries",
                    &retry_count,
                    "--extractor-retries",
                    &retry_count,
                    "--retry-sleep",
                    "http:exp=1:16",
                    "--retry-sleep",
                    "extractor:exp=1:8",
                    raw_url,
                ])
                .stdin(Stdio::null())
                .output(),
        )
        .await
        .map_err(|_| {
            RipprError::AnalysisFailed("The media site took too long to respond.".into())
        })??;

        if !output.status.success() {
            return Err(RipprError::AnalysisFailed(clean_process_error(
                &output.stderr,
            )));
        }
        let value: Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| RipprError::AnalysisFailed(error.to_string()))?;
        normalize_metadata(raw_url, &value)
    }

    pub async fn start(
        self: &Arc<Self>,
        request: DownloadRequest,
    ) -> Result<DownloadStarted, RipprError> {
        validate_url(&request.url)?;
        let destination = PathBuf::from(&request.destination);
        if !destination.is_absolute() {
            return Err(RipprError::InvalidDestination);
        }
        let folder = folder_status(&request.destination).await?;
        if folder.disconnected {
            return Err(RipprError::DriveDisconnected);
        }
        if !folder.exists {
            tokio::fs::create_dir_all(&destination).await?;
        }
        let refreshed = folder_status(&request.destination).await?;
        if !refreshed.writable {
            return Err(RipprError::PermissionDenied);
        }

        let job_id = Uuid::new_v4().to_string();
        let cancellation = CancellationToken::new();
        self.jobs.insert(job_id.clone(), cancellation.clone());
        let downloader = Arc::clone(self);
        let spawned_id = job_id.clone();
        tokio::spawn(async move {
            downloader.emit(DownloadProgress {
                job_id: spawned_id.clone(),
                status: "queued".into(),
                percent: Some(0.0),
                speed: None,
                eta_seconds: None,
                downloaded_bytes: None,
                total_bytes: None,
                file_path: None,
                message: None,
            });
            let result = downloader
                .run_download(&spawned_id, request, cancellation)
                .await;
            if let Err(error) = result {
                downloader.emit(DownloadProgress {
                    job_id: spawned_id.clone(),
                    status: "failed".into(),
                    percent: None,
                    speed: None,
                    eta_seconds: None,
                    downloaded_bytes: None,
                    total_bytes: None,
                    file_path: None,
                    message: Some(error.to_string()),
                });
            }
            downloader.jobs.remove(&spawned_id);
        });
        Ok(DownloadStarted { job_id })
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), RipprError> {
        let token = self.jobs.get(job_id).ok_or(RipprError::JobNotFound)?;
        token.cancel();
        Ok(())
    }

    async fn run_download(
        &self,
        job_id: &str,
        request: DownloadRequest,
        cancellation: CancellationToken,
    ) -> Result<(), RipprError> {
        let settings = self.config.get().await;
        let _permit = match self
            .gate
            .acquire(settings.concurrent_downloads as usize, &cancellation)
            .await
        {
            Ok(permit) => permit,
            Err(_) if cancellation.is_cancelled() => {
                self.emit_cancelled(job_id);
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        if cancellation.is_cancelled() {
            self.emit_cancelled(job_id);
            return Ok(());
        }
        let yt_dlp = resolve_tool("yt-dlp", settings.yt_dlp_path.as_deref())?;
        let needs_ffmpeg = request.format != "original" || request.transcode_for_premiere;
        let ffmpeg = if needs_ffmpeg {
            Some(resolve_tool("ffmpeg", settings.ffmpeg_path.as_deref())?)
        } else {
            resolve_tool("ffmpeg", settings.ffmpeg_path.as_deref()).ok()
        };
        let temp_source_dir =
            if request.transcode_for_premiere && settings.use_temp_conversion_source {
                Some(create_conversion_temp_dir(job_id).await?)
            } else {
                None
            };
        let mut download_request = request.clone();
        if let Some(temp_source_dir) = &temp_source_dir {
            download_request.destination = temp_source_dir.to_string_lossy().into_owned();
        }
        let template = output_template(&download_request, &settings.naming_template);
        let mut command = Command::new(yt_dlp);
        command.args([
            "--no-playlist", "--progress", "--newline", "--progress-delta", "0.2", "--no-color", "--windows-filenames", "--trim-filenames", "180",
            "--retries", &settings.retry_count.to_string(), "--fragment-retries", &settings.retry_count.to_string(), "--extractor-retries", &settings.retry_count.to_string(),
            "--retry-sleep", "http:exp=1:16", "--retry-sleep", "fragment:exp=1:16", "--retry-sleep", "extractor:exp=1:8",
            "--progress-template", "download:rippr-progress:%(progress._percent_str)s|%(progress._speed_str)s|%(progress.eta)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s",
            "--print", "after_move:rippr-file:%(filepath)s", "-o", &template,
        ]);
        let selector = format_selector(&download_request);
        command.args(["-f", &selector]);
        if let Some(path) = ffmpeg.as_ref() {
            command.arg("--ffmpeg-location").arg(path);
        }
        apply_format_arguments(&mut command, &download_request);
        command
            .arg(&request.url)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                cleanup_conversion_temp_dir(temp_source_dir.as_deref()).await;
                return Err(RipprError::DownloadFailed(error.to_string()));
            }
        };
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RipprError::Internal("yt-dlp stdout was unavailable.".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| RipprError::Internal("yt-dlp stderr was unavailable.".into()))?;
        let (lines_tx, mut lines_rx) = mpsc::unbounded_channel::<String>();
        spawn_line_reader(stdout, lines_tx.clone());
        spawn_line_reader(stderr, lines_tx);
        let mut reported_paths = Vec::new();
        let mut last_progress: Option<DownloadProgress> = None;
        let mut errors = Vec::new();

        self.emit(DownloadProgress {
            job_id: job_id.into(),
            status: "downloading".into(),
            percent: Some(0.0),
            speed: None,
            eta_seconds: None,
            downloaded_bytes: None,
            total_bytes: request
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.estimated_bytes),
            file_path: None,
            message: request
                .metadata
                .as_ref()
                .map(|metadata| metadata.title.clone()),
        });

        loop {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    let _ = child.kill().await;
                    cleanup_conversion_temp_dir(temp_source_dir.as_deref()).await;
                    self.emit_cancelled(job_id);
                    return Ok(());
                }
                line = lines_rx.recv() => {
                    let Some(line) = line else { break };
                    if let Some(progress) = parse_progress(job_id, &line) {
                        last_progress = Some(progress.clone());
                        self.emit(progress);
                    }
                    else if let Some(path) = line.strip_prefix("rippr-file:") {
                        reported_paths.push(normalize_reported_path(path, Path::new(&download_request.destination)));
                    }
                    else if line.contains("[Merger]") || line.contains("[ExtractAudio]") || line.contains("[VideoRemuxer]") {
                        let processing = DownloadProgress {
                            job_id: job_id.into(),
                            status: "processing".into(),
                            percent: Some(99.0),
                            speed: None,
                            eta_seconds: None,
                            downloaded_bytes: last_progress.as_ref().and_then(|value| value.downloaded_bytes),
                            total_bytes: last_progress.as_ref().and_then(|value| value.total_bytes),
                            file_path: None,
                            message: Some("Converting media for editing".into()),
                        };
                        last_progress = Some(processing.clone());
                        self.emit(processing);
                    } else if line.to_ascii_lowercase().contains("error") { errors.push(line); }
                }
            }
        }

        let status = match child.wait().await {
            Ok(status) => status,
            Err(error) => {
                cleanup_conversion_temp_dir(temp_source_dir.as_deref()).await;
                return Err(error.into());
            }
        };
        if !status.success() {
            cleanup_conversion_temp_dir(temp_source_dir.as_deref()).await;
            return Err(RipprError::DownloadFailed(
                errors
                    .last()
                    .cloned()
                    .unwrap_or_else(|| format!("yt-dlp exited with {status}")),
            ));
        }
        let mut final_path = match wait_for_downloaded_file(&reported_paths).await {
            Ok(path) => path,
            Err(error) => {
                cleanup_conversion_temp_dir(temp_source_dir.as_deref()).await;
                return Err(error);
            }
        };
        if request.transcode_for_premiere {
            let processing = DownloadProgress {
                job_id: job_id.into(),
                status: "processing".into(),
                percent: Some(0.0),
                speed: None,
                eta_seconds: None,
                downloaded_bytes: None,
                total_bytes: None,
                file_path: None,
                message: Some("Converting to H.264/AAC for Premiere".into()),
            };
            last_progress = Some(processing.clone());
            self.emit(processing);
            let ffmpeg = ffmpeg.as_deref().ok_or(RipprError::MissingFfmpeg)?;
            let duration_seconds = request
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.duration_seconds);
            let conversion_result = self
                .transcode_for_premiere(
                    job_id,
                    &final_path,
                    ffmpeg,
                    temp_source_dir
                        .as_deref()
                        .map(|_| Path::new(&request.destination)),
                    duration_seconds,
                    &cancellation,
                )
                .await;
            cleanup_conversion_temp_dir(temp_source_dir.as_deref()).await;
            let Some(converted_path) = conversion_result? else {
                return Ok(());
            };
            final_path = converted_path;
        }
        self.history
            .add(HistoryEntry {
                id: Uuid::new_v4().to_string(),
                source_url: request.url.clone(),
                title: request
                    .metadata
                    .as_ref()
                    .map(|value| value.title.clone())
                    .unwrap_or_else(|| {
                        Path::new(&final_path)
                            .file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned()
                    }),
                thumbnail_url: request
                    .metadata
                    .as_ref()
                    .and_then(|value| value.thumbnail_url.clone()),
                completed_at: Utc::now().to_rfc3339(),
                destination: request.destination,
                file_path: final_path.clone(),
                kind: request.kind,
                format: request.format,
                quality: request.quality,
            })
            .await?;
        self.emit(DownloadProgress {
            job_id: job_id.into(),
            status: "completed".into(),
            percent: Some(100.0),
            speed: None,
            eta_seconds: Some(0),
            downloaded_bytes: last_progress
                .as_ref()
                .and_then(|value| value.downloaded_bytes),
            total_bytes: last_progress.as_ref().and_then(|value| value.total_bytes),
            file_path: Some(final_path),
            message: None,
        });
        Ok(())
    }

    fn emit(&self, payload: DownloadProgress) {
        if let Ok(message) = serde_json::to_string(&RpcEvent {
            event: "download_progress".into(),
            payload,
        }) {
            let _ = self.events.send(message);
        }
    }

    fn emit_cancelled(&self, job_id: &str) {
        self.emit(DownloadProgress {
            job_id: job_id.into(),
            status: "cancelled".into(),
            percent: None,
            speed: None,
            eta_seconds: None,
            downloaded_bytes: None,
            total_bytes: None,
            file_path: None,
            message: Some("Download cancelled".into()),
        });
    }
}

#[derive(Default)]
struct JobGate {
    active: AtomicUsize,
    notify: Notify,
}

impl JobGate {
    async fn acquire(
        self: &Arc<Self>,
        limit: usize,
        cancellation: &CancellationToken,
    ) -> Result<JobPermit, RipprError> {
        let limit = limit.max(1);
        loop {
            let current = self.active.load(Ordering::Acquire);
            if current < limit
                && self
                    .active
                    .compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Relaxed)
                    .is_ok()
            {
                return Ok(JobPermit {
                    gate: Arc::clone(self),
                });
            }
            tokio::select! { _ = self.notify.notified() => {}, _ = cancellation.cancelled() => return Err(RipprError::JobNotFound) }
        }
    }
}

struct JobPermit {
    gate: Arc<JobGate>,
}
impl Drop for JobPermit {
    fn drop(&mut self) {
        self.gate.active.fetch_sub(1, Ordering::AcqRel);
        self.gate.notify.notify_one();
    }
}

fn validate_url(raw_url: &str) -> Result<(), RipprError> {
    let url = Url::parse(raw_url).map_err(|_| RipprError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(RipprError::InvalidUrl);
    }
    Ok(())
}

fn normalize_metadata(source_url: &str, value: &Value) -> Result<MediaMetadata, RipprError> {
    let formats: Vec<MediaFormat> = value
        .get("formats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|format| {
            let id = string_value(format, "format_id")?;
            Some(MediaFormat {
                id,
                extension: string_value(format, "ext").unwrap_or_else(|| "unknown".into()),
                resolution: string_value(format, "resolution"),
                width: u64_value(format, "width"),
                height: u64_value(format, "height"),
                fps: f64_value(format, "fps"),
                video_codec: string_value(format, "vcodec").filter(|value| value != "none"),
                audio_codec: string_value(format, "acodec").filter(|value| value != "none"),
                bitrate_kbps: f64_value(format, "tbr"),
                estimated_bytes: u64_value(format, "filesize")
                    .or_else(|| u64_value(format, "filesize_approx")),
            })
        })
        .collect();
    let resolutions: BTreeSet<u64> = formats.iter().filter_map(|format| format.height).collect();
    let resolutions = resolutions
        .into_iter()
        .rev()
        .map(|height| format!("{height}p"))
        .collect();
    let estimated_bytes = formats
        .iter()
        .filter_map(|format| format.estimated_bytes)
        .max()
        .or_else(|| u64_value(value, "filesize"))
        .or_else(|| u64_value(value, "filesize_approx"));
    let title = string_value(value, "title").ok_or_else(|| {
        RipprError::AnalysisFailed("The response did not include a title.".into())
    })?;
    Ok(MediaMetadata {
        id: string_value(value, "id").unwrap_or_else(|| Uuid::new_v4().to_string()),
        source_url: source_url.into(),
        webpage_url: string_value(value, "webpage_url").unwrap_or_else(|| source_url.into()),
        title,
        uploader: string_value(value, "uploader")
            .or_else(|| string_value(value, "channel"))
            .unwrap_or_else(|| "Unknown uploader".into()),
        platform: string_value(value, "extractor_key")
            .or_else(|| string_value(value, "extractor"))
            .unwrap_or_else(|| "Supported site".into()),
        duration_seconds: f64_value(value, "duration"),
        upload_date: string_value(value, "upload_date"),
        thumbnail_url: string_value(value, "thumbnail"),
        estimated_bytes,
        resolutions,
        formats,
    })
}

fn output_template(request: &DownloadRequest, default_template: &str) -> String {
    let custom_name = request
        .file_name
        .as_deref()
        .and_then(sanitize_custom_filename);
    let raw = custom_name.as_deref().unwrap_or_else(|| {
        request
            .naming_template
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(default_template)
    });
    let template = if custom_name.is_none() && raw.contains("%(ext)s") {
        raw.to_owned()
    } else {
        format!("{raw}.%(ext)s")
    };
    Path::new(&request.destination)
        .join(template)
        .to_string_lossy()
        .into_owned()
}

fn normalize_reported_path(raw: &str, destination: &Path) -> String {
    let trimmed = raw.trim().trim_matches(['"', '\'']);
    let path = PathBuf::from(trimmed);
    let path = if path.is_absolute() {
        path
    } else {
        destination.join(path)
    };
    path.to_string_lossy().into_owned()
}

async fn wait_for_downloaded_file(paths: &[String]) -> Result<String, RipprError> {
    if paths.is_empty() {
        return Err(RipprError::DownloadFailed(
            "yt-dlp completed without reporting the output file.".into(),
        ));
    }

    for _ in 0..40 {
        for path in paths.iter().rev() {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Ok(path.to_string_lossy().into_owned());
            }
            let windows_variant =
                windows_filename_variant(&path).filter(|variant| variant.is_file());
            if let Some(windows_variant) = windows_variant {
                return Ok(windows_variant.to_string_lossy().into_owned());
            }
            if let Some(equivalent) = find_equivalent_file(&path).await {
                return Ok(equivalent.to_string_lossy().into_owned());
            }
        }
        sleep(Duration::from_millis(250)).await;
    }

    let reported = paths
        .iter()
        .rev()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    Err(RipprError::DownloadFailed(format!(
        "The downloaded file was not available for Premiere conversion. yt-dlp reported: {reported}"
    )))
}

async fn create_conversion_temp_dir(job_id: &str) -> Result<PathBuf, RipprError> {
    let directory = std::env::temp_dir().join("Rippr").join(job_id);
    tokio::fs::create_dir_all(&directory).await?;
    Ok(directory)
}

async fn cleanup_conversion_temp_dir(directory: Option<&Path>) {
    if let Some(directory) = directory {
        let _ = tokio::fs::remove_dir_all(directory).await;
    }
}

fn windows_filename_variant(path: &Path) -> Option<PathBuf> {
    let file_name = path.file_name()?.to_str()?;
    let sanitized = file_name
        .chars()
        .map(|character| match character {
            '"' => '＂',
            '*' => '＊',
            ':' => '：',
            '<' => '＜',
            '>' => '＞',
            '?' => '？',
            '|' => '｜',
            character => character,
        })
        .collect::<String>();
    (sanitized != file_name).then(|| path.with_file_name(sanitized))
}

async fn find_equivalent_file(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    let expected = filename_equivalence_key(path.file_name()?.to_str()?);
    if expected.is_empty() {
        return None;
    }

    let mut entries = tokio::fs::read_dir(parent).await.ok()?;
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let candidate = entry.path();
        if !candidate.is_file() || candidate.extension().is_some_and(|value| value == "part") {
            continue;
        }
        let Some(name) = candidate.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if filename_equivalence_key(name) != expected {
            continue;
        }
        let modified = entry
            .metadata()
            .await
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let is_newer = newest
            .as_ref()
            .map(|(current, _)| modified > *current)
            .unwrap_or(true);
        if is_newer {
            newest = Some((modified, candidate));
        }
    }
    newest.map(|(_, path)| path)
}

fn filename_equivalence_key(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '＂' => '"',
            '＊' => '*',
            '：' => ':',
            '＜' => '<',
            '＞' => '>',
            '？' => '?',
            '｜' => '|',
            character => character,
        })
        .filter(|character| {
            !matches!(character, '"' | '*' | ':' | '<' | '>' | '?' | '|') && !character.is_control()
        })
        .collect::<String>()
        .to_lowercase()
}

fn sanitize_custom_filename(value: &str) -> Option<String> {
    let mut value: String = value
        .trim()
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            value if value.is_control() => '_',
            value => value,
        })
        .collect();
    value = value.trim().trim_matches('.').trim().to_owned();
    let lowercase = value.to_ascii_lowercase();
    for extension in [".mp4", ".mov", ".mkv", ".wav", ".mp3", ".flac"] {
        if lowercase.ends_with(extension) {
            value.truncate(value.len() - extension.len());
            value = value.trim_end().to_owned();
            break;
        }
    }
    if value.is_empty() {
        None
    } else {
        Some(value.replace('%', "%%"))
    }
}

fn format_selector(request: &DownloadRequest) -> String {
    if request.format == "original" {
        return if request.kind == "audio" {
            "bestaudio/best".into()
        } else {
            quality_height(&request.quality)
                .map(|height| format!("best[height<={height}]/best"))
                .unwrap_or_else(|| "best".into())
        };
    }
    if request.kind == "audio" {
        return "bestaudio/best".into();
    }
    quality_height(&request.quality)
        .map(|height| format!("bestvideo[height<={height}]+bestaudio/best[height<={height}]/best"))
        .unwrap_or_else(|| "bestvideo+bestaudio/best".into())
}

fn apply_format_arguments(command: &mut Command, request: &DownloadRequest) {
    if request.kind == "audio" && request.format != "original" {
        command.args(["--extract-audio", "--audio-format", &request.format]);
        let bitrate = request.quality.split_whitespace().next().unwrap_or("Best");
        command.arg("--audio-quality");
        if bitrate.eq_ignore_ascii_case("best") {
            command.arg("0");
        } else {
            command.arg(format!("{bitrate}K"));
        }
    } else if request.kind == "video" {
        match request.format.as_str() {
            "mp4" => {
                command.args(["--merge-output-format", "mp4"]);
            }
            "mkv" => {
                command.args(["--merge-output-format", "mkv"]);
            }
            "mov" => {
                command.args(["--remux-video", "mov"]);
            }
            _ => {}
        }
    }
}

impl Downloader {
    async fn transcode_for_premiere(
        &self,
        job_id: &str,
        input: &str,
        ffmpeg: &Path,
        output_directory: Option<&Path>,
        duration_seconds: Option<f64>,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, RipprError> {
        let input_path = PathBuf::from(input);
        if !input_path.is_file() {
            return Err(RipprError::DownloadFailed(
                "The downloaded file was not available for Premiere conversion.".into(),
            ));
        }
        let parent = input_path.parent().unwrap_or_else(|| Path::new("."));
        let stem = input_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("rippr-download");
        let mut output_path = output_directory
            .and_then(|directory| input_path.file_name().map(|name| directory.join(name)))
            .unwrap_or_else(|| input_path.clone())
            .with_extension("mp4");
        if output_directory.is_some() {
            output_path = next_available_output_path(&output_path).await?;
        }
        let output_parent = output_path.parent().unwrap_or(parent);
        let temporary_path = output_parent.join(format!(".{stem}.rippr-{}.mp4", Uuid::new_v4()));
        let input_arg = input_path.to_string_lossy().into_owned();
        let temporary_arg = temporary_path.to_string_lossy().into_owned();
        let mut child = Command::new(ffmpeg)
            .args([
                "-y",
                "-nostats",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-stats_period",
                "0.5",
                "-i",
                &input_arg,
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                &temporary_arg,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                RipprError::DownloadFailed(format!("Premiere conversion could not start: {error}"))
            })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            RipprError::DownloadFailed("FFmpeg progress output was unavailable.".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            RipprError::DownloadFailed("FFmpeg error output was unavailable.".into())
        })?;
        let mut progress_lines = BufReader::new(stdout).lines();
        let mut error_lines = BufReader::new(stderr).lines();
        let mut progress_done = false;
        let mut error_done = false;
        let mut errors = Vec::new();
        let mut last_emitted_percent: f64 = -1.0;
        let total_bytes: Option<u64> = None;
        let mut last_speed: Option<String> = None;
        let mut speed_multiplier: Option<f64> = None;
        let mut first_progress: Option<(Instant, f64)> = None;

        while !progress_done {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    let _ = child.kill().await;
                    let _ = tokio::fs::remove_file(&temporary_path).await;
                    self.emit_cancelled(job_id);
                    return Ok(None);
                }
                line = progress_lines.next_line(), if !progress_done => {
                    match line {
                        Ok(Some(line)) => {
                            if let Some((key, value)) = line.split_once('=') {
                                if key == "out_time_us" {
                                    if let Ok(out_time_us) = value.parse::<f64>() {
                                        let output_seconds = (out_time_us / 1_000_000.0).max(0.0);
                                        if first_progress.is_none() {
                                            first_progress = Some((Instant::now(), output_seconds));
                                        }
                                        let percent = duration_seconds
                                            .filter(|duration| *duration > 0.0)
                                            .map(|duration| (output_seconds / duration * 100.0).clamp(0.0, 99.0))
                                            .unwrap_or(last_emitted_percent.max(0.0));
                                        if percent - last_emitted_percent >= 0.25 {
                                            let eta_seconds = duration_seconds.and_then(|duration| {
                                                let remaining = (duration - output_seconds).max(0.0);
                                                if remaining <= 0.25 {
                                                    return Some(0);
                                                }
                                                if let Some(speed) = speed_multiplier.filter(|value| *value > 0.0) {
                                                    return Some((remaining / speed).ceil() as u64);
                                                }
                                                let (started_at, start_seconds) = first_progress?;
                                                let processed = output_seconds - start_seconds;
                                                (processed > 0.1).then(|| {
                                                    (remaining * started_at.elapsed().as_secs_f64() / processed).ceil() as u64
                                                })
                                            });
                                            let progress = DownloadProgress {
                                                job_id: job_id.into(),
                                                status: "processing".into(),
                                                percent: Some(percent),
                                                speed: last_speed.clone(),
                                                eta_seconds,
                                                downloaded_bytes: None,
                                                total_bytes,
                                                file_path: None,
                                                message: Some("Converting to H.264/AAC for Premiere".into()),
                                            };
                                            last_emitted_percent = percent;
                                            self.emit(progress);
                                        }
                                    }
                                } else if key == "speed" {
                                    last_speed = (value != "N/A").then(|| value.to_owned());
                                    speed_multiplier = value.trim_end_matches('x').parse::<f64>().ok();
                                } else if key == "progress" && value == "end" {
                                    let progress = DownloadProgress {
                                        job_id: job_id.into(),
                                        status: "processing".into(),
                                        percent: Some(100.0),
                                        speed: None,
                                        eta_seconds: Some(0),
                                        downloaded_bytes: None,
                                        total_bytes,
                                        file_path: None,
                                        message: Some("Finalizing Premiere-ready file".into()),
                                    };
                                    self.emit(progress);
                                    progress_done = true;
                                }
                            }
                        }
                        Ok(None) | Err(_) => progress_done = true,
                    }
                }
            line = error_lines.next_line(), if !error_done => {
                match line {
                    Ok(Some(line)) => {
                        if !line.trim().is_empty() { errors.push(line); }
                    }
                    Ok(None) | Err(_) => error_done = true,
                }
            }
            }
        }
        while let Ok(Some(line)) = error_lines.next_line().await {
            if !line.trim().is_empty() {
                errors.push(line);
            }
        }
        let output = child.wait().await?;
        if !output.success() {
            let _ = tokio::fs::remove_file(&temporary_path).await;
            let detail = errors.last().cloned().unwrap_or_default();
            return Err(RipprError::DownloadFailed(if detail.is_empty() {
                "FFmpeg could not create a Premiere-compatible H.264 file.".into()
            } else {
                format!("FFmpeg could not create a Premiere-compatible file: {detail}")
            }));
        }
        if output_path == input_path && output_path.exists() {
            tokio::fs::remove_file(&output_path).await?;
        }
        tokio::fs::rename(&temporary_path, &output_path).await?;
        if input_path != output_path {
            let _ = tokio::fs::remove_file(input_path).await;
        }
        Ok(Some(output_path.to_string_lossy().into_owned()))
    }
}

async fn next_available_output_path(path: &Path) -> Result<PathBuf, RipprError> {
    if !path.exists() {
        return Ok(path.to_owned());
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("rippr-download");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..=10_000u32 {
        let filename = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = parent.join(filename);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(RipprError::DownloadFailed(
        "Could not find an unused output filename.".into(),
    ))
}

fn quality_height(quality: &str) -> Option<u64> {
    quality.trim_end_matches('p').parse().ok()
}

fn spawn_line_reader<R>(reader: R, sender: mpsc::UnboundedSender<String>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = sender.send(line);
        }
    });
}

fn parse_progress(job_id: &str, line: &str) -> Option<DownloadProgress> {
    let raw = line.split_once("rippr-progress:")?.1;
    let fields: Vec<&str> = raw.split('|').collect();
    let reported_percent = fields
        .first()
        .and_then(|value| value.trim().trim_end_matches('%').parse::<f64>().ok());
    let speed = fields
        .get(1)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && *value != "NA")
        .map(str::to_owned);
    let eta_seconds = fields.get(2).and_then(|value| value.trim().parse().ok());
    let downloaded_bytes = fields.get(3).and_then(|value| value.trim().parse().ok());
    let total_bytes = fields
        .get(4)
        .and_then(|value| value.trim().parse().ok())
        .or_else(|| fields.get(5).and_then(|value| value.trim().parse().ok()));
    let percent = match (downloaded_bytes, total_bytes) {
        (Some(downloaded), Some(total)) if total > 0 => {
            Some(((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0))
        }
        _ => reported_percent,
    };
    Some(DownloadProgress {
        job_id: job_id.into(),
        status: "downloading".into(),
        percent,
        speed,
        eta_seconds,
        downloaded_bytes,
        total_bytes,
        file_path: None,
        message: None,
    })
}

fn clean_process_error(stderr: &[u8]) -> String {
    let value = String::from_utf8_lossy(stderr);
    value
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("The media site rejected the request.")
        .trim()
        .trim_start_matches("ERROR:")
        .trim()
        .to_owned()
}

fn string_value(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_owned)
}
fn u64_value(value: &Value, key: &str) -> Option<u64> {
    value
        .get(key)?
        .as_u64()
        .or_else(|| value.get(key)?.as_f64().map(|value| value as u64))
}
fn f64_value(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)?
        .as_f64()
        .or_else(|| value.get(key)?.as_u64().map(|value| value as f64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_only_http_urls() {
        assert!(validate_url("https://example.com/video").is_ok());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("not a url").is_err());
    }

    #[test]
    fn parses_machine_progress() {
        let progress =
            parse_progress("job", "rippr-progress: 42.5%|3.2MiB/s|12|100|200|NA").unwrap();
        assert_eq!(progress.percent, Some(50.0));
        assert_eq!(progress.downloaded_bytes, Some(100));
        assert_eq!(progress.total_bytes, Some(200));
    }

    #[test]
    fn derives_progress_from_bytes_and_accepts_prefixed_output() {
        let progress =
            parse_progress("job", "[download] rippr-progress:NA|NA|NA|250|1000|NA").unwrap();
        assert_eq!(progress.percent, Some(25.0));
    }

    #[test]
    fn custom_filename_is_safe_and_overrides_the_template() {
        let request = DownloadRequest {
            url: "https://example.com/video".into(),
            metadata: None,
            kind: "video".into(),
            format: "mp4".into(),
            quality: "1080p".into(),
            destination: "/tmp/rippr".into(),
            file_name: Some("../Client: Cut.mp4".into()),
            naming_template: Some("%(title)s".into()),
            transcode_for_premiere: false,
        };
        let expected = Path::new("/tmp/rippr")
            .join("_Client_ Cut.%(ext)s")
            .to_string_lossy()
            .into_owned();
        assert_eq!(output_template(&request, "%(title)s"), expected);
    }

    #[test]
    fn empty_custom_filename_uses_the_configured_template() {
        let request = DownloadRequest {
            url: "https://example.com/video".into(),
            metadata: None,
            kind: "video".into(),
            format: "mp4".into(),
            quality: "1080p".into(),
            destination: "/tmp/rippr".into(),
            file_name: Some("   ".into()),
            naming_template: Some("%(title)s [%(resolution)s]".into()),
            transcode_for_premiere: false,
        };
        let expected = Path::new("/tmp/rippr")
            .join("%(title)s [%(resolution)s].%(ext)s")
            .to_string_lossy()
            .into_owned();
        assert_eq!(output_template(&request, "fallback"), expected);
    }

    #[test]
    fn normalizes_quoted_relative_reported_paths() {
        let expected = Path::new("/tmp/rippr")
            .join("clip.mp4")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            normalize_reported_path(" \"clip.mp4\" ", Path::new("/tmp/rippr")),
            expected
        );
    }

    #[tokio::test]
    async fn chooses_the_last_existing_reported_path() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let existing = directory.path().join("merged.mp4");
        tokio::fs::write(&existing, b"test").await.unwrap();
        let paths = vec![
            directory
                .path()
                .join("intermediate.webm")
                .to_string_lossy()
                .into_owned(),
            existing.to_string_lossy().into_owned(),
        ];

        assert_eq!(wait_for_downloaded_file(&paths).await.unwrap(), paths[1]);
    }

    #[test]
    fn maps_windows_filename_characters_to_full_width_variants() {
        let path = Path::new("/tmp/OVERRATED: The Worst Fitness Advice Ever.mp4");
        let variant = windows_filename_variant(path).expect("a sanitized variant should exist");
        assert_eq!(
            variant.file_name().unwrap().to_string_lossy(),
            "OVERRATED： The Worst Fitness Advice Ever.mp4"
        );
    }

    #[tokio::test]
    async fn resolves_reported_name_when_windows_removed_an_invalid_character() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let actual = directory
            .path()
            .join("OVERRATED： The Worst Fitness Advice Ever [1920x1080].mp4");
        tokio::fs::write(&actual, b"test").await.unwrap();
        let reported = directory
            .path()
            .join("OVERRATED The Worst Fitness Advice Ever [1920x1080].mp4")
            .to_string_lossy()
            .into_owned();

        assert_eq!(
            wait_for_downloaded_file(&[reported]).await.unwrap(),
            actual.to_string_lossy()
        );
    }

    #[tokio::test]
    async fn chooses_a_unique_output_name_instead_of_overwriting() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let existing = directory.path().join("clip.mp4");
        tokio::fs::write(&existing, b"existing").await.unwrap();
        let next = next_available_output_path(&existing).await.unwrap();
        assert_eq!(next, directory.path().join("clip (1).mp4"));
    }
}
