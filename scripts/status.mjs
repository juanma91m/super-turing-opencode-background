import { loadManifest } from "../lib/manifest.mjs";
import { runCli } from "../lib/cli.mjs";
import { loadState } from "../lib/state.mjs";
import { inspectPlugin } from "../lib/plugin.mjs";
import { inspectPatch } from "../lib/patch.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { inspectWorktree } from "../lib/repo.mjs";
import { resolveCompatibleMode } from "../lib/compat.mjs";
import { inspectManagedLocalInstallRoot } from "../lib/local-install.mjs";

await runCli("status", async (options) => {
  const manifest = await loadManifest();
  const state = await loadState(manifest.stateFile);
  const target = await detectOpencodeTarget({
    compat: manifest.compat,
    opencodeRoot: options.opencodeRoot,
    installRoot: options.installRoot,
  });
  const requestedInstallRoot = options.installRoot || target.installRoot;
  const managedLocalInstall = requestedInstallRoot
    ? await inspectManagedLocalInstallRoot(requestedInstallRoot, state)
    : {
        adopted: false,
        candidateManaged: false,
        stateActive: false,
        health: "inactive",
        restoreAvailable: false,
        drift: false,
        problems: [],
      };
  const activeManagedInstall =
    managedLocalInstall.candidateManaged ||
    (state?.mode === "managed-local-install" &&
      state?.managedLocalInstall?.installRoot === requestedInstallRoot)
      ? managedLocalInstall
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
  const plugins = await Promise.all(
    manifest.plugins.map(async (plugin) => ({
      plugin,
      status: await inspectPlugin(
        plugin.sourcePath,
        plugin.installedPath,
      ),
    })),
  );
  const plugin = plugins[0]?.status;
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
  const managedStorage = managedLocalInstall.storage;
  const managedStorageBackupRoot =
    state?.managedLocalInstall?.storageBackupRoot;
  const managedHealth = managedLocalInstall.candidateManaged
    ? managedLocalInstall.health
    : mode.id === "managed-local-install"
      ? "available"
      : "inactive";

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
    plugins,
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
      `plugins: ${plugins.map(({ plugin, status }) => `${plugin.manifest.id}=${status.state}`).join(", ")}`,
      `patch: ${patch.state}`,
      `compat version: ${supportedVersion ? "ok" : "unsupported"}`,
      `mode: ${mode.id}`,
      `worktree: ${worktree.ok ? (worktree.message === "not_required" ? "not_required" : worktree.clean ? "clean" : "dirty") : "n/a"}`,
      `managed-local-install: ${managedHealth}`,
      ...(managedLocalInstall.problems?.length
        ? [`managed-local-install problems: ${managedLocalInstall.problems.join(", ")}`]
        : []),
      managedStorage?.dbPath
        ? `session db: ${managedStorage.dbPath}`
        : "session db: unresolved",
      managedStorageBackupRoot
        ? `storage backup: ${managedStorageBackupRoot}`
        : "storage backup: n/a",
    ],
  };
});
