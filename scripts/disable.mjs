import { loadManifest } from "../lib/manifest.mjs";
import { fail, runCli } from "../lib/cli.mjs";
import { loadState, removeState } from "../lib/state.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { removePlugin } from "../lib/plugin.mjs";
import { revertPatch } from "../lib/patch.mjs";
import { inspectWorktree } from "../lib/repo.mjs";

await runCli("disable", async (options) => {
  const manifest = await loadManifest();
  const state = await loadState(manifest.stateFile);
  const target = await detectOpencodeTarget({
    compat: manifest.compat,
    opencodeRoot: options.opencodeRoot || state?.opencode?.root,
  });

  if (!target.supported) {
    fail({ message: target.message }, 2);
  }

  const patchPath = state?.patch?.path || manifest.patchPathFor(target.version);
  if (!patchPath) {
    fail(
      {
        message: `No existe patch para deshabilitar OpenCode ${target.version}`,
      },
      2,
    );
  }

  const worktree = inspectWorktree(target.root);
  if (!worktree.ok) {
    fail({ message: worktree.message }, 2);
  }
  if (!options.dryRun && !worktree.clean) {
    fail(
      {
        message:
          "El checkout de OpenCode no está limpio; no es seguro deshabilitar el addon automáticamente.",
        details: worktree.entries.slice(0, 10),
      },
      3,
    );
  }

  const patchResult = await revertPatch(target.root, patchPath, {
    dryRun: options.dryRun,
  });
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
      ? `Dry run OK para deshabilitar sobre ${target.root}`
      : `Addon deshabilitado sobre ${target.root}`,
    details: [
      `patch: ${patchResult.state}`,
      `plugin: ${pluginResult.state}`,
      `worktree: ${worktree.clean ? "clean" : "dirty (dry-run allowed)"}`,
      pluginResult.state === "modified"
        ? "el plugin instalado fue modificado manualmente y no se eliminó"
        : "plugin revertido de forma segura",
    ],
  };
});
