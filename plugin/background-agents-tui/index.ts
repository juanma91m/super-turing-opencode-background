import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createElement } from "@opentui/solid";
import type { Message, Part, TextPartInput } from "@opencode-ai/sdk/v2";
import type {
  TuiPlugin,
  TuiPluginModule,
  TuiSessionAdapterContext,
  TuiSessionListAdapterContext,
  TuiSessionListProjection,
  TuiSessionProjection,
} from "@opencode-ai/plugin/tui";

type ToastVariant = "info" | "success" | "warning" | "error";
type DelegationStatus =
  | "pending"
  | "running"
  | "complete"
  | "error"
  | "cancelled"
  | "timeout"
  | "review_pending"
  | "accepted"
  | "discarded"
  | "applied";
type SessionRunStatus = "queued" | "running" | "done" | "error" | "needs_input";
type TaskSource = "delegation" | "session-run";

interface PersistedDelegationMeta {
  id: string;
  mode: "read-only" | "isolated-write";
  sessionID?: string | null;
  agent: string;
  status: DelegationStatus | string;
  queuedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
  title?: string | null;
  description?: string | null;
}

interface SessionRunRef {
  id: string;
  source: "foreground-detach" | "prompt-async";
  sequence?: number;
  title?: string;
  bgTaskToken?: string;
  inspectionHostSessionID?: string;
  parentUserMessageID?: string;
  assistantMessageID?: string;
  createdAt: number;
  detachedAt: number;
}

interface SessionBackgroundState {
  backgroundModeEnabled: boolean;
  trackedTaskRefs: SessionRunRef[];
  threadRootSessionID?: string;
}

interface BackgroundThreadState {
  rootSessionID: string;
  foregroundSessionID: string;
  title?: string;
  nextSequence?: number;
}

interface InspectionState {
  sessionID: string;
  sourceSessionID?: string;
  returnSessionID?: string;
  taskSource?: TaskSource;
  taskID?: string;
  parentUserMessageID?: string;
  assistantMessageID?: string;
}

interface TaskRecord {
  id: string;
  source: TaskSource;
  sequence?: number;
  status: string;
  mode: string;
  title?: string;
  description?: string;
  agent?: string;
  sessionID?: string;
  error?: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  parentUserMessageID?: string;
  assistantMessageID?: string;
  currentSession?: boolean;
}

interface Snapshot {
  projectId?: string;
  items: TaskRecord[];
  counts: {
    pending: number;
    running: number;
    complete: number;
    error: number;
    review_pending: number;
    needs_input: number;
  };
  backgroundModeEnabled: boolean;
  currentSessionID?: string;
}

interface SessionMessageRecord {
  info: Message;
  parts: Part[];
}

type TaskDialogValue =
  | { kind: "action"; action: "background-current" | "queue-prompt" }
  | { kind: "task"; task: TaskRecord };

const POLL_INTERVAL_MS = 2500;
const TOASTABLE_STATUSES = new Set([
  "complete",
  "done",
  "error",
  "review_pending",
  "timeout",
  "cancelled",
  "needs_input",
]);
const SESSION_STATE_PREFIX = "background-agents-tui";
const MAX_TRACKED_SESSION_RUNS = 25;

function hashString(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function randomToken(): string {
  return crypto.randomBytes(6).toString("hex");
}

function normalizePositiveInt(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

class TimeoutError extends Error {
  readonly name = "TimeoutError" as const;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new TimeoutError(message)), ms);
    }),
  ]);
}

async function getProjectId(projectRoot: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-list", "--max-parents=0", "--all"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await withTimeout(
      proc.exited,
      5000,
      "git rev-list timed out",
    ).catch((err) => {
      if (err instanceof TimeoutError) proc.kill();
      return 1;
    });
    if (exitCode === 0) {
      const output = await new Response(proc.stdout).text();
      const roots = output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort();
      if (roots.length > 0) return roots[0].slice(0, 16);
    }
  } catch {
    // fall through
  }
  return hashString(projectRoot);
}

function summarize(text: string | undefined, max = 120): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > max
    ? `${normalized.slice(0, max).trim()}...`
    : normalized;
}

function formatStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "pendiente";
    case "queued":
      return "encolada";
    case "running":
      return "corriendo";
    case "complete":
    case "done":
      return "completada";
    case "review_pending":
      return "lista para revisión";
    case "accepted":
      return "aceptada";
    case "applied":
      return "aplicada";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelada";
    case "discarded":
      return "descartada";
    case "needs_input":
      return "necesita input";
    case "error":
      return "error";
    default:
      return status.replace(/_/g, " ");
  }
}

function getStatusPresentation(status: string): {
  icon: string;
  label: string;
  variant: ToastVariant;
} {
  const label = formatStatusLabel(status);
  switch (status) {
    case "pending":
    case "queued":
      return { icon: "🟡", label, variant: "info" };
    case "running":
      return { icon: "🔵", label, variant: "info" };
    case "complete":
    case "done":
      return { icon: "🟢", label, variant: "success" };
    case "review_pending":
      return { icon: "🟣", label, variant: "success" };
    case "accepted":
      return { icon: "✅", label, variant: "success" };
    case "applied":
      return { icon: "🟢", label, variant: "success" };
    case "timeout":
    case "cancelled":
    case "discarded":
    case "needs_input":
      return { icon: "🟠", label, variant: "warning" };
    case "error":
    default:
      return { icon: "🔴", label, variant: "error" };
  }
}

function sortKey(item: TaskRecord): string {
  return (
    item.completedAt ||
    item.startedAt ||
    item.queuedAt ||
    item.updatedAt ||
    item.id
  );
}

function displayOrderKey(item: TaskRecord): string {
  return (
    item.queuedAt ||
    item.startedAt ||
    item.updatedAt ||
    item.completedAt ||
    item.id
  );
}

function compareSessionRunRefs(a: SessionRunRef, b: SessionRunRef): number {
  const aCreated = Number(a.createdAt || 0);
  const bCreated = Number(b.createdAt || 0);
  if (aCreated !== bCreated) return aCreated - bCreated;

  const aDetached = Number(a.detachedAt || 0);
  const bDetached = Number(b.detachedAt || 0);
  if (aDetached !== bDetached) return aDetached - bDetached;

  return a.id.localeCompare(b.id);
}

function compareTaskDialogOrder(a: TaskRecord, b: TaskRecord): number {
  const aSequence =
    a.source === "session-run" ? normalizePositiveInt(a.sequence) : undefined;
  const bSequence =
    b.source === "session-run" ? normalizePositiveInt(b.sequence) : undefined;
  if (
    aSequence !== undefined &&
    bSequence !== undefined &&
    aSequence !== bSequence
  ) {
    return aSequence - bSequence;
  }

  const aOrder = displayOrderKey(a);
  const bOrder = displayOrderKey(b);
  if (aOrder !== bOrder) return aOrder.localeCompare(bOrder);

  if (a.source !== b.source) return a.source.localeCompare(b.source);
  return a.id.localeCompare(b.id);
}

function normalizeDisplaySummary(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text
    .replace(/^\s*quiero(?:\s+que|\s+una|\s+un)?\s+/i, "")
    .trim();
  return normalized || undefined;
}

function displayTaskTitle(item: TaskRecord, icon: string): string {
  const fallback =
    item.source === "delegation"
      ? "Delegación background"
      : "Tarea en background";
  const summary =
    summarize(normalizeDisplaySummary(item.title) || fallback, 25) || fallback;
  const sequence =
    item.source === "session-run"
      ? normalizePositiveInt(item.sequence)
      : undefined;
  return sequence ? `${icon} #${sequence} — ${summary}` : `${icon} ${summary}`;
}

function toIsoTime(value?: number | string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return new Date(value).toISOString();
}

function buildFooter(snapshot: Snapshot): string {
  const parts = [
    `BG`,
    `p:${snapshot.counts.pending}`,
    `r:${snapshot.counts.running}`,
    `c:${snapshot.counts.complete}`,
    `e:${snapshot.counts.error}`,
  ];
  if (snapshot.counts.review_pending > 0)
    parts.push(`revisión:${snapshot.counts.review_pending}`);
  if (snapshot.counts.needs_input > 0)
    parts.push(`input:${snapshot.counts.needs_input}`);
  if (snapshot.backgroundModeEnabled) parts.push(`same-session:activo`);
  parts.push(`/bg-tasks`);
  return parts.join(" · ");
}

