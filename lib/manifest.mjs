import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveFromAddon,
  resolveInstalledPluginPath,
  resolveStateFile,
} from "./paths.mjs";

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function assertSchemaVersion(name, value, expected) {
  if (value?.schemaVersion !== expected) {
    throw new Error(
      `${name} schemaVersion inválido. esperado=${expected} actual=${value?.schemaVersion ?? "undefined"}`,
    );
  }
}

export async function loadManifest() {
  const addon = await readJson(resolveFromAddon("manifest", "addon.json"));
  const compat = await readJson(resolveFromAddon("manifest", "compat.json"));
  assertSchemaVersion("manifest/addon.json", addon, 1);
  assertSchemaVersion("manifest/compat.json", compat, 1);
  const pluginSourcePath = resolveFromAddon(...addon.plugin.source.split("/"));
  const stateFile = resolveStateFile(addon.state.relativeStateDir);
  const installedPluginPath = resolveInstalledPluginPath(addon.plugin);
  return {
    addon,
    compat,
    pluginSourcePath,
    installedPluginPath,
    stateFile,
    patchPathFor(version) {
      const relative = addon.patches.opencode[version];
      return relative ? resolveFromAddon(...relative.split("/")) : undefined;
    },
    pluginInstallDir() {
      return path.dirname(installedPluginPath);
    },
  };
}
