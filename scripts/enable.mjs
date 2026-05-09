import { loadManifest } from "../lib/manifest.mjs";
import { fail, runCli } from "../lib/cli.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { installPlugin, removePlugin } from "../lib/plugin.mjs";
import { applyPatch } from "../lib/patch.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { sha256File } from "../lib/hash.mjs";
import { ensureCompatibleMode } from "../lib/compat.mjs";
import { inspectWorktree } from "../lib/repo.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";

await runCli("enable", async (options) => {
  const manifest = await loadManifest();
  const previousState = await loadState(manifest.stateFile);
  const target = await detectOpencodeTarget({
    compat: manifest.compat,
    opencodeRoot: options.opencodeRoot,
  });
  const mode = ensureCompatibleMode(manifest, target);
  if (mode.id === "managed-local-install") {
    fail(
      {
        message:
          "Para instalaciones locales tipo curl-binary usá adopt-local-install en lugar de enable.",
      },
      2,
    );
  }
  const targetLabel = target.root || target.execPath || target.method;
  const worktree =
    mode.patchRequired && target.root
      ? inspectWorktree(target.root)
      : { ok: true, clean: true, entries: [] };
  const pluginBackupRoot = path.join(path.dirname(manifest.stateFile), "plugin-backup");

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
    if (!options.dryRun && mode.requiresCleanWorktree && !worktree.clean) {
      fail(
        {
          message:
            "El checkout de OpenCode no está limpio; no es seguro aplicar el addon.",
          details: worktree.entries.slice(0, 10),
        },
        3,
      );
    }
  }

  const pluginResults = [];
  for (const plugin of manifest.plugins) {
    const backupPath = path.join(
      pluginBackupRoot,
      plugin.manifest.installDirName || "root",
      plugin.manifest.installFile,
    );
    const result = await installPlugin(plugin.sourcePath, plugin.installedPath, {
      dryRun: options.dryRun,
      replaceCompatibleInstalledHashes:
        plugin.manifest.compatibleInstalledHashes || [],
      backupPath,
    });
    if (result.state === "modified") {
      fail(
        {
          message:
            "Uno de los plugins instalados fue modificado manualmente; el addon no lo sobreescribe automáticamente.",
          details: [plugin.installedPath],
        },
        3,
      );
    }
    pluginResults.push({ plugin, result, backupPath });
  }

  try {
    const patchResult = mode.patchRequired
      ? await applyPatch(target.root, mode.patchPath, {
          dryRun: options.dryRun,
        })
      : { changed: false, state: "not_required" };
    if (!options.dryRun) {
      const tuiResult = spawnSync(
        "python3",
        [path.join(path.dirname(new URL(import.meta.url).pathname), "ensure_tui_plugin.py"), "ensure", path.join(process.env.HOME ?? "", ".config", "opencode")],
        { encoding: "utf8" },
      );
      if (tuiResult.status !== 0) {
        throw new Error(tuiResult.stderr.trim() || "No se pudo asegurar tui.json del addon background");
      }
    }
    const state = {
      addonId: manifest.addon.id,
      addonVersion: manifest.addon.version,
      channel: manifest.addon.channel,
      mode: mode.id,
      enabledAt: new Date().toISOString(),
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
      plugins: await Promise.all(
        pluginResults.map(async ({ plugin, result, backupPath }) => ({
          id: plugin.manifest.id,
          sourcePath: plugin.sourcePath,
          installedPath: plugin.installedPath,
          backupPath:
            result.state === "replaced_compatible" ||
            result.state === "would_replace_compatible"
              ? backupPath
              : undefined,
          sourceHash: await sha256File(plugin.sourcePath),
          installedHash: result.installedHash || result.sourceHash,
          state: result.state,
        })),
      ),
    };

    if (!options.dryRun) await saveState(manifest.stateFile, state);

    return {
      message: options.dryRun
        ? `Dry run OK para ${targetLabel}`
        : `Addon habilitado sobre ${targetLabel}`,
      details: [
        `mode: ${mode.id}`,
        `plugins: ${pluginResults.map(({ plugin, result }) => `${plugin.manifest.id}=${result.state}`).join(", ")}`,
        `patch: ${patchResult.state}`,
        `version: ${target.version}`,
        `worktree: ${mode.patchRequired ? (worktree.clean ? "clean" : "dirty (dry-run allowed)") : "not_required"}`,
        `tui: ensured`,
      ],
    };
  } catch (error) {
    if (!options.dryRun) {
      for (const plugin of manifest.plugins) {
        const previousPluginState = previousState?.plugins?.find?.((item) => item.id === plugin.manifest.id) || previousState?.plugin;
        await removePlugin(plugin.sourcePath, plugin.installedPath, previousPluginState ? { plugin: previousPluginState } : previousState, {
          dryRun: false,
        }).catch(() => undefined);
      }
    }
    fail(
      { message: error instanceof Error ? error.message : String(error) },
      1,
    );
  }
});