function renderFooter(snapshot: Snapshot) {
  return createElement(
    "box",
    {
      paddingLeft: 1,
      paddingRight: 1,
    },
    createElement("text", {}, buildFooter(snapshot)),
  );
}

function renderSidebarSummary(snapshot: Snapshot) {
  return createElement(
    "box",
    {
      border: true,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      flexDirection: "column",
      gap: 1,
    },
    createElement("text", {}, "Tareas en background"),
    createElement(
      "text",
      {},
      `pendientes ${snapshot.counts.pending} · corriendo ${snapshot.counts.running}`,
    ),
    createElement(
      "text",
      {},
      `completas ${snapshot.counts.complete} · error ${snapshot.counts.error}`,
    ),
    snapshot.counts.review_pending > 0
      ? createElement("text", {}, `revisión ${snapshot.counts.review_pending}`)
      : null,
    snapshot.counts.needs_input > 0
      ? createElement("text", {}, `input ${snapshot.counts.needs_input}`)
      : null,
    snapshot.backgroundModeEnabled
      ? createElement("text", {}, `modo background same-session activo`)
      : null,
    createElement("text", {}, "/bg-tasks"),
  );
}

function buildSessionStateKey(sessionID: string): string {
  return `${SESSION_STATE_PREFIX}:session:${sessionID}`;
}

function buildThreadStateKey(rootSessionID: string): string {
  return `${SESSION_STATE_PREFIX}:thread:${rootSessionID}`;
}

function buildInspectionStateKey(): string {
  return `${SESSION_STATE_PREFIX}:inspection`;
}

function normalizeSessionBackgroundState(
  value: unknown,
): SessionBackgroundState {
  const input =
    value && typeof value === "object"
      ? (value as Partial<SessionBackgroundState>)
      : {};
  const refs = Array.isArray(input.trackedTaskRefs)
    ? input.trackedTaskRefs
        .filter((ref): ref is SessionRunRef =>
          Boolean(
            ref &&
              typeof ref === "object" &&
              typeof (ref as SessionRunRef).id === "string",
          ),
        )
        .map(
          (ref): SessionRunRef => ({
            id: ref.id,
            source:
              ref.source === "foreground-detach"
                ? "foreground-detach"
                : "prompt-async",
            sequence: normalizePositiveInt(ref.sequence),
            title: ref.title,
            bgTaskToken: ref.bgTaskToken,
            inspectionHostSessionID: ref.inspectionHostSessionID,
            parentUserMessageID: ref.parentUserMessageID,
            assistantMessageID: ref.assistantMessageID,
            createdAt: Number(ref.createdAt || Date.now()),
            detachedAt: Number(ref.detachedAt || ref.createdAt || Date.now()),
          }),
        )
    : [];
  const unique = new Map<string, SessionRunRef>();
  for (const ref of refs) unique.set(ref.id, ref);
  const trackedTaskRefs = Array.from(unique.values())
    .sort((a, b) => b.detachedAt - a.detachedAt)
    .slice(0, MAX_TRACKED_SESSION_RUNS);

  return {
    backgroundModeEnabled: Boolean(input.backgroundModeEnabled),
    trackedTaskRefs,
    threadRootSessionID:
      typeof input.threadRootSessionID === "string" &&
      input.threadRootSessionID.trim()
        ? input.threadRootSessionID
        : undefined,
  };
}

function normalizeThreadState(
  value: unknown,
  fallbackRootSessionID: string,
): BackgroundThreadState {
  const input =
    value && typeof value === "object"
      ? (value as Partial<BackgroundThreadState>)
      : {};
  return {
    rootSessionID:
      typeof input.rootSessionID === "string" && input.rootSessionID.trim()
        ? input.rootSessionID
        : fallbackRootSessionID,
    foregroundSessionID:
      typeof input.foregroundSessionID === "string" &&
      input.foregroundSessionID.trim()
        ? input.foregroundSessionID
        : fallbackRootSessionID,
    title:
      typeof input.title === "string" && input.title.trim()
        ? input.title
        : undefined,
    nextSequence: normalizePositiveInt(input.nextSequence) ?? 1,
  };
}

function normalizeInspectionState(value: unknown): InspectionState | undefined {
  const input =
    value && typeof value === "object"
      ? (value as Partial<InspectionState>)
      : undefined;
  if (
    !input?.sessionID ||
    typeof input.sessionID !== "string" ||
    !input.sessionID.trim()
  )
    return undefined;
  return {
    sessionID: input.sessionID.trim(),
    sourceSessionID:
      typeof input.sourceSessionID === "string" && input.sourceSessionID.trim()
        ? input.sourceSessionID.trim()
        : undefined,
    returnSessionID:
      typeof input.returnSessionID === "string" && input.returnSessionID.trim()
        ? input.returnSessionID.trim()
        : undefined,
    taskSource:
      input.taskSource === "delegation"
        ? "delegation"
        : input.taskSource === "session-run"
          ? "session-run"
          : undefined,
    taskID:
      typeof input.taskID === "string" && input.taskID.trim()
        ? input.taskID.trim()
        : undefined,
    parentUserMessageID:
      typeof input.parentUserMessageID === "string" &&
      input.parentUserMessageID.trim()
        ? input.parentUserMessageID.trim()
        : undefined,
    assistantMessageID:
      typeof input.assistantMessageID === "string" &&
      input.assistantMessageID.trim()
        ? input.assistantMessageID.trim()
        : undefined,
  };
}

function summarizeMessageParts(parts: Part[]): string | undefined {
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => String((part as any).text ?? ""))
    .join(" ");
  return summarize(text);
}

function extractBackgroundToken(parts: Part[]): string | undefined {
  for (const part of parts) {
    if (part.type !== "text") continue;
    const token = (part as any).metadata?.bgTaskToken;
    if (typeof token === "string" && token.trim()) return token.trim();
  }
  return undefined;
}

function makeSessionRunDescription(
  status: SessionRunStatus,
  title: string | undefined,
): string {
  const base = title || "Tarea background de la misma sesión";
  switch (status) {
    case "queued":
      return `${base} · esperando detrás de otra corrida`;
    case "running":
      return `${base} · ejecutándose en la sesión actual`;
    case "needs_input":
      return `${base} · necesita input o permiso del usuario`;
    case "done":
      return `${base} · completada`;
    case "error":
    default:
      return `${base} · falló`;
  }
}

function countItems(items: TaskRecord[]): Snapshot["counts"] {
  const counts = {
    pending: 0,
    running: 0,
    complete: 0,
    error: 0,
    review_pending: 0,
    needs_input: 0,
  };
  for (const item of items) {
    if (item.status === "pending" || item.status === "queued")
      counts.pending += 1;
    else if (item.status === "running") counts.running += 1;
    else if (item.status === "review_pending") counts.review_pending += 1;
    else if (item.status === "needs_input") counts.needs_input += 1;
    else if (item.status === "error" || item.status === "timeout")
      counts.error += 1;
    else if (
      [
        "complete",
        "done",
        "accepted",
        "applied",
        "discarded",
        "cancelled",
      ].includes(item.status)
    )
      counts.complete += 1;
  }
  return counts;
}

async function readProjectDelegations(
  projectDirectory: string,
): Promise<{ projectId: string; items: TaskRecord[] }> {
  const projectId = await getProjectId(projectDirectory);
  const baseDir = path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode",
    "delegations",
    projectId,
  );
  const items: TaskRecord[] = [];

  try {
    const sessionDirs = await fs.readdir(baseDir, { withFileTypes: true });
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const sessionPath = path.join(baseDir, sessionDir.name);
      const delegationDirs = await fs
        .readdir(sessionPath, { withFileTypes: true })
        .catch(() => []);
      for (const delegationDir of delegationDirs) {
        if (!delegationDir.isDirectory()) continue;
        const metaPath = path.join(
          sessionPath,
          delegationDir.name,
          "meta.json",
        );
        try {
          const raw = await fs.readFile(metaPath, "utf8");
          const meta = JSON.parse(raw) as PersistedDelegationMeta;
          items.push({
            id: meta.id,
            source: "delegation",
            status: meta.status,
            mode: meta.mode,
            sessionID: meta.sessionID ?? undefined,
            agent: meta.agent,
            title: meta.title ?? undefined,
            description: meta.description ?? undefined,
            error: meta.error ?? undefined,
            queuedAt: meta.queuedAt ?? undefined,
            startedAt: meta.startedAt ?? undefined,
            completedAt: meta.completedAt ?? undefined,
            updatedAt:
              meta.completedAt ?? meta.startedAt ?? meta.queuedAt ?? undefined,
          });
        } catch {
          // ignore malformed or transient files
        }
      }
    }
  } catch {
    // ignore missing delegation dir
  }

  items.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  return { projectId, items };
}

