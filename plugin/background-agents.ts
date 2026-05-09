/**
 * background-agents
 * Async read-only delegation for OpenCode
 *
 * Principles for v1:
 * - delegate only to read-only agents
 * - persist full results to disk
 * - keep notifications compact
 * - survive compaction
 * - keep durable memory backends for curated semantic memory, not raw async output
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin"
import { createOpencodeClient as createOpencodeClientV2 } from "@opencode-ai/sdk/v2"

type OpencodeClient = any
type Event = any
type Part = any

type PermissionEntry = "ask" | "allow" | "deny" | Record<string, "ask" | "allow" | "deny">

type DelegationStatus = "pending" | "running" | "complete" | "error" | "cancelled" | "timeout"
type IsolatedDelegationStatus = DelegationStatus | "review_pending" | "accepted" | "discarded" | "applied"
type DelegationMode = "read-only" | "isolated-write"

interface DelegationProgress {
  toolCalls: number
  lastTool?: string
  lastUpdate: Date
  lastMessage?: string
  lastMessageAt?: Date
}

interface Delegation {
  id: string
  mode: DelegationMode
  sessionID?: string
  parentSessionID: string
  parentMessageID: string
  parentAgent: string
  prompt: string
  agent: string
  status: DelegationStatus | IsolatedDelegationStatus
  queuedAt?: Date
  startedAt?: Date
  completedAt?: Date
  title?: string
  description?: string
  result?: string
  error?: string
  worktree?: WorktreeInfo
  artifactsDir?: string
  promptPreview?: string
  worktreeRemovedAt?: Date
  worktreeCleanupNote?: string
  progress?: DelegationProgress
  concurrencyGroup?: string
}

interface DelegateInput {
  parentSessionID: string
  parentMessageID: string
  parentAgent: string
  prompt: string
  agent: string
}

interface IsolatedDelegateInput extends DelegateInput {
  name?: string
}

interface PersistedDelegationMeta {
  id: string
  mode: DelegationMode
  sessionID?: string | null
  agent: string
  parentAgent: string
  parentSessionID: string
  parentMessageID: string
  status: DelegationStatus | IsolatedDelegationStatus
  queuedAt?: string | null
  startedAt?: string | null
  completedAt?: string | null
  error?: string | null
  progress?: {
    toolCalls: number
    lastTool?: string | null
    lastUpdate: string
    lastMessage?: string | null
    lastMessageAt?: string | null
  } | null
  worktree?: WorktreeInfo | null
  artifactsDir?: string | null
  promptPreview?: string | null
  title?: string | null
  description?: string | null
  worktreeRemovedAt?: string | null
  worktreeCleanupNote?: string | null
}

interface QueueItem {
  delegationId: string
  mode: DelegationMode
  input: DelegateInput | IsolatedDelegateInput
  callerDepth?: number
}

interface CursorMessage {
  info?: {
    id?: string
    time?: { completed?: string } | string | number
    role?: string
  }
}

interface CursorState {
  lastKey?: string
  lastCount: number
}

interface WorktreeInfo {
  name: string
  branch: string
  directory: string
}

interface DelegationListItem {
  id: string
  status: DelegationStatus | string
  title?: string
  description?: string
  agent?: string
  mode?: DelegationMode
  sessionID?: string
  duration?: string
  lastTool?: string
  lastMessage?: string
}

const MAX_RUN_TIME_MS = 15 * 60 * 1000
const RECENT_COMPLETED_LIMIT = 10
const MAX_DELEGATION_CALLER_DEPTH = 1
const READ_ONLY_CONCURRENCY_LIMIT = 4
const ISOLATED_WRITE_CONCURRENCY_LIMIT = 1

const READ_ONLY_DELEGATION_MATRIX: Record<string, string[]> = {
  "master-dev": ["backend-java-developer", "frontend-web-developer", "reviewer", "code-inspector", "explorer", "ui-web-designer"],
  "frontend-web-developer": ["explorer", "code-inspector"],
  "backend-java-developer": ["explorer", "code-inspector"],
  "ui-web-designer": ["explorer"],
  reviewer: ["code-inspector"],
}

const ISOLATED_WRITE_TARGETS = new Set(["backend-java-developer", "frontend-web-developer", "master-dev"])

const ADJECTIVES = [
  "brisk",
  "calm",
  "clear",
  "bright",
  "steady",
  "keen",
  "plain",
  "swift",
  "solid",
  "sharp",
]

const COLORS = [
  "amber",
  "blue",
  "cyan",
  "green",
  "indigo",
  "orange",
  "purple",
  "silver",
  "teal",
  "violet",
]

const ANIMALS = [
  "badger",
  "falcon",
  "fox",
  "heron",
  "lynx",
  "otter",
  "owl",
  "raven",
  "tiger",
  "wolf",
]

class TimeoutError extends Error {
  readonly name = "TimeoutError" as const
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new TimeoutError(message)), ms)
    }),
  ])
}

function hashString(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16)
}

async function getProjectId(projectRoot: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-list", "--max-parents=0", "--all"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await withTimeout(proc.exited, 5000, "git rev-list timed out").catch((err) => {
      if (err instanceof TimeoutError) proc.kill()
      return 1
    })
    if (exitCode === 0) {
      const output = await new Response(proc.stdout).text()
      const roots = output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort()
      if (roots.length > 0) return roots[0].slice(0, 16)
    }
  } catch {
    // fall through
  }
  return hashString(projectRoot)
}

function isPermissionDenied(entry: PermissionEntry | undefined): boolean {
  if (entry === "deny") return true
  if (entry && typeof entry === "object" && entry["*"] === "deny") return true
  return false
}

async function isReadOnlyAgent(client: OpencodeClient, agentName: string): Promise<boolean> {
  const config = await client.config.get()
  const configData = (config?.data ?? {}) as {
    agent?: Record<string, { permission?: Record<string, PermissionEntry> }>
  }

  const permission = configData.agent?.[agentName]?.permission ?? {}
  const editDenied = isPermissionDenied(permission.edit)
  const bashDenied = isPermissionDenied(permission.bash)
  const writeDenied = permission.write === undefined ? true : isPermissionDenied(permission.write)
  return editDenied && bashDenied && writeDenied
}

function generateReadableId(existing: Set<string>): string {
  for (let attempts = 0; attempts < 20; attempts++) {
    const id = `${ADJECTIVES[crypto.randomInt(ADJECTIVES.length)]}-${COLORS[crypto.randomInt(COLORS.length)]}-${ANIMALS[crypto.randomInt(ANIMALS.length)]}`
    if (!existing.has(id)) return id
  }
  return hashString(`${Date.now()}-${Math.random()}`)
}

function firstNonEmptyLine(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "Delegation result"
}

function summarize(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > max ? `${normalized.slice(0, max).trim()}...` : normalized
}

function formatDuration(start: Date, end?: Date): string {
  const duration = (end ?? new Date()).getTime() - start.getTime()
  const seconds = Math.floor(duration / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function formatStatusLabel(status: string): string {
  return status.replace(/_/g, " ")
}

function getDelegationStatusPresentation(status: string): {
  icon: string
  label: string
  variant: "info" | "success" | "warning" | "error"
} {
  const label = formatStatusLabel(status)
  switch (status) {
    case "pending":
      return { icon: "🟡", label, variant: "info" }
    case "running":
      return { icon: "🔵", label, variant: "info" }
    case "complete":
      return { icon: "🟢", label, variant: "success" }
    case "review_pending":
      return { icon: "🟣", label, variant: "success" }
    case "accepted":
      return { icon: "✅", label, variant: "success" }
    case "applied":
      return { icon: "🟢", label, variant: "success" }
    case "cancelled":
      return { icon: "⚪", label, variant: "warning" }
    case "timeout":
      return { icon: "🟠", label, variant: "warning" }
    case "discarded":
      return { icon: "⚪", label, variant: "warning" }
    case "error":
    default:
      return { icon: "🔴", label, variant: "error" }
  }
}

function formatDelegationStatusBadge(status: string): string {
  const presentation = getDelegationStatusPresentation(status)
  return `${presentation.icon} ${presentation.label.toUpperCase()}`
}

function deriveMetadata(content: string): { title: string; description: string } {
  const title = summarize(firstNonEmptyLine(content).replace(/^#+\s*/, ""), 60)
  const description = summarize(content, 180)
  return {
    title: title || "Delegation result",
    description: description || "(No description generated)",
  }
}

function getConcurrencyLimit(mode: DelegationMode): number {
  return mode === "isolated-write" ? ISOLATED_WRITE_CONCURRENCY_LIMIT : READ_ONLY_CONCURRENCY_LIMIT
}

function buildMessageKey(message: CursorMessage, index: number): string {
  const id = message.info?.id
  if (id) return `id:${id}`

  const time = message.info?.time
  if (typeof time === "number" || typeof time === "string") {
    return `t:${time}:${index}`
  }

  const completed = time?.completed
  if (typeof completed === "string") {
    return `t:${completed}:${index}`
  }

  return `i:${index}`
}

function parseIsoDate(value?: string | null): Date | undefined {
  return value ? new Date(value) : undefined
}

function formatDurationFromDelegation(delegation: Delegation): string {
  if (delegation.status === "pending") {
    return delegation.queuedAt ? formatDuration(delegation.queuedAt) : "N/A"
  }
  return delegation.startedAt ? formatDuration(delegation.startedAt, delegation.completedAt) : "N/A"
}

function normalizeWorktreeApiError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /ConnectionRefused/i.test(message) ||
    /localhost:4096/i.test(message) ||
    /experimental\/worktree/i.test(message) ||
    /text\/html/i.test(message)
  ) {
    return new Error(
      "Worktree API is unreachable from this OpenCode runtime. delegate_isolated currently requires an active OpenCode server exposing /experimental/worktree. If you launched via plain `opencode run`, retry through `opencode serve` + `opencode run --attach <url>` (or another server-backed session) before using isolated write delegation.",
    )
  }
  return error instanceof Error ? error : new Error(message)
}

function hasAllowedDelegation(callerAgent: string | undefined, targetAgent: string): boolean {
  if (!callerAgent) return false
  return READ_ONLY_DELEGATION_MATRIX[callerAgent]?.includes(targetAgent) ?? false
}

function shouldExposeDelegateTool(callerDepth: number): boolean {
  return callerDepth <= MAX_DELEGATION_CALLER_DEPTH
}

async function runGit(args: string[], cwd: string, timeoutMs = 10000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  })
  const exitCode = await withTimeout(proc.exited, timeoutMs, `git ${args.join(" ")} timed out`).catch((err) => {
    if (err instanceof TimeoutError) proc.kill()
    return 124
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode, stdout, stderr }
}

function buildDelegationPrompt(input: DelegateInput): string {
  return `## Async Delegation Context

You are running in an isolated background session.
You do NOT inherit the caller's live conversation context beyond this prompt, your system prompt, and any explicit file or memory references included here.

Caller agent: ${input.parentAgent}

Rules:
- Treat the instructions below as the authoritative task context.
- Do not assume hidden goals, prior discussion, or unstated constraints.
- If critical context is missing, say so explicitly and stay within the declared scope.
- Prefer the narrowest reading of the task that still satisfies the stated objective.
- Use explicit file paths, memory references, and constraints from the prompt over guesswork.
- Unless the caller explicitly asks for a longer artifact, prefer concise output: short bullets, short sections, and minimal necessary explanation.
- If the task is broader than the declared output budget, prioritize the most decision-relevant findings first rather than expanding scope.

## Caller-authored task packet

${input.prompt}`
}

