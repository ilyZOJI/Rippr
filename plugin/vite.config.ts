import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  optimizeDeps: {
    exclude: ["uxp", "premierepro"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL("./src/main.ts", import.meta.url)),
      name: "RipprPlugin",
      formats: ["iife"],
      fileName: () => "index.js",
      cssFileName: "style",
    },
    rollupOptions: {
      external: ["uxp", "premierepro"],
    },
  },
});
