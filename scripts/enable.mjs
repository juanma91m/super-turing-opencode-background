import { loadManifest } from "../lib/manifest.mjs";
import { fail, runCli } from "../lib/cli.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { installPlugin, removePlugin } from "../lib/plugin.mjs";
import { applyPatch } from "../lib/patch.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { sha256File } from "../lib/hash.mjs";
import { ensureSupportedTarget } from "../lib/compat.mjs";
import { inspectWorktree } from "../lib/repo.mjs";

await runCli("enable", async (options) => {
  const manifest = await loadManifest();
  const previousState = await loadState(manifest.stateFile);
  const target = await detectOpencodeTarget({
    compat: manifest.compat,
    opencodeRoot: options.opencodeRoot,
  });
  const patchPath = ensureSupportedTarget(manifest, target);
  const worktree = inspectWorktree(target.root);

  if (!worktree.ok) {
    fail({ message: worktree.message }, 2);
  }
  if (!options.dryRun && !worktree.clean) {
    fail(
      {
        message:
          "El checkout de OpenCode no está limpio; no es seguro aplicar el addon.",
        details: worktree.entries.slice(0, 10),
      },
      3,
    );
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

  try {
    const patchResult = await applyPatch(target.root, patchPath, {
      dryRun: options.dryRun,
    });
    const state = {
      addonId: manifest.addon.id,
      addonVersion: manifest.addon.version,
      channel: manifest.addon.channel,
      enabledAt: new Date().toISOString(),
      dryRun: options.dryRun,
      opencode: {
        root: target.root,
        version: target.version,
        method: target.method,
      },
      patch: {
        path: patchPath,
        sha256: await sha256File(patchPath),
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
        ? `Dry run OK para ${target.root}`
        : `Addon habilitado sobre ${target.root}`,
      details: [
        `plugin: ${pluginResult.state}`,
        `patch: ${patchResult.state}`,
        `version: ${target.version}`,
        `worktree: ${worktree.clean ? "clean" : "dirty (dry-run allowed)"}`,
      ],
    };
  } catch (error) {
    if (!options.dryRun && pluginResult.changed) {
      await removePlugin(
        manifest.pluginSourcePath,
        manifest.installedPluginPath,
        previousState,
        { dryRun: false },
      ).catch(() => undefined);
    }
    fail(
      { message: error instanceof Error ? error.message : String(error) },
      1,
    );
  }
});
