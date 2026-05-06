import { loadManifest } from "../lib/manifest.mjs";
import { fail, runCli } from "../lib/cli.mjs";
import { loadState, removeState } from "../lib/state.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { removePlugin } from "../lib/plugin.mjs";
import { revertPatch } from "../lib/patch.mjs";
import { inspectWorktree } from "../lib/repo.mjs";
import { ensureCompatibleMode } from "../lib/compat.mjs";

await runCli("disable", async (options) => {
  const manifest = await loadManifest();
  const state = await loadState(manifest.stateFile);
  const target = await detectOpencodeTarget({
    compat: manifest.compat,
    opencodeRoot: options.opencodeRoot || state?.opencode?.root,
  });
  const mode = ensureCompatibleMode(manifest, target);
  if (mode.id === "managed-local-install") {
    fail(
      {
        message:
          "Para instalaciones locales administradas usá restore-local-install en lugar de disable.",
      },
      2,
    );
  }
  const targetLabel = target.root || target.execPath || target.method;
  const patchPath = state?.patch?.path || mode.patchPath;
  const worktree =
    mode.patchRequired && target.root
      ? inspectWorktree(target.root)
      : { ok: true, clean: true, entries: [] };

  if (mode.patchRequired) {
    if (!patchPath) {
      fail(
        {
          message: `No existe patch para deshabilitar OpenCode ${target.version}`,
        },
        2,
      );
    }
    if (!worktree.ok) {
      fail({ message: worktree.message }, 2);
    }
    if (!options.dryRun && mode.requiresCleanWorktree && !worktree.clean) {
      fail(
        {
          message:
            "El checkout de OpenCode no está limpio; no es seguro deshabilitar el addon automáticamente.",
          details: worktree.entries.slice(0, 10),
        },
        3,
      );
    }
  }

  const patchResult = mode.patchRequired
    ? await revertPatch(target.root, patchPath, {
        dryRun: options.dryRun,
      })
    : { changed: false, state: "not_required" };
  const pluginResult = await removePlugin(
    manifest.pluginSourcePath,
    manifest.installedPluginPath,
    state,
    {
      dryRun: options.dryRun,
    },
  );

  if (!options.dryRun && pluginResult.state !== "modified") {
    await removeState(manifest.stateFile);
  }

  return {
    message: options.dryRun
      ? `Dry run OK para deshabilitar sobre ${targetLabel}`
      : `Addon deshabilitado sobre ${targetLabel}`,
    details: [
      `mode: ${mode.id}`,
      `patch: ${patchResult.state}`,
      `plugin: ${pluginResult.state}`,
      `worktree: ${mode.patchRequired ? (worktree.clean ? "clean" : "dirty (dry-run allowed)") : "not_required"}`,
      pluginResult.state === "modified"
        ? "el plugin instalado fue modificado manualmente y no se eliminó"
        : "plugin revertido de forma segura",
    ],
  };
});
