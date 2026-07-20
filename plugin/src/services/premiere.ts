export interface PremiereBin {
  id: string;
  name: string;
  depth: number;
}

export interface PremiereContext {
  available: boolean;
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  bins: PremiereBin[];
  insertionBinId?: string;
}

export interface PremiereImportResult {
  imported: boolean;
  placedInRequestedBin: boolean;
}

function isUxpHost(): boolean {
  try {
    return typeof require === "function" && Boolean(require("uxp"));
  } catch {
    return false;
  }
}

export class PremiereService {
  readonly available = isUxpHost();
  private activatedProjectId?: string;

  async getContext(): Promise<PremiereContext> {
    if (!this.available) {
      return {
        available: false,
        projectName: "Aurora Campaign.prproj",
        bins: [
          { id: "root", name: "Project Root", depth: 0 },
          { id: "footage", name: "Footage", depth: 1 },
          { id: "downloads", name: "Rippr Downloads", depth: 1 },
        ],
        insertionBinId: "downloads",
      };
    }

    try {
      const ppro = require("premierepro");
      const project = await this.getCurrentProject(ppro);
      if (!project) return { available: true, bins: [] };
      const root = await project.getRootItem();
      const insertionBin = await project.getInsertionBin();
      const bins: PremiereBin[] = [];
      await this.collectBins(ppro, root, bins, 0);
      return {
        available: true,
        projectId: project.guid ? String(project.guid) : undefined,
        projectName: project.name,
        projectPath: project.path,
        bins,
        insertionBinId: insertionBin?.getId?.(),
      };
    } catch (error) {
      console.error("Unable to read Premiere project context", error);
      return { available: true, bins: [] };
    }
  }

  watchProjectChanges(listener: () => void): () => void {
    if (!this.available) return () => undefined;
    const ppro = require("premierepro");
    const projectEvents = ppro.Constants?.ProjectEvent;
    if (!ppro.EventManager?.addGlobalEventListener || !projectEvents) return () => undefined;

    const onActivated = (event?: { id?: string }) => {
      this.activatedProjectId = event?.id ? String(event.id) : undefined;
      listener();
    };
    const onOpened = () => listener();
    const onClosed = (event?: { id?: string }) => {
      if (!event?.id || String(event.id) === this.activatedProjectId) this.activatedProjectId = undefined;
      listener();
    };
    const subscriptions: Array<[unknown, (event?: { id?: string }) => void]> = [
      [projectEvents.ACTIVATED, onActivated],
      [projectEvents.OPENED, onOpened],
      [projectEvents.CLOSED, onClosed],
    ];

    subscriptions.forEach(([eventName, handler]) => ppro.EventManager.addGlobalEventListener(eventName, handler, true));
    return () => subscriptions.forEach(([eventName, handler]) => ppro.EventManager.removeGlobalEventListener(eventName, handler));
  }

