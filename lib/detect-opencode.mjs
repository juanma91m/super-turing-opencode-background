import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expandHome } from "./paths.mjs";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readVersionFromRoot(root) {
  const packageJsonPath = path.join(
    root,
    "packages",
    "opencode",
    "package.json",
  );
  const data = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  return data.version;
}

async function isSourceCheckout(root, markers) {
  const checks = await Promise.all(
    markers.map((marker) => exists(path.join(root, marker))),
  );
  return checks.every(Boolean);
}

function detectInstalledBinary() {
  const which = spawnSync("sh", ["-lc", "command -v opencode"], {
    encoding: "utf8",
  });
  let execPath = which.status === 0 ? which.stdout.trim() : undefined;
  if (!execPath) {
    const fallbackPaths = [
      path.join(process.env.HOME ?? "", ".opencode", "bin", "opencode"),
      path.join(process.env.HOME ?? "", ".local", "bin", "opencode"),
    ];
    execPath = fallbackPaths.find(
      (candidate) => candidate && requireExecutable(candidate),
    );
  }
  if (!execPath) return { method: "not-found" };

  const versionProc = spawnSync(execPath, ["--version"], { encoding: "utf8" });
  const version =
    versionProc.status === 0 ? versionProc.stdout.trim() : undefined;
  if (
    execPath.includes(`${path.sep}.opencode${path.sep}bin${path.sep}opencode`)
  ) {
    return { method: "curl-binary", execPath, version };
  }

  return { method: "binary-or-global", execPath, version };
}

function requireExecutable(filePath) {
  return existsSync(filePath);
}

export async function detectOpencodeTarget({
  compat,
  opencodeRoot,
  cwd = process.cwd(),
}) {
  const explicitRoot = expandHome(opencodeRoot || process.env.OPENCODE_ROOT);
  const markers = compat.opencode.requiredMarkers;

  if (explicitRoot) {
    const root = path.resolve(explicitRoot);
    if (await isSourceCheckout(root, markers)) {
      return {
        supported: true,
        method: "source-checkout-explicit",
        root,
        version: await readVersionFromRoot(root),
      };
    }
    return {
      supported: false,
      method: "unknown",
      message: `El root explícito no parece un checkout fuente soportado: ${root}`,
    };
  }

  if (await isSourceCheckout(cwd, markers)) {
    return {
      supported: true,
      method: "source-checkout-cwd",
      root: cwd,
      version: await readVersionFromRoot(cwd),
    };
  }

  const installed = detectInstalledBinary();
  return {
    supported: false,
    method: installed.method,
    execPath: installed.execPath,
    version: installed.version,
    message:
      installed.method === "not-found"
        ? "No se pudo detectar un target soportado de OpenCode. Pasá --opencode-root con un checkout fuente compatible."
        : `Se detectó una instalación no soportada en este MVP (${installed.method})${installed.execPath ? `: ${installed.execPath}` : ""}. Usá --opencode-root con un checkout fuente compatible.`,
  };
}
