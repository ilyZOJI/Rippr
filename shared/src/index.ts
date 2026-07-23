export type MediaKind = "video" | "audio";
export type VideoFormat = "best" | "mp4" | "mov" | "mkv" | "original";
export type AudioFormat = "wav" | "mp3" | "flac" | "original";

export interface MediaFormat {
  id: string;
  extension: string;
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  bitrateKbps?: number;
  estimatedBytes?: number;
}

export interface MediaMetadata {
  id: string;
  sourceUrl: string;
  webpageUrl: string;
  title: string;
  uploader: string;
  platform: string;
  durationSeconds?: number;
  uploadDate?: string;
  thumbnailUrl?: string;
  estimatedBytes?: number;
  resolutions: string[];
  formats: MediaFormat[];
}

export interface FolderPreset {
  id: string;
  name: string;
  path: string;
  icon?: string;
  color?: string;
  projectRelative?: boolean;
}

export interface AppSettings {
  schemaVersion: number;
  defaultKind: MediaKind;
  defaultVideoFormat: VideoFormat;
  defaultAudioFormat: AudioFormat;
  defaultVideoQuality: string;
  defaultAudioQuality: string;
  defaultFolder?: string;
  autoImport: boolean;
  rememberLastDestination: boolean;
  clipboardMonitoring: boolean;
  /** Stage conversion sources in Rippr's temporary workspace before transcoding. */
  useTempConversionSource: boolean;
  concurrentDownloads: number;
  retryCount: number;
  namingTemplate: string;
  ytDlpPath?: string;
  ffmpegPath?: string;
  lastPremiereBinId?: string;
  autoCreateBin: boolean;
  folderPresets: FolderPreset[];
}

export interface DependencyStatus {
  name: "yt-dlp" | "ffmpeg";
  available: boolean;
  path?: string;
  version?: string;
  message?: string;
}

export interface DownloadRequest {
  url: string;
  metadata?: MediaMetadata;
  kind: MediaKind;
  format: VideoFormat | AudioFormat;
  quality: string;
  destination: string;
  fileName?: string;
  namingTemplate?: string;
  /** Re-encode risky video sources as H.264/AAC MP4 before import. */
  transcodeForPremiere?: boolean;
}

export interface DownloadStarted {
  jobId: string;
}

export interface DownloadProgress {
  jobId: string;
  status: "queued" | "downloading" | "processing" | "completed" | "cancelled" | "failed";
  percent?: number;
  speed?: string;
  etaSeconds?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  filePath?: string;
  message?: string;
}

export interface HistoryEntry {
  id: string;
  sourceUrl: string;
  title: string;
  thumbnailUrl?: string;
  completedAt: string;
  destination: string;
  filePath: string;
  kind: MediaKind;
  format: string;
  quality: string;
}

export interface FolderStatus {
  path: string;
  exists: boolean;
  writable: boolean;
  disconnected: boolean;
}

export interface HelperInfo {
  version: string;
  protocolVersion: number;
  platform: string;
  dependencies: DependencyStatus[];
}

export interface RpcRequest<T = unknown> {
  id: string;
  method: string;
  params?: T;
}

export interface RpcError {
  code: string;
  message: string;
  action?: string;
  details?: string;
}

export interface RpcResponse<T = unknown> {
  id: string;
  result?: T;
  error?: RpcError;
}

export interface RpcEvent<T = unknown> {
  event: string;
  payload: T;
}