  async importFile(filePath: string, binId?: string, createBinName?: string): Promise<PremiereImportResult> {
    if (!this.available) return { imported: true, placedInRequestedBin: true };
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.importFileOnce(filePath, binId, createBinName);
      } catch (error) {
        lastError = error;
        if (!this.isInvalidScriptObject(error) || attempt === 1) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
    }
    throw lastError;
  }

  private async importFileOnce(filePath: string, binId?: string, createBinName?: string): Promise<PremiereImportResult> {
    const ppro = require("premierepro");
    const project = await this.getCurrentProject(ppro);
    if (!project) throw new Error("Open a Premiere project before importing media.");
    const root = await project.getRootItem();
    const rootProjectItem = ppro.ProjectItem.cast(root);
    const rootSelected = !binId || rootProjectItem.getId() === binId;
    const existingIds = new Set<string>((await root.getItems()).map((item: { getId(): string }) => item.getId()));

    // Keep the UXP bridge call to its two primitive arguments. Passing a
    // FolderItem, or explicit undefined values for optional arguments, causes
    // "Illegal Parameter type" in some Premiere builds.
    const imported = await this.importIntoRoot(ppro, project, filePath, existingIds);
    if (!imported) return { imported: false, placedInRequestedBin: false };
    if (rootSelected) return { imported: true, placedInRequestedBin: true };

    // Import succeeded. Any bin-placement failure must not turn that success
    // into a failed import (or trigger a retry that creates a duplicate clip).
    try {
      return {
        imported: true,
        placedInRequestedBin: await this.moveNewRootItem(ppro, filePath, existingIds, binId, createBinName),
      };
    } catch (error) {
      console.warn("Media was imported to the project root but could not be moved to the requested bin", error);
      return { imported: true, placedInRequestedBin: false };
    }
  }

  private async importIntoRoot(ppro: any, project: any, filePath: string, existingIds: Set<string>): Promise<boolean> {
    try {
      return await project.importFiles([String(filePath)], true);
    } catch (error) {
      if (!this.isIllegalParameterType(error)) throw error;

      // Some Premiere versions require all optional bridge arguments. First
      // verify that the rejected call did not add media, then retry with the
      // root converted to the exact ProjectItem type declared by the API.
      const refreshedProject = await this.getCurrentProject(ppro);
      if (!refreshedProject) throw new Error("The Premiere project was closed before import finished.");
      const refreshedRoot = await refreshedProject.getRootItem();
      if (await this.findImportedRootItem(ppro, refreshedRoot, filePath, existingIds)) return true;
      return refreshedProject.importFiles([String(filePath)], true, ppro.ProjectItem.cast(refreshedRoot), false);
    }
  }

  private async moveNewRootItem(
    ppro: any,
    filePath: string,
    existingIds: Set<string>,
    binId: string,
    createBinName?: string,
  ): Promise<boolean> {
    let project = await this.getCurrentProject(ppro);
    if (!project) return false;
    let root = await project.getRootItem();
    let target = await this.findBin(ppro, root, binId);

    if (!target && createBinName) {
      project.lockedAccess(() => {
        project.executeTransaction((compound: { addAction(action: unknown): void }) => {
          compound.addAction(root.createBinAction(createBinName, true));
        }, `Create ${createBinName} bin`);
      });

      // Premiere invalidates DOM wrappers after a transaction. Resolve every
      // object again before creating the move action.
      project = await this.getCurrentProject(ppro);
      if (!project) return false;
      root = await project.getRootItem();
      target = await this.findBinByName(ppro, root, createBinName);
    }

    if (!target) return false;
    const importedItem = await this.findImportedRootItem(ppro, root, filePath, existingIds);
    if (!importedItem) return false;

    project.lockedAccess(() => {
      project.executeTransaction((compound: { addAction(action: unknown): void }) => {
        compound.addAction(root.createMoveItemAction(importedItem, target));
      }, "Move imported media");
    });
    return true;
  }

  private async findImportedRootItem(ppro: any, root: any, filePath: string, existingIds: Set<string>): Promise<any | undefined> {
    const candidates = (await root.getItems()).filter((item: { getId(): string; type: number }) =>
      !existingIds.has(item.getId()) && item.type !== ppro.ProjectItem.TYPE_BIN && item.type !== ppro.ProjectItem.TYPE_ROOT
    );
    for (const item of candidates) {
      if (item.type !== ppro.ProjectItem.TYPE_CLIP && item.type !== ppro.ProjectItem.TYPE_FILE) continue;
      try {
        const clip = ppro.ClipProjectItem.cast(item);
        if (this.samePath(await clip.getMediaFilePath(), filePath)) return item;
      } catch { /* Some imported ProjectItem types do not cast to ClipProjectItem. */ }
    }
    return candidates[0];
  }

  private samePath(left: string, right: string): boolean {
    const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/$/, "").toLocaleLowerCase();
    return normalize(left) === normalize(right);
  }

  private isInvalidScriptObject(error: unknown): boolean {
    return String(error instanceof Error ? error.message : error).toLocaleLowerCase().includes("script object is no longer valid");
  }

  private isIllegalParameterType(error: unknown): boolean {
    return String(error instanceof Error ? error.message : error).toLocaleLowerCase().includes("illegal parameter type");
  }

  private async getCurrentProject(ppro: any): Promise<any | undefined> {
    const activatedProjectId = this.activatedProjectId;
    this.activatedProjectId = undefined;
    if (activatedProjectId && ppro.Project.getProject) {
      try {
        const guid = ppro.Guid?.fromString ? ppro.Guid.fromString(activatedProjectId) : activatedProjectId;
        const activated = ppro.Project.getProject(guid);
        if (activated) return activated;
      } catch { /* Fall back to Premiere's current active-project lookup. */ }
    }
    return ppro.Project.getActiveProject();
  }

  async pickFolder(): Promise<{ path: string; name: string } | undefined> {
    if (!this.available) return { path: "/Users/editor/Projects/Aurora/Footage", name: "Footage" };
    const { localFileSystem } = require("uxp").storage;
    const folder = await localFileSystem.getFolder();
    if (!folder) return undefined;
    return { path: folder.nativePath, name: folder.name };
  }

  async readClipboard(): Promise<string | undefined> {
    try {
      // Premiere UXP exposes clipboard data through getContent(). Keep the
      // browser readText() fallback for the browser preview/mock runtime.
      const clipboard = navigator.clipboard as unknown as {
        getContent?: () => Promise<Record<string, unknown>>;
        readText?: () => Promise<string>;
      };
      if (typeof clipboard.getContent === "function") {
        const content = await clipboard.getContent();
        const text = content?.["text/plain"];
        if (typeof text === "string" && text.trim()) return text.trim();
      }
      if (typeof clipboard.readText === "function") {
        return (await clipboard.readText()).trim() || undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async exportJson(filename: string, value: unknown): Promise<void> {
    const contents = JSON.stringify(value, null, 2);
    if (!this.available) {
      const blob = new Blob([contents], { type: "application/json" });
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(anchor.href);
      return;
    }
    const { localFileSystem, types } = require("uxp").storage;
    const file = await localFileSystem.getFileForSaving(filename, { types: [types?.file ?? "json"] });
    if (file) await file.write(contents);
  }

  async importJson<T>(): Promise<T | undefined> {
    if (!this.available) {
      return new Promise<T | undefined>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) return resolve(undefined);
          void file.text().then((text) => resolve(JSON.parse(text) as T), reject);
        };
        input.click();
      });
    }
    const { localFileSystem } = require("uxp").storage;
    const file = await localFileSystem.getFileForOpening({ types: ["json"] });
    if (!file) return undefined;
    return JSON.parse(await file.read()) as T;
  }

  async launchHelper(): Promise<void> {
    if (!this.available) return;
    const { shell, storage } = require("uxp");
    const os = require("os");
    const pluginFolder = await storage.localFileSystem.getPluginFolder();
    const platform = os.platform();
    const arch = os.arch();
    const relative = platform === "win32"
      ? "vendor/windows-x64/rippr-helper.exe"
      : arch === "arm64"
        ? "vendor/macos-arm64/rippr-helper"
        : "vendor/macos-x64/rippr-helper";
    const separator = platform === "win32" ? "\\" : "/";
    const helperPath = `${pluginFolder.nativePath}${separator}${relative.replaceAll("/", separator)}`;
    const result = await shell.openPath(helperPath, "Start the Rippr media helper");
    if (result) throw new Error(result);
  }

  private async collectBins(ppro: any, folder: any, bins: PremiereBin[], depth: number): Promise<void> {
    const projectItem = ppro.ProjectItem.cast(folder);
    bins.push({ id: projectItem.getId(), name: projectItem.name || "Project Root", depth });
    const items = await folder.getItems();
    for (const item of items) {
      if (item.type !== ppro.ProjectItem.TYPE_BIN && item.type !== ppro.ProjectItem.TYPE_ROOT) continue;
      await this.collectBins(ppro, ppro.FolderItem.cast(item), bins, depth + 1);
    }
  }

  private async findBin(ppro: any, folder: any, id: string): Promise<any | undefined> {
    if (ppro.ProjectItem.cast(folder).getId() === id) return folder;
    const items = await folder.getItems();
    for (const item of items) {
      if (item.type !== ppro.ProjectItem.TYPE_BIN && item.type !== ppro.ProjectItem.TYPE_ROOT) continue;
      const match = await this.findBin(ppro, ppro.FolderItem.cast(item), id);
      if (match) return match;
    }
    return undefined;
  }

  private async findBinByName(ppro: any, folder: any, name: string): Promise<any | undefined> {
    const items = await folder.getItems();
    const match = items.find((item: { name: string; type: number }) => item.type === ppro.ProjectItem.TYPE_BIN && item.name === name);
    return match ? ppro.FolderItem.cast(match) : undefined;
  }
}
