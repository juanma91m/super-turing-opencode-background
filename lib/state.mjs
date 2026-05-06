import fs from "node:fs/promises";
import path from "node:path";

export const STATE_SCHEMA_VERSION = 1;

function normalizeState(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.schemaVersion !== STATE_SCHEMA_VERSION) return undefined;
  return raw;
}

export async function loadState(stateFile) {
  try {
    return normalizeState(JSON.parse(await fs.readFile(stateFile, "utf8")));
  } catch {
    return undefined;
  }
}

export async function saveState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const payload = {
    schemaVersion: STATE_SCHEMA_VERSION,
    ...state,
  };
  await fs.writeFile(
    stateFile,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

export async function removeState(stateFile) {
  await fs.rm(stateFile, { force: true });
}
