import { spawnSync } from "node:child_process";

function git(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
}

export function inspectWorktree(root) {
  const result = git(root, ["status", "--porcelain"]);
  if (result.status !== 0) {
    return {
      ok: false,
      clean: false,
      message:
        result.stderr.trim() || "No se pudo inspeccionar el worktree git",
    };
  }

  const entries = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    ok: true,
    clean: entries.length === 0,
    entries,
  };
}
