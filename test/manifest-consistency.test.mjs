import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
}

test("supported OpenCode versions have an existing patch mapping", async () => {
  const addon = await readJson("manifest/addon.json");
  const compat = await readJson("manifest/compat.json");
  const packageJson = await readJson("package.json");
  const checkoutVersions = compat.opencode.modes["patched-source-checkout"].supportedVersions;
  const managedVersions = compat.opencode.modes["managed-local-install"].supportedVersions;

  assert.equal(addon.version, packageJson.version);
  assert.deepEqual(managedVersions, checkoutVersions);
  assert.ok(checkoutVersions.includes(addon.distribution.preferredOpenCodeVersion));

  for (const version of checkoutVersions) {
    const patch = addon.patches.opencode[version];
    assert.ok(patch, `missing patch mapping for OpenCode ${version}`);
    await fs.access(path.join(root, patch));
  }
});
