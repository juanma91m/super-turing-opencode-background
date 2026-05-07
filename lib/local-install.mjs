import fs from "node:fs/promises";
import os from "node:os";
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

function ensurePathExists(filePath, label) {
  if (!existsSync(filePath)) {
    fail({ message: `No se encontró ${label}: ${filePath}` }, 2);
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

export function resolveStorageBackupPath(stateFile, installRoot) {
  return path.join(
    path.dirname(stateFile),
    "storage-backups",
    `${path.basename(installRoot)}-${timestampToken()}`,
  );
}

export function resolveUserStoragePaths() {
  const home = process.env.HOME || os.homedir();
  return {
    dataRoot: path.join(home, ".local", "share", "opencode"),
    stateRoot: path.join(home, ".local", "state", "opencode"),
    dbPath: path.join(home, ".local", "share", "opencode", "opencode.db"),
  };
}

export function markerPathFor(installRoot) {
  return path.join(installRoot, ".opencode-background-addon.json");
}

export function managedRuntimePathFor(installRoot) {
  return path.join(installRoot, "bin", "opencode-managed-runtime");
}

export function buildManagedLauncher({ runtimeBinaryPath, storage }) {
  return `#!/bin/sh
if [ ! -x "${runtimeBinaryPath}" ]; then
  echo "Missing runtime binary: ${runtimeBinaryPath}" >&2
  exit 1
fi
export OPENCODE_DB="${storage.dbPath}"
export OPENCODE_DISABLE_CHANNEL_DB=1
exec "${runtimeBinaryPath}" "$@"
`;
}

async function readFileText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function readJsonFile(filePath) {
  const text = await readFileText(filePath);
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function resolveManagedStateEntry(installRoot, state) {
  if (
    state?.mode === "managed-local-install" &&
    state?.managedLocalInstall?.installRoot === installRoot
  ) {
    return state.managedLocalInstall;
  }
  return undefined;
}

function storageMatches(left, right) {
  if (!left || !right) return false;
  return (
    left.dbPath === right.dbPath &&
    left.dataRoot === right.dataRoot &&
    left.stateRoot === right.stateRoot
  );
}

function collectStateMarkerConflicts(stateEntry, markerData) {
  if (!stateEntry || !markerData) return [];

  const conflicts = [];
  if (
    stateEntry.runtimeBinaryPath &&
    markerData.runtimeBinaryPath &&
    stateEntry.runtimeBinaryPath !== markerData.runtimeBinaryPath
  ) {
    conflicts.push("marker_runtime_mismatch");
  }
  if (
    stateEntry.backupPath &&
    markerData.backupPath &&
    stateEntry.backupPath !== markerData.backupPath
  ) {
    conflicts.push("marker_backup_mismatch");
  }
  if (stateEntry.storage && markerData.storage && !storageMatches(stateEntry.storage, markerData.storage)) {
    conflicts.push("marker_storage_mismatch");
  }
  if (
    stateEntry.checkoutVersion &&
    markerData.checkoutVersion &&
    stateEntry.checkoutVersion !== markerData.checkoutVersion
  ) {
    conflicts.push("marker_checkout_version_mismatch");
  }

  return conflicts;
}

async function inspectManagedMarker({ markerPath, stateEntry }) {
  const text = await readFileText(markerPath);
  if (!text) {
    return {
      exists: false,
      valid: false,
      data: undefined,
      intrinsicProblems: ["marker_missing"],
      stateConflicts: [],
      matchesState: stateEntry ? false : undefined,
      reason: "marker_missing",
    };
  }

  const data = await readJsonFile(markerPath);
  if (!data || typeof data !== "object") {
    return {
      exists: true,
      valid: false,
      data: undefined,
      intrinsicProblems: ["marker_invalid_json"],
      stateConflicts: [],
      matchesState: stateEntry ? false : undefined,
      reason: "marker_invalid_json",
    };
  }

  const intrinsicProblems = [];
  if (data.mode !== "managed-local-install") {
    intrinsicProblems.push("marker_mode_invalid");
  }
  if (!data.runtimeBinaryPath) {
    intrinsicProblems.push("marker_runtime_missing_metadata");
  }
  if (!data.backupPath) {
    intrinsicProblems.push("marker_backup_missing_metadata");
  }
  if (!data.storage?.dbPath || !data.storage?.dataRoot || !data.storage?.stateRoot) {
    intrinsicProblems.push("marker_storage_missing_metadata");
  }

  const stateConflicts = collectStateMarkerConflicts(stateEntry, data);
  const problems = [...intrinsicProblems, ...stateConflicts];
  return {
    exists: true,
    valid: intrinsicProblems.length === 0,
    data,
    intrinsicProblems,
    stateConflicts,
    matchesState: stateEntry ? stateConflicts.length === 0 : undefined,
    reason: problems[0] ?? "ok",
  };
}

function resolveManagedMetadata(installRoot, stateEntry, marker) {
  return {
    installRoot,
    backupPath: marker.data?.backupPath ?? stateEntry?.backupPath,
    runtimeBinaryPath:
      marker.data?.runtimeBinaryPath ?? stateEntry?.runtimeBinaryPath,
    sourceRuntimeBinaryPath:
      marker.data?.sourceRuntimeBinaryPath ?? stateEntry?.sourceRuntimeBinaryPath,
    runtimeBinaryState:
      marker.data?.runtimeBinaryState ?? stateEntry?.runtimeBinaryState,
    storage: marker.data?.storage ?? stateEntry?.storage,
    checkoutRoot: marker.data?.checkoutRoot ?? stateEntry?.checkoutRoot,
    checkoutVersion:
      marker.data?.checkoutVersion ?? stateEntry?.checkoutVersion,
    bunPath: marker.data?.bunPath ?? stateEntry?.bunPath,
    createdAt: marker.data?.createdAt,
  };
}

async function inspectManagedLauncher({
  launcherPath,
  runtimeBinaryPath,
  storage,
}) {
  const text = await readFileText(launcherPath);
  if (!text) {
    return {
      exists: false,
      isScript: false,
      matchesExpected: false,
      reason: "launcher_missing",
    };
  }

  const expected = buildManagedLauncher({ runtimeBinaryPath, storage });
  const isScript = text.startsWith("#!/bin/sh\n");
  return {
    exists: true,
    isScript,
    matchesExpected: text === expected,
    reason:
      text === expected
        ? "ok"
        : isScript
          ? "launcher_mismatch"
          : "launcher_not_script",
  };
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

  return inspectManagedLocalInstallRoot(installRoot, state);
}

export async function inspectManagedLocalInstallRoot(installRoot, state) {
  if (!installRoot) {
    return {
      adopted: false,
      restoreAvailable: false,
      drift: false,
    };
  }

  const stateEntry = resolveManagedStateEntry(installRoot, state);
  const markerPath = markerPathFor(installRoot);
  const launcherPath = path.join(installRoot, "bin", "opencode");
  const launcherExists = existsSync(launcherPath);
  const marker = await inspectManagedMarker({ markerPath, stateEntry });
  const adopted = marker.exists && launcherExists;
  const candidateManaged = adopted || marker.exists || Boolean(stateEntry);
  const metadata = resolveManagedMetadata(installRoot, stateEntry, marker);
  const backupPath = metadata.backupPath;
  const restoreAvailable = Boolean(backupPath && existsSync(backupPath));
  const checkoutRoot = metadata.checkoutRoot;
  const checkoutVersion = metadata.checkoutVersion;
  const bunPath = metadata.bunPath;
  const runtimeBinaryPath = metadata.runtimeBinaryPath;
  const expectedRuntimeBinaryPath = managedRuntimePathFor(installRoot);
  const sourceRuntimeBinaryPath = metadata.sourceRuntimeBinaryPath;
  const runtimeBinaryState = metadata.runtimeBinaryState;
  const storage = metadata.storage;
  const launcher =
    runtimeBinaryPath && storage
      ? await inspectManagedLauncher({
          launcherPath,
          runtimeBinaryPath,
          storage,
        })
      : {
          exists: adopted,
          isScript: false,
          matchesExpected: false,
          reason: "missing_metadata",
        };

  const problems = [];
  if (candidateManaged) {
    if (!marker.exists) problems.push("marker_missing");
    problems.push(...marker.intrinsicProblems.filter((value) => value !== "marker_missing"));
    problems.push(...marker.stateConflicts);
    if (!launcherExists) problems.push("launcher_missing");
    if (!runtimeBinaryPath) problems.push("runtime_missing_metadata");
    else {
      if (path.resolve(runtimeBinaryPath) !== path.resolve(expectedRuntimeBinaryPath)) {
        problems.push("runtime_path_unmanaged");
      }
      if (!existsSync(runtimeBinaryPath)) problems.push("runtime_missing");
    }
    if (!backupPath) problems.push("backup_missing_metadata");
    else if (!existsSync(backupPath)) problems.push("backup_missing");
    if (!storage?.dbPath || !storage?.dataRoot || !storage?.stateRoot) {
      problems.push("storage_missing_metadata");
    }
    if (launcherExists && !launcher.matchesExpected) problems.push(launcher.reason);
  }

  const drift = candidateManaged ? problems.length > 0 : false;
  const health = !candidateManaged
    ? "inactive"
    : drift
      ? "broken"
      : adopted
        ? "adopted"
        : "broken";

  return {
    adopted,
    candidateManaged,
    stateActive: Boolean(stateEntry),
    health,
    restoreAvailable,
    drift,
    markerPath,
    launcherPath,
    backupPath,
    checkoutRoot,
    checkoutVersion,
    bunPath,
    runtimeBinaryPath,
    expectedRuntimeBinaryPath,
    sourceRuntimeBinaryPath,
    runtimeBinaryState,
    storage,
    launcher,
    marker,
    problems,
  };
}

export async function verifyManagedLocalInstall({
  installRoot,
  backupPath,
  checkoutRoot,
  checkoutVersion,
  bunPath,
  runtimeBinaryPath,
  sourceRuntimeBinaryPath,
  runtimeBinaryState,
  storage,
}) {
  const inspection = await inspectManagedLocalInstallRoot(installRoot, {
    mode: "managed-local-install",
    managedLocalInstall: {
      installRoot,
      backupPath,
      checkoutRoot,
      checkoutVersion,
      bunPath,
      runtimeBinaryPath,
      sourceRuntimeBinaryPath,
      runtimeBinaryState,
      storage,
    },
  });

  return {
    ok: inspection.adopted && !inspection.drift,
    inspection,
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
  checkoutRoot,
  checkoutVersion,
  bunPath,
  sourceRuntimeBinaryPath,
  runtimeBinaryState,
  storage,
  addonId,
}) {
  const tempRoot = `${installRoot}.opencode-background-addon.tmp`;
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(tempRoot, "bin"), { recursive: true });

  const runtimeBinaryPath = managedRuntimePathFor(installRoot);
  const tempRuntimeBinaryPath = managedRuntimePathFor(tempRoot);
  await fs.copyFile(sourceRuntimeBinaryPath, tempRuntimeBinaryPath);
  await fs.chmod(tempRuntimeBinaryPath, 0o755);

  const launcher = buildManagedLauncher({ runtimeBinaryPath, storage });
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
        sourceRuntimeBinaryPath,
        runtimeBinaryState,
        storage,
        backupPath,
        checkoutRoot,
        checkoutVersion,
        bunPath,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    tempRoot,
    runtimeBinaryPath,
  };
}

export async function adoptManagedLocalInstall({
  installRoot,
  backupPath,
  checkoutRoot,
  checkoutVersion,
  bunPath,
  sourceRuntimeBinaryPath,
  runtimeBinaryState,
  storage,
  addonId,
  dryRun = false,
}) {
  ensureExecutable(path.join(installRoot, "bin", "opencode"));
  ensurePathExists(storage.dbPath, "la base de datos de sesiones");
  ensurePathExists(storage.dataRoot, "el directorio de data de OpenCode");
  ensurePathExists(storage.stateRoot, "el directorio de state de OpenCode");
  const runtimeBinaryPath = managedRuntimePathFor(installRoot);
  if (dryRun) {
    return {
      changed: true,
      state: "would_adopt",
      installRoot,
      backupPath,
      checkoutRoot,
      checkoutVersion,
      bunPath,
      runtimeBinaryPath,
      sourceRuntimeBinaryPath,
      runtimeBinaryState,
      storage,
    };
  }

  ensureExecutable(sourceRuntimeBinaryPath);

  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  const moved = await movePath(installRoot, backupPath);

  try {
    const managedTree = await writeManagedInstallTree({
      installRoot,
      backupPath,
      checkoutRoot,
      checkoutVersion,
      bunPath,
      sourceRuntimeBinaryPath,
      runtimeBinaryState,
      storage,
      addonId,
    });
    await fs.rename(managedTree.tempRoot, installRoot);

    const verification = await verifyManagedLocalInstall({
      installRoot,
      backupPath,
      checkoutRoot,
      checkoutVersion,
      bunPath,
      runtimeBinaryPath: managedTree.runtimeBinaryPath,
      sourceRuntimeBinaryPath,
      runtimeBinaryState,
      storage,
    });
    if (!verification.ok) {
      throw new Error(
        `La instalación adoptada no pasó la verificación post-adopción (${verification.inspection.launcher?.reason ?? "unknown"}).`,
      );
    }

    return {
      changed: true,
      state: "adopted",
      installRoot,
      backupPath,
      checkoutRoot,
      checkoutVersion,
      bunPath,
      runtimeBinaryPath: managedTree.runtimeBinaryPath,
      sourceRuntimeBinaryPath,
      runtimeBinaryState,
      storage,
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

export async function backupStorageRoots({
  storage,
  backupRoot,
  dryRun = false,
}) {
  const shareBackupPath = path.join(backupRoot, "share-opencode");
  const stateBackupPath = path.join(backupRoot, "state-opencode");

  if (dryRun) {
    return {
      changed: true,
      state: "would_backup_storage",
      backupRoot,
      shareBackupPath,
      stateBackupPath,
    };
  }

  await fs.mkdir(backupRoot, { recursive: true });
  await fs.cp(storage.dataRoot, shareBackupPath, {
    recursive: true,
    errorOnExist: true,
  });
  await fs.cp(storage.stateRoot, stateBackupPath, {
    recursive: true,
    errorOnExist: true,
  });

  return {
    changed: true,
    state: "storage_backed_up",
    backupRoot,
    shareBackupPath,
    stateBackupPath,
  };
}
