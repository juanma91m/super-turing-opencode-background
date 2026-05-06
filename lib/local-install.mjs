import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fail } from "./cli.mjs";

function timestampToken() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function movePath(sourcePath, targetPath) {
  try {
    await fs.rename(sourcePath, targetPath);
    return { mode: "rename" };
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      errorOnExist: true,
    });
    await fs.rm(sourcePath, { recursive: true, force: true });
    return { mode: "copy" };
  }
}

function ensureExecutable(filePath) {
  if (!existsSync(filePath)) {
    fail({ message: `No se encontró el ejecutable requerido: ${filePath}` }, 2);
  }
}

export function detectBunPath(explicitPath) {
  if (explicitPath) {
    ensureExecutable(explicitPath);
    return explicitPath;
  }

  const which = spawnSync("sh", ["-lc", "command -v bun"], {
    encoding: "utf8",
  });
  const bunPath = which.status === 0 ? which.stdout.trim() : undefined;
  if (!bunPath) {
    fail(
      {
        message:
          "No se encontró bun en PATH. Pasá --bun-path con un binario de bun compatible.",
      },
      2,
    );
  }
  ensureExecutable(bunPath);
  return bunPath;
}

export function resolveBackupPath(stateFile, installRoot) {
  return path.join(
    path.dirname(stateFile),
    "backups",
    `${path.basename(installRoot)}-${timestampToken()}`,
  );
}

export function markerPathFor(installRoot) {
  return path.join(installRoot, ".opencode-background-addon.json");
}

export async function inspectManagedLocalInstall(state) {
  const installRoot = state?.managedLocalInstall?.installRoot;
  const backupPath = state?.managedLocalInstall?.backupPath;
  if (!installRoot) {
    return {
      adopted: false,
      restoreAvailable: false,
      drift: false,
    };
  }

  const markerPath = markerPathFor(installRoot);
  const launcherPath = path.join(installRoot, "bin", "opencode");
  const adopted = existsSync(markerPath) && existsSync(launcherPath);
  const restoreAvailable = Boolean(backupPath && existsSync(backupPath));
  const checkoutRoot = state?.managedLocalInstall?.checkoutRoot;
  const bunPath = state?.managedLocalInstall?.bunPath;
  const drift =
    !adopted ||
    !restoreAvailable ||
    !checkoutRoot ||
    !existsSync(checkoutRoot) ||
    !bunPath ||
    !existsSync(bunPath);

  return {
    adopted,
    restoreAvailable,
    drift,
    markerPath,
    launcherPath,
    backupPath,
    checkoutRoot,
    bunPath,
  };
}

export async function inspectManagedLocalInstallRoot(installRoot, state) {
  if (!installRoot) {
    return {
      adopted: false,
      restoreAvailable: false,
      drift: false,
    };
  }

  const markerPath = markerPathFor(installRoot);
  const launcherPath = path.join(installRoot, "bin", "opencode");
  const adopted = existsSync(markerPath) && existsSync(launcherPath);
  const backupPath =
    state?.managedLocalInstall?.installRoot === installRoot
      ? state?.managedLocalInstall?.backupPath
      : undefined;
  const restoreAvailable = Boolean(backupPath && existsSync(backupPath));
  const checkoutRoot =
    state?.managedLocalInstall?.installRoot === installRoot
      ? state?.managedLocalInstall?.checkoutRoot
      : undefined;
  const bunPath =
    state?.managedLocalInstall?.installRoot === installRoot
      ? state?.managedLocalInstall?.bunPath
      : undefined;
  const drift =
    !adopted ||
    (restoreAvailable && checkoutRoot && !existsSync(checkoutRoot)) ||
    (restoreAvailable && bunPath && !existsSync(bunPath));

  return {
    adopted,
    restoreAvailable,
    drift,
    markerPath,
    launcherPath,
    backupPath,
    checkoutRoot,
    bunPath,
  };
}

