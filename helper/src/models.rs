use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const SETTINGS_SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse<T: Serialize> {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RpcEvent<T: Serialize> {
    pub event: String,
    pub payload: T,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPreset {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub project_relative: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub schema_version: u32,
    pub default_kind: String,
    pub default_video_format: String,
    pub default_audio_format: String,
    pub default_video_quality: String,
    pub default_audio_quality: String,
    pub default_folder: Option<String>,
    pub auto_import: bool,
    pub remember_last_destination: bool,
    pub clipboard_monitoring: bool,
    pub use_temp_conversion_source: bool,
    pub concurrent_downloads: u8,
    pub retry_count: u8,
    pub naming_template: String,
    pub yt_dlp_path: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub last_premiere_bin_id: Option<String>,
    pub auto_create_bin: bool,
    pub folder_presets: Vec<FolderPreset>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            default_kind: "video".into(),
            default_video_format: "mp4".into(),
            default_audio_format: "wav".into(),
            default_video_quality: "1080p".into(),
            default_audio_quality: "320 kbps".into(),
            default_folder: None,
            auto_import: true,
            remember_last_destination: true,
            clipboard_monitoring: false,
            use_temp_conversion_source: true,
            concurrent_downloads: 2,
            retry_count: 3,
            naming_template: "%(title)s [%(resolution)s]".into(),
            yt_dlp_path: None,
            ffmpeg_path: None,
            last_premiere_bin_id: None,
            auto_create_bin: true,
            folder_presets: Vec::new(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettingsPatch {
    pub default_kind: Option<String>,
    pub default_video_format: Option<String>,
    pub default_audio_format: Option<String>,
    pub default_video_quality: Option<String>,
    pub default_audio_quality: Option<String>,
    pub default_folder: Option<Option<String>>,
    pub auto_import: Option<bool>,
    pub remember_last_destination: Option<bool>,
    pub clipboard_monitoring: Option<bool>,
    pub use_temp_conversion_source: Option<bool>,
    pub concurrent_downloads: Option<u8>,
    pub retry_count: Option<u8>,
    pub naming_template: Option<String>,
    pub yt_dlp_path: Option<Option<String>>,
    pub ffmpeg_path: Option<Option<String>>,
    pub last_premiere_bin_id: Option<Option<String>>,
    pub auto_create_bin: Option<bool>,
    pub folder_presets: Option<Vec<FolderPreset>>,
}

impl AppSettings {
    pub fn apply(&mut self, patch: AppSettingsPatch) {
        if let Some(value) = patch
            .default_kind
            .filter(|v| matches!(v.as_str(), "video" | "audio"))
        {
            self.default_kind = value;
        }
        if let Some(value) = patch
            .default_video_format
            .filter(|v| matches!(v.as_str(), "best" | "mp4" | "mov" | "mkv" | "original"))
        {
            self.default_video_format = value;
        }
        if let Some(value) = patch
            .default_audio_format
            .filter(|v| matches!(v.as_str(), "wav" | "mp3" | "flac" | "original"))
        {
            self.default_audio_format = value;
        }
        if let Some(value) = patch.default_video_quality {
            self.default_video_quality = value;
        }
        if let Some(value) = patch.default_audio_quality {
            self.default_audio_quality = value;
        }
        if let Some(value) = patch.default_folder {
            self.default_folder = clean_optional(value);
        }
        if let Some(value) = patch.auto_import {
            self.auto_import = value;
        }
        if let Some(value) = patch.remember_last_destination {
            self.remember_last_destination = value;
        }
        if let Some(value) = patch.clipboard_monitoring {
            self.clipboard_monitoring = value;
        }
        if let Some(value) = patch.use_temp_conversion_source {
            self.use_temp_conversion_source = value;
        }
        if let Some(value) = patch.concurrent_downloads {
            self.concurrent_downloads = value.clamp(1, 6);
        }
        if let Some(value) = patch.retry_count {
            self.retry_count = value.min(10);
        }
        if let Some(value) = patch.naming_template.filter(|v| !v.trim().is_empty()) {
            self.naming_template = value;
        }
        if let Some(value) = patch.yt_dlp_path {
            self.yt_dlp_path = clean_optional(value);
        }
        if let Some(value) = patch.ffmpeg_path {
            self.ffmpeg_path = clean_optional(value);
        }
        if let Some(value) = patch.last_premiere_bin_id {
            self.last_premiere_bin_id = clean_optional(value);
        }
        if let Some(value) = patch.auto_create_bin {
            self.auto_create_bin = value;
        }
        if let Some(value) = patch.folder_presets {
            self.folder_presets = value;
        }
        self.schema_version = SETTINGS_SCHEMA_VERSION;
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFormat {
    pub id: String,
    pub extension: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate_kbps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub id: String,
    pub source_url: String,
    pub webpage_url: String,
    pub title: String,
    pub uploader: String,
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_bytes: Option<u64>,
    pub resolutions: Vec<String>,
    pub formats: Vec<MediaFormat>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    pub metadata: Option<MediaMetadata>,
    pub kind: String,
    pub format: String,
    pub quality: String,
    pub destination: String,
    pub file_name: Option<String>,
    pub naming_template: Option<String>,
    #[serde(default)]
    pub transcode_for_premiere: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStarted {
    pub job_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub job_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub source_url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    pub completed_at: String,
    pub destination: String,
    pub file_path: String,
    pub kind: String,
    pub format: String,
    pub quality: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    pub name: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperInfo {
    pub version: String,
    pub protocol_version: u32,
    pub platform: String,
    pub dependencies: Vec<DependencyStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStatus {
    pub path: String,
    pub exists: bool,
    pub writable: bool,
    pub disconnected: bool,
}

#[derive(Debug, Serialize)]
pub struct OkResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
