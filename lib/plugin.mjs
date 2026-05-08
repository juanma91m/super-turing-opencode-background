import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./hash.mjs";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function inspectPlugin(sourcePath, installedPath) {
  const sourceHash = await sha256File(sourcePath);
  const installed = await exists(installedPath);
  if (!installed) {
    return { state: "missing", sourceHash, installedPath };
  }
  const installedHash = await sha256File(installedPath);
  return {
    state: installedHash === sourceHash ? "installed" : "modified",
    sourceHash,
    installedHash,
    installedPath,
  };
}

export async function installPlugin(
  sourcePath,
  installedPath,
  { dryRun = false, replaceCompatibleInstalledHashes = [], backupPath } = {},
) {
  const status = await inspectPlugin(sourcePath, installedPath);
  if (status.state === "installed") return { changed: false, ...status };
  if (status.state === "modified") {
    const compatible =
      status.installedHash &&
      replaceCompatibleInstalledHashes.includes(status.installedHash);
    if (compatible) {
      if (dryRun) {
        return {
          changed: true,
          state: "would_replace_compatible",
          sourceHash: status.sourceHash,
          installedHash: status.installedHash,
          installedPath,
          backupPath,
        };
      }

      if (!backupPath) {
        throw new Error(
          "backupPath es requerido para reemplazar un plugin compatible preinstalado",
        );
      }

      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.copyFile(installedPath, backupPath);
      await fs.copyFile(sourcePath, installedPath);
      return {
        changed: true,
        state: "replaced_compatible",
        sourceHash: status.sourceHash,
        installedHash: await sha256File(installedPath),
        previousInstalledHash: status.installedHash,
        installedPath,
        backupPath,
      };
    }
    return {
      changed: false,
      state: "modified",
      sourceHash: status.sourceHash,
      installedHash: status.installedHash,
      installedPath,
    };
  }
  if (dryRun) return { changed: true, state: "would_install", ...status };

  await fs.mkdir(path.dirname(installedPath), { recursive: true });
  await fs.copyFile(sourcePath, installedPath);
  return {
    changed: true,
    state: "installed",
    sourceHash: status.sourceHash,
    installedHash: await sha256File(installedPath),
    installedPath,
  };
}

export async function removePlugin(
  sourcePath,
  installedPath,
  state,
  { dryRun = false } = {},
) {
  const status = await inspectPlugin(sourcePath, installedPath);
  if (status.state === "missing") return { changed: false, ...status };

  const backupPath = state?.plugin?.backupPath;
  if (backupPath) {
    if (dryRun) {
      return {
        changed: true,
        state: "would_restore_backup",
        installedPath,
        backupPath,
      };
    }

    await fs.mkdir(path.dirname(installedPath), { recursive: true });
    await fs.copyFile(backupPath, installedPath);
    await fs.rm(backupPath, { force: true });
    return {
      changed: true,
      state: "restored_backup",
      installedPath,
      installedHash: await sha256File(installedPath),
      backupPath,
    };
  }

  const expectedHash = state?.plugin?.installedHash || status.sourceHash;
  if (status.installedHash !== expectedHash) {
    return {
      changed: false,
      state: "modified",
      installedPath,
      installedHash: status.installedHash,
    };
  }
  if (dryRun) return { changed: true, state: "would_remove", installedPath };

  await fs.rm(installedPath, { force: true });
  return { changed: true, state: "missing", installedPath };
}
