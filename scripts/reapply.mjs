import { loadManifest } from "../lib/manifest.mjs";
import { fail, runCli } from "../lib/cli.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { installPlugin } from "../lib/plugin.mjs";
import { applyPatch } from "../lib/patch.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { sha256File } from "../lib/hash.mjs";
import { ensureCompatibleMode } from "../lib/compat.mjs";
import { inspectWorktree } from "../lib/repo.mjs";

await runCli("reapply", async (options) => {
  const manifest = await loadManifest();
  const previousState = await loadState(manifest.stateFile);
  const target = await detectOpencodeTarget({
    compat: manifest.compat,
    opencodeRoot: options.opencodeRoot || previousState?.opencode?.root,
  });
  const mode = ensureCompatibleMode(manifest, target);
  if (mode.id === "managed-local-install") {
    fail(
      {
        message:
          "Para instalaciones locales administradas usá adopt-local-install si necesitás re-adoptar el takeover en lugar de reapply.",
      },
      2,
    );
  }
  const targetLabel = target.root || target.execPath || target.method;
  const worktree =
    mode.patchRequired && target.root
      ? inspectWorktree(target.root)
      : { ok: true, clean: true, entries: [] };

  if (mode.patchRequired) {
    if (!target.root) {
      fail(
        {
          message:
            "El modo patched-source-checkout requiere un root fuente válido.",
        },
        2,
      );
    }
    if (!worktree.ok) {
      fail({ message: worktree.message }, 2);
    }
  }

  const pluginResult = await installPlugin(
    manifest.pluginSourcePath,
    manifest.installedPluginPath,
    {
      dryRun: options.dryRun,
    },
  );

  if (pluginResult.state === "modified") {
    fail(
      {
        message:
          "El plugin instalado fue modificado manualmente; el addon no lo sobreescribe automáticamente.",
        details: [manifest.installedPluginPath],
      },
      3,
    );
  }

  const patchResult = mode.patchRequired
    ? await applyPatch(target.root, mode.patchPath, {
        dryRun: options.dryRun,
      })
    : { changed: false, state: "not_required" };

  const state = {
    addonId: manifest.addon.id,
    addonVersion: manifest.addon.version,
    channel: manifest.addon.channel,
    mode: mode.id,
    reapplyAt: new Date().toISOString(),
    dryRun: options.dryRun,
    opencode: {
      root: target.root,
      version: target.version,
      method: target.method,
      supportLevel: mode.supportLevel,
    },
    patch: {
      path: mode.patchPath,
      sha256: mode.patchPath ? await sha256File(mode.patchPath) : undefined,
      state: patchResult.state,
    },
    plugin: {
      sourcePath: manifest.pluginSourcePath,
      installedPath: manifest.installedPluginPath,
      sourceHash: await sha256File(manifest.pluginSourcePath),
      installedHash: pluginResult.installedHash || pluginResult.sourceHash,
      state: pluginResult.state,
    },
  };

  if (!options.dryRun) await saveState(manifest.stateFile, state);

  return {
    message: options.dryRun
      ? `Dry run OK para reapply sobre ${targetLabel}`
      : `Addon re-aplicado sobre ${targetLabel}`,
    details: [
      `mode: ${mode.id}`,
      `plugin: ${pluginResult.state}`,
      `patch: ${patchResult.state}`,
      `version: ${target.version}`,
      `worktree: ${mode.patchRequired ? (worktree.clean ? "clean" : options.dryRun ? "dirty (dry-run allowed)" : "dirty (patch state validated)") : "not_required"}`,
    ],
  };
});
