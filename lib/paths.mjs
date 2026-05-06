import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
export const addonRoot = path.resolve(path.dirname(thisFile), "..");

export function expandHome(input) {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolveFromAddon(...segments) {
  return path.join(addonRoot, ...segments);
}

export function resolveStateFile(relativeStateDir) {
  return path.join(
    os.homedir(),
    ".local",
    "state",
    relativeStateDir,
    "state.json",
  );
}

export function resolveInstalledPluginPath(pluginManifest) {
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "plugins",
    pluginManifest.installDirName,
    pluginManifest.installFile,
  );
}