function buildIsolatedDelegationPrompt(input: IsolatedDelegateInput, worktree: WorktreeInfo): string {
  return `## Isolated Write Delegation Context

You are running in an isolated OpenCode worktree.
You MAY edit files only inside this worktree directory: ${worktree.directory}

Caller agent: ${input.parentAgent}
Worktree name: ${worktree.name}
Worktree branch: ${worktree.branch}

Rules:
- Do not modify the parent workspace.
- Keep changes minimal and scoped to the caller-authored task packet.
- Do not commit, push, merge, or run destructive git operations.
- If critical context is missing, stop and report what is missing instead of guessing.
- At the end, summarize changed files, validation run, and remaining risks.
- The parent will review the diff manually; there is no auto-merge.

## Caller-authored task packet

${input.prompt}`
}

function createLogger(client: OpencodeClient) {
  const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
    client?.app?.log?.({ body: { service: "background-agents", level, message } }).catch?.(() => {})

  return {
    debug: (message: string) => log("debug", message),
    info: (message: string) => log("info", message),
    warn: (message: string) => log("warn", message),
    error: (message: string) => log("error", message),
  }
}

type Logger = ReturnType<typeof createLogger>

class DelegationManager {
  private readonly client: OpencodeClient
  private readonly worktreeClient: any
  private readonly projectDirectory: string
  private readonly baseDir: string
  private readonly log: Logger
  private readonly delegations = new Map<string, Delegation>()
  private readonly pendingByParent = new Map<string, Set<string>>()
  private readonly queuesByMode = new Map<DelegationMode, QueueItem[]>()
  private readonly activeByMode = new Map<DelegationMode, number>()
  private readonly processingModes = new Set<DelegationMode>()
  private readonly sessionCursors = new Map<string, CursorState>()

  constructor(client: OpencodeClient, worktreeClient: any, projectDirectory: string, baseDir: string, log: Logger) {
    this.client = client
    this.worktreeClient = worktreeClient
    this.projectDirectory = projectDirectory
    this.baseDir = baseDir
    this.log = log
  }

  async debugLog(message: string): Promise<void> {
    const line = `${new Date().toISOString()}: ${message}\n`
    try {
      await fs.mkdir(this.baseDir, { recursive: true })
      await fs.appendFile(path.join(this.baseDir, "background-agents-debug.log"), line, "utf8")
    } catch {
      // ignore
    }
  }

