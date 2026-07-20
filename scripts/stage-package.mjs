import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "dist", "package");
const pluginDist = join(root, "plugin", "dist");
const targets = ["macos-arm64", "macos-x64", "windows-x64"];

await assertFile(join(pluginDist, "manifest.json"), "Run pnpm build:plugin first.");
await mkdir(stage, { recursive: true });
await cp(pluginDist, stage, { recursive: true });
await cp(join(root, "shared", "protocol.schema.json"), join(stage, "protocol.schema.json"));

for (const target of targets) {
  const source = join(root, "vendor", target);
  const output = join(stage, "vendor", target);
  await assertFile(join(source, target === "windows-x64" ? "rippr-helper.exe" : "rippr-helper"), `Missing ${target} helper binary.`);
  await mkdir(output, { recursive: true });
  await cp(source, output, { recursive: true });
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(join(stage, "versions.json"), JSON.stringify({ rippr: packageJson.version, protocol: 1, builtAt: new Date().toISOString() }, null, 2));
console.log(`Staged UXP package at ${stage}`);

async function assertFile(path, message) {
  try { if (!(await stat(path)).isFile()) throw new Error(); }
  catch { throw new Error(`${message} Expected ${path}`); }
}