async function fetchSessionMessages(
  api: Parameters<TuiPlugin>[0],
  sessionID: string,
): Promise<SessionMessageRecord[]> {
  const result = await api.client.session.messages({ sessionID, limit: 200 });
  return ((result?.data ?? []) as SessionMessageRecord[])
    .slice()
    .sort((a, b) => {
      const aTime = Number((a.info as any)?.time?.created ?? 0);
      const bTime = Number((b.info as any)?.time?.created ?? 0);
      return aTime - bTime;
    });
}

async function fetchSessionInfo(
  api: Parameters<TuiPlugin>[0],
  sessionID: string,
): Promise<any | undefined> {
  const result = await api.client.session
    .get({ sessionID })
    .catch(() => undefined);
  return (result as any)?.data;
}

function findMostRecentRunningAssistant(
  items: SessionMessageRecord[],
): SessionMessageRecord | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.info.role !== "assistant") continue;
    const completed = (item.info as any)?.time?.completed;
    if (!completed) return item;
  }
  return undefined;
}

function buildSessionRunStatus(item: {
  assistant?: SessionMessageRecord;
  hasPendingInput: boolean;
}): SessionRunStatus {
  if (item.assistant?.info?.error) return "error";
  if (!item.assistant) return "queued";
  if ((item.assistant.info as any)?.time?.completed) return "done";
  if (item.hasPendingInput) return "needs_input";
  return "running";
}

function resolveThreadRootSessionID(
  state: SessionBackgroundState,
  sessionInfo: { id: string; parentID?: string },
): string {
  return state.threadRootSessionID || sessionInfo.parentID || sessionInfo.id;
}

