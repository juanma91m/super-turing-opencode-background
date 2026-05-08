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
  const pluginManifests = Array.isArray(addon.plugins)
    ? addon.plugins
    : addon.plugin
      ? [addon.plugin]
      : [];
  if (pluginManifests.length === 0) {
    throw new Error("manifest/addon.json no define plugins instalables")
  }

  const plugins = pluginManifests.map((plugin) => ({
    manifest: plugin,
    sourcePath: resolveFromAddon(...plugin.source.split("/")),
    installedPath: resolveInstalledPluginPath(plugin),
  }));

  const pluginSourcePath = plugins[0].sourcePath;
  const stateFile = resolveStateFile(addon.state.relativeStateDir);
  const installedPluginPath = plugins[0].installedPath;
  return {
    addon,
    compat,
    plugins,
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
