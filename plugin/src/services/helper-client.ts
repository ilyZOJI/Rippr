import type {
  AppSettings,
  DownloadProgress,
  DownloadRequest,
  DownloadStarted,
  FolderStatus,
  HelperInfo,
  HistoryEntry,
  MediaMetadata,
  RpcError,
  RpcEvent,
  RpcRequest,
  RpcResponse,
} from "@rippr/shared";
import { cloneJson } from "../utils/clone-json";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface HelperClient {
  readonly connectionState: ConnectionState;
  connect(): void;
  destroy(): void;
  request<T>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  onConnection(listener: (state: ConnectionState) => void): () => void;
}

class HelperRequestError extends Error {
  constructor(public readonly rpcError: RpcError) {
    super(rpcError.message);
    this.name = "HelperRequestError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: number;
}

export class SocketHelperClient implements HelperClient {
  private socket?: WebSocket;
  private pending = new Map<string, PendingRequest>();
  private eventListeners = new Set<(event: RpcEvent) => void>();
  private connectionListeners = new Set<(state: ConnectionState) => void>();
  private reconnectTimer?: number;
  private reconnectAttempt = 0;
  private intentionallyClosed = false;
  connectionState: ConnectionState = "disconnected";

  constructor(private readonly endpoint = "ws://127.0.0.1:43117/rpc") {}

  connect(): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.intentionallyClosed = false;
    this.setConnectionState("connecting");

