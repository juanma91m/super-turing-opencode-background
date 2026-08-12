import fs from "node:fs/promises";
import path from "node:path";

const REQUIRED_HOOK_SIGNATURES = [
  {
    variants: [
      {
        file: "packages/plugin/src/tui.ts",
        snippets: [
          "registerAdapter: (adapter: TuiSessionAdapter)",
          "registerListAdapter: (adapter: TuiSessionListAdapter)",
          "allowSubmitWhenBusy?: boolean",
          "session_notice:",
        ],
      },
    ],
  },
  {
    variants: [
      {
        file: "packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx",
        snippets: ["allowSubmitWhenBusy?: boolean"],
      },
      {
        file: "packages/tui/src/component/prompt/index.tsx",
        snippets: ["allowSubmitWhenBusy?: boolean"],
      },
    ],
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
  {
    file: "packages/tui/src/keymap.tsx",
    snippets: ["registerOpencodeKeymap", "useCommandShortcut"],
  },
]

export async function inspectHostHooks(root) {
  const missing = []

  for (const entry of REQUIRED_HOOK_SIGNATURES) {
    let variantOk = false
    const variantProblems = []
    for (const variant of entry.variants) {
      const filePath = path.join(root, variant.file)
      let content
      try {
        content = await fs.readFile(filePath, "utf8")
      } catch {
        variantProblems.push(`${variant.file} (missing file)`)
        continue
      }
      const missingSnippets = variant.snippets.filter((snippet) => !content.includes(snippet))
      if (missingSnippets.length === 0) {
        variantOk = true
        break
      }
      variantProblems.push(...missingSnippets.map((snippet) => `${variant.file} :: ${snippet}`))
    }
    if (!variantOk) missing.push(...variantProblems)
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
      `${KEYBIND_HOOK_VARIANTS.map((variant) => variant.file).join(" or ")} :: missing compatible keybind hook implementation`,
    )
  }

  return {
    ok: missing.length === 0,
    missing,
  }
}
