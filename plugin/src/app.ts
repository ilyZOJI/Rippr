import type {
  AppSettings,
  DependencyStatus,
  DownloadProgress,
  DownloadRequest,
  FolderPreset,
  HelperInfo,
  HistoryEntry,
  MediaKind,
  MediaMetadata,
} from "@rippr/shared";
import type { ConnectionState, HelperClient } from "./services/helper-client";
import { PremiereService, type PremiereContext } from "./services/premiere";
import { cloneJson } from "./utils/clone-json";
import { escapeHtml, formatBytes, formatDate, formatDuration, isSupportedUrl } from "./utils/format";

type View = "download" | "history" | "settings";
type AnalysisState = "idle" | "loading" | "ready" | "error";
type ImportState = "idle" | "importing" | "completed" | "failed";

interface CodecWarning {
  codec: string;
  message: string;
}

interface Toast {
  id: string;
  tone: "success" | "warning" | "error" | "info";
  title: string;
  message?: string;
}

const initialSettings: AppSettings = {
  schemaVersion: 3,
  defaultKind: "video",
  defaultVideoFormat: "mp4",
  defaultAudioFormat: "wav",
  defaultVideoQuality: "1080p",
  defaultAudioQuality: "320 kbps",
  autoImport: true,
  rememberLastDestination: true,
  clipboardMonitoring: false,
  useTempConversionSource: true,
  concurrentDownloads: 2,
  retryCount: 3,
  namingTemplate: "%(title)s [%(resolution)s]",
  autoCreateBin: true,
  folderPresets: [],
};