const BackgroundAgentsTui: TuiPlugin = async (api) => {
  let snapshot: Snapshot = {
    items: [],
    counts: {
      pending: 0,
      running: 0,
      complete: 0,
      error: 0,
      review_pending: 0,
      needs_input: 0,
    },
    backgroundModeEnabled: false,
  };
  let lastStatuses = new Map<string, string>();
  let initializedProjectId: string | undefined;
  const fallbackSessionState = new Map<string, SessionBackgroundState>();
  const fallbackThreadState = new Map<string, BackgroundThreadState>();
  const promptRefs = new Map<string, any>();

  const currentDirectory = () =>
    api.state.path.directory || api.state.path.worktree || process.cwd();
  const currentRouteSessionID = () =>
    api.route.current.name === "session"
      ? String(api.route.current.params.sessionID)
      : undefined;

  const loadSessionState = (sessionID: string): SessionBackgroundState => {
    if (api.kv.ready)
      return normalizeSessionBackgroundState(
        api.kv.get(buildSessionStateKey(sessionID), undefined),
      );
    return normalizeSessionBackgroundState(fallbackSessionState.get(sessionID));
  };

  const saveSessionState = (
    sessionID: string,
    state: SessionBackgroundState,
  ) => {
    const normalized = normalizeSessionBackgroundState(state);
    if (api.kv.ready) api.kv.set(buildSessionStateKey(sessionID), normalized);
    fallbackSessionState.set(sessionID, normalized);
  };

  const loadThreadState = (rootSessionID: string): BackgroundThreadState => {
    if (api.kv.ready)
      return normalizeThreadState(
        api.kv.get(buildThreadStateKey(rootSessionID), undefined),
        rootSessionID,
      );
    return normalizeThreadState(
      fallbackThreadState.get(rootSessionID),
      rootSessionID,
    );
  };

  const saveThreadState = (
    rootSessionID: string,
    state: BackgroundThreadState,
  ) => {
    const normalized = normalizeThreadState(state, rootSessionID);
    if (api.kv.ready)
      api.kv.set(buildThreadStateKey(rootSessionID), normalized);
    fallbackThreadState.set(rootSessionID, normalized);
  };

  const loadInspectionState = (): InspectionState | undefined => {
    if (!api.kv.ready) return undefined;
    return normalizeInspectionState(
      api.kv.get(buildInspectionStateKey(), undefined),
    );
  };

  const saveInspectionState = (state?: InspectionState) => {
    const normalized = normalizeInspectionState(state);
    if (api.kv.ready) api.kv.set(buildInspectionStateKey(), normalized);
  };

  const clearInspectionState = () => {
    saveInspectionState(undefined);
  };

  const resolveShellSessionID = (sessionID?: string): string | undefined => {
    if (!sessionID) return undefined;
    const state = loadSessionState(sessionID);
    return state.threadRootSessionID || sessionID;
  };

  const resolvePromptTargetSessionID = (
    sessionID?: string,
  ): string | undefined => {
    const shellSessionID = resolveShellSessionID(sessionID);
    if (!shellSessionID) return sessionID;
    return (
      loadThreadState(shellSessionID).foregroundSessionID || shellSessionID
    );
  };

  const filterTrackedMessages = (
    items: ReadonlyArray<Message>,
    state:
      | {
          backgroundModeEnabled?: boolean;
          trackedTaskRefs?: Array<{
            parentUserMessageID?: string;
            assistantMessageID?: string;
          }>;
        }
      | undefined,
  ) => {
    if (!state?.backgroundModeEnabled || !state.trackedTaskRefs?.length)
      return [...items];

    const parentIDs = new Set(
      state.trackedTaskRefs
        .map((item) => item.parentUserMessageID)
        .filter(Boolean),
    );
    const assistantIDs = new Set(
      state.trackedTaskRefs
        .map((item) => item.assistantMessageID)
        .filter(Boolean),
    );

    return items.filter((item) => {
      if (item.role === "user") return !parentIDs.has(item.id);
      return (
        !assistantIDs.has(item.id) &&
        !parentIDs.has((item as Message & { parentID?: string }).parentID)
      );
    });
  };

  const completeSupersededAssistants = (items: ReadonlyArray<Message>) => {
    const assistantsByParent = new Map<
      string,
      Array<{ id: string; createdAt: number; completedAt?: number; order: number }>
    >();

    for (const [order, item] of items.entries()) {
      if (item.role !== "assistant" || !item.id) continue;
      const parentID = (item as Message & { parentID?: string }).parentID;
      if (!parentID) continue;
      const createdAt = Number(item.time.created ?? 0);
      const completedAt = Number(item.time.completed ?? 0) || undefined;
      const group = assistantsByParent.get(parentID) ?? [];
      group.push({ id: item.id, createdAt, completedAt, order });
      assistantsByParent.set(parentID, group);
    }

    const staleCompletionTimes = new Map<string, number>();
    for (const group of assistantsByParent.values()) {
      const ordered = group
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
      for (let index = 0; index < ordered.length - 1; index += 1) {
        const current = ordered[index];
        if (current.completedAt) continue;
        const next = ordered[index + 1];
        staleCompletionTimes.set(
          current.id,
          next.completedAt || next.createdAt || current.createdAt,
        );
      }
    }

    if (staleCompletionTimes.size === 0) return [...items];

    return items.map((item) => {
      const completedAt = item.id ? staleCompletionTimes.get(item.id) : undefined;
      if (!completedAt || item.role !== "assistant") return item;
      return {
        ...item,
        time: {
          ...(item.time ?? {}),
          completed: item.time.completed ?? completedAt,
        },
      } satisfies Message;
    });
  };

  const buildSessionProjection = (
    context: TuiSessionAdapterContext,
  ): TuiSessionProjection | undefined => {
    const shellSessionID = context.routeSessionID;
    if (!shellSessionID) return undefined;

    const routeSession = context.routeSession;
    const sessionState = loadSessionState(shellSessionID);
    const inspection = loadInspectionState();
    const inspectionActive = inspection?.sessionID === shellSessionID;
    const technicalThreadRootID =
      sessionState.threadRootSessionID ||
      (!routeSession?.parentID ? routeSession?.id : undefined);
    const threadState = technicalThreadRootID
      ? loadThreadState(technicalThreadRootID)
      : undefined;
    const activeSessionID = inspectionActive
      ? inspection?.sourceSessionID || shellSessionID
      : sessionState.threadRootSessionID || !routeSession?.parentID
        ? threadState?.foregroundSessionID || shellSessionID
        : shellSessionID;
    const activeSessionState = loadSessionState(activeSessionID);
    const activeMessages = context.messagesBySession[activeSessionID] ?? [];

    const visibleMessages = (() => {
      if (inspectionActive) {
        if (inspection?.taskSource === "delegation")
          return completeSupersededAssistants(activeMessages);
        if (
          inspection?.sessionID === shellSessionID &&
          (inspection.parentUserMessageID || inspection.assistantMessageID)
        ) {
          return completeSupersededAssistants(
            activeMessages.filter((item) => {
              if (item.role === "user")
                return item.id === inspection.parentUserMessageID;
              if (
                inspection.assistantMessageID &&
                item.id === inspection.assistantMessageID
              )
                return true;
              return inspection.parentUserMessageID
                ? (item as Message & { parentID?: string }).parentID ===
                    inspection.parentUserMessageID
                : false;
            }),
          );
        }
        return completeSupersededAssistants(
          filterTrackedMessages(activeMessages, activeSessionState),
        );
      }

      if (!technicalThreadRootID)
        return completeSupersededAssistants(activeMessages);

      const ids = new Set<string>([
        shellSessionID,
        activeSessionID,
        technicalThreadRootID,
      ]);
      for (const item of context.sessions) {
        if (item.id === technicalThreadRootID) {
          ids.add(item.id);
          continue;
        }
        if (
          loadSessionState(item.id).threadRootSessionID ===
          technicalThreadRootID
        )
          ids.add(item.id);
      }

      return completeSupersededAssistants(
        Array.from(ids)
        .flatMap((sessionID) =>
          filterTrackedMessages(
            context.messagesBySession[sessionID] ?? [],
            loadSessionState(sessionID),
          ),
        )
        .toSorted((a, b) => {
          const aCreated = Number(a.time.created ?? 0);
          const bCreated = Number(b.time.created ?? 0);
          if (aCreated !== bCreated) return aCreated - bCreated;
          if (a.id < b.id) return -1;
          if (a.id > b.id) return 1;
          return 0;
        }),
      );
    })();

    const permissions = context.permissionsBySession[activeSessionID] ?? [];
    const questions = context.questionsBySession[activeSessionID] ?? [];
    const isTechnicalForeground =
      threadState?.foregroundSessionID === shellSessionID;
    const promptTargetSessionID =
      resolvePromptTargetSessionID(shellSessionID) || shellSessionID;
    const promptState = loadSessionState(promptTargetSessionID);

    return {
      canonicalSessionID:
        resolveShellSessionID(shellSessionID) || shellSessionID,
      activeSessionID,
      visibleMessages,
      promptTargetSessionID,
      promptVisible:
        (isTechnicalForeground || !routeSession?.parentID) &&
        permissions.length === 0 &&
        questions.length === 0 &&
        !inspectionActive,
      allowSubmitWhenBusy:
        promptState.backgroundModeEnabled &&
        promptState.trackedTaskRefs.length > 0,
      permissionSessionID: activeSessionID,
      questionSessionID: activeSessionID,
      inspection: {
        active: inspectionActive,
      },
    };
  };

  const buildSessionListProjection = (
    context: TuiSessionListAdapterContext,
  ): TuiSessionListProjection | undefined => {
    const currentSessionID =
      context.routeCurrent.name === "session"
        ? resolveShellSessionID(context.routeCurrent.params.sessionID) ||
          context.routeCurrent.params.sessionID
        : undefined;

    return {
      currentSessionID,
      navigateToSessionID: (selectedSessionID) =>
        resolveShellSessionID(selectedSessionID) || selectedSessionID,
      beforeNavigate: () => {
        resetInspectionInterrupt();
        clearInspectionState();
      },
    };
  };

  const resolveThreadSessionIDs = async (
    rootSessionID: string,
  ): Promise<string[]> => {
    const sessionsResult = await api.client.session.list({
      directory: currentDirectory(),
      limit: 200,
    });
    const sessions = (
      (sessionsResult?.data ?? []) as Array<{ id: string; parentID?: string }>
    )
      .filter(
        (item) => item.id === rootSessionID || item.parentID === rootSessionID,
      )
      .map((item) => item.id);

    if (!sessions.includes(rootSessionID)) sessions.unshift(rootSessionID);
    return Array.from(new Set(sessions));
  };

  const ensureThreadSequences = async (
    rootSessionID: string,
    sessionIDs?: string[],
  ) => {
    const ids = sessionIDs?.length
      ? Array.from(new Set([rootSessionID, ...sessionIDs]))
      : await resolveThreadSessionIDs(rootSessionID);
    const sessionStates = new Map<string, SessionBackgroundState>();
    const refs: Array<{ sessionID: string; ref: SessionRunRef }> = [];

    for (const sessionID of ids) {
      const state = loadSessionState(sessionID);
      sessionStates.set(sessionID, state);
      for (const ref of state.trackedTaskRefs) refs.push({ sessionID, ref });
    }

    const ordered = refs
      .slice()
      .sort((a, b) => compareSessionRunRefs(a.ref, b.ref));
    const seen = new Set<number>();
    const needsResequence = ordered.some(({ ref }) => {
      const sequence = normalizePositiveInt(ref.sequence);
      if (!sequence || seen.has(sequence)) return true;
      seen.add(sequence);
      return false;
    });

    const nextSequence = ordered.length + 1;
    if (needsResequence) {
      for (const [index, entry] of ordered.entries()) {
        entry.ref.sequence = index + 1;
      }
      for (const [sessionID, state] of sessionStates)
        saveSessionState(sessionID, state);
    }

    const threadState = loadThreadState(rootSessionID);
    if (threadState.nextSequence !== nextSequence) {
      threadState.nextSequence = nextSequence;
      saveThreadState(rootSessionID, threadState);
    }
  };

  const allocateThreadSequence = async (
    rootSessionID: string,
    sessionIDs?: string[],
  ) => {
    await ensureThreadSequences(rootSessionID, sessionIDs);
    const threadState = loadThreadState(rootSessionID);
    const sequence = normalizePositiveInt(threadState.nextSequence) ?? 1;
    threadState.nextSequence = sequence + 1;
    saveThreadState(rootSessionID, threadState);
    return sequence;
  };

  const resolveInspectionHostSessionID = (
    sourceSessionID: string,
    returnSessionID?: string,
  ): string => {
    if (returnSessionID && sourceSessionID !== returnSessionID)
      return sourceSessionID;
    const promptTargetSessionID = resolvePromptTargetSessionID(returnSessionID);
    if (promptTargetSessionID && promptTargetSessionID !== returnSessionID)
      return promptTargetSessionID;
    return sourceSessionID;
  };

  const ensureInspectionHostSession = async (
    item: TaskRecord,
    returnSessionID?: string,
  ): Promise<string> => {
    if (!item.sessionID)
      throw new Error(
        "La tarea no tiene una sesión origen para abrir la vista background",
      );
    if (!returnSessionID || item.sessionID !== returnSessionID)
      return item.sessionID;

    const state = loadSessionState(item.sessionID);
    const ref = state.trackedTaskRefs.find(
      (candidate) =>
        candidate.id === item.id ||
        (item.parentUserMessageID &&
          candidate.parentUserMessageID === item.parentUserMessageID) ||
        (item.assistantMessageID &&
          candidate.assistantMessageID === item.assistantMessageID),
    );

    if (ref?.inspectionHostSessionID) {
      const existing = await fetchSessionInfo(api, ref.inspectionHostSessionID);
      if (existing?.id) return existing.id;
    }

    const createResult = await api.client.session.create({
      parentID: returnSessionID,
      title: item.title || "Vista background",
    });
    const hostSessionID = (createResult as any)?.data?.id as string | undefined;
    if (!hostSessionID) {
      throw new Error(
        `No se pudo crear una vista background para la tarea ${item.id}`,
      );
    }

    const hostState = loadSessionState(hostSessionID);
    hostState.backgroundModeEnabled = false;
    hostState.threadRootSessionID = returnSessionID;
    hostState.trackedTaskRefs = hostState.trackedTaskRefs ?? [];
    saveSessionState(hostSessionID, hostState);

    if (ref) {
      ref.inspectionHostSessionID = hostSessionID;
      saveSessionState(item.sessionID, state);
    }

    return hostSessionID;
  };

  const showStatusToast = (item: TaskRecord) => {
    const presentation = getStatusPresentation(item.status);
    const title =
      item.source === "delegation"
        ? item.status === "review_pending"
          ? "Tarea background lista para revisión"
          : `Tarea background ${presentation.label}`
        : item.status === "needs_input"
          ? "La tarea background de la misma sesión necesita input"
          : `Tarea background de la misma sesión ${presentation.label}`;
    const detail = summarize(item.title || item.error || item.description);
    api.ui.toast({
      title,
      message: detail ? `${item.id} · ${detail}` : `${item.id} · ${item.mode}`,
      variant: presentation.variant,
      duration: presentation.variant === "error" ? 7000 : 5000,
    });
  };

  const ensureCurrentRunTracked = async (
    sessionID: string,
    rootSessionID?: string,
  ): Promise<boolean> => {
    const messages = await fetchSessionMessages(api, sessionID);
    const sessionInfo = await fetchSessionInfo(api, sessionID);
    if (!sessionInfo?.id) {
      api.ui.toast({
        title: "No se pudo resolver la sesión",
        message: `No se pudo cargar la sesión ${sessionID} antes de registrar la corrida.`,
        variant: "error",
        duration: 7000,
      });
      return false;
    }
    const runningAssistant = findMostRecentRunningAssistant(messages);
    if (!runningAssistant || runningAssistant.info.role !== "assistant") {
      api.ui.toast({
        title: "No se encontró una corrida activa",
        message:
          "La sesión actual no tiene una respuesta en curso para enviar a background.",
        variant: "warning",
        duration: 5000,
      });
      return false;
    }

    const parentUserMessageID = (runningAssistant.info as any).parentID as
      | string
      | undefined;
    if (!parentUserMessageID) {
      api.ui.toast({
        title: "No se pudo registrar la corrida actual",
        message: "La respuesta en curso no tiene un mensaje de usuario padre.",
        variant: "error",
        duration: 7000,
      });
      return false;
    }

    const parentUser = messages.find(
      (item) =>
        item.info.id === parentUserMessageID && item.info.role === "user",
    );
    const title =
      summarizeMessageParts(parentUser?.parts ?? []) || "Tarea actual";
    const state = loadSessionState(sessionID);
    state.threadRootSessionID =
      rootSessionID || resolveThreadRootSessionID(state, sessionInfo);
    state.backgroundModeEnabled = true;
    if (
      !state.trackedTaskRefs.some(
        (ref) => ref.parentUserMessageID === parentUserMessageID,
      )
    ) {
      const sequence = await allocateThreadSequence(state.threadRootSessionID);
      state.trackedTaskRefs.unshift({
        id: `session-run:${parentUserMessageID}`,
        source: "foreground-detach",
        sequence,
        title,
        parentUserMessageID,
        assistantMessageID: runningAssistant.info.id,
        createdAt: Number(
          (parentUser?.info as any)?.time?.created ?? Date.now(),
        ),
        detachedAt: Date.now(),
      });
    }
    saveSessionState(sessionID, state);
    return true;
  };

  const queueAsyncPrompt = async (sessionID: string, promptText: string) => {
    const trimmed = promptText.trim();
    if (!trimmed) return;
    const token = randomToken();
    const sessionInfo = await fetchSessionInfo(api, sessionID);
    const result = await api.client.session.promptAsync({
      sessionID,
      parts: [
        {
          id: `prt-bg-${token}`,
          type: "text",
          text: trimmed,
          metadata: {
            bgTaskToken: token,
            backgroundTask: true,
          },
        } satisfies TextPartInput,
      ],
    });

    if ((result as any)?.error) {
      throw new Error(JSON.stringify((result as any).error));
    }

    const state = loadSessionState(sessionID);
    state.threadRootSessionID = sessionInfo?.id
      ? resolveThreadRootSessionID(state, sessionInfo)
      : state.threadRootSessionID;
    state.backgroundModeEnabled = true;
    const sequence = state.threadRootSessionID
      ? await allocateThreadSequence(state.threadRootSessionID)
      : undefined;
    state.trackedTaskRefs.unshift({
      id: `session-run:token:${token}`,
      source: "prompt-async",
      sequence,
      title: summarize(trimmed) || "Tarea encolada de la misma sesión",
      bgTaskToken: token,
      createdAt: Date.now(),
      detachedAt: Date.now(),
    });
    saveSessionState(sessionID, state);
    api.ui.toast({
      title: "Prompt enviado a background",
      message: summarize(trimmed) || "Tarea encolada de la misma sesión",
      variant: "success",
      duration: 5000,
    });
  };

  const submitInlineBackgroundPrompt = async (
    sessionID: string,
    request: {
      sessionID?: string;
      messageID: string;
      input: string;
      mode?: "normal" | "shell";
      parts: any[];
      agent: string;
      model: { providerID: string; modelID: string; variant?: string };
    },
  ) => {
    if (!sessionID) return false;
    const sessionInfo = await api.client.session
      .get({ sessionID })
      .catch(() => {
        throw new Error(
          `No se pudo resolver la sesión ${sessionID} antes de enviar el promptAsync`,
        );
      });

    const busy = api.state.session.status(sessionID)?.type === "busy";
    const state = loadSessionState(sessionID);
    if (!busy || !state.backgroundModeEnabled || request.mode === "shell")
      return false;
    const sessionData = (sessionInfo as any)?.data as
      | { id: string; parentID?: string }
      | undefined;
    if (sessionData?.id)
      state.threadRootSessionID = resolveThreadRootSessionID(
        state,
        sessionData,
      );

    const token = randomToken();
    let tagged = false;
    const parts = request.parts.map((part) => {
      if (tagged) return part;
      if (part.type !== "text") return part;
      if (part.synthetic) return part;
      if (String(part.text ?? "") !== request.input) return part;
      tagged = true;
      return {
        ...part,
        id: `prt-bg-${token}`,
        metadata: {
          ...(part.metadata ?? {}),
          bgTaskToken: token,
          backgroundTask: true,
        },
      };
    });

    const result = await api.client.session.promptAsync({
      sessionID,
      agent: request.agent,
      model: {
        providerID: request.model.providerID,
        modelID: request.model.modelID,
      },
      variant: request.model.variant,
      parts,
    });
    if ((result as any)?.error) {
      throw new Error(JSON.stringify((result as any).error));
    }

    const sequence = state.threadRootSessionID
      ? await allocateThreadSequence(state.threadRootSessionID)
      : undefined;
    state.trackedTaskRefs.unshift({
      id: `session-run:token:${token}`,
      source: "prompt-async",
      sequence,
      title: summarize(request.input) || "Tarea encolada de la misma sesión",
      bgTaskToken: token,
      createdAt: Date.now(),
      detachedAt: Date.now(),
    });
    saveSessionState(sessionID, state);
    api.ui.toast({
      title: "Prompt enviado a background",
      message: summarize(request.input) || "Tarea encolada de la misma sesión",
      variant: "success",
      duration: 5000,
    });
    const shellSessionID = resolveShellSessionID(sessionID) || sessionID;
    if (shellSessionID !== currentRouteSessionID()) {
      api.route.navigate("session", { sessionID: shellSessionID });
    }
    void refreshSnapshot();
    return true;
  };

  const focusForegroundSession = async () => {
    const routeSessionID = currentRouteSessionID();
    if (!routeSessionID) return;
    const inspection = loadInspectionState();
    const sessionInfo = await fetchSessionInfo(api, routeSessionID);
    const shellSessionID =
      inspection?.returnSessionID ||
      resolveShellSessionID(routeSessionID) ||
      sessionInfo?.parentID ||
      routeSessionID;
    const hadInspection = Boolean(inspection);
    clearInspectionState();
    if (routeSessionID !== shellSessionID) {
      api.route.navigate("session", { sessionID: shellSessionID });
      return;
    }
    if (!hadInspection) {
      api.ui.toast({
        title: "Ya estás en el foreground",
        message: "Seguís en la consola principal de esta sesión.",
        variant: "info",
        duration: 3000,
      });
    }
  };

  let inspectionInterruptCount = 0;
  let inspectionInterruptTimeout: ReturnType<typeof setTimeout> | undefined;

  const resetInspectionInterrupt = () => {
    inspectionInterruptCount = 0;
    if (inspectionInterruptTimeout) clearTimeout(inspectionInterruptTimeout);
    inspectionInterruptTimeout = undefined;
  };

  const resolveInterruptibleInspectionSourceSessionID = () => {
    const inspection = loadInspectionState();
    if (!inspection || inspection.taskSource !== "session-run")
      return undefined;
    return inspection.sourceSessionID || inspection.sessionID || undefined;
  };

  const interruptInspectionRun = async () => {
    const sessionID = resolveInterruptibleInspectionSourceSessionID();
    if (!sessionID) {
      resetInspectionInterrupt();
      api.ui.toast({
        title: "No hay una tarea inspeccionada para interrumpir",
        message: "Abrí primero una tarea background de la misma sesión.",
        variant: "warning",
        duration: 4000,
      });
      return;
    }

    if (api.state.session.status(sessionID)?.type !== "busy") {
      resetInspectionInterrupt();
      api.ui.toast({
        title: "La tarea ya no está corriendo",
        message:
          "La sesión inspeccionada ya no tiene una corrida activa para interrumpir.",
        variant: "info",
        duration: 4000,
      });
      await refreshSnapshot();
      return;
    }

    inspectionInterruptCount += 1;
    if (inspectionInterruptCount < 2) {
      if (inspectionInterruptTimeout) clearTimeout(inspectionInterruptTimeout);
      inspectionInterruptTimeout = setTimeout(() => {
        inspectionInterruptCount = 0;
        inspectionInterruptTimeout = undefined;
      }, 5000);
      api.ui.toast({
        title: "Presioná esc otra vez para interrumpir",
        message:
          "La tarea background inspeccionada sigue corriendo en su sesión real.",
        variant: "warning",
        duration: 2500,
      });
      return;
    }

    resetInspectionInterrupt();
    await api.client.session.abort({ sessionID });
    api.ui.toast({
      title: "Interrumpiendo tarea background",
      message: sessionID,
      variant: "success",
      duration: 4000,
    });
    await refreshSnapshot();
  };

  const buildSessionRunRecords = async (
    sessionID: string,
    activeSessionID?: string,
  ): Promise<{
    records: TaskRecord[];
    backgroundModeEnabled: boolean;
    stateChanged: boolean;
    nextState: SessionBackgroundState;
  }> => {
    const state = loadSessionState(sessionID);
    if (state.trackedTaskRefs.length === 0) {
      return {
        records: [],
        backgroundModeEnabled: state.backgroundModeEnabled,
        stateChanged: false,
        nextState: state,
      };
    }

    const messages = await fetchSessionMessages(api, sessionID);
    const userMessages = new Map<string, SessionMessageRecord>();
    const assistantByParent = new Map<string, SessionMessageRecord>();
    let stateChanged = false;

    for (const item of messages) {
      if (item.info.role === "user") userMessages.set(item.info.id, item);
      if (item.info.role === "assistant") {
        const parentID = (item.info as any).parentID as string | undefined;
        if (!parentID) continue;
        const previous = assistantByParent.get(parentID);
        const previousCreated = Number(
          (previous?.info as any)?.time?.created ?? 0,
        );
        const currentCreated = Number((item.info as any)?.time?.created ?? 0);
        if (!previous || currentCreated >= previousCreated)
          assistantByParent.set(parentID, item);
      }
    }

    const hasPendingInput =
      api.state.session.permission(sessionID).length > 0 ||
      api.state.session.question(sessionID).length > 0;
    const refs = [...state.trackedTaskRefs];
    const records = refs.map((ref) => {
      let userRecord: SessionMessageRecord | undefined;
      if (ref.parentUserMessageID)
        userRecord = userMessages.get(ref.parentUserMessageID);
      if (!userRecord && ref.bgTaskToken) {
        userRecord = messages.find(
          (item) =>
            item.info.role === "user" &&
            extractBackgroundToken(item.parts) === ref.bgTaskToken,
        );
        if (userRecord) {
          ref.parentUserMessageID = userRecord.info.id;
          stateChanged = true;
        }
      }

      const assistantRecord = ref.parentUserMessageID
        ? assistantByParent.get(ref.parentUserMessageID)
        : undefined;
      if (
        assistantRecord &&
        ref.assistantMessageID !== assistantRecord.info.id
      ) {
        ref.assistantMessageID = assistantRecord.info.id;
        stateChanged = true;
      }

      const title =
        ref.title ||
        summarizeMessageParts(userRecord?.parts ?? []) ||
        "Tarea background de la misma sesión";
      if (title !== ref.title) {
        ref.title = title;
        stateChanged = true;
      }

      const status = buildSessionRunStatus({
        assistant: assistantRecord,
        hasPendingInput,
      });
      const queuedAt = toIsoTime(
        (userRecord?.info as any)?.time?.created ?? ref.createdAt,
      );
      const startedAt = toIsoTime(
        (assistantRecord?.info as any)?.time?.created,
      );
      const completedAt = toIsoTime(
        (assistantRecord?.info as any)?.time?.completed,
      );
      const error =
        assistantRecord && (assistantRecord.info as any).error
          ? JSON.stringify((assistantRecord.info as any).error)
          : undefined;

      return {
        id: ref.id,
        source: "session-run" as const,
        sequence: ref.sequence,
        status,
        mode: "same-session",
        sessionID,
        title,
        description: error || makeSessionRunDescription(status, title),
        error,
        queuedAt,
        startedAt,
        completedAt,
        updatedAt:
          completedAt || startedAt || queuedAt || toIsoTime(ref.detachedAt),
        parentUserMessageID: ref.parentUserMessageID,
        assistantMessageID: ref.assistantMessageID,
        currentSession: sessionID === activeSessionID,
      };
    });

    if (stateChanged) saveSessionState(sessionID, state);
    return {
      records,
      backgroundModeEnabled: state.backgroundModeEnabled,
      stateChanged,
      nextState: state,
    };
  };

  const refreshSnapshot = async () => {
    const delegationSnapshot = await readProjectDelegations(currentDirectory());
    const sessionID = currentRouteSessionID();
    let sessionItems: TaskRecord[] = [];
    let backgroundModeEnabled = false;

    if (sessionID) {
      const sessionsResult = await api.client.session.list({
        directory: currentDirectory(),
        limit: 200,
      });
      const sessions = (sessionsResult?.data ?? []) as Array<{
        id: string;
        parentID?: string;
        title?: string;
      }>;
      const currentSessionInfo =
        sessions.find((item) => item.id === sessionID) ??
        (await fetchSessionInfo(api, sessionID));
      if (currentSessionInfo?.id) {
        const currentState = loadSessionState(sessionID);
        backgroundModeEnabled = currentState.backgroundModeEnabled;
        const rootSessionID = resolveThreadRootSessionID(
          currentState,
          currentSessionInfo,
        );
        const threadState = loadThreadState(rootSessionID);
        const threadSessionIDs = sessions
          .filter(
            (item) =>
              item.id === rootSessionID || item.parentID === rootSessionID,
          )
          .map((item) => item.id);
        if (!threadSessionIDs.includes(rootSessionID))
          threadSessionIDs.unshift(rootSessionID);
        await ensureThreadSequences(rootSessionID, threadSessionIDs);
        const backgroundSessionIDs = threadSessionIDs.filter(
          (candidate) => candidate !== threadState.foregroundSessionID,
        );

        for (const candidateSessionID of backgroundSessionIDs) {
          const candidateState = loadSessionState(candidateSessionID);
          if (!candidateState.trackedTaskRefs.length) continue;
          const currentSession = await buildSessionRunRecords(
            candidateSessionID,
            sessionID,
          );
          sessionItems = [...sessionItems, ...currentSession.records];
        }
      }
    }

    const items = [...sessionItems, ...delegationSnapshot.items].sort((a, b) =>
      sortKey(b).localeCompare(sortKey(a)),
    );
    const next: Snapshot = {
      projectId: delegationSnapshot.projectId,
      items,
      counts: countItems(items),
      backgroundModeEnabled,
      currentSessionID: sessionID,
    };

    const nextStatuses = new Map<string, string>();
    for (const item of next.items)
      nextStatuses.set(`${item.source}:${item.id}`, item.status);

    const inspection = loadInspectionState();
    if (
      inspection &&
      !next.items.some((item) => {
        if (inspection.taskSource === "delegation") {
          return (
            item.source === "delegation" &&
            (!inspection.taskID || item.id === inspection.taskID)
          );
        }
        return (
          item.source === "session-run" &&
          item.sessionID ===
            (inspection.sourceSessionID || inspection.sessionID) &&
          (!inspection.taskID || item.id === inspection.taskID)
        );
      })
    ) {
      clearInspectionState();
    }

    if (initializedProjectId && initializedProjectId === next.projectId) {
      for (const item of next.items) {
        const key = `${item.source}:${item.id}`;
        const previousStatus = lastStatuses.get(key);
        if (
          previousStatus &&
          previousStatus !== item.status &&
          TOASTABLE_STATUSES.has(item.status)
        ) {
          showStatusToast(item);
        }
      }
    }

    snapshot = next;
    initializedProjectId = next.projectId;
    lastStatuses = nextStatuses;
    api.renderer.requestRender();
  };

  const openFallbackAlert = (item: TaskRecord) => {
    const message =
      item.source === "delegation"
        ? `Usá delegation_read("${item.id}") desde la sesión actual para inspeccionar el resultado persistido.`
        : item.status === "needs_input"
          ? "Esta tarea de la misma sesión está esperando input del usuario o un permiso en la sesión actual."
          : "Esta tarea background pertenece a la sesión actual; inspeccioná la conversación para ver el detalle.";

    api.ui.dialog.replace(() =>
      api.ui.DialogAlert({
        title:
          item.source === "delegation"
            ? "No hay una sesión hija activa"
            : "Tarea de la sesión actual",
        message,
      }),
    );
  };

  const handleTaskSelect = async (item: TaskRecord) => {
    const currentRouteID = currentRouteSessionID();
    const returnSessionID =
      resolveShellSessionID(currentRouteID) || currentRouteID || item.sessionID;

    if (item.source === "delegation") {
      if (!item.sessionID) {
        openFallbackAlert(item);
        return;
      }
      const hostSessionID = resolveInspectionHostSessionID(
        item.sessionID,
        returnSessionID,
      );
      saveInspectionState({
        sessionID: hostSessionID,
        sourceSessionID: item.sessionID,
        returnSessionID: returnSessionID || undefined,
        taskSource: "delegation",
        taskID: item.id,
      });
      api.ui.dialog.clear();
      if (hostSessionID !== currentRouteID)
        api.route.navigate("session", { sessionID: hostSessionID });
      return;
    }

    if (!item.sessionID) {
      openFallbackAlert(item);
      return;
    }

    const selectedInfo = await fetchSessionInfo(api, item.sessionID);
    if (!selectedInfo?.id) {
      api.ui.toast({
        title: "No se pudo cargar la sesión de la tarea",
        message: item.sessionID,
        variant: "error",
        duration: 7000,
      });
      return;
    }
    const hostSessionID = await ensureInspectionHostSession(
      item,
      returnSessionID,
    );
    saveInspectionState({
      sessionID: hostSessionID,
      sourceSessionID: item.sessionID,
      returnSessionID: returnSessionID || undefined,
      taskSource: "session-run",
      taskID: item.id,
      parentUserMessageID: item.parentUserMessageID,
      assistantMessageID: item.assistantMessageID,
    });

    api.ui.toast({
      title: "Inspeccionando tarea en background",
      message: item.title || item.id,
      variant: "info",
      duration: 4000,
    });
    if (hostSessionID !== currentRouteID) {
      api.route.navigate("session", { sessionID: hostSessionID });
      return;
    }
    void refreshSnapshot();
  };

  const openTasksDialog = () => {
    const actionOptions: Array<{
      title: string;
      value: TaskDialogValue;
      description: string;
      footer?: string;
    }> = [];
    const taskOptions = snapshot.items
      .slice()
      .sort(compareTaskDialogOrder)
      .map((item) => {
        const presentation = getStatusPresentation(item.status);
        const isSameSessionRun = item.source === "session-run";
        const description = isSameSessionRun ? undefined : item.mode;
        const footer = isSameSessionRun
          ? undefined
          : item.sessionID
            ? `Abrir sesión hija ${item.sessionID}`
            : `Usá delegation_read("${item.id}") para ver el resultado persistido`;
        return {
          title: displayTaskTitle(item, presentation.icon),
          value: { kind: "task", task: item } satisfies TaskDialogValue,
          description,
          footer,
        };
      });

    const options = [...actionOptions, ...taskOptions];

    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "Tareas en background",
        placeholder: "Seleccioná una tarea o acción",
        options:
          options.length > 0
            ? options
            : [
                {
                  title: "No se encontraron tareas en background",
                  value: undefined,
                  description:
                    "Lanzá primero una delegación o enviá la corrida actual a background.",
                  disabled: true,
                },
              ],
        onSelect: (option) => {
          const value = option.value as TaskDialogValue | undefined;
          if (!value) return;
          resetInspectionInterrupt();
          api.ui.dialog.clear();
          if (value.kind === "action") return;
          void handleTaskSelect(value.task);
        },
      }),
    );
  };

  const backgroundCurrentRun = async () => {
    try {
      const routeSessionID = currentRouteSessionID();
      const shellSessionID =
        resolveShellSessionID(routeSessionID) || routeSessionID;
      const sessionID = resolvePromptTargetSessionID(routeSessionID);
      if (
        !routeSessionID ||
        !sessionID ||
        api.route.current.name !== "session"
      ) {
        api.ui.toast({
          title: "No hay una sesión activa",
          message: "Abrí primero una sesión en ejecución.",
          variant: "warning",
          duration: 4000,
        });
        return;
      }

      const status = api.state.session.status(sessionID);
      if (status?.type !== "busy") {
        api.ui.toast({
          title: "La sesión no está corriendo",
          message:
            "Sólo las sesiones ocupadas pueden enviar la corrida actual a background.",
          variant: "warning",
          duration: 4000,
        });
        return;
      }

      const sessionInfo = await fetchSessionInfo(api, sessionID);
      if (!sessionInfo?.id) {
        throw new Error(
          `No se pudo cargar la sesión ${sessionID} antes de enviar la corrida actual a background`,
        );
      }
      const currentState = loadSessionState(sessionID);
      const rootSessionID = resolveThreadRootSessionID(
        currentState,
        sessionInfo,
      );
      const currentThreadState = loadThreadState(rootSessionID);
      const threadTitle =
        currentThreadState.title ||
        sessionInfo.title ||
        "Hilo de tareas en background";

      if (!(await ensureCurrentRunTracked(sessionID, rootSessionID))) return;

      const createResult = await api.client.session.create({
        parentID: rootSessionID,
        title: threadTitle,
      });
      const newForegroundSessionID = (createResult as any)?.data?.id as
        | string
        | undefined;
      if (!newForegroundSessionID) {
        throw new Error(
          `No se pudo crear una nueva sesión técnica de foreground para el hilo ${rootSessionID}`,
        );
      }

      const foregroundState = loadSessionState(newForegroundSessionID);
      foregroundState.backgroundModeEnabled = false;
      foregroundState.threadRootSessionID = rootSessionID;
      foregroundState.trackedTaskRefs = foregroundState.trackedTaskRefs ?? [];
      saveSessionState(newForegroundSessionID, foregroundState);

      const threadState = loadThreadState(rootSessionID);
      threadState.rootSessionID = rootSessionID;
      threadState.foregroundSessionID = newForegroundSessionID;
      threadState.title = threadTitle;
      saveThreadState(rootSessionID, threadState);

      clearInspectionState();
      if (shellSessionID && routeSessionID !== shellSessionID) {
        api.route.navigate("session", { sessionID: shellSessionID });
      }
      await refreshSnapshot();
      api.ui.toast({
        title: "La tarea actual pasó a background",
        message:
          "La tarea anterior sigue viva en background. Esta consola ya quedó libre para un nuevo prompt.",
        variant: "success",
        duration: 6000,
      });
    } catch (error) {
      api.ui.toast({
        title: "No se pudo enviar la corrida a background",
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
        duration: 7000,
      });
    }
  };

  const openForegroundCommand = async () => {
    try {
      resetInspectionInterrupt();
      await focusForegroundSession();
      await refreshSnapshot();
    } catch (error) {
      api.ui.toast({
        title: "No se pudo volver al foreground",
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
        duration: 7000,
      });
    }
  };

  const renderSessionNotice = (input: {
    sessionID: string;
    activeSessionID: string;
  }) => {
    const inspection = loadInspectionState();
    if (!inspection || inspection.sessionID !== input.sessionID) return null;

    const theme = api.theme.current;
    const needsForegroundResponse =
      api.state.session.permission(input.activeSessionID).length > 0 ||
      api.state.session.question(input.activeSessionID).length > 0;

    return createElement(
      "box",
      {
        flexShrink: 0,
        marginTop: 1,
        border: ["left"],
        borderColor: theme.backgroundPanel,
      },
      createElement(
        "box",
        {
          paddingTop: 1,
          paddingBottom: 1,
          paddingLeft: 2,
          backgroundColor: theme.backgroundPanel,
          flexDirection: "column",
        },
        createElement(
          "text",
          { fg: theme.text },
          "Inspeccionando tarea en background",
        ),
        createElement(
          "text",
          { fg: theme.textMuted },
          "Usá ctrl+f ctrl+f para volver al foreground.",
        ),
        needsForegroundResponse
          ? createElement(
              "text",
              { fg: theme.warning },
              "Esta tarea requiere una respuesta para continuar.",
            )
          : null,
      ),
    );
  };

  const debugBackgroundState = async () => {
    const sessionID = currentRouteSessionID();
    if (!sessionID) return;
    const state = loadSessionState(sessionID);
    api.ui.toast({
      title: "Estado BG",
      message: `${sessionID} · modo=${String(state.backgroundModeEnabled)} · tracked=${state.trackedTaskRefs.length}`,
      variant: "info",
      duration: 5000,
    });
  };

  const unregisterSessionAdapter = api.session.registerAdapter({
    id: "background-agents-tui.session-adapter",
    priority: 1000,
    resolve: buildSessionProjection,
  });
  const unregisterSessionListAdapter = api.session.registerListAdapter({
    id: "background-agents-tui.session-list-adapter",
    priority: 1000,
    resolve: buildSessionListProjection,
  });

  const unregisterCommands = api.command.register(() => {
    const routeSessionID = currentRouteSessionID();
    const promptTargetSessionID = resolvePromptTargetSessionID(routeSessionID);
    const busy = Boolean(
      promptTargetSessionID &&
        api.state.session.status(promptTargetSessionID)?.type === "busy",
    );
    const inspectionSourceSessionID =
      resolveInterruptibleInspectionSourceSessionID();
    const inspectionBusy = Boolean(
      inspectionSourceSessionID &&
        api.state.session.status(inspectionSourceSessionID)?.type === "busy",
    );

    return [
      {
        title: "Tareas en background",
        value: "bg-tasks",
        description:
          "Mostrar tareas async/background de este proyecto y de la sesión actual",
        category: "Async",
        slash: { name: "bg-tasks", aliases: ["bgtasks"] },
        suggested:
          snapshot.counts.running > 0 ||
          snapshot.counts.pending > 0 ||
          snapshot.backgroundModeEnabled,
        onSelect: openTasksDialog,
      },
      {
        title: "Enviar corrida actual a background",
        value: "bg-current",
        description:
          "Mantener viva la corrida actual y liberar el foreground para seguir trabajando",
        category: "Async",
        keybind: "ctrl+b ctrl+b",
        slash: { name: "bg-current", aliases: ["background-current"] },
        hidden: api.route.current.name !== "session",
        enabled: busy,
        suggested: busy && !snapshot.backgroundModeEnabled,
        onSelect: () => {
          void backgroundCurrentRun();
        },
      },
      {
        title: "Volver al foreground",
        value: "bg-foreground",
        description: "Volver al foreground actual de esta sesión lógica",
        category: "Async",
        keybind: "ctrl+f ctrl+f",
        slash: { name: "bg-foreground", aliases: ["foreground-task"] },
        hidden: api.route.current.name !== "session",
        enabled: true,
        onSelect: () => {
          void openForegroundCommand();
        },
      },
      {
        title: "Interrumpir tarea inspeccionada",
        value: "bg-inspection-interrupt",
        description:
          "Interrumpir la corrida real de la tarea background que estás inspeccionando",
        category: "Async",
        keybind: "session_interrupt",
        hidden: !inspectionSourceSessionID,
        enabled: inspectionBusy,
        suggested: inspectionBusy,
        onSelect: () => {
          void interruptInspectionRun().catch((error) => {
            resetInspectionInterrupt();
            api.ui.toast({
              title: "No se pudo interrumpir la tarea background",
              message: error instanceof Error ? error.message : String(error),
              variant: "error",
              duration: 7000,
            });
          });
        },
      },
      {
        title: "Debug del estado background",
        value: "bg-debug",
        description:
          "Inspeccionar el estado background actual de la misma sesión",
        category: "Async",
        slash: { name: "bg-debug" },
        hidden: api.route.current.name !== "session",
        onSelect: () => {
          void debugBackgroundState();
        },
      },
    ];
  });

  const unregisterSlots = api.slots.register({
    order: 1000,
    id: "background-agents-tui-footer",
    slots: {
      sidebar_content: () => renderSidebarSummary(snapshot),
      sidebar_footer: () => renderFooter(snapshot),
      session_prompt: (props: {
        session_id: string;
        visible?: boolean;
        disabled?: boolean;
        on_submit?: () => void;
        ref?: (ref: any) => void;
      }) => {
        const shellSessionID =
          props.session_id || currentRouteSessionID() || "";
        const promptTargetSessionID =
          resolvePromptTargetSessionID(shellSessionID) || shellSessionID;
        const promptState = loadSessionState(promptTargetSessionID);
        return api.ui.Prompt({
          sessionID: promptTargetSessionID,
          visible: props.visible,
          disabled: props.disabled,
          allowSubmitWhenBusy:
            promptState.backgroundModeEnabled &&
            promptState.trackedTaskRefs.length > 0,
          submit: (request: any) =>
            submitInlineBackgroundPrompt(promptTargetSessionID, request),
          onSubmit: props.on_submit,
          ref: (ref) => {
            const sessionKey = promptTargetSessionID || shellSessionID;
            if (sessionKey) {
              if (ref) promptRefs.set(sessionKey, ref);
              else promptRefs.delete(sessionKey);
            }
            props.ref?.(ref);
          },
          right: api.ui.Slot({
            name: "session_prompt_right",
            session_id: promptTargetSessionID || shellSessionID,
          }),
        });
      },
      session_notice: (props: {
        session_id: string;
        active_session_id: string;
      }) =>
        renderSessionNotice({
          sessionID: props.session_id,
          activeSessionID: props.active_session_id,
        }),
      session_prompt_right: (props: { session_id: string }) =>
        snapshot.backgroundModeEnabled &&
        props.session_id &&
        api.state.session.status(props.session_id)?.type === "busy"
          ? createElement(
              "text",
              {},
              "Modo BG · el prompt inline usa promptAsync",
            )
          : null,
    },
  });

  clearInspectionState();
  await refreshSnapshot();
  const interval = setInterval(() => {
    void refreshSnapshot();
  }, POLL_INTERVAL_MS);

  api.lifecycle.onDispose(() => {
    clearInterval(interval);
    resetInspectionInterrupt();
    unregisterSessionAdapter();
    unregisterSessionListAdapter();
    unregisterCommands();
    unregisterSlots();
  });
};

export const id: TuiPluginModule["id"] = "background-agents-tui";
export const tui: TuiPluginModule["tui"] = BackgroundAgentsTui;
export { BackgroundAgentsTui };
export default { id, tui } satisfies TuiPluginModule;
