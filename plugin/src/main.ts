import "@spectrum-web-components/button/sp-button.js";
import "@spectrum-web-components/theme/sp-theme.js";
import "@spectrum-web-components/theme/theme-dark.js";
import "@spectrum-web-components/theme/scale-medium.js";
import "@fontsource/oxanium/latin-400.css";
import "@fontsource/oxanium/latin-600.css";
import "@fontsource/oxanium/latin-700.css";
import "@fontsource/oxanium/latin-800.css";
import "./styles.css";
import { RipprApp } from "./app";
import { createHelperClient } from "./services/helper-client";
import { PremiereService } from "./services/premiere";

let rippr: RipprApp | undefined;

function mount(rootNode: Document | HTMLElement = document): void {
  if (rippr) return;
  const root = rootNode.querySelector<HTMLElement>("#app") ?? document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Rippr could not find its application root.");
  rippr = new RipprApp(root, createHelperClient(), new PremiereService());
  rippr.mount();
}

function unmount(): void {
  rippr?.destroy();
  rippr = undefined;
}

try {
  const { entrypoints } = require("uxp");
  entrypoints.setup({
    plugin: { destroy: unmount },
    panels: {
      "rippr.main": {
        create(rootNode: HTMLElement) { mount(rootNode); },
        show(rootNode: HTMLElement) { mount(rootNode); },
        destroy: unmount,
      },
    },
  });
} catch {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mount());
  else mount();
}
