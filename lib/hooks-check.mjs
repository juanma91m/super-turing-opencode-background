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
  {
    file: "packages/opencode/src/util/keybind.ts",
    snippets: ["export function parseSequences", "export function sequenceToString"],
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

  return {
    ok: missing.length === 0,
    missing,
  }
}
