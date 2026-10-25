import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../lib/cli.mjs";
import {
  adoptManagedLocalInstall,
  backupStorageRoots,
  managedBuildVersion,
  prepareStorageBackup,
  restoreManagedLocalInstall,
} from "../lib/local-install.mjs";

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeExecutable(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  await fs.chmod(filePath, 0o755);
}

test("managed build version includes the OpenCode version and build timestamp", () => {
  assert.equal(
    managedBuildVersion("1.19.4", new Date("2026-10-07T17:38:59.000Z")),
    "1.19.4--202610071738",
  );
});

test("restore preserves auxiliary binaries installed after adoption", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-background-restore-"));
  const installRoot = path.join(root, ".opencode");
  const backupPath = path.join(root, "backup", ".opencode");
  const sourceRuntimeBinaryPath = path.join(root, "build", "opencode");
  const storage = {
    dataRoot: path.join(root, "share", "opencode"),
    stateRoot: path.join(root, "state", "opencode"),
    dbPath: path.join(root, "share", "opencode", "opencode.db"),
  };

  try {
    await writeExecutable(path.join(installRoot, "bin", "opencode"), "original-opencode");
    await writeExecutable(path.join(installRoot, "bin", "semgrep"), "original-semgrep");
    await writeExecutable(sourceRuntimeBinaryPath, "managed-opencode");
    await fs.mkdir(storage.dataRoot, { recursive: true });
    await fs.mkdir(storage.stateRoot, { recursive: true });
    await fs.writeFile(storage.dbPath, "db", "utf8");

    await adoptManagedLocalInstall({
      installRoot,
      backupPath,
      checkoutRoot: path.join(root, "checkout"),
      checkoutVersion: "test",
      bunPath: process.execPath,
      sourceRuntimeBinaryPath,
      runtimeBinaryState: "test",
      storage,
      addonId: "opencode-background-tasks",
    });

    await writeExecutable(path.join(installRoot, "bin", "engram"), "post-adoption-engram");

    const dryRun = await restoreManagedLocalInstall({
      installRoot,
      backupPath,
      dryRun: true,
    });
    assert.deepEqual(
      dryRun.preservedBinEntries.map((entry) => entry.name),
      ["engram"],
    );

    const restored = await restoreManagedLocalInstall({ installRoot, backupPath });
    assert.deepEqual(
      restored.preservedBinEntries.map((entry) => entry.name),
      ["engram"],
    );
    assert.equal(
      await fs.readFile(path.join(installRoot, "bin", "opencode"), "utf8"),
      "original-opencode",
    );
    assert.equal(
      await fs.readFile(path.join(installRoot, "bin", "semgrep"), "utf8"),
      "original-semgrep",
    );
    assert.equal(
      await fs.readFile(path.join(installRoot, "bin", "engram"), "utf8"),
      "post-adoption-engram",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI parser exposes explicit storage-backup skip flag", () => {
  const options = parseArgs([
    "--install-root",
    "/tmp/install",
    "--skip-storage-backup",
    "--dry-run",
  ]);

  assert.equal(options.installRoot, "/tmp/install");
  assert.equal(options.skipStorageBackup, true);
  assert.equal(options.dryRun, true);
  assert.deepEqual(options.errors, []);
  assert.deepEqual(options.unknown, []);
});

test("prepareStorageBackup records skipped storage backup without touching disk", async () => {
  const result = await prepareStorageBackup({
    storage: {
      dataRoot: "/should/not/be/read",
      stateRoot: "/should/not/be/read",
      dbPath: "/should/not/be/read/opencode.db",
    },
    backupRoot: "/should/not/be/created",
    skip: true,
    dryRun: false,
  });

  assert.equal(result.backupRoot, undefined);
  assert.deepEqual(result.backup, {
    changed: false,
    state: "storage_backup_skipped",
    reason: "requested_by_cli",
  });
});

test("backupStorageRoots removes partial backup when copy fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-storage-backup-"));
  const backupRoot = path.join(root, "backup");
  const storage = {
    dataRoot: path.join(root, "share", "opencode"),
    stateRoot: path.join(root, "missing-state", "opencode"),
    dbPath: path.join(root, "share", "opencode", "opencode.db"),
  };

  try {
    await fs.mkdir(storage.dataRoot, { recursive: true });
    await fs.writeFile(storage.dbPath, "db", "utf8");

    await assert.rejects(
      backupStorageRoots({
        storage,
        backupRoot,
      }),
      /ENOENT|no such file/i,
    );

    assert.equal(await pathExists(backupRoot), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
