import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

async function ensureExists(filePath) {
  await fs.access(filePath);
}

function git(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
}

export async function inspectPatch(root, patchPath) {
  await ensureExists(patchPath);

  const forward = git(root, ["apply", "--check", patchPath]);
  const reverse = git(root, ["apply", "--reverse", "--check", patchPath]);

  if (forward.status === 0 && reverse.status !== 0) {
    return { state: "not_applied" };
  }
  if (reverse.status === 0 && forward.status !== 0) {
    return { state: "applied" };
  }
  return {
    state: "conflict",
    forward: forward.stderr.trim(),
    reverse: reverse.stderr.trim(),
  };
}

export async function applyPatch(root, patchPath, { dryRun = false } = {}) {
  const status = await inspectPatch(root, patchPath);
  if (status.state === "applied") return { changed: false, state: "applied" };
  if (status.state !== "not_applied") {
    throw new Error("El patch no está en un estado seguro para aplicar");
  }
  if (dryRun) return { changed: true, state: "would_apply" };

  const result = git(root, ["apply", patchPath]);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "git apply falló");
  }
  return { changed: true, state: "applied" };
}

export async function revertPatch(root, patchPath, { dryRun = false } = {}) {
  const status = await inspectPatch(root, patchPath);
  if (status.state === "not_applied")
    return { changed: false, state: "not_applied" };
  if (status.state !== "applied") {
    throw new Error("El patch no está en un estado seguro para revertir");
  }
  if (dryRun) return { changed: true, state: "would_revert" };

  const result = git(root, ["apply", "--reverse", patchPath]);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "git apply --reverse falló");
  }
  return { changed: true, state: "not_applied" };
}
