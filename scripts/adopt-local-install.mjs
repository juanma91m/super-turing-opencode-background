import { loadManifest } from "../lib/manifest.mjs";
import { fail, runCli } from "../lib/cli.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { ensureCompatibleMode } from "../lib/compat.mjs";
import {
  adoptManagedLocalInstall,
  detectBunPath,
  ensureBuiltOpencodeBinary,
  inspectManagedLocalInstall,
  resolveBackupPath,
} from "../lib/local-install.mjs";
import { inspectHostHooks } from "../lib/hooks-check.mjs";

await runCli("adopt-local-install", async (options) => {
  const manifest = await loadManifest();
  const previousState = await loadState(manifest.stateFile);
  if (previousState?.mode === "managed-local-install") {
    fail(
      {
        message:
          "Ya existe una instalación local administrada registrada. Usá status o restore-local-install antes de volver a adoptar.",
      },
      3,
    );
  }

  if (!options.checkoutRoot) {
    fail(
      {
        message:
          "adopt-local-install requiere --checkout-root apuntando a un checkout fuente compatible y preparado.",
      },
      2,
    );
  }

  const localTarget = await detectOpencodeTarget({
    compat: manifest.compat,
    installRoot: options.installRoot,
  });
  const localMode = ensureCompatibleMode(manifest, localTarget);
  if (localMode.id !== "managed-local-install") {
    fail(
      {
        message: `El target actual no es compatible con managed-local-install (modo detectado: ${localMode.id}).`,
      },
      2,
    );
  }

  const sourceTarget = await detectOpencodeTarget({
    compat: manifest.compat,
    opencodeRoot: options.checkoutRoot,
  });
  const sourceMode = ensureCompatibleMode(manifest, sourceTarget);
  if (sourceMode.id !== "patched-source-checkout") {
    fail(
      {
        message: `El checkout fuente debe estar en modo patched-source-checkout. Modo detectado: ${sourceMode.id}.`,
      },
      2,
    );
  }

  const hostHooks = await inspectHostHooks(sourceTarget.root);
  if (!hostHooks.ok) {
    fail(
      {
        message:
          "El checkout fuente no expone todos los host hooks requeridos por el addon. Preparalo primero con una build/check-out compatible antes de adoptarlo como base local.",
        details: hostHooks.missing.slice(0, 10),
      },
      3,
    );
  }

  const bunPath = detectBunPath(options.bunPath);
  const runtimeBinary = await ensureBuiltOpencodeBinary({
    checkoutRoot: sourceTarget.root,
    bunPath,
    dryRun: options.dryRun,
  });
  const installRoot = localTarget.installRoot;
  if (!installRoot) {
    fail(
      {
        message:
          "No se pudo resolver el root de la instalación local para managed-local-install.",
      },
      2,
    );
  }

  const inspection = await inspectManagedLocalInstall(previousState);
  if (inspection.adopted) {
    fail(
      {
        message:
          "La instalación local ya parece administrada por el addon. Revisá status o corré restore-local-install antes de volver a adoptar.",
      },
      3,
    );
  }

  const backupPath = resolveBackupPath(manifest.stateFile, installRoot);
  const result = await adoptManagedLocalInstall({
    installRoot,
    backupPath,
    runtimeBinaryPath: runtimeBinary.binaryPath,
    addonId: manifest.addon.id,
    dryRun: options.dryRun,
  });

  const nextState = {
    addonId: manifest.addon.id,
    addonVersion: manifest.addon.version,
    channel: manifest.addon.channel,
    mode: "managed-local-install",
    managedLocalInstall: {
      adoptedAt: new Date().toISOString(),
      installRoot,
      execPath: localTarget.execPath,
      originalVersion: localTarget.version,
      backupPath,
      checkoutRoot: sourceTarget.root,
      checkoutVersion: sourceTarget.version,
      bunPath,
      runtimeBinaryPath: runtimeBinary.binaryPath,
      runtimeBinaryState: runtimeBinary.state,
      sourcePatchPath: sourceMode.patchPath,
    },
  };

  if (!options.dryRun) {
    await saveState(manifest.stateFile, nextState);
  }

  return {
    message: options.dryRun
      ? `Dry run OK para adoptar ${installRoot}`
      : `Instalación local adoptada en ${installRoot}`,
    details: [
      `mode: managed-local-install`,
      `install root: ${installRoot}`,
      `backup: ${backupPath}`,
      `checkout: ${sourceTarget.root}`,
      `bun: ${bunPath}`,
      `runtime binary: ${runtimeBinary.binaryPath}`,
      `binary prep: ${runtimeBinary.state}`,
      `result: ${result.state}`,
    ],
  };
});
