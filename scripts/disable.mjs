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
  }

  const patchResult = mode.patchRequired
    ? await revertPatch(target.root, patchPath, {
        dryRun: options.dryRun,
      })
    : { changed: false, state: "not_required" };
  const pluginResults = await Promise.all(
    manifest.plugins.map(async (plugin) => {
      const pluginState = state?.plugins?.find?.((item) => item.id === plugin.manifest.id) || state?.plugin;
      const result = await removePlugin(
        plugin.sourcePath,
        plugin.installedPath,
        pluginState ? { plugin: pluginState } : state,
        {
          dryRun: options.dryRun,
        },
      );
      return { plugin, result };
    }),
  );

  if (!options.dryRun && !pluginResults.some(({ result }) => result.state === "modified")) {
    await removeState(manifest.stateFile);
  }

  return {
    message: options.dryRun
      ? `Dry run OK para deshabilitar sobre ${targetLabel}`
      : `Addon deshabilitado sobre ${targetLabel}`,
    details: [
      `mode: ${mode.id}`,
      `patch: ${patchResult.state}`,
      `plugins: ${pluginResults.map(({ plugin, result }) => `${plugin.manifest.id}=${result.state}`).join(", ")}`,
      `worktree: ${mode.patchRequired ? (worktree.clean ? "clean" : options.dryRun ? "dirty (dry-run allowed)" : "dirty (patch state validated)") : "not_required"}`,
      pluginResults.some(({ result }) => result.state === "modified")
        ? "alguno de los plugins instalados fue modificado manualmente y no se eliminó"
        : pluginResults.some(({ result }) => result.state === "restored_backup")
          ? "plugin previo restaurado de forma segura"
          : "plugins revertidos de forma segura",
    ],
  };
});
