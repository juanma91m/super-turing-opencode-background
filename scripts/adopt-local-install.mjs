import { loadManifest } from "../lib/manifest.mjs";
import { fail, runCli } from "../lib/cli.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { detectOpencodeTarget } from "../lib/detect-opencode.mjs";
import { ensureCompatibleMode } from "../lib/compat.mjs";
import { inspectManagedFile } from "../lib/plugin.mjs";
import {
  adoptManagedLocalInstall,
  backupStorageRoots,
  detectBunPath,
  ensureBuiltOpencodeBinary,
  inspectManagedLocalInstall,
  inspectManagedLocalInstallRoot,
  resolveBackupPath,
  resolveStorageBackupPath,
  resolveUserStoragePaths,
} from "../lib/local-install.mjs";
import { inspectHostHooks } from "../lib/hooks-check.mjs";

await runCli("adopt-local-install", async (options) => {
  const manifest = await loadManifest();
  const previousState = await loadState(manifest.stateFile);

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
  const localInspection = localTarget.installRoot
    ? await inspectManagedLocalInstallRoot(localTarget.installRoot, previousState)
    : { candidateManaged: false };
  const localMode = localInspection.candidateManaged
    ? {
        id: "managed-local-install",
      }
    : ensureCompatibleMode(manifest, localTarget);
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

  const plugins = await Promise.all(
    manifest.plugins.map(async (plugin) => ({
      plugin,
      status: await inspectManagedFile(
        plugin.sourcePath,
        plugin.installedPath,
      ),
    })),
  );
  const assets = await Promise.all(
    manifest.assets.map(async (asset) => ({
      asset,
      status: await inspectManagedFile(
        asset.sourcePath,
        asset.installedPath,
      ),
    })),
  );
  if (plugins.some(({ status }) => status.state !== "installed")) {
    fail(
      {
        message:
          "managed-local-install requiere que todos los plugins del addon ya estén instalados. Corré enable --opencode-root sobre el mismo checkout fuente antes de adoptar la instalación local.",
        details: plugins.map(({ plugin, status }) => `${plugin.manifest.id}: ${status.state}`),
      },
      plugins.some(({ status }) => status.state === "modified") ? 3 : 2,
    );
  }
  if (assets.some(({ status }) => status.state !== "installed")) {
    fail(
      {
        message:
          "managed-local-install requiere que todos los assets auxiliares del addon background ya estén instalados. Corré enable --opencode-root sobre el mismo checkout fuente antes de adoptar la instalación local.",
        details: assets.map(({ asset, status }) => `${asset.manifest.id}: ${status.state}`),
      },
      assets.some(({ status }) => status.state === "modified") ? 3 : 2,
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

  if (
    previousState?.mode === "managed-local-install" &&
    previousState?.managedLocalInstall?.installRoot &&
    previousState.managedLocalInstall.installRoot !== installRoot
  ) {
    fail(
      {
        message:
          "Ya existe otra instalación local administrada registrada por el addon. Corré restore-local-install sobre ese root antes de adoptar uno distinto.",
        details: [
          `active install root: ${previousState.managedLocalInstall.installRoot}`,
          `requested install root: ${installRoot}`,
        ],
      },
      3,
    );
  }

  const inspection = localTarget.installRoot
    ? localInspection
    : await inspectManagedLocalInstall(previousState);
  if (inspection.candidateManaged) {
    fail(
      {
        message:
          "La instalación local ya parece administrada o quedó en un estado reconocible por el addon. Revisá status o corré restore-local-install antes de volver a adoptar.",
        details: [
          `health: ${inspection.health ?? "unknown"}`,
          ...(inspection.problems?.length
            ? [`problems: ${inspection.problems.join(", ")}`]
            : []),
        ],
      },
      3,
    );
  }

  const backupPath = resolveBackupPath(manifest.stateFile, installRoot);
  const storage = resolveUserStoragePaths();
  const storageBackupRoot = resolveStorageBackupPath(
    manifest.stateFile,
    installRoot,
  );
  const storageBackup = await backupStorageRoots({
    storage,
    backupRoot: storageBackupRoot,
    dryRun: options.dryRun,
  });
  const result = await adoptManagedLocalInstall({
    installRoot,
    backupPath,
    checkoutRoot: sourceTarget.root,
    checkoutVersion: sourceTarget.version,
    bunPath,
    sourceRuntimeBinaryPath: runtimeBinary.binaryPath,
    runtimeBinaryState: runtimeBinary.state,
    storage,
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
      runtimeBinaryPath: result.runtimeBinaryPath,
      sourceRuntimeBinaryPath: runtimeBinary.binaryPath,
      runtimeBinaryState: runtimeBinary.state,
      preservedBinEntries: result.preservedBinEntries,
      storage,
      storageBackupRoot,
      storageBackup,
      sourcePatchPath: sourceMode.patchPath,
    },
    plugins: plugins.map(({ plugin, status }) => ({
      id: plugin.manifest.id,
      sourcePath: plugin.sourcePath,
      installedPath: plugin.installedPath,
      sourceHash: status.sourceHash,
      installedHash: status.installedHash,
      state: status.state,
    })),
    assets: assets.map(({ asset, status }) => ({
      id: asset.manifest.id,
      sourcePath: asset.sourcePath,
      installedPath: asset.installedPath,
      sourceHash: status.sourceHash,
      installedHash: status.installedHash,
      state: status.state,
    })),
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
      `plugins: ${plugins.map(({ plugin, status }) => `${plugin.manifest.id}=${status.state}`).join(", ")}`,
      `assets: ${assets.map(({ asset, status }) => `${asset.manifest.id}=${status.state}`).join(", ") || "none"}`,
      `bun: ${bunPath}`,
      `source runtime binary: ${runtimeBinary.binaryPath}`,
      `managed runtime binary: ${result.runtimeBinaryPath}`,
      `preserved bin entries: ${result.preservedBinEntries?.map((entry) => `${entry.name}=${entry.mode}`).join(", ") || "none"}`,
      `binary prep: ${runtimeBinary.state}`,
      `session db: ${storage.dbPath}`,
      `storage backup: ${storageBackupRoot}`,
      `result: ${result.state}`,
    ],
  };
});
