import fs from "node:fs/promises";
import path from "node:path";

const REQUIRED_HOOK_SIGNATURES = [
  {
    file: "packages/plugin/src/tui.ts",
    snippets: ["registerAdapter: (adapter: TuiSessionAdapter)", "registerListAdapter: (adapter: TuiSessionListAdapter)", "allowSubmitWhenBusy?: boolean", "session_notice:"],
  },
  {
    file: "packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx",
    snippets: ["allowSubmitWhenBusy?: boolean"],
  },
]

const KEYBIND_HOOK_VARIANTS = [
  {
    file: "packages/opencode/src/util/keybind.ts",
    snippets: ["export function parseSequences", "export function sequenceToString"],
  },
  {
    file: "packages/opencode/src/cli/cmd/tui/keymap.tsx",
    snippets: ["registerOpencodeKeymap", "useCommandShortcut"],
  },
]

export async function inspectHostHooks(root) {
  const missing = []

  for (const entry of REQUIRED_HOOK_SIGNATURES) {
    const filePath = path.join(root, entry.file)
    let content
    try {
      content = await fs.readFile(filePath, "utf8")
    } catch {
      missing.push(`${entry.file} (missing file)`)
      continue
    }
    for (const snippet of entry.snippets) {
      if (!content.includes(snippet)) {
        missing.push(`${entry.file} :: ${snippet}`)
      }
    }
  }

  let keybindVariantOk = false
  for (const variant of KEYBIND_HOOK_VARIANTS) {
    const filePath = path.join(root, variant.file)
    let content
    try {
      content = await fs.readFile(filePath, "utf8")
    } catch {
      continue
    }
    if (variant.snippets.every((snippet) => content.includes(snippet))) {
      keybindVariantOk = true
      break
    }
  }
  if (!keybindVariantOk) {
    missing.push(
      `${KEYBIND_HOOK_VARIANTS[0].file} or ${KEYBIND_HOOK_VARIANTS[1].file} :: missing compatible keybind hook implementation`,
    )
  }

  return {
    ok: missing.length === 0,
    missing,
  }
}
