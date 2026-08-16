import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  adoptManagedLocalInstall,
  restoreManagedLocalInstall,
} from "../lib/local-install.mjs";

async function writeExecutable(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  await fs.chmod(filePath, 0o755);
}

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