    try {
      const socket = new WebSocket(this.endpoint);
      this.socket = socket;
      socket.onopen = () => {
        this.reconnectAttempt = 0;
        this.setConnectionState("connected");
      };
      socket.onmessage = (message) => this.handleMessage(String(message.data));
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        this.socket = undefined;
        this.setConnectionState("disconnected");
        this.rejectPending("HELPER_DISCONNECTED", "The Rippr helper disconnected.");
        if (!this.intentionallyClosed) this.scheduleReconnect();
      };
    } catch {
      this.setConnectionState("disconnected");
      this.scheduleReconnect();
    }
  }

  destroy(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Panel closed");
    this.rejectPending("HELPER_DISCONNECTED", "The Rippr helper disconnected.");
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new HelperRequestError({
          code: "HELPER_OFFLINE",
          message: "The Rippr helper is not running.",
          action: "Start the helper, then try again.",
        }),
      );
    }

    const id = crypto.randomUUID();
    const payload: RpcRequest = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperRequestError({ code: "TIMEOUT", message: `${method} timed out.`, action: "Try again." }));
      }, method === "analyze" ? 120_000 : 30_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      this.socket?.send(JSON.stringify(payload));
    });
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnection(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => this.connectionListeners.delete(listener);
  }

  private handleMessage(raw: string): void {
    try {
      const message = JSON.parse(raw) as RpcResponse | RpcEvent;
      if ("event" in message) {
        this.eventListeners.forEach((listener) => listener(message));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new HelperRequestError(message.error));
      else pending.resolve(message.result);
    } catch (error) {
      console.error("Rippr received an invalid helper message", error);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionallyClosed) return;
    const delay = Math.min(10_000, 500 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private setConnectionState(state: ConnectionState): void {
    if (state === this.connectionState) return;
    this.connectionState = state;
    this.connectionListeners.forEach((listener) => listener(state));
  }

  private rejectPending(code: string, message: string): void {
    this.pending.forEach((pending) => {
      window.clearTimeout(pending.timeout);
      pending.reject(new HelperRequestError({ code, message }));
    });
    this.pending.clear();
  }
}

const mockMetadata: MediaMetadata = {
  id: "demo-rippr",
  sourceUrl: "https://vimeo.com/example",
  webpageUrl: "https://vimeo.com/example",
  title: "The Shape of Motion - Studio Reel",
  uploader: "Northline Studio",
  platform: "Vimeo",
  durationSeconds: 173,
  uploadDate: "2026-06-18",
  thumbnailUrl: "https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=1200&q=80",
  estimatedBytes: 428_000_000,
  resolutions: ["2160p", "1440p", "1080p", "720p", "480p", "360p"],
  formats: [
    { id: "401", extension: "mp4", resolution: "3840x2160", width: 3840, height: 2160, fps: 24, videoCodec: "av01", estimatedBytes: 428_000_000 },
    { id: "137", extension: "mp4", resolution: "1920x1080", width: 1920, height: 1080, fps: 24, videoCodec: "h264", estimatedBytes: 182_000_000 },
  ],
};

const defaultMockSettings: AppSettings = {
  schemaVersion: 2,
  defaultKind: "video",
  defaultVideoFormat: "mp4",
  defaultAudioFormat: "wav",
  defaultVideoQuality: "1080p",
  defaultAudioQuality: "320 kbps",
  defaultFolder: "/Users/editor/Projects/Aurora/Footage",
  autoImport: true,
  rememberLastDestination: true,
  clipboardMonitoring: false,
  concurrentDownloads: 2,
  retryCount: 3,
  namingTemplate: "%(title)s [%(resolution)s]",
  autoCreateBin: true,
  folderPresets: [],
};

export class MockHelperClient implements HelperClient {
  connectionState: ConnectionState = "connected";
  private eventListeners = new Set<(event: RpcEvent) => void>();
  private connectionListeners = new Set<(state: ConnectionState) => void>();
  private settings = cloneJson(defaultMockSettings);
  private history: HistoryEntry[] = [];
  private timers = new Map<string, number>();

  connect(): void {
    this.connectionState = "connected";
    this.connectionListeners.forEach((listener) => listener("connected"));
  }

  destroy(): void {
    this.timers.forEach((timer) => window.clearInterval(timer));
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await new Promise((resolve) => window.setTimeout(resolve, method === "analyze" ? 850 : 120));
    switch (method) {
      case "hello":
        return {
          version: "1.0.0-mock",
          protocolVersion: 1,
          platform: "mock",
          dependencies: [
            { name: "yt-dlp", available: true, version: "2026.07.15" },
            { name: "ffmpeg", available: true, version: "8.0" },
          ],
        } as T;
      case "analyze":
        return { ...mockMetadata, sourceUrl: (params as { url: string }).url } as T;
      case "get_settings":
        return cloneJson(this.settings) as T;
      case "update_settings":
        this.settings = { ...this.settings, ...(params as Partial<AppSettings>) };
        return cloneJson(this.settings) as T;
      case "folder_status": {
        const path = (params as { path: string }).path;
        return { path, exists: true, writable: true, disconnected: false } as T;
      }
      case "create_folder":
      case "reveal_path":
      case "open_file":
        return { ok: true } as T;
      case "get_history":
        return cloneJson(this.history) as T;
      case "clear_history":
        this.history = [];
        return { ok: true } as T;
      case "check_dependencies":
        return (await this.request<HelperInfo>("hello")).dependencies as T;
      case "update_dependency":
        return { ok: true, message: "Already up to date." } as T;
      case "start_download":
        return this.startMockDownload(params as DownloadRequest) as T;
      case "cancel_download": {
        const jobId = (params as { jobId: string }).jobId;
        const timer = this.timers.get(jobId);
        if (timer) window.clearInterval(timer);
        this.timers.delete(jobId);
        this.emit("download_progress", { jobId, status: "cancelled", message: "Download cancelled" } satisfies DownloadProgress);
        return { ok: true } as T;
      }
      default:
        throw new HelperRequestError({ code: "UNKNOWN_METHOD", message: `Unknown mock method: ${method}` });
    }
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnection(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => this.connectionListeners.delete(listener);
  }

  private startMockDownload(request: DownloadRequest): DownloadStarted {
    const jobId = crypto.randomUUID();
    let percent = 0;
    const totalBytes = request.metadata?.estimatedBytes ?? 428_000_000;
    const timer = window.setInterval(() => {
      percent = Math.min(100, percent + 2.4);
      const completed = percent >= 100;
      const extension = request.format === "best" || request.format === "original" ? "mp4" : request.format;
      const customName = request.fileName
        ?.trim()
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/\.(mp4|mov|mkv|wav|mp3|flac)$/i, "");
      const templatedName = (request.namingTemplate || "%(title)s")
        .replaceAll("%(title)s", request.metadata?.title || "Rippr download")
        .replaceAll("%(uploader)s", request.metadata?.uploader || "Unknown uploader")
        .replaceAll("%(upload_date)s", request.metadata?.uploadDate || "")
        .replaceAll("%(resolution)s", request.quality)
        .replaceAll("%(ext)s", extension);
      const fileName = customName || templatedName;
      const filePath = `${request.destination}/${fileName}${fileName.toLocaleLowerCase().endsWith(`.${extension}`) ? "" : `.${extension}`}`;
      this.emit("download_progress", {
        jobId,
        status: completed ? "completed" : percent > 91 ? "processing" : "downloading",
        percent,
        speed: completed ? undefined : "24.8 MiB/s",
        etaSeconds: completed ? 0 : Math.ceil((100 - percent) / 7),
        downloadedBytes: Math.floor((totalBytes * percent) / 100),
        totalBytes,
        filePath: completed ? filePath : undefined,
      } satisfies DownloadProgress);
      if (completed) {
        window.clearInterval(timer);
        this.timers.delete(jobId);
        this.history.unshift({
          id: crypto.randomUUID(),
          sourceUrl: request.url,
          title: request.metadata?.title ?? "Rippr download",
          thumbnailUrl: request.metadata?.thumbnailUrl,
          completedAt: new Date().toISOString(),
          destination: request.destination,
          filePath,
          kind: request.kind,
          format: request.format,
          quality: request.quality,
        });
      }
    }, 180);
    this.timers.set(jobId, timer);
    return { jobId };
  }

  private emit<T>(event: string, payload: T): void {
    const message: RpcEvent<T> = { event, payload };
    this.eventListeners.forEach((listener) => listener(message));
  }
}

export function createHelperClient(): HelperClient {
  const mock = window.__RIPPR_MOCK__ || new URLSearchParams(window.location.search).get("mock") === "1";
  return mock ? new MockHelperClient() : new SocketHelperClient();
}

export type {
  AppSettings,
  DownloadProgress,
  DownloadRequest,
  DownloadStarted,
  FolderStatus,
  HelperInfo,
  HistoryEntry,
  MediaMetadata,
};
