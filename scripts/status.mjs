import { loadManifest } from "../lib/manifest.mjs";
import { runCli } from "../lib/cli.mjs";
import { loadState } from "../lib/state.mjs";
import { inspectPlugin } from "../lib/plugin.mjs";
import { inspectPatch } from "../lib/patch.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { inspectWorktree } from "../lib/repo.mjs";

await runCli("status", async (options) => {
  const manifest = await loadManifest();
  const state = await loadState(manifest.stateFile);
  const target = await detectOpencodeTarget({
    compat: manifest.compat,
    opencodeRoot: options.opencodeRoot,
  });
  const plugin = await inspectPlugin(
    manifest.pluginSourcePath,
    manifest.installedPluginPath,
  );
  const supportedVersion =
    target.supported && target.version
      ? manifest.compat.opencode.supportedVersions.includes(target.version)
      : false;
  const patchPath =
    target.supported && supportedVersion
      ? manifest.patchPathFor(target.version)
      : undefined;
  const patch =
    target.supported && patchPath
      ? await inspectPatch(target.root, patchPath)
      : { state: "unsupported" };
  const worktree = target.supported
    ? inspectWorktree(target.root)
    : { ok: false, clean: false, message: "target unsupported" };

  return {
    addon: {
      id: manifest.addon.id,
      version: manifest.addon.version,
      channel: manifest.addon.channel,
    },
    target,
    compatibility: {
      supportedVersion,
      supportLevel: manifest.compat.opencode.supportLevel,
      patchPath,
    },
    plugin,
    patch,
    worktree,
    state,
    message: target.supported
      ? `Target soportado detectado en ${target.root}`
      : target.message,
    details: [
      `plugin: ${plugin.state}`,
      `patch: ${patch.state}`,
      `compat version: ${supportedVersion ? "ok" : "unsupported"}`,
      `worktree: ${worktree.ok ? (worktree.clean ? "clean" : "dirty") : "n/a"}`,
    ],
  };
});
