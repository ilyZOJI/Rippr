use crate::models::RpcError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RipprError {
    #[error("The URL is invalid or unsupported.")]
    InvalidUrl,
    #[error("yt-dlp is not available.")]
    MissingYtDlp,
    #[error("FFmpeg is not available.")]
    MissingFfmpeg,
    #[error("The destination path must be absolute.")]
    InvalidDestination,
    #[error("The destination is not writable.")]
    PermissionDenied,
    #[error("The destination drive is disconnected.")]
    DriveDisconnected,
    #[error("The requested download was not found.")]
    JobNotFound,
    #[error("The helper received an invalid request: {0}")]
    InvalidRequest(String),
    #[error("The media site did not return usable information: {0}")]
    AnalysisFailed(String),
    #[error("The download failed: {0}")]
    DownloadFailed(String),
    #[error("The operation failed: {0}")]
    Internal(String),
}

impl RipprError {
    pub fn rpc_error(&self) -> RpcError {
        let (code, action) = match self {
            Self::InvalidUrl => (
                "INVALID_URL",
                "Check the link and make sure it begins with http or https.",
            ),
            Self::MissingYtDlp => (
                "MISSING_YT_DLP",
                "Install yt-dlp or set its executable path in Settings.",
            ),
            Self::MissingFfmpeg => (
                "MISSING_FFMPEG",
                "Install FFmpeg or set its executable path in Settings.",
            ),
            Self::InvalidDestination => (
                "INVALID_DESTINATION",
                "Choose an absolute destination folder.",
            ),
            Self::PermissionDenied => (
                "PERMISSION_DENIED",
                "Choose a writable folder or update its permissions.",
            ),
            Self::DriveDisconnected => (
                "DRIVE_DISCONNECTED",
                "Reconnect the external drive or choose another folder.",
            ),
            Self::JobNotFound => ("JOB_NOT_FOUND", "Refresh Rippr and try again."),
            Self::InvalidRequest(_) => ("INVALID_REQUEST", "Check the request and try again."),
            Self::AnalysisFailed(details) if is_forbidden(details) => (
                "SOURCE_FORBIDDEN",
                "The source temporarily rejected the request. Refresh the link and retry, or update yt-dlp if it continues.",
            ),
            Self::AnalysisFailed(_) => (
                "ANALYSIS_FAILED",
                "Confirm the media is public and supported, then try again.",
            ),
            Self::DownloadFailed(details) if is_forbidden(details) => (
                "DOWNLOAD_FORBIDDEN",
                "The source temporarily rejected the request. Wait a few seconds and retry, or update yt-dlp if it continues.",
            ),
            Self::DownloadFailed(_) => (
                "DOWNLOAD_FAILED",
                "Check your connection, free disk space, and retry.",
            ),
            Self::Internal(_) => ("INTERNAL_ERROR", "Restart the helper and try again."),
        };
        RpcError {
            code: code.into(),
            message: self.to_string(),
            action: Some(action.into()),
            details: match self {
                Self::AnalysisFailed(details)
                | Self::DownloadFailed(details)
                | Self::Internal(details) => Some(details.clone()),
                _ => None,
            },
        }
    }
}

fn is_forbidden(details: &str) -> bool {
    let lower = details.to_ascii_lowercase();
    lower.contains("http error 403") || lower.contains("403: forbidden")
}

impl From<std::io::Error> for RipprError {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::PermissionDenied => Self::PermissionDenied,
            std::io::ErrorKind::StorageFull => {
                Self::DownloadFailed("The destination disk is full.".into())
            }
            _ => Self::Internal(error.to_string()),
        }
    }
}

impl From<serde_json::Error> for RipprError {
    fn from(error: serde_json::Error) -> Self {
        Self::InvalidRequest(error.to_string())
    }
}
