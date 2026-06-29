import type { ScanConnection, ScanMessage, MessageFieldMap } from "./recipe";

/** A "messages" pass appended after the connection pass(es). Metadata only. */
export type MessagesTarget = {
  listPathTemplate: string;
  pageSize: number;
  /** Path to the next-page cursor token. Absent → numeric offset pagination. */
  cursorPath?: string;
  /** Pre-fetch to learn the owner's own id (for direction). */
  selfIdSource?: { listPathTemplate: string; idPath: string };
  /** Or the owner id is in the list response itself, at this path. */
  selfIdPath?: string;
  messageFieldMap: MessageFieldMap;
  /** Drop conversations that are only un-replied first message(s) (X). */
  excludeUnreplied?: boolean;
};

/** Recipe shape the orchestrator needs. Site specifics live here, never in code. */
export type ScanRecipe = {
  /** Source discriminator + payload routing key (e.g. "linkedin_extension" | "x"). */
  source?: string;
  /** Human label for the popup (e.g. "LinkedIn", "X"). */
  networkLabel?: string;
  /** First-party endpoint the handoff POSTs this source's payload to. */
  ingestPath?: string;
  targetOrigin: string;
  listPathTemplate: string;
  paginationParams: { pageSize: number };
  /** Cursor-pagination path for the connection list (X). Absent → numeric offset. */
  cursorPath?: string;
  pacing: { maxPagesPerSession: number; minDelayMs: number; maxDelayMs: number };
  csrfRule: { header: string; cookie: string };
  /** Extra static headers merged onto every request (e.g. X's public bearer). */
  staticHeaders?: Record<string, string>;
  fieldMap: {
    elementsPath: string;
    firstName: string;
    lastName: string;
    profileUrl: string;
    headline: string;
    connectedOn?: string;
    pictureRootUrl?: string;
    pictureArtifactsPath?: string;
    /** A stable external id (X rest_id) when profileUrl is a handle. */
    externalId?: string;
  };
  /** Two+ lists to scan and INTERSECT into connections (X mutual follows). When
   *  present, these REPLACE the single top-level list. */
  connectionLists?: Array<{ listPathTemplate: string; cursorPath?: string }>;
  intersectConnections?: boolean;
  /** Optional second "messages" pass (1:1 DM metadata). */
  messages?: MessagesTarget;
  /** Source values to hide from the sync history (recipe-driven, set at pair time). */
  excludeSources?: string[];
};

export type Account = {
  id: string;
  displayName?: string;
  [key: string]: unknown;
};

export type Needs = "network-signin" | "noticed-signin" | null;

/** A finished, source-shaped scan awaiting the first-party POST. The payload is
 *  the EXACT body for `ingestPath`; the broker just posts it (no per-source logic). */
export type PendingScan = {
  source: string;
  ingestPath: string;
  payload: Record<string, unknown>;
  count: number;
};

export type State = {
  /** Back-compat single recipe (the LinkedIn one). New code reads `recipes`. */
  recipe: ScanRecipe | null;
  /** Per-source recipes, keyed by `recipe.source` (NT-45 multi-network). */
  recipes?: Record<string, ScanRecipe> | null;
  account: Account | null;
  noticedOrigin: string | null;
  /** Per-source finished scans awaiting handoff, keyed by source. */
  pendingScans?: Record<string, PendingScan> | null;
  /** Per-source last confirmed sync, keyed by source. */
  lastScanBySource?: Record<string, { at: number; count: number }> | null;
  lastScanAt: number | null;
  lastScanCount: number | null;
  /** When the most recent automatic scan hit the network — drives the once-per-period throttle. */
  lastScanStartedAt: number | null;
  needs: Needs;
  testMode?: boolean;
  // ── Checkpoint-and-resume scan state (MV3 resilience) ─────────────────────
  /** A scan is mid-flight (set at scanNow, cleared on finalize/abort). */
  scanInProgress?: boolean;
  /** The source of the single in-flight scan. */
  scanSource?: string | null;
  /** Index into the source's phase plan (connection list(s) then messages). */
  scanPhaseIndex?: number | null;
  /** The cursor of the next page to fetch (resume point) — a numeric offset, or
   *  an opaque token string for cursor-paginated sources (X). */
  scanCursor?: number | string | null;
  /** Items accumulated so far for the CURRENT phase. */
  scanItems?: unknown[] | null;
  /** Completed-phase outputs: one ScanConnection[] per connection list + messages. */
  scanPhaseResults?: { connLists: ScanConnection[][]; messages: ScanMessage[] } | null;
  /** The owner's own id resolved for the messages pass (direction). */
  scanSelfId?: string | null;
  /** When the current scan began — drives the stale-zombie guard. */
  scanStartedAt?: number | null;
  /**
   * The id of the background handoff tab opened at finalize (the /x/sync page).
   * Closed on syncConfirmed so the silent background tab doesn't linger.
   */
  syncTabId?: number | null;
};

const KEYS: (keyof State)[] = [
  "recipe",
  "recipes",
  "account",
  "noticedOrigin",
  "pendingScans",
  "lastScanBySource",
  "lastScanAt",
  "lastScanCount",
  "lastScanStartedAt",
  "needs",
  "testMode",
  "scanInProgress",
  "scanSource",
  "scanPhaseIndex",
  "scanCursor",
  "scanItems",
  "scanPhaseResults",
  "scanSelfId",
  "scanStartedAt",
  "syncTabId",
];

/** Typed read of the full stored state (any unset key is simply absent). */
export async function getState(): Promise<Partial<State>> {
  const raw = await chrome.storage.local.get(KEYS as string[]);
  return raw as Partial<State>;
}

/** Typed partial write. */
export async function setState(patch: Partial<State>): Promise<void> {
  await chrome.storage.local.set(patch as Record<string, unknown>);
}
