import { fail } from "./cli.mjs";

export function ensureSupportedTarget(manifest, target) {
  if (!target.supported) {
    fail({ message: target.message }, 2);
  }

  if (!manifest.compat.opencode.supportedVersions.includes(target.version)) {
    fail(
      {
        message: `Versión de OpenCode no soportada por este alpha: ${target.version}`,
      },
      2,
    );
  }

  const patchPath = manifest.patchPathFor(target.version);
  if (!patchPath) {
    fail(
      {
        message: `No existe patch versionado para OpenCode ${target.version}`,
      },
      2,
    );
  }

  return patchPath;
}
