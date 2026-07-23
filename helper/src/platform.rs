use crate::{
    error::RipprError,
    models::{AppSettings, DependencyStatus, FolderStatus, OkResponse},
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::path::Component;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;
use uuid::Uuid;

pub fn resolve_tool(name: &str, explicit: Option<&str>) -> Result<PathBuf, RipprError> {
    if let Some(path) = explicit.filter(|path| !path.trim().is_empty()) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let env_name = match name {
        "yt-dlp" => "RIPPR_YTDLP_PATH",
        "ffmpeg" => "RIPPR_FFMPEG_PATH",
        _ => "",
    };
    let env_path = (!env_name.is_empty())
        .then(|| std::env::var(env_name).ok())
        .flatten()
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    if let Some(path) = env_path {
        return Ok(path);
    }

    if let Ok(path) = which::which(name) {
        return Ok(path);
    }
    #[cfg(windows)]
    if let Ok(path) = which::which(format!("{name}.exe")) {
        return Ok(path);
    }

    if let Ok(executable) = std::env::current_exe() {
        let directory = executable.parent().unwrap_or_else(|| Path::new("."));
        let candidates = if cfg!(windows) {
            vec![format!("{name}.exe")]
        } else {
            vec![name.to_owned()]
        };
        for candidate in candidates {
            let path = directory.join(candidate);
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    match name {
        "yt-dlp" => Err(RipprError::MissingYtDlp),
        "ffmpeg" => Err(RipprError::MissingFfmpeg),
        _ => Err(RipprError::Internal(format!("Unknown tool: {name}"))),
    }
}

pub async fn dependency_statuses(settings: &AppSettings) -> Vec<DependencyStatus> {
    let mut statuses = Vec::new();
    for (name, explicit) in [
        ("yt-dlp", settings.yt_dlp_path.as_deref()),
        ("ffmpeg", settings.ffmpeg_path.as_deref()),
    ] {
        match resolve_tool(name, explicit) {
            Ok(path) => {
                let version = tool_version(name, &path).await;
                statuses.push(DependencyStatus {
                    name: name.into(),
                    available: version.is_some(),
                    path: Some(path.to_string_lossy().into_owned()),
                    version,
                    message: None,
                });
            }
            Err(error) => statuses.push(DependencyStatus {
                name: name.into(),
                available: false,
                path: None,
                version: None,
                message: Some(error.to_string()),
            }),
        }
    }
    statuses
}

async fn tool_version(name: &str, path: &Path) -> Option<String> {
    let argument = if name == "ffmpeg" {
        "-version"
    } else {
        "--version"
    };
    let output = Command::new(path)
        .arg(argument)
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next()?.trim();
    Some(if name == "ffmpeg" {
        line.strip_prefix("ffmpeg version ")
            .unwrap_or(line)
            .split_whitespace()
            .next()
            .unwrap_or(line)
            .into()
    } else {
        line.into()
    })
}

pub async fn update_dependency(
    name: &str,
    settings: &AppSettings,
) -> Result<OkResponse, RipprError> {
    match name {
        "yt-dlp" => {
            let executable = resolve_tool("yt-dlp", settings.yt_dlp_path.as_deref())?;
            let output = Command::new(executable)
                .arg("-U")
                .stdin(Stdio::null())
                .output()
                .await?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if !output.status.success() {
                return Err(RipprError::Internal(if stderr.is_empty() {
                    stdout
                } else {
                    stderr
                }));
            }
            Ok(OkResponse {
                ok: true,
                message: Some(if stdout.is_empty() {
                    "yt-dlp is up to date.".into()
                } else {
                    stdout
                }),
            })
        }
        "ffmpeg" => Ok(OkResponse {
            ok: true,
            message: Some(
                "Rippr verified FFmpeg. Replace the configured or bundled binary to upgrade it."
                    .into(),
            ),
        }),
        _ => Err(RipprError::InvalidRequest(format!(
            "Unknown dependency: {name}"
        ))),
    }
}

pub async fn folder_status(path: &str) -> Result<FolderStatus, RipprError> {
    let path_buf = PathBuf::from(path);
    if !path_buf.is_absolute() {
        return Err(RipprError::InvalidDestination);
    }
    match tokio::fs::metadata(&path_buf).await {
        Ok(metadata) => {
            let is_directory = metadata.is_dir();
            let writable = is_directory && can_write_folder(&path_buf).await;
            Ok(FolderStatus {
                path: path.into(),
                exists: is_directory,
                writable,
                disconnected: false,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FolderStatus {
            path: path.into(),
            exists: false,
            writable: false,
            disconnected: mount_root_missing(&path_buf),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => Ok(FolderStatus {
            path: path.into(),
            exists: true,
            writable: false,
            disconnected: false,
        }),
        Err(error) => Err(error.into()),
    }
}

async fn can_write_folder(path: &Path) -> bool {
    let probe_path = path.join(format!(".rippr-write-test-{}.tmp", Uuid::new_v4()));
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe_path)
        .await
    {
        Ok(_) => {
            let _ = tokio::fs::remove_file(probe_path).await;
            true
        }
        Err(_) => false,
    }
}

pub async fn create_folder(path: &str) -> Result<OkResponse, RipprError> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(RipprError::InvalidDestination);
    }
    if mount_root_missing(&path) {
        return Err(RipprError::DriveDisconnected);
    }
    tokio::fs::create_dir_all(path).await?;
    Ok(OkResponse {
        ok: true,
        message: None,
    })
}

pub fn open_file(path: &str) -> Result<OkResponse, RipprError> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err(RipprError::InvalidRequest(
            "The downloaded file no longer exists.".into(),
        ));
    }
    open::that_detached(path).map_err(|error| RipprError::Internal(error.to_string()))?;
    Ok(OkResponse {
        ok: true,
        message: None,
    })
}

pub async fn reveal_path(path: &str) -> Result<OkResponse, RipprError> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(RipprError::InvalidRequest(
            "The downloaded file no longer exists.".into(),
        ));
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg("-R").arg(&path).status().await?;
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer.exe")
        .arg(format!("/select,{}", path.to_string_lossy()))
        .status()
        .await?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open")
        .arg(path.parent().unwrap_or(&path))
        .status()
        .await?;

    if !status.success() {
        return Err(RipprError::Internal(
            "The system file browser could not reveal the file.".into(),
        ));
    }
    Ok(OkResponse {
        ok: true,
        message: None,
    })
}

fn mount_root_missing(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut components = path.components();
        if matches!(components.next(), Some(Component::RootDir))
            && matches!(components.next(), Some(Component::Normal(name)) if name == "Volumes")
        {
            if let Some(Component::Normal(volume)) = components.next() {
                return !Path::new("/Volumes").join(volume).exists();
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(Component::Prefix(prefix)) = path.components().next() {
            let root = PathBuf::from(format!("{}\\", prefix.as_os_str().to_string_lossy()));
            return !root.exists();
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = path;
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_a_writable_existing_directory() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let status = folder_status(directory.path().to_string_lossy().as_ref())
            .await
            .expect("folder status should succeed");

        assert!(status.exists);
        assert!(status.writable);
        assert!(!status.disconnected);
    }
}
