import { loadManifest } from "../lib/manifest.mjs";
import { fail, runCli } from "../lib/cli.mjs";
import { loadState, removeState } from "../lib/state.mjs";
import { restoreManagedLocalInstall } from "../lib/local-install.mjs";

await runCli("restore-local-install", async (options) => {
  const manifest = await loadManifest();
  const state = await loadState(manifest.stateFile);

  if (state?.mode !== "managed-local-install") {
    fail(
      {
        message:
          "No hay una instalación local administrada activa para restaurar.",
      },
      2,
    );
  }

  const installRoot = state?.managedLocalInstall?.installRoot;
  const backupPath = state?.managedLocalInstall?.backupPath;
  const effectiveInstallRoot = options.installRoot || installRoot;
  if (!installRoot || !backupPath) {
    fail(
      {
        message:
          "El estado persistido no tiene la metadata necesaria para restaurar la instalación local.",
      },
      2,
    );
  }

  const result = await restoreManagedLocalInstall({
    installRoot: effectiveInstallRoot,
    backupPath,
    dryRun: options.dryRun,
  });

  if (!options.dryRun) {
    await removeState(manifest.stateFile);
  }

  return {
    message: options.dryRun
      ? `Dry run OK para restaurar ${installRoot}`
      : `Instalación local restaurada en ${installRoot}`,
    details: [
      `mode: managed-local-install`,
      `install root: ${effectiveInstallRoot}`,
      `backup: ${backupPath}`,
      `result: ${result.state}`,
    ],
  };
});
