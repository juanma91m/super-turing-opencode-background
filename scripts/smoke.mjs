import path from "node:path";
import { spawnSync } from "node:child_process";
import { runCli, fail } from "../lib/cli.mjs";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);

function runNodeScript(scriptName, options) {
  const args = [path.join(scriptDir, `${scriptName}.mjs`)];
  if (options.opencodeRoot) {
    args.push("--opencode-root", options.opencodeRoot);
  }
  args.push("--dry-run");
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
  });
  return {
    command: scriptName,
    exitCode: result.status ?? 1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

await runCli("smoke", async (options) => {
  if (!options.opencodeRoot) {
    fail(
      {
        message:
          "smoke requiere --opencode-root apuntando a un checkout fuente compatible.",
      },
      2,
    );
  }

  const commands = ["status", "enable", "disable", "reapply"];
  const results = commands.map((command) => runNodeScript(command, options));
  const failed = results.filter((result) => result.exitCode !== 0);

  if (failed.length > 0) {
    fail(
      {
        message: "Smoke validation failed",
        details: failed.map(
          (result) =>
            `${result.command}: exit=${result.exitCode} ${result.stdout || result.stderr}`,
        ),
      },
      1,
    );
  }

  return {
    message: `Smoke validation OK para ${options.opencodeRoot}`,
    details: results.map(
      (result) => `${result.command}: exit=${result.exitCode}`,
    ),
  };
});