export class RipprApp {
  private view: View = "download";
  private connection: ConnectionState = "disconnected";
  private helperInfo?: HelperInfo;
  private settings: AppSettings = cloneJson(initialSettings);
  private context: PremiereContext = { available: false, bins: [] };
  private history: HistoryEntry[] = [];
  private url = "";
  private analysisState: AnalysisState = "idle";
  private analysisError?: string;
  private metadata?: MediaMetadata;
  private kind: MediaKind = "video";
  private format = "mp4";
  private quality = "1080p";
  private destination = "";
  private customFileName = "";
  private transcodeForPremiere = true;
  private binId = "";
  private autoImport = true;
  private download?: DownloadProgress;
  private importState: ImportState = "idle";
  private aboutOpen = false;
  private toasts: Toast[] = [];
  private clipboardTimer?: number;
  private helperLaunchTimer?: number;
  private helperAutoStartAttempted = false;
  private renamingPresetId?: string;
  private openDropdownId?: string;
  private premiereRefreshTimer?: number;
  private premiereRefreshRunning = false;
  private premiereRefreshAgain = false;
  private unlisten: Array<() => void> = [];
  private destroyed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly helper: HelperClient,
    private readonly premiere: PremiereService,
  ) {}

  mount(): void {
    this.unlisten.push(
      this.helper.onConnection((state) => {
        this.connection = state;
        this.render();
        if (state === "connected") void this.hydrate();
      }),
      this.helper.onEvent((event) => {
        if (event.event === "download_progress") void this.handleProgress(event.payload as DownloadProgress);
      }),
    );
    this.helper.connect();
    this.scheduleAutomaticHelperLaunch();
    this.installKeyboardShortcuts();
    this.unlisten.push(this.premiere.watchProjectChanges(() => this.queuePremiereContextRefresh()));
    const refreshOnFocus = () => this.queuePremiereContextRefresh(0);
    window.addEventListener("focus", refreshOnFocus);
    this.unlisten.push(() => window.removeEventListener("focus", refreshOnFocus));
    void this.refreshPremiereContext();
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.unlisten.forEach((unlisten) => unlisten());
    if (this.clipboardTimer) window.clearInterval(this.clipboardTimer);
    if (this.helperLaunchTimer) window.clearTimeout(this.helperLaunchTimer);
    if (this.premiereRefreshTimer) window.clearTimeout(this.premiereRefreshTimer);
    this.helper.destroy();
  }

  private scheduleAutomaticHelperLaunch(): void {
    // Browser preview and mock mode do not have a native helper to launch.
    if (!this.premiere.available || this.helperAutoStartAttempted || this.helperLaunchTimer) return;
    this.helperLaunchTimer = window.setTimeout(() => {
      this.helperLaunchTimer = undefined;
      if (this.destroyed || this.helper.connectionState === "connected") return;
      this.helperAutoStartAttempted = true;
      void this.launchHelperAutomatically();
    }, 900);
  }

  private async launchHelperAutomatically(): Promise<void> {
    try {
      await this.premiere.launchHelper();
      // Give the operating system a moment to spawn the bundled binary before reconnecting.
      window.setTimeout(() => {
        if (!this.destroyed) this.helper.connect();
      }, 700);
    } catch (error) {
      // Keep the existing offline banner visible so the user can retry manually.
      console.warn("Rippr could not automatically start the native helper", error);
    }
  }

  private async hydrate(): Promise<void> {
    try {
      const [helperInfo, settings, history] = await Promise.all([
        this.helper.request<HelperInfo>("hello"),
        this.helper.request<AppSettings>("get_settings"),
        this.helper.request<HistoryEntry[]>("get_history"),
      ]);
      if (this.destroyed) return;
      this.helperInfo = helperInfo;
      this.settings = settings;
      this.history = history;
      this.kind = settings.defaultKind;
      this.format = this.kind === "video" ? settings.defaultVideoFormat : settings.defaultAudioFormat;
      this.quality = this.kind === "video" ? settings.defaultVideoQuality : settings.defaultAudioQuality;
      this.destination = settings.defaultFolder ?? settings.folderPresets[0]?.path ?? this.destination;
      this.autoImport = settings.autoImport;
      this.binId = this.resolveBinId(this.context, settings.lastPremiereBinId ?? this.binId);
      this.configureClipboardMonitoring();
      this.render();
    } catch (error) {
      this.notifyError(error, "Could not load Rippr settings");
    }
  }

  private async refreshPremiereContext(): Promise<void> {
    if (this.premiereRefreshRunning) {
      this.premiereRefreshAgain = true;
      return;
    }
    this.premiereRefreshRunning = true;
    try {
      const previousContext = this.context;
      const previousBinId = this.binId;
      const nextContext = await this.premiere.getContext();
      if (this.destroyed) return;
      const projectChanged = this.projectIdentity(previousContext) !== this.projectIdentity(nextContext);
      this.context = nextContext;
      this.binId = this.resolveBinId(nextContext, projectChanged ? undefined : previousBinId);
      if (this.contextSignature(previousContext) !== this.contextSignature(nextContext) || previousBinId !== this.binId) this.render();
    } finally {
      this.premiereRefreshRunning = false;
      if (this.premiereRefreshAgain && !this.destroyed) {
        this.premiereRefreshAgain = false;
        this.queuePremiereContextRefresh(0);
      }
    }
  }

  private queuePremiereContextRefresh(delay = 80): void {
    if (this.destroyed) return;
    if (this.premiereRefreshTimer) window.clearTimeout(this.premiereRefreshTimer);
    this.premiereRefreshTimer = window.setTimeout(() => {
      this.premiereRefreshTimer = undefined;
      void this.refreshPremiereContext();
    }, delay);
  }

  private resolveBinId(context: PremiereContext, preferred?: string): string {
    if (preferred && context.bins.some((bin) => bin.id === preferred)) return preferred;
    if (context.insertionBinId && context.bins.some((bin) => bin.id === context.insertionBinId)) return context.insertionBinId;
    return context.bins[0]?.id ?? "";
  }

  private projectIdentity(context: PremiereContext): string {
    return context.projectId ?? context.projectPath ?? context.projectName ?? "";
  }

  private contextSignature(context: PremiereContext): string {
    return JSON.stringify([
      context.available,
      context.projectId,
      context.projectName,
      context.projectPath,
      context.insertionBinId,
      context.bins.map((bin) => [bin.id, bin.name, bin.depth]),
    ]);
  }

  private render(resetScroll = false): void {
    const previousScroll = resetScroll ? 0 : (this.root.querySelector<HTMLElement>(".app-shell")?.scrollTop ?? 0);
    const connected = this.connection === "connected";
    const downloadActive = Boolean(this.download && !["completed", "failed", "cancelled"].includes(this.download.status));
    this.root.innerHTML = `
      <sp-theme color="dark" scale="medium">
      <div class="app-shell ${downloadActive ? "download-active" : ""}">
        ${this.renderHeader()}
        ${!connected ? this.renderOfflineBanner() : this.renderDependencyBanner()}
        <div class="view-frame">
          ${this.view === "download" ? this.renderDownloadView() : ""}
          ${this.view === "history" ? this.renderHistoryView() : ""}
          ${this.view === "settings" ? this.renderSettingsView() : ""}
        </div>
        ${this.renderToasts()}
      </div>
      </sp-theme>`;
    this.bindEvents();
    const shell = this.root.querySelector<HTMLElement>(".app-shell");
    if (shell) shell.scrollTop = previousScroll;
  }

  private renderHeader(): string {
    return `
      <header class="topbar">
        <div class="brand" aria-label="Rippr">
          <img class="brand-logo" src="./rippr-logo.png" alt="Rippr" />
        </div>
        <nav class="nav-tabs" aria-label="Rippr sections">
          ${this.navButton("download", "Download", "download")}
          ${this.navButton("history", "History", "history", this.history.length)}
        </nav>
        <div class="topbar-actions">
          <span class="connection-pill ${this.connection}" title="Helper ${this.connection}">
            <span class="status-dot"></span><span class="connection-label">${this.connection === "connected" ? "Ready" : "Offline"}</span>
          </span>
          <div class="icon-button ${this.view === "settings" ? "active" : ""}" data-view="settings" role="button" tabindex="0" aria-label="Settings" title="Settings">
            ${this.icon("settings")}
          </div>
        </div>
      </header>`;
  }

  private navButton(view: View, label: string, icon: string, count?: number): string {
    return `<div class="nav-tab ${this.view === view ? "active" : ""}" data-view="${view}" role="button" tabindex="0" ${this.view === view ? 'aria-current="page"' : ""}>
      <span class="nav-label">${this.icon(icon)}&nbsp;${label}${count ? ` [${count}]` : ""}</span>
    </div>`;
  }

  private renderOfflineBanner(): string {
    return `
      <aside class="system-banner warning" role="status">
        <span class="banner-icon">${this.icon("bolt")}</span>
        <div><strong>Helper offline</strong><span>Start the native helper to rip media.</span></div>
        <sp-button id="start-helper" size="s" variant="secondary">Start helper</sp-button>
      </aside>`;
  }

  private renderDependencyBanner(): string {
    const missing = this.helperInfo?.dependencies.filter((dependency) => !dependency.available) ?? [];
    if (!missing.length) return "";
    return `
      <aside class="system-banner error" role="alert">
        <span class="banner-icon">${this.icon("warning")}</span>
        <div><strong>${missing.map((item) => item.name).join(" and ")} unavailable</strong><span>Set the executable location in Integrations.</span></div>
        <button class="text-button" data-view="settings">Fix</button>
      </aside>`;
  }

  private renderDownloadView(): string {
    return `
      <section class="download-view">
        <div class="url-composer ${this.analysisState === "error" ? "invalid" : ""}" id="url-dropzone">
          <input id="url-input" type="url" spellcheck="false" autocomplete="off" value="${escapeHtml(this.url)}"
            aria-label="Media URL" placeholder="Paste a media URL..." />
          ${this.url ? `<div id="clear-url" class="clear-button" role="button" tabindex="0" aria-label="Clear URL">${this.icon("close")}</div>` : ""}
          <div id="rip-button" class="rip-button" role="button" tabindex="0" aria-disabled="${this.analysisState === "loading" || this.connection !== "connected"}">
            ${this.analysisState === "loading" ? "Ripping..." : "Rip"}
          </div>
        </div>
        ${this.analysisState === "error" ? `<div class="composer-hint"><span>${escapeHtml(this.analysisError)}</span></div>` : ""}
        ${this.analysisState === "loading" ? this.renderSkeleton() : ""}
        ${this.metadata ? this.renderMediaWorkspace() : this.renderEmptyCanvas()}
        ${this.download ? this.renderDownloadProgress() : ""}
      </section>`;
  }

  private renderEmptyCanvas(): string {
    if (this.analysisState === "loading") return "";
    return `
      <div class="empty-canvas" aria-hidden="true">
        <div class="empty-rings"><span>${this.icon("download")}</span></div>
        <p>Your media details will appear here</p>
        <span>Paste a supported link, then press Rip</span>
      </div>`;
  }

  private renderSkeleton(): string {
    return `
      <div class="media-card skeleton-card" aria-label="Ripping media">
        <div class="skeleton thumbnail-skeleton"></div>
        <div class="skeleton-copy"><div class="skeleton line wide"></div><div class="skeleton line mid"></div><div class="skeleton line short"></div></div>
      </div>`;
  }

  private renderMediaWorkspace(): string {
    const media = this.metadata!;
    const formats: Array<[string, string]> = this.kind === "video"
      ? [["best", "Best available"], ["mp4", "MP4"], ["mov", "MOV"], ["mkv", "MKV"], ["original", "Original"]]
      : [["wav", "WAV"], ["mp3", "MP3"], ["flac", "FLAC"], ["original", "Original"]];
    const qualities = this.kind === "video"
      ? ["Best", "2160p", "1440p", "1080p", "720p", "480p", "360p"]
      : ["Best", "320 kbps", "256 kbps", "192 kbps", "160 kbps", "128 kbps"];
    const binOptions: Array<[string, string]> = this.context.bins.length
      ? this.context.bins.map((bin) => [bin.id, `${"· ".repeat(bin.depth)}${bin.name}`])
      : [["", "Project root"]];
    const codecWarning = this.videoCodecWarning();

    return `
      <div class="workspace-grid">
        <article class="media-card">
          <div class="thumbnail-wrap">
            ${media.thumbnailUrl ? `<img src="${escapeHtml(media.thumbnailUrl)}" alt="" />` : `<div class="thumbnail-fallback">${this.icon("film")}</div>`}
            <span class="duration-chip">${formatDuration(media.durationSeconds)}</span>
            <span class="platform-chip">${escapeHtml(media.platform)}</span>
          </div>
          <div class="media-copy">
            <span class="media-kicker">Ready to download</span>
            <h2>${escapeHtml(media.title)}</h2>
            <p>${escapeHtml(media.uploader)}</p>
            <div class="metadata-row">
              <span>${formatDate(media.uploadDate)}</span>
              <i aria-hidden="true">·</i>
              <span>${escapeHtml(media.resolutions[0] ?? "Best")}</span>
              <i aria-hidden="true">·</i>
              <span>${formatBytes(media.estimatedBytes)}</span>
            </div>
          </div>
        </article>
        ${codecWarning ? `<aside class="codec-warning" role="alert"><span class="codec-warning-icon">!</span><div class="codec-warning-copy"><strong>Premiere compatibility warning</strong><span><b>${escapeHtml(codecWarning.codec)}</b> video is likely for this selection. ${escapeHtml(codecWarning.message)}</span><label class="codec-warning-toggle toggle-control"><input id="transcode-premiere" type="checkbox" ${this.transcodeForPremiere ? "checked" : ""} /><span aria-hidden="true"></span><em>Convert to Premiere-ready H.264/AAC automatically</em></label></div></aside>` : ""}

        <section class="options-card">
          <div class="section-heading"><div><h3>Download setup</h3></div><span class="step-number">01</span></div>
          <div class="segmented-control" role="radiogroup" aria-label="Media type">
            <div role="radio" tabindex="0" aria-checked="${this.kind === "video"}" data-kind="video" class="segment-option ${this.kind === "video" ? "active" : ""}">Video</div>
            <div role="radio" tabindex="0" aria-checked="${this.kind === "audio"}" data-kind="audio" class="segment-option ${this.kind === "audio" ? "active" : ""}">Audio</div>
          </div>
          <div class="field-grid">
            <div class="field"><span>Format</span>${this.customSelect("format-select", "Format", this.format, formats)}</div>
            <div class="field"><span>Quality</span>${this.customSelect("quality-select", "Quality", this.quality, qualities.map((value) => [value, value]))}</div>
          </div>
          <div class="field filename-field">
            <span>File name <em>Optional</em></span>
            <input id="filename-input" maxlength="160" spellcheck="false" autocomplete="off" value="${escapeHtml(this.customFileName)}" placeholder="Leave blank to use the filename template" />
          </div>
          <div class="field destination-field">
            <span>Destination</span>
            <div class="path-control"><input id="destination-input" value="${escapeHtml(this.destination)}" placeholder="Choose a destination folder" /><div id="browse-folder" class="browse-button" role="button" tabindex="0" title="Choose folder">Browse</div></div>
          </div>
          ${this.renderPresets()}
        </section>

        <section class="premiere-card">
          <div class="premiere-header">
            <div class="premiere-logo" aria-hidden="true">Pr</div>
            <div class="premiere-copy">
              <span class="media-kicker">Adobe Premiere</span>
              <h3>${this.context.projectName ? escapeHtml(this.context.projectName) : "No project detected"}</h3>
              <p>${this.context.projectName ? "Import directly into your active project" : "Open a project to enable automatic import"}</p>
            </div>
          </div>
          <div class="field bin-field"><span>Target bin</span>${this.customSelect("bin-select", "Target bin", this.binId, binOptions, !this.context.projectName)}</div>
          <label class="toggle-control labeled"><input id="auto-import" type="checkbox" ${this.autoImport ? "checked" : ""} /><span aria-hidden="true"></span><em>Auto import</em></label>
        </section>

        ${this.isDownloadActive() ? '<div class="download-lock-indicator" role="status">Download in progress · controls locked</div>' : ""}
        <div class="download-action-row">
          <div class="legal-note">${this.icon("shield")}Only download media you own or are authorized to use.</div>
          <div id="download-button" class="download-primary" role="button" tabindex="0" aria-disabled="${!this.destination || this.connection !== "connected" || Boolean(this.download && !["completed", "failed", "cancelled"].includes(this.download.status))}">
            Download &amp; ${this.autoImport ? "Import" : "Save"}
          </div>
        </div>
      </div>`;
  }

  /**
   * yt-dlp's `bestvideo` selector can choose a codec that is wrapped in a
   * perfectly valid MP4/MOV file but is still a poor Premiere interchange
   * choice. Rank the analyzed formats the same way a user-selected quality is
   * normally resolved, then warn when the highest-quality candidates include
   * AV1 or an otherwise unknown video codec.
   */
  private videoCodecWarning(): CodecWarning | undefined {
    if (!this.metadata || this.kind !== "video") return undefined;
    const allVideoFormats = this.metadata.formats.filter((format) => {
      const codec = format.videoCodec?.trim();
      return Boolean(codec && codec.toLowerCase() !== "none");
    });
    const heightLimit = this.quality.toLowerCase() === "best"
      ? undefined
      : Number.parseInt(this.quality, 10);
    const constrainedFormats = allVideoFormats.filter((format) => {
      return heightLimit === undefined || !Number.isFinite(heightLimit) || format.height === undefined || format.height <= heightLimit;
    });
    // The helper uses a `/best` fallback if no stream exists at the requested
    // height. Mirror that fallback so an AV1-only source is still warned.
    const formats = constrainedFormats.length ? constrainedFormats : allVideoFormats;
    if (!formats.length) return undefined;

    const highestHeight = Math.max(...formats.map((format) => format.height ?? 0));
    const likelyCandidates = formats.filter((format) => (format.height ?? 0) === highestHeight);
    const codecFamily = (codec: string | undefined): string => {
      const normalized = (codec ?? "").trim().toLowerCase();
      return normalized.split(/[.\-_\s]/, 1)[0] ?? "";
    };
    const av1 = likelyCandidates.find((format) => {
      const family = codecFamily(format.videoCodec);
      return family === "av01" || family === "av1";
    });
    if (av1) {
      return {
        codec: "AV1 / AV01",
        message: "Premiere may not import or play AV1 reliably. Choose a quality with H.264/AVC when available, or transcode the finished file to H.264 before importing.",
      };
    }

    const knownPremiereCodecs = new Set(["avc1", "avc3", "h264", "hev1", "hvc1", "hevc", "h265", "prores", "apcn", "apch", "apcs", "apco", "ap4h", "dnxhd", "dnxhr"]);
    const unknown = likelyCandidates.find((format) => !knownPremiereCodecs.has(codecFamily(format.videoCodec)));
    if (unknown) {
      return {
        codec: unknown.videoCodec ?? "Unknown",
        message: "This codec is not in Rippr's known Premiere-safe set. Use H.264/AVC for the most dependable import, or transcode before importing.",
      };
    }
    return undefined;
  }

  /** Estimate the output size for the currently selected media type, format and quality. */
  private estimatedDownloadBytes(): number | undefined {
    const metadata = this.metadata;
    if (!metadata) return undefined;
    const duration = metadata.durationSeconds;
    const validSize = (size: number | undefined): size is number => Boolean(size && Number.isFinite(size) && size > 0);
    const audioFormats = metadata.formats.filter((format) => {
      const codec = format.audioCodec?.trim().toLowerCase();
      return Boolean(codec && codec !== "none");
    });

    if (this.kind === "audio") {
      if (duration && this.format === "wav") return Math.round(duration * 44_100 * 2 * 2);
      if (duration && this.quality.toLowerCase() !== "best") {
        const bitrate = Number.parseFloat(this.quality);
        if (Number.isFinite(bitrate) && bitrate > 0) return Math.round(duration * bitrate * 1000 / 8);
      }
      const bestAudio = audioFormats
        .filter((format) => validSize(format.estimatedBytes))
        .sort((left, right) => (right.estimatedBytes ?? 0) - (left.estimatedBytes ?? 0))[0];
      return bestAudio?.estimatedBytes ?? metadata.estimatedBytes;
    }

    const allVideo = metadata.formats.filter((format) => {
      const codec = format.videoCodec?.trim().toLowerCase();
      return Boolean(codec && codec !== "none");
    });
    const heightLimit = this.quality.toLowerCase() === "best" ? undefined : Number.parseInt(this.quality, 10);
    const constrained = allVideo.filter((format) => heightLimit === undefined || !Number.isFinite(heightLimit) || format.height === undefined || format.height <= heightLimit);
    const candidates = constrained.length ? constrained : allVideo;
    const selectedVideo = candidates
      .filter((format) => validSize(format.estimatedBytes))
      .sort((left, right) => ((right.height ?? 0) - (left.height ?? 0)) || ((right.estimatedBytes ?? 0) - (left.estimatedBytes ?? 0)))[0];
    if (!selectedVideo?.estimatedBytes) return metadata.estimatedBytes;

    let estimate = selectedVideo.estimatedBytes;
    const hasAudio = Boolean(selectedVideo.audioCodec && selectedVideo.audioCodec.toLowerCase() !== "none");
    if (!hasAudio) {
      const audioSize = audioFormats
        .filter((format) => validSize(format.estimatedBytes))
        .reduce((largest, format) => Math.max(largest, format.estimatedBytes ?? 0), 0);
      estimate += audioSize;
    }
    // Remuxing between MP4/MOV/MKV keeps the stream size roughly unchanged.
    // H.264 conversion is reported separately while it is running.
    return estimate;
  }

  private renderPresets(): string {
    if (!this.settings.folderPresets.length) return "";
    return `<div class="preset-row" aria-label="Quick folders">
      ${this.settings.folderPresets.map((preset) => `<div class="preset-chip ${this.destination === preset.path ? "active" : ""}" data-preset="${preset.id}" role="button" tabindex="0" title="${escapeHtml(preset.path)}">${escapeHtml(preset.name)}</div>`).join("")}
    </div>`;
  }

  private renderDownloadProgress(): string {
    const progress = this.download!;
    const percent = Math.max(0, Math.min(100, progress.percent ?? 0));
    const terminal = ["completed", "failed", "cancelled"].includes(progress.status);
    const converting = /conver|premiere-ready/i.test(progress.message ?? "");
    const expectedBytes = converting ? progress.totalBytes : this.estimatedDownloadBytes() ?? progress.totalBytes;
    const progressValue = `${formatBytes(progress.downloadedBytes)} / ${formatBytes(expectedBytes)}`;
    const detailLabel = converting ? "Codec" : "Format";
    const detailValue = converting ? "H.264/AAC" : this.format.toUpperCase();
    const importFailed = progress.status === "completed" && this.importState === "failed";
    const finished = progress.status === "completed" && (!this.autoImport || this.importState === "completed");
    const statusIcon = progress.status === "failed" || importFailed ? "warning" : finished ? "check" : "download";
    return `
      <section class="progress-card ${progress.status} import-${this.importState} ${finished ? "finished" : ""}">
        <div class="progress-topline">
          <div class="progress-state"><span>${this.icon(statusIcon)}</span><div><strong id="download-status-label">${this.progressTitle(progress)}</strong><small>${escapeHtml(progress.message ?? this.metadata?.title ?? "Media")}</small></div></div>
          <span class="progress-percent">${Math.round(percent)}%</span>
        </div>
        <div class="progress-track" role="progressbar" aria-label="Download progress" aria-labelledby="download-status-label" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}">
          <div class="progress-fill" style="width: ${percent}%"></div>
        </div>
        <div class="progress-bottom">
          <div class="progress-metrics">
            <span class="progress-metric"><small>Downloaded</small><strong>${progressValue}</strong></span>
            <span class="progress-metric"><small>${detailLabel}</small><strong>${detailValue}</strong></span>
            <span class="progress-metric"><small>Time left</small><strong>${progress.etaSeconds !== undefined ? `${progress.etaSeconds}s` : "-"}</strong></span>
          </div>
          ${!terminal ? `<button id="cancel-download" class="cancel-button">Cancel</button>` : ""}
        </div>
      </section>`;
  }

  private progressTitle(progress: DownloadProgress): string {
    if (progress.status === "completed" && this.autoImport) {
      if (this.importState === "importing") return "Importing into Premiere";
      if (this.importState === "completed") return "Downloaded and imported";
      if (this.importState === "failed") return "Downloaded; import failed";
    }
    const titles: Record<DownloadProgress["status"], string> = {
      queued: "Queued",
      downloading: "Downloading",
      processing: "Making it edit-ready",
      completed: "Download complete",
      cancelled: "Download cancelled",
      failed: "Download failed",
    };
    return titles[progress.status];
  }

  private renderHistoryView(): string {
    return `
      <section class="subview history-view">
        <div class="subview-title history-title">
          <div><h1>Download history</h1><p>Everything you have brought into Premiere with Rippr.</p></div>
          ${this.history.length ? `<button id="clear-history" class="text-button danger">Clear history</button>` : ""}
        </div>
        <div id="history-results">${this.history.length ? `<div class="history-list">${this.history.map((entry) => this.renderHistoryEntry(entry)).join("")}</div>` : this.renderEmptyHistory()}</div>
      </section>`;
  }

  private renderHistoryEntry(entry: HistoryEntry): string {
    return `
      <article class="history-item">
        <div class="history-thumb">${entry.thumbnailUrl ? `<img src="${escapeHtml(entry.thumbnailUrl)}" alt="" />` : this.icon("film")}</div>
        <div class="history-body">
          <div class="history-copy"><h3>${escapeHtml(entry.title)}</h3><p>${formatDate(entry.completedAt)} · ${escapeHtml(entry.format.toUpperCase())} · ${escapeHtml(entry.quality)}</p><span>${escapeHtml(entry.destination)}</span></div>
        </div>
        <div class="history-actions">
          <button data-open-file="${escapeHtml(entry.id)}" title="Open file" aria-label="Open file">${this.icon("play")}</button>
          <button data-open-folder="${escapeHtml(entry.id)}" title="Find in folder" aria-label="Find in folder">${this.icon("folder")}</button>
        </div>
      </article>`;
  }

  private renderEmptyHistory(): string {
    return `<div class="empty-state"><span>${this.icon("history")}</span><h2>No downloads yet</h2><p>Completed downloads will collect here.</p><button class="primary-native" data-view="download">Start a download</button></div>`;
  }

  private renderSettingsView(): string {
    return `
      <section class="subview settings-view">
        <div class="subview-title settings-title"><div><span class="eyebrow"><span></span>Preferences</span><h1>Settings</h1></div><span class="version-badge">v${escapeHtml(this.helperInfo?.version ?? "1.0.0")}</span></div>
        <div class="settings-stack">
          ${this.settingsSection("Behavior", `
            ${this.settingToggle("Remember last destination", "Use the most recent folder next time", "setting-remember-destination", this.settings.rememberLastDestination)}
            ${this.settingToggle("Monitor clipboard", "Offer to rip copied media links", "setting-clipboard", this.settings.clipboardMonitoring)}
          `)}
          ${this.settingsSection("Downloads", `
            ${this.settingNumberSelect("Simultaneous files", "How many downloads Rippr may process at once", "setting-concurrent", this.settings.concurrentDownloads, 1, 6)}
            ${this.settingNumberSelect("Retry attempts", "How many times a failed transfer is retried", "setting-retries", this.settings.retryCount, 0, 10)}
            ${this.settingToggle("Use temporary conversion files", "Stage originals outside the destination, then remove them after conversion", "setting-temp-conversion", this.settings.useTempConversionSource)}
            ${this.settingInput("Filename template", "setting-template", this.settings.namingTemplate, "%(title)s [%(resolution)s]", "Tokens: %(title)s, %(uploader)s, %(upload_date)s, %(resolution)s")}
            <p class="settings-intro">Filename safety: Windows-invalid title characters are replaced with safe equivalents when Rippr creates the output filename. Custom filenames use underscores for unsafe characters.</p>
          `)}
          ${this.settingsSection("Quick folders", `
            <p class="settings-intro">Use the up and down arrows to reorder presets. Paths stay absolute so external-drive availability can be checked before every download.</p>
            <div class="preset-manager">${this.settings.folderPresets.length ? this.settings.folderPresets.map((preset) => this.renderPresetManagerRow(preset)).join("") : '<div class="preset-empty"><strong>No quick folders yet</strong><span>Add only the destinations you actually use.</span></div>'}</div>
            <div class="settings-actions"><button id="add-preset" class="secondary-native">Add folder</button></div>
          `)}
          ${this.settingsSection("Integrations", `
            ${this.renderIntegration("yt-dlp", "setting-ytdlp", this.settings.ytDlpPath ?? "")}
            ${this.renderIntegration("FFmpeg", "setting-ffmpeg", this.settings.ffmpegPath ?? "")}
            <button id="check-dependencies" class="secondary-native">Check integrations</button>
          `)}
          ${this.settingsSection("Updates", `
            <div class="update-row"><div><strong>yt-dlp</strong><span>Update site compatibility without reinstalling Rippr.</span></div><button data-update-dependency="yt-dlp" class="secondary-native">Update</button></div>
            <div class="update-row"><div><strong>FFmpeg</strong><span>Check the configured binary and show update guidance.</span></div><button data-update-dependency="ffmpeg" class="secondary-native">Check</button></div>
          `)}
        </div>
        <div class="about-launcher">
          <button id="about-plugin-button" class="secondary-native" aria-expanded="${this.aboutOpen}">${this.aboutOpen ? "Close about Rippr" : "About Rippr"}</button>
        </div>
        ${this.aboutOpen ? this.renderAboutPanel() : ""}
      </section>`;
  }

  private renderAboutPanel(): string {
    return `
      <section class="about-panel" aria-label="About Rippr">
        <div class="about-panel-heading">
          <div>
            <span class="eyebrow"><span></span>About</span>
            <img class="about-logo" src="./rippr-logo.png" alt="Rippr" />
          </div>
          <span class="about-version">v${escapeHtml(this.helperInfo?.version ?? "1.0.0")}</span>
        </div>
        <p class="about-lede">A focused media workflow for Adobe Premiere Pro.</p>
        <p>Rippr analyzes authorized media links, downloads edit-ready video or audio, and can place the finished file directly into your active Premiere project.</p>
        <div class="about-facts">
          <div><strong>Created by</strong><span>ZOJI</span></div>
          <div><strong>Built for</strong><span>Adobe Premiere Pro 25.6+</span></div>
          <div><strong>Powered by</strong><span>yt-dlp and FFmpeg</span></div>
        </div>
        <p class="about-note">The native helper runs locally on your computer. Only download media you own or are authorized to use.</p>
      </section>`;
  }

  private settingsSection(title: string, content: string): string {
    return `<section class="settings-card"><header><h2>${title}</h2></header><div class="settings-content">${content}</div></section>`;
  }

  private settingToggle(title: string, detail: string, id: string, checked: boolean): string {
    return `<div class="setting-row"><div><strong>${title}</strong><span>${detail}</span></div><label class="toggle-control" aria-label="${escapeHtml(title)}"><input id="${id}" type="checkbox" ${checked ? "checked" : ""} /><span aria-hidden="true"></span></label></div>`;
  }

  private settingInput(label: string, id: string, value: string, placeholder: string, hint?: string): string {
    return `<label class="setting-field"><span>${label}</span><input id="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</label>`;
  }

  private settingNumberSelect(title: string, detail: string, id: string, value: number, min: number, max: number): string {
    const options = Array.from({ length: max - min + 1 }, (_, index) => index + min);
    return `<div class="setting-row select-row"><div><strong>${title}</strong><span>${detail}</span></div>${this.customSelect(id, title, String(value), options.map((option) => [String(option), String(option)]), false, true)}</div>`;
  }

  private customSelect(
    id: string,
    label: string,
    value: string,
    options: Array<[string, string]>,
    disabled = false,
    compact = false,
  ): string {
    const open = this.openDropdownId === id && !disabled;
    const selectedLabel = options.find(([optionValue]) => optionValue === value)?.[1] ?? options[0]?.[1] ?? "";
    return `<div class="custom-select ${compact ? "compact" : ""} ${open ? "open" : ""} ${disabled ? "disabled" : ""}" data-custom-select="${escapeHtml(id)}">
      <div class="custom-select-trigger" role="combobox" tabindex="${disabled ? "-1" : "0"}" aria-label="${escapeHtml(label)}" aria-haspopup="listbox" aria-expanded="${open}" aria-disabled="${disabled}" data-dropdown-trigger="${escapeHtml(id)}">
        <span>${escapeHtml(selectedLabel)}</span><i class="custom-select-chevron" aria-hidden="true"></i>
      </div>
      ${open ? `<div class="custom-select-menu" role="listbox" aria-label="${escapeHtml(label)} options">
        ${options.map(([optionValue, optionLabel]) => `<div class="custom-select-option ${optionValue === value ? "selected" : ""}" role="option" tabindex="0" aria-selected="${optionValue === value}" data-dropdown-id="${escapeHtml(id)}" data-dropdown-value="${escapeHtml(optionValue)}">${escapeHtml(optionLabel)}</div>`).join("")}
      </div>` : ""}
    </div>`;
  }

  private renderIntegration(name: "yt-dlp" | "FFmpeg", id: string, value: string): string {
    const dependencyName = name.toLocaleLowerCase() as DependencyStatus["name"];
    const dependency = this.helperInfo?.dependencies.find((item) => item.name === dependencyName);
    const status = dependency?.available ? `Ready${dependency.version ? ` · ${dependency.version}` : ""}` : "Not found";
    return `<label class="integration-row"><span class="integration-meta"><strong>${name}</strong><em class="${dependency?.available ? "ok" : "missing"}">${escapeHtml(status)}</em></span><input id="${id}" class="integration-path" value="${escapeHtml(value)}" placeholder="Auto-detect from PATH or bundled tools" /></label>`;
  }

  private renderPresetManagerRow(preset: FolderPreset): string {
    const renaming = this.renamingPresetId === preset.id;
    const presetIndex = this.settings.folderPresets.findIndex((item) => item.id === preset.id);
    const canMoveUp = presetIndex > 0;
    const canMoveDown = presetIndex >= 0 && presetIndex < this.settings.folderPresets.length - 1;
    return `<div class="preset-manager-row" data-preset-row="${preset.id}">
      <div class="preset-order" aria-label="Reorder ${escapeHtml(preset.name)}">
        <button class="preset-order-button" data-move-preset="${preset.id}" data-direction="up" ${canMoveUp ? "" : "disabled"} title="Move up" aria-label="Move ${escapeHtml(preset.name)} up">${this.icon("up")}</button>
        <button class="preset-order-button" data-move-preset="${preset.id}" data-direction="down" ${canMoveDown ? "" : "disabled"} title="Move down" aria-label="Move ${escapeHtml(preset.name)} down">${this.icon("down")}</button>
      </div>
      <div class="preset-copy">${renaming ? `<input id="preset-rename-${preset.id}" class="preset-name-input" value="${escapeHtml(preset.name)}" aria-label="Quick folder name" />` : `<strong>${escapeHtml(preset.name)}</strong>`}<small>${escapeHtml(preset.path)}</small></div>
      <div class="preset-actions">${renaming ? `<button class="preset-text-action" data-save-preset="${preset.id}">Save</button><button class="preset-text-action" data-cancel-preset="${preset.id}">Cancel</button>` : `<button class="preset-text-action" data-rename-preset="${preset.id}">Rename</button><button class="preset-text-action danger preset-delete-button" data-delete-preset="${preset.id}" title="Remove folder" aria-label="Remove ${escapeHtml(preset.name)}">${this.icon("trash")}</button>`}</div>
    </div>`;
  }

  private renderToasts(): string {
    if (!this.toasts.length) return "";
    return `<div class="toast-stack" aria-live="assertive">${this.toasts.map((toast) => `<div class="toast ${toast.tone}" data-toast="${toast.id}"><span>${this.icon(toast.tone === "success" ? "check" : toast.tone === "error" ? "warning" : "info")}</span><div><strong>${escapeHtml(toast.title)}</strong>${toast.message ? `<small>${escapeHtml(toast.message)}</small>` : ""}</div><button data-dismiss-toast="${toast.id}" aria-label="Dismiss">${this.icon("close")}</button></div>`).join("")}</div>`;
  }

  private bindEvents(): void {
    const shell = this.root.querySelector<HTMLElement>(".app-shell");
    if (shell && this.isDownloadActive() && this.view === "download") {
      const blockWhileDownloading = (event: Event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest?.("#cancel-download, [data-view]")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      ["pointerdown", "mousedown", "click", "keydown", "input", "change", "drop", "dragover"].forEach((type) => {
        shell.addEventListener(type, blockWhileDownloading, true);
      });
    }
    this.root.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
      const openView = () => {
        this.openDropdownId = undefined;
        this.view = button.dataset.view as View;
        this.render(true);
      };
      button.addEventListener("click", openView);
      if (button.getAttribute("role") === "button") button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openView();
      });
    });
    this.root.querySelector("#start-helper")?.addEventListener("click", () => void this.startHelper());
    this.bindDownloadEvents();
    this.bindHistoryEvents();
    this.bindSettingsEvents();
    this.bindDropdownEvents();
    this.root.querySelectorAll<HTMLElement>("[data-dismiss-toast]").forEach((button) => button.addEventListener("click", () => this.dismissToast(button.dataset.dismissToast!)));
  }

  private bindDownloadEvents(): void {
    const input = this.root.querySelector<HTMLInputElement>("#url-input");
    input?.addEventListener("input", () => { this.url = input.value.trim(); });
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.analyze();
    });
    input?.addEventListener("paste", (event) => {
      // UXP hosts have differed in how they apply a paste over a selection.
      // Apply the selected-range replacement ourselves when clipboardData is
      // available, so pasting a new URL never appends to the old one.
      const pasted = event.clipboardData?.getData("text")?.trim();
      if (!pasted) {
        window.setTimeout(() => {
          this.url = input.value.trim();
          if (isSupportedUrl(this.url)) void this.analyze();
        }, 0);
        return;
      }
      event.preventDefault();
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const nextValue = `${input.value.slice(0, start)}${pasted}${input.value.slice(end)}`;
      input.value = nextValue;
      this.url = nextValue.trim();
      const caret = start + pasted.length;
      input.setSelectionRange?.(caret, caret);
      if (isSupportedUrl(this.url)) void this.analyze();
    });
    this.bindPressable(this.root.querySelector<HTMLElement>("#clear-url"), () => {
      this.url = "";
      this.metadata = undefined;
      this.customFileName = "";
      this.analysisState = "idle";
      this.download = undefined;
      this.importState = "idle";
      this.render(true);
    });
    this.bindPressable(this.root.querySelector<HTMLElement>("#rip-button"), () => void this.analyze());
    const dropzone = this.root.querySelector<HTMLElement>("#url-dropzone");
    dropzone?.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("dragging"); });
    dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
    dropzone?.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragging");
      const value = event.dataTransfer?.getData("text/uri-list") || event.dataTransfer?.getData("text/plain") || "";
      if (value) { this.url = value.trim(); void this.analyze(); }
    });
    this.root.querySelectorAll<HTMLElement>("[data-kind]").forEach((button) => this.bindPressable(button, () => {
        this.kind = button.dataset.kind as MediaKind;
        this.format = this.kind === "video" ? this.settings.defaultVideoFormat : this.settings.defaultAudioFormat;
        this.quality = this.kind === "video" ? this.settings.defaultVideoQuality : this.settings.defaultAudioQuality;
        this.openDropdownId = undefined;
        this.render();
      }));
    this.listenValue("#destination-input", (value) => { this.destination = value; });
    const filenameInput = this.root.querySelector<HTMLInputElement>("#filename-input");
    filenameInput?.addEventListener("input", () => { this.customFileName = filenameInput.value; });
    this.root.querySelector<HTMLInputElement>("#transcode-premiere")?.addEventListener("change", (event) => {
      this.transcodeForPremiere = (event.currentTarget as HTMLInputElement).checked;
    });
    this.bindPressable(this.root.querySelector<HTMLElement>("#browse-folder"), () => void this.chooseFolder());
    this.root.querySelectorAll<HTMLElement>("[data-preset]").forEach((button) => this.bindPressable(button, () => {
      const preset = this.settings.folderPresets.find((item) => item.id === button.dataset.preset);
      if (preset) { this.destination = preset.path; this.render(); }
    }));
    this.root.querySelector("#auto-import")?.addEventListener("change", (event) => {
      this.autoImport = (event.currentTarget as HTMLInputElement).checked;
      void this.saveSettings({ autoImport: this.autoImport });
      this.render();
    });
    this.bindPressable(this.root.querySelector<HTMLElement>("#download-button"), () => void this.startDownload());
    this.root.querySelector("#cancel-download")?.addEventListener("click", () => void this.cancelDownload());
  }

  private bindPressable(element: HTMLElement | null, action: () => void): void {
    if (!element) return;
    const trigger = () => {
      if (element.getAttribute("aria-disabled") === "true") return;
      action();
    };
    element.addEventListener("click", trigger);
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      trigger();
    });
  }

  private isDownloadActive(): boolean {
    return Boolean(this.download && !["completed", "failed", "cancelled"].includes(this.download.status));
  }

  private bindDropdownEvents(): void {
    this.root.querySelectorAll<HTMLElement>("[data-dropdown-trigger]").forEach((trigger) => this.bindPressable(trigger, () => {
      const id = trigger.dataset.dropdownTrigger!;
      this.openDropdownId = this.openDropdownId === id ? undefined : id;
      this.render();
    }));
    this.root.querySelectorAll<HTMLElement>("[data-dropdown-value]").forEach((option) => this.bindPressable(option, () => {
      const id = option.dataset.dropdownId!;
      const value = option.dataset.dropdownValue ?? "";
      this.openDropdownId = undefined;
      if (id === "format-select") this.format = value;
      if (id === "quality-select") this.quality = value;
      if (id === "bin-select") {
        this.binId = value;
        void this.saveSettings({ lastPremiereBinId: value });
      }
      if (id === "setting-concurrent") void this.saveSettings({ concurrentDownloads: Number(value) });
      if (id === "setting-retries") void this.saveSettings({ retryCount: Number(value) });
      this.render();
    }));
    this.root.querySelector<HTMLElement>(".app-shell")?.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.openDropdownId) return;
      event.preventDefault();
      this.openDropdownId = undefined;
      this.render();
    });
  }

  private bindHistoryEvents(): void {
    this.root.querySelector("#clear-history")?.addEventListener("click", () => void this.clearHistory());
    this.bindHistoryResultEvents(this.root);
  }

  private bindHistoryResultEvents(scope: ParentNode): void {
    scope.querySelectorAll<HTMLElement>("[data-open-file]").forEach((button) => button.addEventListener("click", () => void this.openHistoryPath(button.dataset.openFile!, false)));
    scope.querySelectorAll<HTMLElement>("[data-open-folder]").forEach((button) => button.addEventListener("click", () => void this.openHistoryPath(button.dataset.openFolder!, true)));
    const start = scope.querySelector<HTMLElement>('[data-view="download"]');
    this.bindPressable(start, () => {
      this.view = "download";
      this.render(true);
    });
  }

  private bindSettingsEvents(): void {
    this.listenToggle("#setting-remember-destination", (checked) => void this.saveSettings({ rememberLastDestination: checked }));
    this.listenToggle("#setting-clipboard", (checked) => { void this.saveSettings({ clipboardMonitoring: checked }).then(() => this.configureClipboardMonitoring()); });
    this.listenToggle("#setting-temp-conversion", (checked) => void this.saveSettings({ useTempConversionSource: checked }));
    this.listenValue("#setting-template", (value) => void this.saveSettings({ namingTemplate: value }));
    this.listenValue("#setting-ytdlp", (value) => void this.saveSettings({ ytDlpPath: value || undefined }));
    this.listenValue("#setting-ffmpeg", (value) => void this.saveSettings({ ffmpegPath: value || undefined }));
    this.root.querySelector("#check-dependencies")?.addEventListener("click", () => void this.checkDependencies());
    this.root.querySelector("#about-plugin-button")?.addEventListener("click", () => {
      this.aboutOpen = !this.aboutOpen;
      this.render();
    });
    this.root.querySelector("#add-preset")?.addEventListener("click", () => void this.addPreset());
    this.root.querySelectorAll<HTMLElement>("[data-delete-preset]").forEach((button) => button.addEventListener("click", () => void this.deletePreset(button.dataset.deletePreset!)));
    this.root.querySelectorAll<HTMLElement>("[data-rename-preset]").forEach((button) => button.addEventListener("click", () => this.beginPresetRename(button.dataset.renamePreset!)));
    this.root.querySelectorAll<HTMLElement>("[data-save-preset]").forEach((button) => button.addEventListener("click", () => void this.savePresetRename(button.dataset.savePreset!)));
    this.root.querySelectorAll<HTMLElement>("[data-cancel-preset]").forEach((button) => button.addEventListener("click", () => this.cancelPresetRename()));
    if (this.renamingPresetId) {
      const input = this.root.querySelector<HTMLInputElement>(`#preset-rename-${this.renamingPresetId}`);
      input?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void this.savePresetRename(this.renamingPresetId!);
        if (event.key === "Escape") this.cancelPresetRename();
      });
    }
    this.root.querySelectorAll<HTMLElement>("[data-move-preset]").forEach((button) => button.addEventListener("click", () => {
      if (button.hasAttribute("disabled")) return;
      void this.movePreset(button.dataset.movePreset!, button.dataset.direction === "up" ? -1 : 1);
    }));
    this.root.querySelectorAll<HTMLElement>("[data-update-dependency]").forEach((button) => button.addEventListener("click", () => void this.updateDependency(button.dataset.updateDependency!)));
  }

  private listenValue(selector: string, listener: (value: string) => void): void {
    const element = this.root.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
    element?.addEventListener("change", () => listener(element.value));
  }

  private listenToggle(selector: string, listener: (checked: boolean) => void): void {
    this.root.querySelector(selector)?.addEventListener("change", (event) => listener((event.currentTarget as HTMLInputElement).checked));
  }

  private async analyze(): Promise<void> {
    this.url = this.root.querySelector<HTMLInputElement>("#url-input")?.value.trim() || this.url;
    if (!isSupportedUrl(this.url)) {
      this.analysisState = "error";
      this.analysisError = "Paste a complete http or https media URL.";
      this.render();
      return;
    }
    this.analysisState = "loading";
    this.analysisError = undefined;
    this.metadata = undefined;
    this.customFileName = "";
    this.transcodeForPremiere = true;
    this.download = undefined;
    this.importState = "idle";
    this.render();
    try {
      this.metadata = await this.helper.request<MediaMetadata>("analyze", { url: this.url });
      this.analysisState = "ready";
      this.render();
    } catch (error) {
      this.analysisState = "error";
      this.analysisError = this.errorMessage(error);
      this.notifyError(error, "Could not rip that link", false);
      this.render();
    }
  }

  private async chooseFolder(): Promise<void> {
    const folder = await this.premiere.pickFolder();
    if (!folder) return;
    this.destination = folder.path;
    if (this.settings.rememberLastDestination) await this.saveSettings({ defaultFolder: folder.path });
    this.render();
  }

  private async startDownload(): Promise<void> {
    if (!this.metadata || !this.destination) return;
    const codecWarning = this.videoCodecWarning();
    if (codecWarning) {
      if (this.transcodeForPremiere) {
        this.pushToast("info", "Premiere conversion enabled", "Rippr will re-encode this video as H.264/AAC MP4 before importing it.");
      } else {
        this.pushToast("warning", "Original codec selected", `${codecWarning.codec} may not import or play reliably in Premiere.`);
      }
    }
    const folder = await this.helper.request<{ exists: boolean; writable: boolean; disconnected: boolean }>("folder_status", { path: this.destination });
    if (folder.disconnected) {
      this.pushToast("error", "Destination unavailable", "Reconnect the external drive or choose another folder.");
      return;
    }
    if (!folder.exists) {
      await this.helper.request("create_folder", { path: this.destination });
      this.pushToast("info", "Folder created", this.destination);
    }
    if (!folder.writable && folder.exists) {
      this.pushToast("error", "Folder is read-only", "Choose a destination where Rippr can write files.");
      return;
    }

    const request: DownloadRequest = {
      url: this.url,
      metadata: this.metadata,
      kind: this.kind,
      format: this.format as DownloadRequest["format"],
      quality: this.quality,
      destination: this.destination,
      fileName: this.customFileName.trim() || undefined,
      namingTemplate: this.settings.namingTemplate,
      transcodeForPremiere: Boolean(codecWarning && this.transcodeForPremiere),
    };
    try {
      const result = await this.helper.request<{ jobId: string }>("start_download", request);
      this.download = { jobId: result.jobId, status: "queued", percent: 0 };
      this.importState = "idle";
      if (this.settings.rememberLastDestination) void this.saveSettings({ defaultFolder: this.destination });
      this.render();
    } catch (error) {
      this.notifyError(error, "Download could not start");
    }
  }

  private async cancelDownload(): Promise<void> {
    if (!this.download) return;
    await this.helper.request("cancel_download", { jobId: this.download.jobId });
  }

  private async handleProgress(progress: DownloadProgress): Promise<void> {
    if (this.download && progress.jobId !== this.download.jobId) return;
    const previous = this.download?.jobId === progress.jobId ? this.download : undefined;
    const conversionPhase = /conver|premiere-ready/i.test(progress.message ?? "");
    const conversionFailure = progress.status === "failed" && conversionPhase;
    const preserveDownloadMetrics = progress.status !== "processing" && !conversionFailure;
    const totalBytes = progress.totalBytes
      ?? (preserveDownloadMetrics ? previous?.totalBytes ?? this.metadata?.estimatedBytes : undefined);
    const downloadedBytes = progress.downloadedBytes
      ?? (preserveDownloadMetrics && progress.status === "completed" ? totalBytes : undefined)
      ?? (preserveDownloadMetrics ? previous?.downloadedBytes : undefined);
    const measuredPercent = downloadedBytes !== undefined && totalBytes
      ? (downloadedBytes / totalBytes) * 100
      : undefined;
    // Download byte totals describe the source transfer, but conversion reports
    // its own timeline percentage. Never let the completed transfer overwrite
    // the conversion progress bar or its ETA.
    const reportedPercent = progress.status === "processing"
      ? (progress.percent ?? previous?.percent)
      : measuredPercent ?? progress.percent ?? (conversionFailure ? undefined : previous?.percent);
    const percent = progress.status === "completed"
      ? 100
      : progress.status === "processing"
        ? Math.min(99, reportedPercent ?? 99)
        : reportedPercent;
    this.download = { ...progress, percent, downloadedBytes, totalBytes };
    if (progress.status === "completed" && progress.filePath && this.autoImport) this.importState = "importing";
    this.render();
    if (progress.status === "completed" && progress.filePath) {
      if (this.autoImport) {
        try {
          const result = await this.premiere.importFile(progress.filePath, this.binId, this.settings.autoCreateBin ? "Rippr Downloads" : undefined);
          if (!result.imported) throw new Error("Premiere did not accept the downloaded file.");
          this.importState = "completed";
          if (result.placedInRequestedBin) {
            this.pushToast("success", "Ready in Premiere", "The downloaded file was added to your project.");
          } else {
            this.pushToast("warning", "Ready in Premiere", "Imported to the project root because the selected bin was unavailable.");
          }
        } catch (error) {
          this.importState = "failed";
          this.notifyError(error, "Downloaded, but import failed");
        }
      } else {
        this.pushToast("success", "Download complete", progress.filePath);
      }
      this.history = await this.helper.request<HistoryEntry[]>("get_history");
      this.render();
    } else if (progress.status === "failed") {
      this.pushToast("error", "Download failed", progress.message);
    }
  }

  private async clearHistory(): Promise<void> {
    await this.helper.request("clear_history");
    this.history = [];
    this.pushToast("success", "History cleared");
    this.render();
  }

  private async openHistoryPath(id: string, folder: boolean): Promise<void> {
    const entry = this.history.find((item) => item.id === id);
    if (!entry) return;
    await this.helper.request(folder ? "reveal_path" : "open_file", { path: entry.filePath });
  }

  private async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    try {
      this.settings = await this.helper.request<AppSettings>("update_settings", patch);
    } catch (error) {
      this.notifyError(error, "Settings were not saved");
    }
  }

  private async checkDependencies(): Promise<void> {
    try {
      const dependencies = await this.helper.request<DependencyStatus[]>("check_dependencies");
      this.helperInfo = { ...(this.helperInfo ?? { version: "1.0.0", protocolVersion: 1, platform: "unknown", dependencies: [] }), dependencies };
      this.pushToast(dependencies.every((item) => item.available) ? "success" : "warning", dependencies.every((item) => item.available) ? "Integrations ready" : "Some integrations need attention");
      this.render();
    } catch (error) {
      this.notifyError(error, "Integration check failed");
    }
  }

  private async updateDependency(name: string): Promise<void> {
    try {
      const result = await this.helper.request<{ message: string }>("update_dependency", { name });
      this.pushToast("success", `${name} checked`, result.message);
      await this.checkDependencies();
    } catch (error) {
      this.notifyError(error, `${name} could not be updated`);
    }
  }

  private async addPreset(): Promise<void> {
    const folder = await this.premiere.pickFolder();
    if (!folder) return;
    const preset: FolderPreset = { id: crypto.randomUUID(), name: folder.name, path: folder.path };
    await this.saveSettings({ folderPresets: [...this.settings.folderPresets, preset] });
    this.render();
  }

  private async deletePreset(id: string): Promise<void> {
    await this.saveSettings({ folderPresets: this.settings.folderPresets.filter((preset) => preset.id !== id) });
    this.render();
  }

  private beginPresetRename(id: string): void {
    this.renamingPresetId = id;
    this.render();
    const input = this.root.querySelector<HTMLInputElement>(`#preset-rename-${id}`);
    input?.focus();
    input?.select();
  }

  private cancelPresetRename(): void {
    this.renamingPresetId = undefined;
    this.render();
  }

  private async savePresetRename(id: string): Promise<void> {
    const input = this.root.querySelector<HTMLInputElement>(`#preset-rename-${id}`);
    const name = input?.value.trim();
    if (!name) {
      input?.focus();
      return;
    }
    await this.saveSettings({ folderPresets: this.settings.folderPresets.map((item) => item.id === id ? { ...item, name } : item) });
    this.renamingPresetId = undefined;
    this.render();
  }

  private async movePreset(id: string, direction: -1 | 1): Promise<void> {
    const presets = [...this.settings.folderPresets];
    const index = presets.findIndex((preset) => preset.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= presets.length) return;
    const current = presets[index];
    const adjacent = presets[target];
    if (!current || !adjacent) return;
    presets[index] = adjacent;
    presets[target] = current;
    await this.saveSettings({ folderPresets: presets });
    this.render();
  }

  private async startHelper(): Promise<void> {
    try {
      await this.premiere.launchHelper();
      window.setTimeout(() => this.helper.connect(), 800);
    } catch (error) {
      this.notifyError(error, "Could not start the helper");
    }
  }

  private configureClipboardMonitoring(): void {
    if (this.clipboardTimer) window.clearInterval(this.clipboardTimer);
    if (!this.settings.clipboardMonitoring) return;
    this.clipboardTimer = window.setInterval(() => void this.pollClipboard(), 3000);
  }

  private async pollClipboard(): Promise<void> {
    const value = await this.premiere.readClipboard();
    if (!value || value === this.url || !isSupportedUrl(value)) return;
    this.url = value;
    this.view = "download";
    this.pushToast("info", "Link detected", "Rippr added it to the URL field.");
    this.render();
  }

  private installKeyboardShortcuts(): void {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "Enter") { event.preventDefault(); void this.analyze(); }
      if (event.key.toLowerCase() === "d" && this.metadata) { event.preventDefault(); void this.startDownload(); }
    };
    window.addEventListener("keydown", handler);
    this.unlisten.push(() => window.removeEventListener("keydown", handler));
  }

  private pushToast(tone: Toast["tone"], title: string, message?: string): void {
    const toast: Toast = { id: crypto.randomUUID(), tone, title, message };
    this.toasts = [...this.toasts.slice(-2), toast];
    this.render();
    window.setTimeout(() => this.dismissToast(toast.id), 5000);
  }

  private dismissToast(id: string): void {
    if (!this.toasts.some((toast) => toast.id === id)) return;
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
    this.render();
  }

  private notifyError(error: unknown, title: string, rerender = true): void {
    console.error(title, error);
    this.toasts = [...this.toasts.slice(-2), { id: crypto.randomUUID(), tone: "error", title, message: this.errorMessage(error) }];
    if (rerender) this.render();
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      const withRpc = error as Error & { rpcError?: { action?: string } };
      return withRpc.rpcError?.action ? `${error.message} ${withRpc.rpcError.action}` : error.message;
    }
    return String(error);
  }

  private icon(name: string, slot = false): string {
    const slotAttribute = slot ? ' slot="icon"' : "";
    const rasterIcons: Record<string, string> = {
      play: "iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABGElEQVQ4y5WUMU7DQBBF/9pOAQ0hEg13oKBA4SpcACFxFDgAl+AG1Ig7UKeKEpo04IRH4TEZFo8XvmTJ8u68/TM74yQToEgpJZVURbGSan/I2EERqJaEpJ2kxqBF1x7UB8wkPUo6l7Q1aPNnd0CyTUfAlk53wKF9r4C6B4VABzoGluy1AK5c8MTt/Q1zi1PgzSDvDvgEnDlAMwjLHK0t+BPYAa0D3rt0/wXq5WEL4MbVLEV9NKRaUmvvp5IuJU1Kxc4dfTg3L8CFSytFqU0dqHWwFXCdFfv79iJHK37qAZg5B3E/ZQ25McAzMI+uvNSQJ8ArcJsBqjHA0EAe2LO29UrdAO+DBn4rY5PdqBvaUUAJlNRNfRHQ6wud8h2J9VjXXgAAAABJRU5ErkJggg==",
      folder: "iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABOklEQVQ4y52UO0pEQRBFT795fkBEQV2EmLsEMXURrsBAmNC9COIODNyAmYmJmJkpg4GozOg7BlZj2848PxeKbqqqb1VXVXdSKZCYjq9O6btbW5HIP5Eio0zSAKtAV2Qn8BBBpwV7A0RNKiFn6ot6r47UO/VVPSp8pkkqr7YH7MR+oYq6DzyHPmeUgBvgGOgy44EfGIdMChnbj1MV1EX11r/jUn2M/XYLLAHzke55pD7oaZDAHHAInMT51TY69BZOQ+Dilx1fAZZj3+Vi51Znw1xB/m1kwtaUo9BWTvlwFzKLCKp5aitlKtbUQ2Rtr4leq3VWsQEmNVETAh/Po41C9tVoAqwXukF+a1fAJjDi6zv7CWuxbubJ3lWf/jGUqkOVpDaRxQawxeyvpNYPgFvgGj6/kUFPTX5CA3TvbhhLB9NPJmgAAAAASUVORK5CYII=",
      trash: "iVBORw0KGgoAAAANSUhEUgAAABIAAAASBAMAAACk4JNkAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAeUExURQAAAP81Rf81Rf81Rf81Rf81Rf81Rf81Rf81Rf///6+dyZwAAAAIdFJOUwAdj62QnM5DJVoYXwAAAAFiS0dECfHZpewAAAAHdElNRQfqBxIFICScd9PYAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA3LTE4VDA1OjMyOjM2KzAwOjAwrYHUwwAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wNy0xOFQwNTozMjozNiswMDowMNzcbH8AAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDctMThUMDU6MzI6MzYrMDA6MDCLyU2gAAAATklEQVQI12NgYGAQUlISYAADjY4OBQgLJgakQUAALAcCQHkhCxDDCCSv4aSk5AHWohEkIBQBYWUoABGZLIQpcJMrQLYVgFjsQJeoMzAAAKCGGWcSoVFHAAAAAElFTkSuQmCC",
    };
    if (rasterIcons[name]) {
      return `<img class="history-action-icon"${slotAttribute} src="data:image/png;base64,${rasterIcons[name]}" alt="" aria-hidden="true" />`;
    }
    const glyphs: Record<string, string> = {
      rip: "R", download: "↓", history: "↺", settings: "⚙", link: "↗", close: "×", spark: "+",
      bolt: "!", warning: "!", film: "V", audio: "A", calendar: "·", layers: "·", drive: "·",
      folder: "F", music: "A", wave: "~", shield: "!", activity: "·", check: "✓", search: "?",
      play: ">", repeat: "↻", sliders: "=", plug: "+", refresh: "↻", plus: "+", grip: "::",
      up: "↑", down: "↓", edit: "/", trash: "×", info: "i",
    };
    return `<span class="ui-icon"${slotAttribute} aria-hidden="true">${glyphs[name] ?? "·"}</span>`;
  }
}