  private async showToast(
    input: { title: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number },
    directory = this.projectDirectory,
  ): Promise<void> {
    try {
      if (!this.worktreeClient?.tui?.showToast) return
      const result = await withTimeout(
        this.worktreeClient.tui.showToast({
          directory,
          title: input.title,
          message: input.message,
          variant: input.variant,
          duration: input.duration,
        }),
        1500,
        "tui.showToast timed out",
      )
      if (result?.error) {
        throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error))
      }
    } catch (error) {
      await this.debugLog(`showToast failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private buildDelegationToastDetail(delegation: Delegation): string {
    const detail = `${delegation.id} · ${delegation.agent}`
    const extra = delegation.title ?? delegation.error ?? delegation.description
    return extra ? `${detail} — ${summarize(extra, 120)}` : detail
  }

  private async notifyLaunchToast(delegation: Delegation): Promise<void> {
    const title =
      delegation.status === "running"
        ? delegation.mode === "isolated-write"
          ? "Isolated task started"
          : "Background task started"
        : delegation.mode === "isolated-write"
          ? "Isolated task queued"
          : "Background task queued"
    const statusLabel = formatStatusLabel(delegation.status)
    await this.showToast({
      title,
      message: `${this.buildDelegationToastDetail(delegation)} is ${statusLabel}.`,
      variant: "info",
      duration: 3500,
    })
  }

  private async notifyTerminalToast(delegation: Delegation): Promise<void> {
    const presentation = getDelegationStatusPresentation(String(delegation.status))
    let title = `Background task ${presentation.label}`
    if (delegation.status === "review_pending") title = "Isolated task ready for review"
    else if (delegation.status === "timeout") title = "Background task timed out"
    else if (delegation.status === "cancelled") title = "Background task cancelled"
    else if (delegation.status === "error") title = "Background task failed"

    await this.showToast({
      title,
      message: this.buildDelegationToastDetail(delegation),
      variant: presentation.variant,
      duration: presentation.variant === "error" ? 7000 : 5000,
    })
  }

  private getQueue(mode: DelegationMode): QueueItem[] {
    const queue = this.queuesByMode.get(mode) ?? []
    if (!this.queuesByMode.has(mode)) this.queuesByMode.set(mode, queue)
    return queue
  }

  private getActiveCount(mode: DelegationMode): number {
    return this.activeByMode.get(mode) ?? 0
  }

  private setActiveCount(mode: DelegationMode, count: number): void {
    this.activeByMode.set(mode, Math.max(0, count))
  }

  private markQueued(delegation: Delegation, input: DelegateInput | IsolatedDelegateInput, callerDepth?: number): void {
    const queue = this.getQueue(delegation.mode)
    queue.push({ delegationId: delegation.id, mode: delegation.mode, input, callerDepth })
    delegation.status = "pending"
    delegation.queuedAt = new Date()
    delegation.startedAt = undefined
    delegation.completedAt = undefined
    delegation.progress = {
      toolCalls: 0,
      lastUpdate: delegation.queuedAt,
    }
    delegation.concurrencyGroup = delegation.mode
  }

  private async processQueue(mode: DelegationMode): Promise<void> {
    if (this.processingModes.has(mode)) return
    this.processingModes.add(mode)

    try {
      const queue = this.getQueue(mode)
      const limit = getConcurrencyLimit(mode)
      while (queue.length > 0 && this.getActiveCount(mode) < limit) {
        const item = queue.shift()!
        const delegation = this.delegations.get(item.delegationId)
        if (!delegation || delegation.status === "cancelled") continue

        this.setActiveCount(mode, this.getActiveCount(mode) + 1)
        try {
          if (mode === "isolated-write") {
            await this.startQueuedIsolatedDelegation(delegation, item.input as IsolatedDelegateInput)
          } else {
            await this.startQueuedReadOnlyDelegation(delegation, item.input as DelegateInput, item.callerDepth ?? 0)
          }
        } catch (error) {
          delegation.status = "error"
          delegation.error = error instanceof Error ? error.message : String(error)
          delegation.completedAt = new Date()
          if (delegation.mode === "isolated-write") {
            await this.captureIsolatedArtifacts(delegation, `Delegation failed before completion.\n\nError: ${delegation.error}`)
            await this.cleanupIsolatedWorktree(delegation, "Automatic cleanup after isolated delegation launch failure")
            await this.writeIsolatedSummary(delegation, delegation.result ?? `Delegation failed before completion.\n\nError: ${delegation.error}`)
          } else {
            await this.persistOutput(delegation, `Delegation failed before completion.\n\nError: ${delegation.error}`)
          }
          await this.notifyParent(delegation)
          this.releaseConcurrency(delegation)
        }
      }
    } finally {
      this.processingModes.delete(mode)
    }
  }

  private releaseConcurrency(delegation: Delegation): void {
    const mode = delegation.concurrencyGroup
    if (!mode) return
    delegation.concurrencyGroup = undefined
    this.setActiveCount(mode, this.getActiveCount(mode) - 1)
    void this.processQueue(mode)
  }

  private async consumeNewMessages<T extends CursorMessage>(sessionID: string | undefined, messages: T[]): Promise<T[]> {
    if (!sessionID) return messages

    const keys = messages.map((message, index) => buildMessageKey(message, index))
    const cursor = this.sessionCursors.get(sessionID)
    let startIndex = 0

    if (cursor) {
      if (cursor.lastCount > messages.length) {
        startIndex = 0
      } else if (cursor.lastKey) {
        const lastIndex = keys.lastIndexOf(cursor.lastKey)
        startIndex = lastIndex >= 0 ? lastIndex + 1 : 0
      }
    }

    if (messages.length === 0) {
      this.sessionCursors.delete(sessionID)
    } else {
      this.sessionCursors.set(sessionID, {
        lastKey: keys[keys.length - 1],
        lastCount: messages.length,
      })
    }

    return messages.slice(startIndex)
  }

  private resetMessageCursor(sessionID?: string): void {
    if (!sessionID) return
    this.sessionCursors.delete(sessionID)
  }

  private async saveDelegationMeta(delegation: Delegation): Promise<void> {
    const artifactsDir = await this.ensureArtifactDir(delegation)
    const meta: PersistedDelegationMeta = {
      id: delegation.id,
      mode: delegation.mode,
      sessionID: delegation.sessionID ?? null,
      agent: delegation.agent,
      parentAgent: delegation.parentAgent,
      parentSessionID: delegation.parentSessionID,
      parentMessageID: delegation.parentMessageID,
      status: delegation.status,
      queuedAt: delegation.queuedAt?.toISOString() ?? null,
      startedAt: delegation.startedAt?.toISOString() ?? null,
      completedAt: delegation.completedAt?.toISOString() ?? null,
      error: delegation.error ?? null,
      progress: delegation.progress
        ? {
            toolCalls: delegation.progress.toolCalls,
            lastTool: delegation.progress.lastTool ?? null,
            lastUpdate: delegation.progress.lastUpdate.toISOString(),
            lastMessage: delegation.progress.lastMessage ?? null,
            lastMessageAt: delegation.progress.lastMessageAt?.toISOString() ?? null,
          }
        : null,
      worktree: delegation.worktree ?? null,
      artifactsDir,
      promptPreview: delegation.promptPreview || summarize(delegation.prompt, 500),
      title: delegation.title ?? null,
      description: delegation.description ?? null,
      worktreeRemovedAt: delegation.worktreeRemovedAt?.toISOString() ?? null,
      worktreeCleanupNote: delegation.worktreeCleanupNote ?? null,
    }

    await fs.writeFile(path.join(artifactsDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8")
  }

  private hydrateDelegationMeta(meta: PersistedDelegationMeta): Delegation {
    return {
      id: meta.id,
      mode: meta.mode,
      sessionID: meta.sessionID ?? undefined,
      parentSessionID: meta.parentSessionID,
      parentMessageID: meta.parentMessageID,
      parentAgent: meta.parentAgent,
      prompt: meta.promptPreview ?? "",
      agent: meta.agent,
      status: meta.status,
      queuedAt: parseIsoDate(meta.queuedAt),
      startedAt: parseIsoDate(meta.startedAt),
      completedAt: parseIsoDate(meta.completedAt),
      error: meta.error ?? undefined,
      progress: meta.progress
        ? {
            toolCalls: meta.progress.toolCalls,
            lastTool: meta.progress.lastTool ?? undefined,
            lastUpdate: new Date(meta.progress.lastUpdate),
            lastMessage: meta.progress.lastMessage ?? undefined,
            lastMessageAt: parseIsoDate(meta.progress.lastMessageAt),
          }
        : undefined,
      title: meta.title ?? undefined,
      description: meta.description ?? undefined,
      result: undefined,
      worktree: meta.worktree ?? undefined,
      artifactsDir: meta.artifactsDir ?? undefined,
      promptPreview: meta.promptPreview ?? undefined,
      worktreeRemovedAt: parseIsoDate(meta.worktreeRemovedAt),
      worktreeCleanupNote: meta.worktreeCleanupNote ?? undefined,
      concurrencyGroup: undefined,
    }
  }

  private async loadPersistedDelegation(sessionID: string, id: string): Promise<Delegation | undefined> {
    try {
      const artifactsDir = await this.getArtifactDirForID(sessionID, id)
      const raw = await fs.readFile(path.join(artifactsDir, "meta.json"), "utf8")
      const meta = JSON.parse(raw) as PersistedDelegationMeta
      const delegation = this.hydrateDelegationMeta(meta)
      delegation.result = await this.readArtifactText(sessionID, id, "result.md")
      return delegation
    } catch {
      return undefined
    }
  }

  private async resolveDelegation(sessionID: string, id: string): Promise<Delegation> {
    const inMemory = this.delegations.get(id)
    if (inMemory) return inMemory

    const persisted = await this.loadPersistedDelegation(sessionID, id)
    if (persisted) return persisted

    throw new Error(`Delegation "${id}" not found.\n\nUse delegation_list() to see available delegations.`)
  }

  private async getSessionMessages(sessionID: string): Promise<Array<{ info?: any; parts?: Part[] }>> {
    const messages = await this.client.session.messages({ path: { id: sessionID } })
    return (messages?.data ?? []) as Array<{ info?: any; parts?: Part[] }>
  }

  private extractPartText(part: any): string {
    if (!part) return ""
    if (typeof part.text === "string") return part.text
    if (typeof part.content === "string") return part.content
    if (Array.isArray(part.content)) {
      return part.content
        .map((item: any) => (item?.type === "text" ? String(item.text ?? "") : ""))
        .join("\n")
    }
    return ""
  }

  private getMessageTimestamp(info: any): Date | undefined {
    const raw = info?.time?.completed ?? info?.time?.created ?? info?.time
    if (!raw) return undefined
    if (typeof raw === "number") return new Date(raw)
    if (typeof raw === "string") return new Date(raw)
    return undefined
  }

  private buildProgressFromMessages(messages: Array<{ info?: any; parts?: Part[] }>, previous?: DelegationProgress): DelegationProgress {
    let toolCalls = 0
    let lastTool: string | undefined
    let lastMessage: string | undefined
    let lastMessageAt: Date | undefined

    for (const message of messages) {
      const role = message.info?.role
      const parts = message.parts ?? []

      if (role === "tool") {
        toolCalls += 1
        const firstToolPart = parts.find((part: any) => part?.type === "tool") as any
        lastTool = firstToolPart?.tool || firstToolPart?.name || lastTool
      }

      const text = parts
        .map((part: any) => this.extractPartText(part))
        .join("\n")
        .trim()
      if (text) {
        lastMessage = summarize(text, 500)
        lastMessageAt = this.getMessageTimestamp(message.info) ?? lastMessageAt
      }

      const embeddedToolPart = parts.find((part: any) => part?.type === "tool") as any
      if (embeddedToolPart) {
        toolCalls += 1
        lastTool = embeddedToolPart.tool || embeddedToolPart.name || lastTool
      }
    }

    return {
      toolCalls,
      lastTool: lastTool ?? previous?.lastTool,
      lastUpdate: new Date(),
      lastMessage: lastMessage ?? previous?.lastMessage,
      lastMessageAt: lastMessageAt ?? previous?.lastMessageAt,
    }
  }

  private async refreshProgress(delegation: Delegation): Promise<void> {
    if (!delegation.sessionID || delegation.status === "pending") return
    try {
      const messages = await this.getSessionMessages(delegation.sessionID)
      delegation.progress = this.buildProgressFromMessages(messages, delegation.progress)
      if (this.delegations.has(delegation.id)) this.delegations.set(delegation.id, delegation)
      await this.saveDelegationMeta(delegation)
    } catch (error) {
      await this.debugLog(`refreshProgress failed for ${delegation.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private renderMessages(messages: Array<{ info?: any; parts?: Part[] }>): string {
    const blocks: string[] = []
    for (const message of messages) {
      const role = message.info?.role ?? "unknown"
      const timestamp = this.getMessageTimestamp(message.info)?.toISOString() ?? "N/A"
      const parts = message.parts ?? []
      const body = parts
        .map((part: any) => {
          if (part?.type === "tool") {
            const toolName = part.tool || part.name || "tool"
            const toolText = this.extractPartText(part)
            return `[tool:${toolName}]${toolText ? `\n${toolText}` : ""}`
          }
          return this.extractPartText(part)
        })
        .join("\n")
        .trim()
      if (!body) continue
      blocks.push(`## ${role} @ ${timestamp}\n\n${body}`)
    }
    return blocks.join("\n\n---\n\n")
  }

  private formatDelegationStatus(delegation: Delegation): string {
    const progress = delegation.progress
    const lines = [
      `# Delegation Status`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| ID | \`${delegation.id}\` |`,
      `| Mode | ${delegation.mode} |`,
      `| Agent | ${delegation.agent} |`,
      `| Status | **${formatDelegationStatusBadge(String(delegation.status))}** |`,
      `| Duration | ${formatDurationFromDelegation(delegation)} |`,
      `| Session ID | ${delegation.sessionID ? `\`${delegation.sessionID}\`` : "N/A"} |`,
    ]

    if (progress?.lastTool) lines.push(`| Last tool | ${progress.lastTool} |`)
    if (progress?.toolCalls !== undefined) lines.push(`| Tool calls | ${progress.toolCalls} |`)
    if (progress?.lastUpdate) lines.push(`| Last update | ${progress.lastUpdate.toISOString()} |`)

    if (delegation.sessionID) {
      lines.push(``, `> **Open session**: Use \`delegation_open("${delegation.id}")\` to jump into the delegated session.`)
    }

    if (delegation.status === "pending") {
      lines.push(``, `> **Queued**: Waiting for a concurrency slot to start.`)
    } else if (delegation.status === "running") {
      lines.push(``, `> **Running**: Use \`delegation_tail("${delegation.id}")\` for incremental output.`)
    } else if (delegation.status === "cancelled") {
      lines.push(``, `> **Cancelled**: The delegation was stopped before normal completion.`)
    } else if (delegation.status === "timeout") {
      lines.push(``, `> **Timed out**: The delegation exceeded the allowed runtime.`)
    }

    if (progress?.lastMessage) {
      lines.push(``, `## Last Message`, ``, "```", progress.lastMessage, "```")
    }

    return lines.join("\n")
  }

  findBySession(sessionID: string): Delegation | undefined {
    for (const delegation of this.delegations.values()) {
      if (delegation.sessionID === sessionID) return delegation
    }
    return undefined
  }

  getRunningDelegations(): Delegation[] {
    return Array.from(this.delegations.values()).filter((d) => d.status === "running")
  }

  getActiveDelegations(): Delegation[] {
    return Array.from(this.delegations.values()).filter((d) => d.status === "running" || d.status === "pending")
  }

  async getRootSessionID(sessionID: string): Promise<string> {
    let currentID = sessionID
    for (let depth = 0; depth < 10; depth++) {
      try {
        const session = await this.client.session.get({ path: { id: currentID } })
        const parentID = session?.data?.parentID
        if (!parentID) return currentID
        currentID = parentID
      } catch {
        return currentID
      }
    }
    return currentID
  }

  async getDelegationDepth(sessionID: string): Promise<number> {
    let depthCount = 0
    let currentID = sessionID
    for (let depth = 0; depth < 10; depth++) {
      if (this.findBySession(currentID)) depthCount++
      try {
        const session = await this.client.session.get({ path: { id: currentID } })
        const parentID = session?.data?.parentID
        if (!parentID) return depthCount
        currentID = parentID
      } catch {
        return depthCount
      }
    }
    return depthCount
  }

  private async getDelegationsDir(sessionID: string): Promise<string> {
    const rootID = await this.getRootSessionID(sessionID)
    return path.join(this.baseDir, rootID)
  }

  private async ensureDelegationsDir(sessionID: string): Promise<string> {
    const dir = await this.getDelegationsDir(sessionID)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  private async ensureArtifactDir(delegation: Delegation): Promise<string> {
    if (delegation.artifactsDir) return delegation.artifactsDir
    const dir = path.join(await this.ensureDelegationsDir(delegation.parentSessionID), delegation.id)
    await fs.mkdir(dir, { recursive: true })
    delegation.artifactsDir = dir
    return dir
  }

  private async getArtifactDirForID(sessionID: string, id: string): Promise<string> {
    return path.join(await this.getDelegationsDir(sessionID), id)
  }

  private async readArtifactText(sessionID: string, id: string, filename: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(await this.getArtifactDirForID(sessionID, id), filename), "utf8")
    } catch {
      return undefined
    }
  }

  private async saveIsolatedMeta(delegation: Delegation): Promise<void> {
    await this.saveDelegationMeta(delegation)
  }

  private async writeIsolatedSummary(delegation: Delegation, content: string): Promise<void> {
    const artifactsDir = await this.ensureArtifactDir(delegation)
    let changedFiles: string[] = []
    try {
      const raw = await fs.readFile(path.join(artifactsDir, "changed-files.json"), "utf8")
      changedFiles = JSON.parse(raw) as string[]
    } catch {
      changedFiles = []
    }

    const cleanupLines = [
      `**Worktree Removed At:** ${delegation.worktreeRemovedAt?.toISOString() || "N/A"}`,
      `**Cleanup Note:** ${delegation.worktreeCleanupNote || "N/A"}`,
    ]

    const summary = `# ${delegation.title || delegation.id}

${delegation.description || summarize(content, 180) || "(No description generated)"}

**ID:** ${delegation.id}
**Mode:** isolated-write
**Agent:** ${delegation.agent}
**Status:** ${delegation.status}
**Started:** ${delegation.startedAt?.toISOString() || "N/A"}
**Completed:** ${delegation.completedAt?.toISOString() || "N/A"}
**Worktree:** ${delegation.worktree?.directory || "N/A"}
**Artifacts:** ${artifactsDir}
${cleanupLines.join("\n")}

## Changed Files

${changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join("\n") : "(none detected)"}

## Result

${content}

## Review

Review artifacts before applying anything to the main workspace. This plugin does not auto-merge isolated changes.`

    await fs.writeFile(path.join(await this.ensureDelegationsDir(delegation.parentSessionID), `${delegation.id}.md`), summary, "utf8")
  }

  private async loadPersistedIsolatedDelegation(sessionID: string, id: string): Promise<Delegation | undefined> {
    try {
      const artifactsDir = await this.getArtifactDirForID(sessionID, id)
      const raw = await fs.readFile(path.join(artifactsDir, "meta.json"), "utf8")
      const meta = JSON.parse(raw) as PersistedDelegationMeta
      const delegation = this.hydrateDelegationMeta(meta)
      delegation.result = await this.readArtifactText(sessionID, id, "result.md")
      delegation.artifactsDir = delegation.artifactsDir || artifactsDir
      return delegation
    } catch {
      return undefined
    }
  }

  private async resolveIsolatedDelegation(sessionID: string, id: string): Promise<Delegation> {
    const inMemory = this.delegations.get(id)
    if (inMemory?.mode === "isolated-write") return inMemory

    const persisted = await this.loadPersistedIsolatedDelegation(sessionID, id)
    if (persisted?.mode === "isolated-write") return persisted

    throw new Error(`Isolated delegation "${id}" not found.`)
  }

  private async cleanupIsolatedWorktree(delegation: Delegation, reason: string, throwOnFailure = false): Promise<void> {
    if (!delegation.worktree?.directory) return

    try {
      await this.worktreeClient.worktree.remove({
        directory: this.projectDirectory,
        worktreeRemoveInput: { directory: delegation.worktree.directory },
      })
      delegation.worktreeRemovedAt = new Date()
      delegation.worktreeCleanupNote = reason
    } catch (error) {
      const normalized = normalizeWorktreeApiError(error)
      delegation.worktreeCleanupNote = `${reason}. Cleanup failed: ${normalized.message}`
      if (throwOnFailure) throw normalized
      await this.debugLog(`cleanupIsolatedWorktree failed for ${delegation.id}: ${delegation.worktreeCleanupNote}`)
    }
  }

  private async validateTargetAgent(agentName: string): Promise<void> {
    const agentsResult = await this.client.app.agents({})
    const agents = (agentsResult?.data ?? []) as Array<{ name: string; description?: string }>
    const match = agents.find((agent) => agent.name === agentName)
    if (!match) {
      const available = agents.map((agent) => `• ${agent.name}${agent.description ? ` - ${agent.description}` : ""}`).join("\n")
      throw new Error(`Agent "${agentName}" not found.\n\nAvailable agents:\n${available || "(none)"}`)
    }

    const readOnly = await isReadOnlyAgent(this.client, agentName)
    if (!readOnly) {
      throw new Error(
        `Agent "${agentName}" is write-capable. In async v1, delegate only supports read-only agents. Use task for synchronous work, or wait for isolated write-capable async in v2.`,
      )
    }
  }

  private async validateReadOnlyDelegation(input: DelegateInput): Promise<void> {
    await this.validateTargetAgent(input.agent)

    if (!hasAllowedDelegation(input.parentAgent, input.agent)) {
      throw new Error(
        `Agent "${input.parentAgent}" is not allowed to delegate to "${input.agent}". Allowed targets: ${(READ_ONLY_DELEGATION_MATRIX[input.parentAgent] ?? []).join(", ") || "none"}.`,
      )
    }

    const callerDepth = await this.getDelegationDepth(input.parentSessionID)
    if (callerDepth > MAX_DELEGATION_CALLER_DEPTH) {
      throw new Error(
        `Delegation depth exceeded. Caller depth is ${callerDepth}; maximum allowed caller depth is ${MAX_DELEGATION_CALLER_DEPTH}.`,
      )
    }
  }

  private async validateIsolatedWriteDelegation(input: IsolatedDelegateInput): Promise<void> {
    const agentsResult = await this.client.app.agents({})
    const agents = (agentsResult?.data ?? []) as Array<{ name: string; description?: string }>
    const match = agents.find((agent) => agent.name === input.agent)
    if (!match) {
      const available = agents.map((agent) => `• ${agent.name}${agent.description ? ` - ${agent.description}` : ""}`).join("\n")
      throw new Error(`Agent "${input.agent}" not found.\n\nAvailable agents:\n${available || "(none)"}`)
    }

    if (input.parentAgent !== "master-dev") {
      throw new Error(`delegate_isolated is restricted to master-dev. Caller was "${input.parentAgent}".`)
    }

    if (!ISOLATED_WRITE_TARGETS.has(input.agent)) {
      throw new Error(`Agent "${input.agent}" is not allowed for isolated write delegation.`)
    }

    const callerDepth = await this.getDelegationDepth(input.parentSessionID)
    if (callerDepth !== 0) {
      throw new Error("delegate_isolated can only be launched from the root orchestration session.")
    }
  }

  private async startQueuedReadOnlyDelegation(delegation: Delegation, input: DelegateInput, callerDepth: number): Promise<void> {
    const sessionResult = await this.client.session.create({
      body: {
        title: `Delegation: ${delegation.id}`,
        parentID: input.parentSessionID,
      },
    })

    if (!sessionResult?.data?.id) {
      throw new Error("Failed to create delegation session")
    }

    delegation.sessionID = sessionResult.data.id
    delegation.status = "running"
    delegation.startedAt = new Date()
    delegation.completedAt = undefined
    delegation.error = undefined
    delegation.progress = {
      toolCalls: 0,
      lastUpdate: delegation.startedAt,
    }
    await this.saveDelegationMeta(delegation)

    setTimeout(() => {
      const current = this.delegations.get(delegation.id)
      if (current?.status === "running") {
        void this.handleTimeout(delegation.id)
      }
    }, MAX_RUN_TIME_MS + 5000)

    this.client.session
      .prompt({
        path: { id: delegation.sessionID },
        body: {
          agent: input.agent,
          parts: [{ type: "text", text: buildDelegationPrompt(input) }],
          tools: {
            task: false,
            delegate: shouldExposeDelegateTool(callerDepth + 1),
            delegation_open: false,
            delegation_read: false,
            delegation_list: false,
            delegation_tail: false,
            delegation_cancel: false,
            delegation_continue: false,
            delegation_apply: false,
            delegation_accept: false,
            delegation_discard: false,
            delegate_isolated: false,
            todowrite: false,
          },
        },
      })
      .catch(async (error: Error) => {
        delegation.status = "error"
        delegation.error = error.message
        delegation.completedAt = new Date()
        await this.persistOutput(delegation, `Delegation failed before completion.\n\nError: ${error.message}`)
        this.releaseConcurrency(delegation)
        await this.notifyParent(delegation)
      })

    void this.monitorDelegationUntilTerminal(delegation.id)
  }

  private async startQueuedIsolatedDelegation(delegation: Delegation, input: IsolatedDelegateInput): Promise<void> {
    if (!this.worktreeClient?.worktree?.create) {
      throw new Error("OpenCode worktree API is unavailable; cannot launch isolated write delegation.")
    }

    const worktreeName = input.name || `delegate-${delegation.id}`
    let worktreeResult: any
    try {
      worktreeResult = await this.worktreeClient.worktree.create({
        directory: this.projectDirectory,
        worktreeCreateInput: { name: worktreeName },
      })
    } catch (error) {
      throw normalizeWorktreeApiError(error)
    }
    const worktree = worktreeResult?.data as WorktreeInfo | undefined
    if (!worktree?.directory) {
      if (worktreeResult?.error) {
        throw normalizeWorktreeApiError(new Error(JSON.stringify(worktreeResult.error)))
      }
      const errorDetails = worktreeResult?.error
        ? JSON.stringify(worktreeResult.error)
        : JSON.stringify(worktreeResult?.data ?? null)
      throw new Error(`Failed to create isolated worktree. Response: ${errorDetails}`)
    }

    const sessionResult = await this.client.session.create({
      query: { directory: worktree.directory },
      body: {
        title: `Isolated delegation: ${delegation.id}`,
        parentID: input.parentSessionID,
      },
    })

    if (!sessionResult?.data?.id) {
      throw new Error("Failed to create isolated delegation session")
    }

    delegation.worktree = worktree
    delegation.sessionID = sessionResult.data.id
    delegation.status = "running"
    delegation.startedAt = new Date()
    delegation.completedAt = undefined
    delegation.error = undefined
    delegation.progress = {
      toolCalls: 0,
      lastUpdate: delegation.startedAt,
    }
    await this.ensureArtifactDir(delegation)
    await this.saveDelegationMeta(delegation)

    setTimeout(() => {
      const current = this.delegations.get(delegation.id)
      if (current?.status === "running") {
        void this.handleTimeout(delegation.id)
      }
    }, MAX_RUN_TIME_MS + 5000)

    this.client.session
      .prompt({
        path: { id: delegation.sessionID },
        query: { directory: worktree.directory },
        body: {
          agent: input.agent,
          parts: [{ type: "text", text: buildIsolatedDelegationPrompt(input, worktree) }],
          tools: {
            bash: false,
            task: false,
            delegate: false,
            delegation_open: false,
            delegation_read: false,
            delegation_list: false,
            delegation_tail: false,
            delegation_cancel: false,
            delegation_continue: false,
            delegation_apply: false,
            delegation_accept: false,
            delegation_discard: false,
            delegate_isolated: false,
            todowrite: false,
          },
        },
      })
      .catch(async (error: Error) => {
        delegation.status = "error"
        delegation.error = error.message
        delegation.completedAt = new Date()
        await this.captureIsolatedArtifacts(delegation, `Isolated delegation failed before completion.\n\nError: ${error.message}`)
        await this.cleanupIsolatedWorktree(delegation, "Automatic cleanup after isolated delegation error")
        await this.saveIsolatedMeta(delegation)
        await this.writeIsolatedSummary(delegation, delegation.result ?? `Isolated delegation failed before completion.\n\nError: ${error.message}`)
        this.releaseConcurrency(delegation)
        await this.notifyParent(delegation)
      })

    void this.monitorDelegationUntilTerminal(delegation.id)
  }

  async delegate(input: DelegateInput): Promise<Delegation> {
    await this.validateReadOnlyDelegation(input)
    const callerDepth = await this.getDelegationDepth(input.parentSessionID)

    const id = generateReadableId(new Set(this.delegations.keys()))
    const delegation: Delegation = {
      id,
      mode: "read-only",
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
      parentAgent: input.parentAgent,
      prompt: input.prompt,
      agent: input.agent,
      status: "pending",
    }

    this.delegations.set(delegation.id, delegation)
    await this.ensureDelegationsDir(input.parentSessionID)

    if (!this.pendingByParent.has(input.parentSessionID)) {
      this.pendingByParent.set(input.parentSessionID, new Set())
    }
    this.pendingByParent.get(input.parentSessionID)?.add(delegation.id)

    this.markQueued(delegation, input, callerDepth)
    await this.saveDelegationMeta(delegation)
    void this.notifyLaunchToast(delegation)
    void this.processQueue("read-only")

    return delegation
  }

  async delegateIsolated(input: IsolatedDelegateInput): Promise<Delegation> {
    await this.validateIsolatedWriteDelegation(input)

    const id = generateReadableId(new Set(this.delegations.keys()))

    const delegation: Delegation = {
      id,
      mode: "isolated-write",
      parentSessionID: input.parentSessionID,
      parentMessageID: input.parentMessageID,
      parentAgent: input.parentAgent,
      prompt: input.prompt,
      agent: input.agent,
      status: "pending",
    }

    this.delegations.set(delegation.id, delegation)
    await this.ensureDelegationsDir(input.parentSessionID)

    if (!this.pendingByParent.has(input.parentSessionID)) {
      this.pendingByParent.set(input.parentSessionID, new Set())
    }
    this.pendingByParent.get(input.parentSessionID)?.add(delegation.id)

    this.markQueued(delegation, input)
    await this.saveDelegationMeta(delegation)
    void this.notifyLaunchToast(delegation)
    void this.processQueue("isolated-write")

    return delegation
  }

  private async hasTerminalAssistantMessage(delegation: Delegation): Promise<boolean> {
    if (!delegation.sessionID) return false
    const messages = await this.client.session.messages({ path: { id: delegation.sessionID } })
    const items = (messages?.data ?? []) as Array<{ info?: any; parts?: Part[] }>
    const last = items[items.length - 1]
    if (!last || last.info?.role !== "assistant") return false

    const finish = String(last.info?.finish ?? "")
    const completed = Boolean(last.info?.time?.completed)
    const hasRunningTool = (last.parts ?? []).some((part: any) => part?.type === "tool" && part?.state?.status === "running")
    const hasText = (last.parts ?? []).some((part: any) => part?.type === "text" && String(part.text ?? "").trim())

    return !hasRunningTool && (finish === "stop" || (completed && hasText))
  }

  private async monitorDelegationUntilTerminal(delegationId: string): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < MAX_RUN_TIME_MS + 10000) {
      const delegation = this.delegations.get(delegationId)
      if (!delegation || delegation.status !== "running") return

      try {
        await this.refreshProgress(delegation)
        const terminal = await this.hasTerminalAssistantMessage(delegation)
        if (terminal) {
          if (delegation.sessionID) await this.handleSessionIdle(delegation.sessionID)
          return
        }
      } catch (error) {
        await this.debugLog(`monitorDelegationUntilTerminal check failed for ${delegationId}: ${error instanceof Error ? error.message : String(error)}`)
      }

      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  async acceptIsolated(sessionID: string, id: string): Promise<Delegation> {
    const delegation = await this.resolveIsolatedDelegation(sessionID, id)

    if (delegation.status === "accepted") {
      return delegation
    }

    if (delegation.status !== "review_pending") {
      throw new Error(`Isolated delegation "${id}" is not awaiting review. Current status: ${delegation.status}.`)
    }

    delegation.status = "accepted"
    delegation.completedAt = delegation.completedAt ?? new Date()
    const content = delegation.result ?? (await this.readArtifactText(sessionID, id, "result.md")) ?? "(No result content available)"
    delegation.result = content

    await this.captureIsolatedArtifacts(delegation, content)
    if (this.delegations.has(id)) this.delegations.set(id, delegation)
    return delegation
  }

  async applyIsolated(sessionID: string, id: string): Promise<Delegation> {
    const delegation = await this.resolveIsolatedDelegation(sessionID, id)

    if (delegation.status === "applied") {
      return delegation
    }

    if (delegation.status !== "accepted") {
      throw new Error(`Isolated delegation "${id}" must be accepted before apply. Current status: ${delegation.status}.`)
    }

    const artifactsDir = delegation.artifactsDir ?? (await this.getArtifactDirForID(sessionID, id))
    const diffPath = path.join(artifactsDir, "diff.patch")
    let diffContent = await this.readArtifactText(sessionID, id, "diff.patch")
    if (!diffContent?.trim()) {
      diffContent = await this.buildPatchFromWorktree(delegation)
      if (!diffContent.trim()) {
        throw new Error(`Cannot apply isolated delegation "${id}": diff artifact is missing/empty and no patch could be rebuilt from the worktree.`)
      }
      await fs.writeFile(diffPath, diffContent, "utf8")
    }

    const statusCheck = await runGit(["status", "--porcelain"], this.projectDirectory)
    if (statusCheck.exitCode !== 0) {
      throw new Error(`Failed to inspect main workspace status before apply.\n\n${statusCheck.stderr || statusCheck.stdout || "Unknown git status failure."}`)
    }

    if ((statusCheck.stdout || "").trim()) {
      throw new Error("Main workspace is not clean. Commit, stash, or discard local changes before using delegation_apply.")
    }

    const checkApply = await runGit(["apply", "--check", diffPath], this.projectDirectory, 30000)
    if (checkApply.exitCode !== 0) {
      throw new Error(`Diff cannot be applied cleanly to the main workspace.\n\n${checkApply.stderr || checkApply.stdout || "git apply --check failed."}`)
    }

    const applyResult = await runGit(["apply", diffPath], this.projectDirectory, 30000)
    if (applyResult.exitCode !== 0) {
      throw new Error(`Failed to apply diff to the main workspace.\n\n${applyResult.stderr || applyResult.stdout || "git apply failed."}`)
    }

    delegation.status = "applied"
    delegation.completedAt = delegation.completedAt ?? new Date()
    const content = delegation.result ?? (await this.readArtifactText(sessionID, id, "result.md")) ?? "(No result content available)"
    delegation.result = content
    await this.cleanupIsolatedWorktree(delegation, "Applied to main workspace")
    await this.saveIsolatedMeta(delegation)
    await this.writeIsolatedSummary(delegation, content)
    if (this.delegations.has(id)) this.delegations.set(id, delegation)
    return delegation
  }

  async discardIsolated(sessionID: string, id: string): Promise<Delegation> {
    const delegation = await this.resolveIsolatedDelegation(sessionID, id)

    if (delegation.status === "discarded") {
      return delegation
    }

    if (delegation.status === "applied") {
      throw new Error(`Isolated delegation "${id}" was already applied and cannot be discarded.`)
    }

    if (delegation.status === "running") {
      throw new Error(`Isolated delegation "${id}" is still running. Wait for completion before discarding.`)
    }

    const content = delegation.result ?? (await this.readArtifactText(sessionID, id, "result.md")) ?? "(No result content available)"
    delegation.result = content
    if (!delegation.worktreeRemovedAt) {
      await this.cleanupIsolatedWorktree(delegation, "Discarded by operator", true)
    } else {
      delegation.worktreeCleanupNote = delegation.worktreeCleanupNote || "Discarded after prior automatic cleanup"
    }
    delegation.status = "discarded"
    delegation.completedAt = delegation.completedAt ?? new Date()

    await this.saveIsolatedMeta(delegation)
    await this.writeIsolatedSummary(delegation, content)
    if (this.delegations.has(id)) this.delegations.set(id, delegation)
    return delegation
  }

  async cancelDelegation(sessionID: string, id: string): Promise<Delegation> {
    const delegation = await this.resolveDelegation(sessionID, id)
    this.delegations.set(delegation.id, delegation)

    if (["complete", "applied", "discarded", "accepted", "review_pending"].includes(String(delegation.status))) {
      throw new Error(`Delegation "${id}" is already in terminal review/completion state (${delegation.status}) and cannot be cancelled.`)
    }

    if (delegation.status === "pending") {
      const queue = this.getQueue(delegation.mode)
      const index = queue.findIndex((item) => item.delegationId === delegation.id)
      if (index >= 0) queue.splice(index, 1)
      delegation.status = "cancelled"
      delegation.completedAt = new Date()
      delegation.error = "Cancelled before start"
      if (delegation.mode === "isolated-write") {
        await this.captureIsolatedArtifacts(delegation, `Delegation cancelled before start.`)
        await this.writeIsolatedSummary(delegation, delegation.result ?? `Delegation cancelled before start.`)
      } else {
        await this.persistOutput(delegation, `Delegation cancelled before start.`)
      }
      await this.notifyParent(delegation)
      if (this.delegations.has(id)) this.delegations.set(id, delegation)
      return delegation
    }

    if (delegation.status !== "running") {
      return delegation
    }

    delegation.completedAt = new Date()
    const partial = await this.getResult(delegation)
    delegation.status = "cancelled"
    delegation.error = "Cancelled by operator"

    if (delegation.sessionID) {
      try {
        await this.client.session.delete({ path: { id: delegation.sessionID } })
        delegation.sessionID = undefined
      } catch {
        // ignore
      }
    }

    if (delegation.mode === "isolated-write") {
      await this.captureIsolatedArtifacts(delegation, `${partial}\n\n[CANCELLED]`)
      await this.cleanupIsolatedWorktree(delegation, "Automatic cleanup after isolated delegation cancellation")
      await this.writeIsolatedSummary(delegation, delegation.result ?? `${partial}\n\n[CANCELLED]`)
    } else {
      await this.persistOutput(delegation, `${partial}\n\n[CANCELLED]`)
    }

    this.releaseConcurrency(delegation)
    await this.notifyParent(delegation)
    if (this.delegations.has(id)) this.delegations.set(id, delegation)
    return delegation
  }

  async cancelAllForSession(sessionID: string): Promise<Delegation[]> {
    const delegations = await this.listDelegations(sessionID)
    const cancellable = delegations.filter((item) => item.status === "pending" || item.status === "running")
    const cancelled: Delegation[] = []

    for (const item of cancellable) {
      try {
        cancelled.push(await this.cancelDelegation(sessionID, item.id))
      } catch (error) {
        await this.debugLog(`cancelAllForSession failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return cancelled
  }

  async tailOutput(sessionID: string, id: string): Promise<string> {
    const delegation = await this.resolveDelegation(sessionID, id)
    if (!delegation.sessionID) {
      return this.formatDelegationStatus(delegation)
    }

    const messages = await this.getSessionMessages(delegation.sessionID)
    const relevant = messages.filter((message) => message.info?.role === "assistant" || message.info?.role === "tool")
    const newMessages = await this.consumeNewMessages(delegation.sessionID, relevant)
    await this.refreshProgress(delegation)

    if (newMessages.length === 0) {
      return `${this.formatDelegationStatus(delegation)}\n\n(No new output since last tail)`
    }

    return `${this.formatDelegationStatus(delegation)}\n\n${this.renderMessages(newMessages)}`
  }

  async continueDelegation(sessionID: string, id: string, prompt: string): Promise<Delegation> {
    const delegation = await this.resolveDelegation(sessionID, id)
    this.delegations.set(delegation.id, delegation)
    if (delegation.mode !== "read-only") {
      throw new Error(`delegation_continue currently supports read-only delegations only. Delegation "${id}" is ${delegation.mode}.`)
    }
    if (!delegation.sessionID) {
      throw new Error(`Delegation "${id}" has no persisted session to continue.`)
    }
    if (delegation.status === "pending" || delegation.status === "running") {
      throw new Error(`Delegation "${id}" is already ${delegation.status}. Wait for it to settle before continuing.`)
    }

    delegation.status = "running"
    delegation.queuedAt = undefined
    delegation.startedAt = new Date()
    delegation.completedAt = undefined
    delegation.error = undefined
    delegation.prompt = `${delegation.prompt}\n\n[FOLLOW-UP]\n${prompt}`
    delegation.promptPreview = summarize(delegation.prompt, 500)
    delegation.progress = {
      toolCalls: delegation.progress?.toolCalls ?? 0,
      lastTool: delegation.progress?.lastTool,
      lastUpdate: delegation.startedAt,
      lastMessage: delegation.progress?.lastMessage,
      lastMessageAt: delegation.progress?.lastMessageAt,
    }
    delegation.concurrencyGroup = "read-only"
    if (!this.pendingByParent.has(delegation.parentSessionID)) {
      this.pendingByParent.set(delegation.parentSessionID, new Set())
    }
    this.pendingByParent.get(delegation.parentSessionID)?.add(delegation.id)
    this.setActiveCount("read-only", this.getActiveCount("read-only") + 1)
    await this.saveDelegationMeta(delegation)
    void this.notifyLaunchToast(delegation)

    this.client.session
      .prompt({
        path: { id: delegation.sessionID },
        body: {
          agent: delegation.agent,
          parts: [{ type: "text", text: prompt }],
          tools: {
            task: false,
            delegate: false,
            delegation_open: false,
            delegation_read: false,
            delegation_list: false,
            delegation_tail: false,
            delegation_cancel: false,
            delegation_continue: false,
            delegation_apply: false,
            delegation_accept: false,
            delegation_discard: false,
            delegate_isolated: false,
            todowrite: false,
          },
        },
      })
      .catch(async (error: Error) => {
        delegation.status = "error"
        delegation.error = error.message
        delegation.completedAt = new Date()
        await this.persistOutput(delegation, `Delegation continuation failed.\n\nError: ${error.message}`)
        this.releaseConcurrency(delegation)
        await this.notifyParent(delegation)
      })

    void this.monitorDelegationUntilTerminal(delegation.id)
    return delegation
  }

  private async waitForCompletion(delegationId: string): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < MAX_RUN_TIME_MS + 10000) {
      const delegation = this.delegations.get(delegationId)
      if (!delegation || (delegation.status !== "running" && delegation.status !== "pending")) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  private async handleTimeout(delegationId: string): Promise<void> {
    const delegation = this.delegations.get(delegationId)
    if (!delegation || delegation.status !== "running") return

    delegation.status = "timeout"
    delegation.completedAt = new Date()
    delegation.error = `Delegation timed out after ${MAX_RUN_TIME_MS / 1000}s`
    const result = await this.getResult(delegation)

    if (delegation.sessionID) {
      try {
        await this.client.session.delete({ path: { id: delegation.sessionID } })
        delegation.sessionID = undefined
      } catch {
        // ignore
      }
    }

    if (delegation.mode === "isolated-write") {
      await this.captureIsolatedArtifacts(delegation, `${result}\n\n[TIMEOUT REACHED]`)
      await this.cleanupIsolatedWorktree(delegation, "Automatic cleanup after isolated delegation timeout")
      await this.saveIsolatedMeta(delegation)
      await this.writeIsolatedSummary(delegation, `${result}\n\n[TIMEOUT REACHED]`)
    } else {
      await this.persistOutput(delegation, `${result}\n\n[TIMEOUT REACHED]`)
    }
    this.releaseConcurrency(delegation)
    await this.notifyParent(delegation)
  }

  async handleSessionIdle(sessionID: string): Promise<void> {
    const delegation = this.findBySession(sessionID)
    if (!delegation || delegation.status !== "running") return

    delegation.completedAt = new Date()
    delegation.result = await this.getResult(delegation)
    await this.refreshProgress(delegation)
    const metadata = deriveMetadata(delegation.result)
    delegation.title = metadata.title
    delegation.description = metadata.description

    if (delegation.mode === "isolated-write") {
      delegation.status = "review_pending"
      await this.captureIsolatedArtifacts(delegation, delegation.result)
    } else {
      delegation.status = "complete"
      await this.persistOutput(delegation, delegation.result)
    }
    this.releaseConcurrency(delegation)
    await this.notifyParent(delegation)
  }

  private async getResult(delegation: Delegation): Promise<string> {
    if (!delegation.sessionID) {
      return `Delegation ${delegation.id} has no active session.`
    }
    try {
      const messages = await this.client.session.messages({ path: { id: delegation.sessionID } })
      const items = (messages?.data ?? []) as Array<{ info?: { role?: string }; parts?: Part[] }>
      const assistants = items.filter((item) => item.info?.role === "assistant")
      if (assistants.length === 0) {
        return `Delegation ${delegation.id} completed but produced no assistant response.`
      }

      const last = assistants[assistants.length - 1]
      const text = (last.parts ?? [])
        .filter((part: any) => part?.type === "text")
        .map((part: any) => String(part.text ?? ""))
        .join("\n")
        .trim()

      return text || `Delegation ${delegation.id} completed but produced no text output.`
    } catch (error) {
      return `Delegation ${delegation.id} completed but result retrieval failed: ${error instanceof Error ? error.message : "Unknown error"}`
    }
  }

  private async buildPatchFromWorktree(delegation: Delegation): Promise<string> {
    const worktreeDir = delegation.worktree?.directory
    if (!worktreeDir) return ""

    const status = await runGit(["status", "--short"], worktreeDir)
    const trackedDiff = await runGit(["diff", "--binary"], worktreeDir, 30000)
    let patch = trackedDiff.stdout || ""

    const untrackedFiles = (status.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())

    for (const file of untrackedFiles) {
      const diff = await runGit(["diff", "--binary", "--no-index", "--", "/dev/null", file], worktreeDir, 30000)
      if (diff.exitCode !== 0 && diff.exitCode !== 1 && !diff.stdout) {
        throw new Error(`Failed to build patch for untracked file "${file}": ${diff.stderr || diff.stdout || "Unknown git diff failure."}`)
      }
      if (!diff.stdout) continue
      if (patch && !patch.endsWith("\n")) patch += "\n"
      patch += diff.stdout
    }

    return patch
  }

  private async captureIsolatedArtifacts(delegation: Delegation, content: string): Promise<void> {
    const artifactsDir = await this.ensureArtifactDir(delegation)
    delegation.result = content
    const worktreeDir = delegation.worktree?.directory
    const status = worktreeDir ? await runGit(["status", "--short"], worktreeDir).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error) })) : undefined
    const diffText = worktreeDir ? await this.buildPatchFromWorktree(delegation).catch((error) => `STDERR:\n${error instanceof Error ? error.message : String(error)}`) : undefined
    const changedFiles = (status?.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^\S+\s+/, ""))

    await Promise.all([
      fs.writeFile(path.join(artifactsDir, "result.md"), content, "utf8"),
      fs.writeFile(path.join(artifactsDir, "changed-files.json"), JSON.stringify(changedFiles, null, 2), "utf8"),
      fs.writeFile(path.join(artifactsDir, "git-status.txt"), status ? `${status.stdout}${status.stderr ? `\nSTDERR:\n${status.stderr}` : ""}` : "No worktree directory recorded.", "utf8"),
      fs.writeFile(path.join(artifactsDir, "diff.patch"), diffText ?? "No worktree directory recorded.", "utf8"),
      fs.writeFile(path.join(artifactsDir, "worktree.json"), JSON.stringify(delegation.worktree ?? null, null, 2), "utf8"),
    ])
    await this.saveIsolatedMeta(delegation)
    await this.writeIsolatedSummary(delegation, content)
  }

  private async persistOutput(delegation: Delegation, content: string): Promise<void> {
    try {
      const dir = await this.ensureDelegationsDir(delegation.parentSessionID)
      const filePath = path.join(dir, `${delegation.id}.md`)
      const artifactsDir = await this.ensureArtifactDir(delegation)
      const title = delegation.title || delegation.id
      const description = delegation.description || summarize(content, 180) || "(No description generated)"
      const promptPreview = summarize(delegation.prompt, 240)

      const body = `# ${title}

${description}

**ID:** ${delegation.id}
**Agent:** ${delegation.agent}
**Status:** ${delegation.status}
**Started:** ${delegation.startedAt?.toISOString() || "N/A"}
**Completed:** ${delegation.completedAt?.toISOString() || "N/A"}
**Prompt Preview:** ${promptPreview}

---

${content}`

      await Promise.all([
        fs.writeFile(filePath, body, "utf8"),
        fs.writeFile(path.join(artifactsDir, "result.md"), content, "utf8"),
      ])
      delegation.result = content
      await this.saveDelegationMeta(delegation)
    } catch (error) {
      await this.debugLog(`persistOutput failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async notifyParent(delegation: Delegation): Promise<void> {
    try {
      void this.notifyTerminalToast(delegation)

      const pendingSet = this.pendingByParent.get(delegation.parentSessionID)
      pendingSet?.delete(delegation.id)
      const allComplete = !pendingSet || pendingSet.size === 0
      if (allComplete) {
        this.pendingByParent.delete(delegation.parentSessionID)
      }

      const titleLine = delegation.title ? `\nTitle: ${delegation.title}` : ""
      const sessionHint = delegation.sessionID
        ? `\nUse delegation_open("${delegation.id}") to jump into the child session.`
        : ""
      const completionNotification = `[TASK NOTIFICATION]\nID: ${delegation.id}\nStatus: ${delegation.status}${titleLine}${sessionHint}\nUse delegation_read("${delegation.id}") to retrieve the full result.`

      await this.client.session.prompt({
        path: { id: delegation.parentSessionID },
        body: {
          noReply: true,
          agent: delegation.parentAgent,
          parts: [{ type: "text", text: completionNotification }],
        },
      })

      if (allComplete) {
        await this.client.session.prompt({
          path: { id: delegation.parentSessionID },
          body: {
            noReply: false,
            agent: delegation.parentAgent,
            parts: [{ type: "text", text: "[TASK NOTIFICATION] All background delegations complete." }],
          },
        })
      }
    } catch (error) {
      await this.debugLog(`notifyParent failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async readOutput(sessionID: string, id: string, wait = false): Promise<string> {
    const delegation = await this.resolveDelegation(sessionID, id)
    if (delegation.status === "pending" || delegation.status === "running") {
      await this.refreshProgress(delegation)
      if (!wait) {
        return `${this.formatDelegationStatus(delegation)}\n\nUse delegation_tail("${id}") for incremental output, or delegation_read("${id}", wait=true) if you intentionally want to block.`
      }
      await this.waitForCompletion(id)
    }

    const dir = await this.getDelegationsDir(sessionID)
    const filePath = path.join(dir, `${id}.md`)
    try {
      return await fs.readFile(filePath, "utf8")
    } catch {
      if (delegation.result) return delegation.result
      return `Delegation "${id}" ended with status: ${delegation.status}.${delegation.error ? ` ${delegation.error}` : ""}`
    }
  }

  async listDelegations(sessionID: string): Promise<DelegationListItem[]> {
    const results: DelegationListItem[] = []

    for (const delegation of this.delegations.values()) {
      if (delegation.status === "running") {
        await this.refreshProgress(delegation)
      }
      results.push({
        id: delegation.id,
        status: delegation.status,
        title: delegation.title || "(generating...)",
        description: delegation.description || summarize(delegation.prompt, 120),
        agent: delegation.agent,
        mode: delegation.mode,
        sessionID: delegation.sessionID,
        duration: formatDurationFromDelegation(delegation),
        lastTool: delegation.progress?.lastTool,
        lastMessage: delegation.progress?.lastMessage,
      })
    }

    try {
      const dir = await this.getDelegationsDir(sessionID)
      const files = await fs.readdir(dir)
      for (const file of files) {
        if (!file.endsWith(".md")) continue
        const id = file.replace(/\.md$/, "")
        if (results.find((item) => item.id === id)) continue

        const filePath = path.join(dir, file)
        const content = await fs.readFile(filePath, "utf8")
        const metaRaw = await this.readArtifactText(sessionID, id, "meta.json")
        if (metaRaw) {
          const meta = JSON.parse(metaRaw) as PersistedDelegationMeta
          const delegation = this.hydrateDelegationMeta(meta)
          results.push({
            id,
            status: delegation.status,
            title: delegation.title ?? id,
            description: delegation.description ?? "(loaded from storage)",
            agent: delegation.agent,
            mode: delegation.mode,
            sessionID: delegation.sessionID,
            duration: formatDurationFromDelegation(delegation),
            lastTool: delegation.progress?.lastTool,
            lastMessage: delegation.progress?.lastMessage,
          })
          continue
        }

        const titleMatch = content.match(/^# (.+)$/m)
        const descriptionMatch = content.split("\n").find((line, index, lines) => index > 0 && line.trim() && !line.startsWith("**") && lines[index - 1]?.startsWith("# "))
        const agentMatch = content.match(/^\*\*Agent:\*\* (.+)$/m)
        const statusMatch = content.match(/^\*\*Status:\*\* (.+)$/m)

        results.push({
          id,
          status: statusMatch?.[1] ?? "complete",
          title: titleMatch?.[1] ?? id,
          description: descriptionMatch ?? "(loaded from storage)",
          agent: agentMatch?.[1],
        })
      }
    } catch {
      // ignore missing directory
    }

    return results.sort((a, b) => a.id.localeCompare(b.id))
  }

  async openDelegationSession(sessionID: string, id: string): Promise<string> {
    const delegation = await this.resolveDelegation(sessionID, id)
    if (!delegation.sessionID) {
      if (delegation.status === "pending") {
        return `Delegation "${id}" is still pending and has no child session yet. Wait for it to start, or use delegation_read("${id}") after completion.`
      }
      return `Delegation "${id}" has no live child session to open. Use delegation_read("${id}") to inspect persisted output.`
    }

    if (!this.worktreeClient?.tui?.selectSession) {
      return `This OpenCode runtime does not expose TUI session navigation. Use delegation_read("${id}") to inspect persisted output.`
    }

    const directory = delegation.worktree?.directory || this.projectDirectory
    try {
      const result = await withTimeout(
        this.worktreeClient.tui.selectSession({
          directory,
          sessionID: delegation.sessionID,
        }),
        2000,
        "tui.selectSession timed out",
      )
      if (result?.error) {
        throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error))
      }
      return `Opened delegation session: ${delegation.id}\nSession ID: ${delegation.sessionID}\nAgent: ${delegation.agent}`
    } catch (error) {
      return `Could not open delegation session for "${id}". Use delegation_read("${id}") to inspect persisted output.\n\nReason: ${error instanceof Error ? error.message : "Unknown error"}`
    }
  }

  async getRecentCompletedDelegations(sessionID: string): Promise<DelegationListItem[]> {
    const all = await this.listDelegations(sessionID)
    return all.filter((item) => item.status !== "running" && item.status !== "pending").slice(-RECENT_COMPLETED_LIMIT)
  }
}

function formatDelegationContext(
  running: Array<{ id: string; agent?: string; prompt?: string; startedAt?: Date; queuedAt?: Date; status?: string }>,
  completed: DelegationListItem[],
): string {
  const sections: string[] = ["<delegation-context>"]

  if (running.length > 0) {
    sections.push("## Active Delegations", "")
    for (const delegation of running) {
      sections.push(`### \`${delegation.id}\`${delegation.agent ? ` (${delegation.agent})` : ""}`)
      if (delegation.status) sections.push(`**Status:** ${delegation.status}`)
      if (delegation.startedAt) sections.push(`**Started:** ${delegation.startedAt.toISOString()}`)
      else if (delegation.queuedAt) sections.push(`**Queued:** ${delegation.queuedAt.toISOString()}`)
      if (delegation.prompt) sections.push(`**Prompt:** ${summarize(delegation.prompt, 200)}`)
      sections.push("")
    }
    sections.push("> You WILL be notified when delegations complete.")
    sections.push("> Do NOT poll delegation_list(). Continue productive work.", "")
  }

  if (completed.length > 0) {
    sections.push("## Recent Completed Delegations", "")
    for (const delegation of completed) {
      sections.push(`- \`${delegation.id}\` [${delegation.status}]${delegation.title ? ` — ${delegation.title}` : ""}`)
    }
    sections.push("", "> Use delegation_open(id) to jump into a persisted child session when available, or delegation_read(id) for the stored result.", "")
  }

  sections.push("## Retrieval")
  sections.push('Use `delegation_open("id")` to navigate into a child session when it exists.')
  sections.push('Use `delegation_read("id")` to access full delegation output.')
  sections.push("</delegation-context>")
  return sections.join("\n")
}

function createDelegate(manager: DelegationManager) {
  return tool({
    description: `Delegate a task to a read-only agent. Returns immediately with a readable ID.

Use this for:
- research and exploration
- review and analysis
- design work that does not edit files
- any task where you want persistent, retrievable output while continuing productive work

Results are persisted to disk and survive compaction. Nested read-only delegation is policy-limited to approved caller/target pairs and one secondary level.`,
    args: {
      prompt: tool.schema.string().describe("Detailed prompt for the delegated read-only agent. Include enough context for an isolated worker: objective, why, scope, constraints, relevant facts, exact paths or memory references, and expected output. Prefer English for consistency."),
      agent: tool.schema.string().describe("Target read-only agent name, for example code-inspector, reviewer, explorer, or ui-web-designer."),
    },
    async execute(args: { prompt: string; agent: string }, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegate requires sessionID. This is a system error."
      if (!toolCtx?.messageID) return "❌ delegate requires messageID. This is a system error."

      try {
        const delegation = await manager.delegate({
          parentSessionID: toolCtx.sessionID,
          parentMessageID: toolCtx.messageID,
          parentAgent: toolCtx.agent,
          prompt: args.prompt,
          agent: args.agent,
        })

        const activeCount = manager.getRunningDelegations().filter((d) => d.parentSessionID === toolCtx.sessionID).length
        let response = `Delegation queued: ${delegation.id}\nAgent: ${args.agent}\nStatus: ${delegation.status}`
        if (activeCount > 1) response += `\n\n${activeCount} delegations now active.`
        response += `\nUse delegation_open("${delegation.id}") once it starts if you want to jump into the child session.`
        response += "\nYou WILL be notified when it completes. Use delegation_tail(id) if you need incremental progress. Do NOT poll delegation_list()."
        return response
      } catch (error) {
        return `❌ Delegation failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
      }
    },
  })
}

function createDelegateIsolated(manager: DelegationManager) {
  return tool({
    description: `Delegate write-capable implementation work to an isolated OpenCode worktree.

Use this only from master-dev when parallel implementation is worthwhile and the result must be reviewed manually before integration.
It creates a sandbox worktree, runs the target write-capable agent there, and persists result artifacts including git status and diff.patch.
It does NOT commit, merge, apply, or push changes.`,
    args: {
      prompt: tool.schema.string().describe("Detailed implementation prompt. Include objective, why, scope, constraints, exact files or areas, validation expectations, and expected final summary."),
      agent: tool.schema.string().describe("Target write-capable agent. Allowed: backend-java-developer, frontend-web-developer, master-dev."),
      name: tool.schema.string().optional().describe("Optional worktree name. Defaults to delegate-<id>."),
    },
    async execute(args: { prompt: string; agent: string; name?: string }, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegate_isolated requires sessionID. This is a system error."
      if (!toolCtx?.messageID) return "❌ delegate_isolated requires messageID. This is a system error."

      try {
        const delegation = await manager.delegateIsolated({
          parentSessionID: toolCtx.sessionID,
          parentMessageID: toolCtx.messageID,
          parentAgent: toolCtx.agent,
          prompt: args.prompt,
          agent: args.agent,
          name: args.name,
        })

        return `Isolated delegation queued: ${delegation.id}\nAgent: ${args.agent}\nStatus: ${delegation.status}\nUse delegation_open("${delegation.id}") once it starts if you want to jump into the child session.\nYou WILL be notified when it reaches review_pending/error/timeout. No changes will be applied automatically.`
      } catch (error) {
        return `❌ Isolated delegation failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
      }
    },
  })
}

function createDelegationAccept(manager: DelegationManager) {
  return tool({
    description: `Mark an isolated write delegation as accepted for manual integration later.
Use this after reviewing the persisted diff and artifacts. It keeps the worktree and updates status to accepted.`,
    args: {
      id: tool.schema.string().describe("Delegation ID for an isolated write task."),
    },
    async execute(args: { id: string }, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegation_accept requires sessionID. This is a system error."
      if (toolCtx?.agent !== "master-dev") return '❌ delegation_accept is restricted to master-dev.'

      try {
        const delegation = await manager.acceptIsolated(toolCtx.sessionID, args.id)
        return `Delegation accepted: ${delegation.id}\nStatus: ${delegation.status}\nWorktree: ${delegation.worktree?.directory || "N/A"}\nArtifacts: ${delegation.artifactsDir || "stored"}`
      } catch (error) {
        return `❌ delegation_accept failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
      }
    },
  })
}

function createDelegationDiscard(manager: DelegationManager) {
  return tool({
    description: `Discard an isolated write delegation and remove its worktree.
Artifacts are preserved for audit, but the sandbox worktree is deleted.`,
    args: {
      id: tool.schema.string().describe("Delegation ID for an isolated write task."),
    },
    async execute(args: { id: string }, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegation_discard requires sessionID. This is a system error."
      if (toolCtx?.agent !== "master-dev") return '❌ delegation_discard is restricted to master-dev.'

      try {
        const delegation = await manager.discardIsolated(toolCtx.sessionID, args.id)
        return `Delegation discarded: ${delegation.id}\nStatus: ${delegation.status}\nArtifacts: ${delegation.artifactsDir || "stored"}`
      } catch (error) {
        return `❌ delegation_discard failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
      }
    },
  })
}

function createDelegationApply(manager: DelegationManager) {
  return tool({
    description: `Apply an accepted isolated write delegation to the main workspace.
Use this only after review. It requires a clean main workspace, checks patch applicability first, applies the persisted diff without committing, and then attempts worktree cleanup.`,
    args: {
      id: tool.schema.string().describe("Delegation ID for an accepted isolated write task."),
    },
    async execute(args: { id: string }, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegation_apply requires sessionID. This is a system error."
      if (toolCtx?.agent !== "master-dev") return '❌ delegation_apply is restricted to master-dev.'

      try {
        const delegation = await manager.applyIsolated(toolCtx.sessionID, args.id)
        const worktreeRemoved = delegation.worktreeRemovedAt ? "yes" : "no"
        return `Delegation applied: ${delegation.id}\nStatus: ${delegation.status}\nWorktree removed: ${worktreeRemoved}\nWorkspace now contains unstaged changes from the accepted diff.`
      } catch (error) {
        return `❌ delegation_apply failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
      }
    },
  })
}

function createDelegationRead(manager: DelegationManager) {
  return tool({
    description: `Read the output of a delegation by its ID.
Use this to retrieve full results from delegated tasks, especially after compaction or when a compact notification already arrived.
If the delegation is still pending/running, it returns current status unless wait=true.`,
    args: {
      id: tool.schema.string().describe("Delegation ID, for example brisk-blue-falcon."),
      wait: tool.schema.boolean().optional().describe("If true, wait for the delegation to finish before returning. Default: false."),
    },
    async execute(args: { id: string; wait?: boolean }, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegation_read requires sessionID. This is a system error."
      return manager.readOutput(toolCtx.sessionID, args.id, args.wait === true)
    },
  })
}

function createDelegationOpen(manager: DelegationManager) {
  return tool({
    description: `Open the child session for a delegation in the TUI when one exists.
Use this to jump directly into a live or persisted worker session from its delegation ID.`,
    args: {
      id: tool.schema.string().describe("Delegation ID, for example brisk-blue-falcon."),
    },
    async execute(args: { id: string }, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegation_open requires sessionID. This is a system error."
      try {
        return await manager.openDelegationSession(toolCtx.sessionID, args.id)
      } catch (error) {
        return `❌ delegation_open failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
      }
    },
  })
}

function createDelegationTail(manager: DelegationManager) {
  return tool({
    description: `Read only new incremental output from a running delegation.
Use this when you want progress updates without blocking or re-reading the entire persisted result.`,
    args: {
      id: tool.schema.string().describe("Delegation ID, for example brisk-blue-falcon."),
    },
    async execute(args: { id: string }, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegation_tail requires sessionID. This is a system error."
      return manager.tailOutput(toolCtx.sessionID, args.id)
    },
  })
}

function createDelegationCancel(manager: DelegationManager) {
  return tool({
    description: `Cancel a pending or running delegation.
Use all=true to cancel all cancellable delegations for the current session tree.`,
    args: {
      id: tool.schema.string().optional().describe("Delegation ID to cancel."),
      all: tool.schema.boolean().optional().describe("Cancel all pending/running delegations for the current session tree. Default: false."),
    },
    async execute(args: { id?: string; all?: boolean }, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegation_cancel requires sessionID. This is a system error."
      try {
        if (args.all === true) {
          const cancelled = await manager.cancelAllForSession(toolCtx.sessionID)
          if (cancelled.length === 0) return "No pending or running delegations to cancel."
          return `Cancelled ${cancelled.length} delegations:\n${cancelled.map((item) => `- ${item.id} [${item.status}]`).join("\n")}`
        }
        if (!args.id) return "❌ delegation_cancel requires id or all=true."
        const delegation = await manager.cancelDelegation(toolCtx.sessionID, args.id)
        return `Delegation cancelled: ${delegation.id}\nStatus: ${delegation.status}`
      } catch (error) {
        return `❌ delegation_cancel failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
      }
    },
  })
}

function createDelegationContinue(manager: DelegationManager) {
  return tool({
    description: `Continue a completed read-only delegation in the same background session.
Use this when follow-up questions benefit from preserving the subagent's prior context.`,
    args: {
      id: tool.schema.string().describe("Delegation ID to continue."),
      prompt: tool.schema.string().describe("Follow-up prompt to send into the existing read-only delegation session."),
    },
    async execute(args: { id: string; prompt: string }, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegation_continue requires sessionID. This is a system error."
      try {
        const delegation = await manager.continueDelegation(toolCtx.sessionID, args.id, args.prompt)
        return `Delegation continued: ${delegation.id}\nAgent: ${delegation.agent}\nStatus: ${delegation.status}\nUse delegation_open("${delegation.id}") to jump into the worker session, or delegation_tail("${delegation.id}") for incremental output.`
      } catch (error) {
        return `❌ delegation_continue failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
      }
    },
  })
}

function createDelegationList(manager: DelegationManager) {
  return tool({
    description: `List delegations for the current session.
Use sparingly. Do NOT use this as a polling loop while waiting for completion notifications.`,
    args: {},
    async execute(_args: Record<string, never>, toolCtx: ToolContext): Promise<string> {
      if (!toolCtx?.sessionID) return "❌ delegation_list requires sessionID. This is a system error."

      const delegations = await manager.listDelegations(toolCtx.sessionID)
      if (delegations.length === 0) return "No delegations found for this session."

      const lines = delegations.map((delegation) => {
        const title = delegation.title ? ` — ${delegation.title}` : ""
        const description = delegation.description ? `\n  → ${delegation.description}` : ""
        const meta = [formatDelegationStatusBadge(delegation.status), delegation.mode, delegation.duration, delegation.lastTool ? `last tool: ${delegation.lastTool}` : ""]
          .filter(Boolean)
          .join(" | ")
        const commands = delegation.sessionID
          ? `\n  ↗ open: \`delegation_open("${delegation.id}")\` | read: \`delegation_read("${delegation.id}")\``
          : `\n  ↗ read: \`delegation_read("${delegation.id}")\``
        const progress = delegation.lastMessage ? `\n  ↳ ${delegation.lastMessage}` : ""
        return `- **${delegation.id}**${title}${meta ? `\n  ${meta}` : ""}${commands}${description}${progress}`
      })
      return `## Delegations\n\n${lines.join("\n")}`
    },
  })
}

const DELEGATION_RULES = `<task-notification>
<delegation-system>

## Async Background Delegation

You have tools for parallel background work:
- \`delegate(prompt, agent)\` - Launch a background task and get an ID immediately
- \`delegate_isolated(prompt, agent, name?)\` - Launch write-capable work in an isolated worktree for manual review
- \`delegation_open(id)\` - Jump into the child session when it exists
- \`delegation_read(id)\` - Retrieve the full persisted result
- \`delegation_tail(id)\` - Retrieve only new incremental output/status from a running delegation
- \`delegation_list()\` - List delegations (use sparingly)
- \`delegation_cancel(id | all=true)\` - Cancel pending or running delegations
- \`delegation_continue(id, prompt)\` - Continue a completed read-only delegation in the same session
- \`delegation_apply(id)\` - Apply an accepted isolated delegation to the main workspace
- \`delegation_accept(id)\` - Mark an isolated write delegation as accepted after review
- \`delegation_discard(id)\` - Discard an isolated write delegation and remove its worktree

## When to Use delegate vs task

| Tool | Behavior | Use When |
|------|----------|----------|
| \`delegate\` | Async, background, persisted to disk | Read-only work where you can continue productively while it runs |
| \`delegate_isolated\` | Async, isolated OpenCode worktree, persisted diff artifacts | master-dev needs parallel implementation without touching the main workspace |
| \`task\` | Synchronous, blocks until complete | You need the result before continuing, or the work can write/edit/execute with risk |

## Critical Constraints

- \`delegate\` is ONLY for read-only target agents.
- \`delegate\` is restricted by caller/target policy and max nested depth 1.
- Approved nested read-only paths: master-dev -> any specialist/read-only agent; frontend/backend -> explorer or code-inspector; ui-web-designer -> explorer; reviewer -> code-inspector.
- Never use \`delegate\` for write-capable implementation work.
- \`delegate_isolated\` is restricted to master-dev and allowed write-capable targets. It never auto-merges; review artifacts first.
- \`delegation_apply\` is restricted to master-dev, requires an \`accepted\` isolated delegation, and requires a clean main workspace.
- \`delegation_accept\` and \`delegation_discard\` are also restricted to master-dev.
- If a delegation result contains durable knowledge, save a curated summary to the durable memory backend with \`mem_save\` instead of storing the raw output there.

## Context Contract (MANDATORY)

When calling \`delegate\`, the prompt you send MUST include enough context for an isolated worker to act correctly.

Include, when relevant:
- Objective: what exactly the delegated agent must do
- Why: why this matters now
- Scope: what is in and out of scope
- Relevant facts/evidence already known
- Exact file paths, directories, or artifacts to inspect
- Relevant durable memory references or memory findings if they matter
- Expected output shape (bullets, report, checklist, etc.)
- Output budget (for example: max 5 bullets, max 15 lines, or concise only)

Do NOT assume the delegated agent can infer hidden context from the parent conversation.

## How It Works

1. Call \`delegate(prompt, agent)\`
2. Continue productive work while it runs in the background
3. Receive a compact notification with ID and status only
4. Use \`delegation_open(id)\` to jump into the child session, \`delegation_tail(id)\` for incremental progress, and \`delegation_read(id)\` when you need the full result

For \`delegate_isolated\`, wait for \`review_pending\`, then inspect the persisted summary, worktree path, changed files, and \`diff.patch\`.
After review:
- use \`delegation_accept(id)\` to keep the reviewed worktree for manual integration later,
- use \`delegation_apply(id)\` only after acceptance, when the main workspace is clean and you want to apply the stored diff without committing,
- use \`delegation_discard(id)\` to remove the worktree and close it out.

On isolated \`error\` or \`timeout\`, the plugin attempts automatic worktree cleanup and preserves artifacts for audit.

## Anti-patterns

- NEVER poll \`delegation_list()\` in a loop while waiting.
- NEVER sit idle waiting for a background task if there is other productive work to do.
- NEVER assume the compact notification contains the full result.
- NEVER forget that \`delegation_continue\` is for read-only follow-up, not for restarting isolated write review/apply flow.
- NEVER send vague prompts like "inspect this" or "continue from before" without explicit context.
- NEVER ask for a long open-ended report when a short decision-support artifact would do.
- NEVER use \`delegate_isolated\` as a way to bypass review, tests, or ownership of final integration.
- NEVER use \`delegation_apply\` on a dirty main workspace.

</delegation-system>
</task-notification>`

interface SystemTransformInput {
  agent?: string
  sessionID?: string
}

export const BackgroundAgents: Plugin = async (ctx) => {
  const { client, directory, serverUrl } = ctx
  const log = createLogger(client as OpencodeClient)
  const worktreeClient = createOpencodeClientV2({
    baseUrl: serverUrl.toString(),
    directory,
  })
  const projectId = await getProjectId(directory)
  const baseDir = path.join(os.homedir(), ".local", "share", "opencode", "delegations", projectId)
  await fs.mkdir(baseDir, { recursive: true })

  const manager = new DelegationManager(client as OpencodeClient, worktreeClient, directory, baseDir, log)

  return {
    tool: {
      delegate: createDelegate(manager),
      delegation_open: createDelegationOpen(manager),
      delegation_read: createDelegationRead(manager),
      delegation_tail: createDelegationTail(manager),
      delegation_list: createDelegationList(manager),
      delegation_cancel: createDelegationCancel(manager),
      delegation_continue: createDelegationContinue(manager),
      delegation_apply: createDelegationApply(manager),
      delegation_accept: createDelegationAccept(manager),
      delegation_discard: createDelegationDiscard(manager),
      delegate_isolated: createDelegateIsolated(manager),
    },

    "experimental.chat.system.transform": async (_input: SystemTransformInput, output) => {
      const combined = [...output.system, DELEGATION_RULES].join("\n\n---\n\n")
      output.system = [combined]
    },

    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[] },
    ) => {
      const rootSessionID = await manager.getRootSessionID(input.sessionID)
      const running = manager
        .getActiveDelegations()
        .filter((delegation) => delegation.parentSessionID === input.sessionID || delegation.parentSessionID === rootSessionID)
        .map((delegation) => ({
          id: delegation.id,
          agent: delegation.agent,
          prompt: delegation.prompt,
          startedAt: delegation.startedAt,
          queuedAt: delegation.queuedAt,
          status: delegation.status,
        }))

      const completed = await manager.getRecentCompletedDelegations(input.sessionID)
      if (running.length === 0 && completed.length === 0) return

      output.context.push(formatDelegationContext(running, completed))
    },

    event: async ({ event }: { event: Event }): Promise<void> => {
      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID
        const delegation = manager.findBySession(sessionID)
        if (delegation) await manager.handleSessionIdle(sessionID)
      }
    },
  }
}

export default BackgroundAgents
