import { fail } from "./cli.mjs";

export function resolveCompatibleMode(manifest, target) {
  const modes = manifest.compat.opencode.modes ?? {};

  for (const [id, config] of Object.entries(modes)) {
    const versionOk = Boolean(
      target.version && config.supportedVersions.includes(target.version),
    );
    const methodOk = config.supportedDetectionMethods.includes(target.method);
    if (!versionOk || !methodOk) continue;

    return {
      id,
      supported: true,
      supportLevel: config.supportLevel,
      patchRequired: config.requiresPatch === true,
      requiresCleanWorktree: config.requiresCleanWorktree === true,
      patchPath:
        config.requiresPatch === true
          ? manifest.patchPathFor(target.version)
          : undefined,
      notes: config.notes,
    };
  }

  return {
    id: "unsupported",
    supported: false,
    supportLevel: "unsupported",
    patchRequired: false,
    requiresCleanWorktree: false,
    patchPath: undefined,
    notes: target.message,
  };
}

export function ensureCompatibleMode(manifest, target) {
  const mode = resolveCompatibleMode(manifest, target);

  if (!mode.supported) {
    fail(
      {
        message:
          target.message ||
          `No hay modo compatible para el método ${target.method}${target.version ? ` y la versión ${target.version}` : ""}.`,
      },
      2,
    );
  }

  if (mode.patchRequired && !mode.patchPath) {
    fail(
      {
        message: `No existe patch versionado para OpenCode ${target.version}`,
      },
      2,
    );
  }

  return mode;
}