export async function ensureBuiltOpencodeBinary({
  checkoutRoot,
  bunPath,
  dryRun = false,
}) {
  const binaryPath = path.join(
    checkoutRoot,
    "packages",
    "opencode",
    "dist",
    "opencode-linux-x64",
    "bin",
    "opencode",
  );

  if (existsSync(binaryPath)) {
    return {
      binaryPath,
      built: false,
      state: "existing_build",
    };
  }

  if (dryRun) {
    return {
      binaryPath,
      built: false,
      state: "would_build",
    };
  }

  const install = spawnSync(bunPath, ["install"], {
    cwd: checkoutRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (install.status !== 0) {
    fail(
      {
        message: "Falló bun install al preparar el checkout fuente.",
      },
      3,
    );
  }

  const build = spawnSync(
    bunPath,
    [
      "run",
      path.join(checkoutRoot, "packages", "opencode", "script", "build.ts"),
      "--single",
    ],
    {
      cwd: checkoutRoot,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  if (build.status !== 0) {
    fail(
      {
        message:
          "Falló la build del binario de OpenCode para managed-local-install.",
      },
      3,
    );
  }

  ensureExecutable(binaryPath);
  return {
    binaryPath,
    built: true,
    state: "built",
  };
}

async function writeManagedInstallTree({
  installRoot,
  backupPath,
  runtimeBinaryPath,
  addonId,
}) {
  const tempRoot = `${installRoot}.opencode-background-addon.tmp`;
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(tempRoot, "bin"), { recursive: true });

  const launcher = `#!/bin/sh
if [ ! -x "${runtimeBinaryPath}" ]; then
  echo "Missing runtime binary: ${runtimeBinaryPath}" >&2
  exit 1
fi
exec "${runtimeBinaryPath}" "$@"
`;
  const launcherPath = path.join(tempRoot, "bin", "opencode");
  await fs.writeFile(launcherPath, launcher, "utf8");
  await fs.chmod(launcherPath, 0o755);

  const backupBinDir = path.join(backupPath, "bin");
  try {
    const entries = await fs.readdir(backupBinDir);
    for (const name of entries) {
      if (name === "opencode") continue;
      const target = path.join(backupBinDir, name);
      const linkPath = path.join(tempRoot, "bin", name);
      await fs.symlink(target, linkPath);
    }
  } catch {
    // ignore missing backup bin dir
  }

  await fs.writeFile(
    markerPathFor(tempRoot),
    `${JSON.stringify(
      {
        addonId,
        mode: "managed-local-install",
        runtimeBinaryPath,
        backupPath,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return tempRoot;
}

export async function adoptManagedLocalInstall({
  installRoot,
  backupPath,
  runtimeBinaryPath,
  addonId,
  dryRun = false,
}) {
  ensureExecutable(path.join(installRoot, "bin", "opencode"));
  ensureExecutable(runtimeBinaryPath);
  if (dryRun) {
    return {
      changed: true,
      state: "would_adopt",
      installRoot,
      backupPath,
      runtimeBinaryPath,
    };
  }

  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  const moved = await movePath(installRoot, backupPath);

  try {
    const tempRoot = await writeManagedInstallTree({
      installRoot,
      backupPath,
      runtimeBinaryPath,
      addonId,
    });
    await fs.rename(tempRoot, installRoot);
    return {
      changed: true,
      state: "adopted",
      installRoot,
      backupPath,
      runtimeBinaryPath,
      backupMode: moved.mode,
    };
  } catch (error) {
    await fs
      .rm(installRoot, { recursive: true, force: true })
      .catch(() => undefined);
    await movePath(backupPath, installRoot).catch(() => undefined);
    throw error;
  }
}

export async function restoreManagedLocalInstall({
  installRoot,
  backupPath,
  dryRun = false,
}) {
  if (!backupPath || !existsSync(backupPath)) {
    fail(
      { message: "No existe backup para restaurar la instalación local." },
      2,
    );
  }
  const markerPath = markerPathFor(installRoot);
  if (!existsSync(markerPath)) {
    fail(
      {
        message:
          "La instalación actual no parece estar administrada por el addon; restore cancelado.",
      },
      3,
    );
  }

  if (dryRun) {
    return {
      changed: true,
      state: "would_restore",
      installRoot,
      backupPath,
    };
  }

  const tempManaged = `${installRoot}.opencode-background-addon.restore-tmp`;
  await fs.rm(tempManaged, { recursive: true, force: true });
  await fs.rename(installRoot, tempManaged);
  try {
    await movePath(backupPath, installRoot);
    await fs.rm(tempManaged, { recursive: true, force: true });
    return {
      changed: true,
      state: "restored",
      installRoot,
      backupPath,
    };
  } catch (error) {
    await fs
      .rm(installRoot, { recursive: true, force: true })
      .catch(() => undefined);
    await fs.rename(tempManaged, installRoot).catch(() => undefined);
    throw error;
  }
}
