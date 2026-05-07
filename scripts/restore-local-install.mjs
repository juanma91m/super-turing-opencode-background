import { loadManifest } from "../lib/manifest.mjs";
import { fail, runCli } from "../lib/cli.mjs";
import { loadState, removeState } from "../lib/state.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { removePlugin } from "../lib/plugin.mjs";
import {
  inspectManagedLocalInstallRoot,
  restoreManagedLocalInstall,
} from "../lib/local-install.mjs";

function restoreBlockingProblems(inspection) {
  const allowed = new Set([
    "runtime_missing",
    "runtime_path_unmanaged",
    "marker_runtime_mismatch",
    "marker_storage_mismatch",
    "marker_checkout_version_mismatch",
  ]);
  return (inspection.problems || []).filter((problem) => !allowed.has(problem));
}

await runCli("restore-local-install", async (options) => {
  const manifest = await loadManifest();
  const state = await loadState(manifest.stateFile);

  const target = await detectOpencodeTarget({
    compat: manifest.compat,
    installRoot: options.installRoot,
  });
  const effectiveInstallRoot =
    options.installRoot ||
    state?.managedLocalInstall?.installRoot ||
    target.installRoot;
  if (!effectiveInstallRoot) {
    fail(
      {
        message:
          "No se pudo resolver el install root para restore-local-install.",
      },
      2,
    );
  }

  const inspection = await inspectManagedLocalInstallRoot(
    effectiveInstallRoot,
    state,
  );
  const blockingProblems = restoreBlockingProblems(inspection);
  if (!inspection.adopted || blockingProblems.length > 0) {
    fail(
      {
        message:
          "La instalación local no coincide con un estado adoptado sano; restore cancelado para evitar sobrescribir un root inconsistente.",
        details: [
          `adopted=${String(inspection.adopted)}`,
          `drift=${String(inspection.drift)}`,
          `problems=${blockingProblems.join(", ") || inspection.problems?.join(", ") || inspection.launcher?.reason || "unknown"}`,
        ],
      },
      3,
    );
  }

  if (!inspection.backupPath) {
    fail(
      {
        message:
          "La instalación administrada no expone un backup path usable; restore cancelado.",
      },
      2,
    );
  }

  const result = await restoreManagedLocalInstall({
    installRoot: effectiveInstallRoot,
    backupPath: inspection.backupPath,
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

  if (!options.dryRun) {
    await removeState(manifest.stateFile);
  }

  return {
    message: options.dryRun
      ? `Dry run OK para restaurar ${effectiveInstallRoot}`
      : `Instalación local restaurada en ${effectiveInstallRoot}`,
    details: [
      `mode: managed-local-install`,
      `install root: ${effectiveInstallRoot}`,
      `backup: ${inspection.backupPath}`,
      `result: ${result.state}`,
      `plugin: ${pluginResult.state}`,
      pluginResult.state === "modified"
        ? "el plugin quedó instalado porque fue modificado manualmente"
        : "plugin revertido de forma segura",
    ],
  };
});
