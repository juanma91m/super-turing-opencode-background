import { loadManifest } from "../lib/manifest.mjs";
import { runCli } from "../lib/cli.mjs";
import { loadState } from "../lib/state.mjs";
import { inspectPlugin } from "../lib/plugin.mjs";
import { inspectPatch } from "../lib/patch.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { inspectWorktree } from "../lib/repo.mjs";
import { resolveCompatibleMode } from "../lib/compat.mjs";
import {
  inspectManagedLocalInstall,
  inspectManagedLocalInstallRoot,
} from "../lib/local-install.mjs";

await runCli("status", async (options) => {
  const manifest = await loadManifest();
  const state = await loadState(manifest.stateFile);
  const target = await detectOpencodeTarget({
    compat: manifest.compat,
    opencodeRoot: options.opencodeRoot,
    installRoot: options.installRoot,
  });
  const requestedInstallRoot = options.installRoot || target.installRoot;
  const activeManagedInstall =
    state?.mode === "managed-local-install" &&
    state?.managedLocalInstall?.installRoot === requestedInstallRoot
      ? state.managedLocalInstall
      : undefined;
  const mode = activeManagedInstall
    ? {
        id: "managed-local-install",
        supported: true,
        supportLevel: "alpha-managed-local-install",
        patchRequired: false,
        requiresCleanWorktree: false,
        requiresCheckoutSource: true,
        patchPath: undefined,
      }
    : resolveCompatibleMode(manifest, target);
  const targetLabel = target.root || target.execPath || target.method;
  const plugin = await inspectPlugin(
    manifest.pluginSourcePath,
    manifest.installedPluginPath,
  );
  const supportedVersion = activeManagedInstall
    ? Boolean(activeManagedInstall.checkoutVersion)
    : mode.supported;
  const patchPath = mode.patchPath;
  const patch =
    mode.patchRequired && target.root && patchPath
      ? await inspectPatch(target.root, patchPath)
      : !mode.patchRequired && mode.supported
        ? { state: "not_required" }
        : { state: "unsupported" };
  const worktree =
    mode.patchRequired && target.root
      ? inspectWorktree(target.root)
      : mode.supported
        ? { ok: true, clean: true, message: "not_required" }
        : { ok: false, clean: false, message: "target unsupported" };
  const managedLocalInstall = options.installRoot
    ? await inspectManagedLocalInstallRoot(options.installRoot, state)
    : await inspectManagedLocalInstall(state);
  const managedStorage = state?.managedLocalInstall?.storage;
  const managedStorageBackupRoot =
    state?.managedLocalInstall?.storageBackupRoot;

  return {
    addon: {
      id: manifest.addon.id,
      version: manifest.addon.version,
      channel: manifest.addon.channel,
    },
    target,
    compatibility: {
      mode: mode.id,
      supportedVersion,
      supportLevel: mode.supportLevel,
      patchRequired: mode.patchRequired,
      patchPath,
    },
    plugin,
    patch,
    worktree,
    managedLocalInstall,
    managedStorage,
    managedStorageBackupRoot,
    state,
    message: mode.supported
      ? `Target compatible detectado en ${targetLabel}`
      : target.message,
    details: [
      `plugin: ${plugin.state}`,
      `patch: ${patch.state}`,
      `compat version: ${supportedVersion ? "ok" : "unsupported"}`,
      `mode: ${mode.id}`,
      `worktree: ${worktree.ok ? (worktree.message === "not_required" ? "not_required" : worktree.clean ? "clean" : "dirty") : "n/a"}`,
      `managed-local-install: ${managedLocalInstall.adopted ? "adopted" : mode.id === "managed-local-install" ? "available" : "inactive"}`,
      managedStorage?.dbPath
        ? `session db: ${managedStorage.dbPath}`
        : "session db: unresolved",
      managedStorageBackupRoot
        ? `storage backup: ${managedStorageBackupRoot}`
        : "storage backup: n/a",
    ],
  };
});
