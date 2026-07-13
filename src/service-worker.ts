/**
 * The extension's brain. Stores per-source recipes + an account (from pairing
 * with a first-party noticed page), runs paced scans as the logged-in user
 * against each recipe's target site, and hands results to a noticed page that
 * POSTs them — the extension never holds a noticed credential.
 *
 * No site specifics live here: everything site-shaped comes from the recipe at
 * runtime. A scan is a sequence of PHASES (one per connection list — one for
 * LinkedIn, two to intersect into mutual follows for X — then an optional 1:1
 * message-metadata pass). Multi-network: LinkedIn and X coexist (per-source
 * recipes, pending scans and last-sync stamps).
 *
 * Scan resilience (MV3): the service worker can be torn down mid-scan. The scan
 * is a CHECKPOINT-AND-RESUME stepper: progress (phase index, cursor, items,
 * completed-phase results) is persisted after every page, a short keepalive tick
 * alarm re-drives the stepper, and on SW startup an interrupted scan auto-resumes.
 */
import { buildCsrfHeaders } from "./lib/cookies";
import { applyFieldMap, getByPath } from "./lib/recipe";
import type { ScanConnection, ScanMessage } from "./lib/recipe";
import {
  extractMessages,
  extractTweetEdges,
  tweetsArrayOf,
  extractConversationEventTargets,
  computeHadReplyFromEvents,
  encodeRestliValue,
} from "./lib/message-extract";
import type { XTweetEdgeRow } from "./lib/message-extract";
import { planPhases, assembleScanPayload, type Phase, type ScanExtras } from "./lib/scan-plan";
import { getState, setState } from "./lib/storage";
import type { Account, ScanRecipe, PendingScan, State } from "./lib/storage";

const SCAN_ALARM = "scan";
const SCAN_PERIOD_MINUTES = 43200; // ~30 days
const SCAN_PERIOD_MS = SCAN_PERIOD_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_THROTTLE_MS = SCAN_PERIOD_MS - DAY_MS;
const SYNC_PATH = "/x/sync";
const DEFAULT_SOURCE = "linkedin_extension";

const SCAN_TICK_ALARM = "scan-tick";
const SCAN_TICK_PERIOD_MINUTES = 0.5;
const SCAN_STALE_CUTOFF_MS = 60 * 60 * 1000; // 1h

/**
 * NT-99 — circuit breaker for the message-events probe: abort the whole pass
 * after this many CONSECUTIVE failed probe fetches (non-OK response or throw;
 * a success resets the count). A rotated/broken events endpoint (e.g. a stale
 * recipe queryId) would otherwise fire up to `maxConversations` sequential
 * failed requests per scan — the v1.2.3 ban-risk fingerprint. Aborted
 * conversations simply omit had_reply (legacy server behavior) and cached
 * verdicts are unaffected.
 */
const MAX_CONSECUTIVE_PROBE_FAILURES = 5;

// ── Messages ────────────────────────────────────────────────────────────────

type ExternalMessage =
  | { type: "ping" }
  | { type: "pair"; recipe: ScanRecipe; recipes?: ScanRecipe[]; account: Account }
  | { type: "getCachedScan"; source?: string }
  | { type: "syncConfirmed"; source?: string };

type InternalMessage =
  | { type: "getStatus" }
  | { type: "scanNow"; source?: string }
  | { type: "setTestMode"; value: boolean }
  | { type: "getSyncHistory" };

// ── Origin allowlist ─────────────────────────────────────────────────────────

/** Only first-party noticed pages may talk to the extension externally. */
export function isNoticedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && /(^|\.)noticed\.so$/.test(url.hostname);
  } catch {
    return false;
  }
}

function senderOrigin(sender: { origin?: string; url?: string }): string | null {
  if (sender.origin) return sender.origin;
  if (sender.url) {
    try {
      return new URL(sender.url).origin;
    } catch {
      return null;
    }
  }
  return null;
}

// ── Recipe registry ───────────────────────────────────────────────────────────

/** All paired recipes keyed by source (back-compat: fall back to the single recipe). */
function recipesOf(state: Partial<State>): Record<string, ScanRecipe> {
  if (state.recipes && Object.keys(state.recipes).length > 0) return state.recipes;
  if (state.recipe) return { [state.recipe.source ?? DEFAULT_SOURCE]: state.recipe };
  return {};
}

function sourceOf(recipe: ScanRecipe): string {
  return recipe.source ?? DEFAULT_SOURCE;
}

/**
 * Does a just-granted host pattern (e.g. "https://www.linkedin.com/*" or the
 * broader optional "*://*.linkedin.com/*") cover a source's target origin? Host
 * suffix match, tolerant of a leading "*." wildcard — so a permissions.onAdded
 * event can be mapped back to the paired source it unlocks.
 */
export function grantCovers(pattern: string, targetOrigin: string): boolean {
  try {
    const host = new URL(targetOrigin).hostname;
    const patHost = /^[^:]+:\/\/([^/]+)/.exec(pattern)?.[1] ?? "";
    const bare = patHost.replace(/^\*\./, "").replace(/^\*/, "");
    if (!bare) return false;
    return host === bare || host.endsWith("." + bare);
  } catch {
    return false;
  }
}

/** Sources whose optional host permission the user has already granted. */
async function grantedSources(
  recipes: Record<string, ScanRecipe>,
): Promise<string[]> {
  const out: string[] = [];
  for (const [src, recipe] of Object.entries(recipes)) {
    try {
      const ok = await chrome.permissions.contains({ origins: [recipe.targetOrigin + "/*"] });
      if (ok) out.push(src);
    } catch {
      // ignore — treat as not granted
    }
  }
  return out;
}

// ── Scan ─────────────────────────────────────────────────────────────────────

export type RunScanDeps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  nowMs?: () => number;
};

export type RunScanResult = { ok: boolean; needs?: string; count?: number; note?: string };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeJitter(recipe: ScanRecipe): () => number {
  const { minDelayMs, maxDelayMs } = recipe.pacing;
  return () => minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
}

/** An X cursor of "0"/"" (and any missing value) marks the end of a list. */
function normalizeCursor(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  if (s === "" || s === "0") return null;
  return s;
}

/** First cursor for a phase: an opaque token source starts at "-1" (X), else 0. */
function defaultStart(phase: Phase): number | string {
  return phase.kind === "connections" && phase.cursorPath ? "-1" : 0;
}

function substituteCursor(
  template: string,
  recipe: ScanRecipe,
  cursor: number | string,
  selfId = "",
): string {
  return recipe.targetOrigin +
    template
      .replaceAll("{start}", String(cursor))
      .replaceAll("{cursor}", String(cursor))
      .replaceAll("{count}", String(recipe.paginationParams.pageSize))
      .replaceAll("{self}", selfId);
}

/** Raw item count on a messages page (for short-page detection) — the entries
 *  array (dmEntries) or the conversation list (else), array or keyed object. */
function countMessageRaw(json: unknown, fieldMap: NonNullable<ScanRecipe["messages"]>["messageFieldMap"]): number {
  const path =
    "mode" in fieldMap && fieldMap.mode === "dmEntries"
      ? fieldMap.entriesPath
      : (fieldMap as { elementsPath: string }).elementsPath;
  const raw = getByPath(json, path);
  if (Array.isArray(raw)) return raw.length;
  if (raw && typeof raw === "object") return Object.keys(raw).length;
  return 0;
}

let scanRunning = false;

function armScanTick(): void {
  chrome.alarms.create(SCAN_TICK_ALARM, { periodInMinutes: SCAN_TICK_PERIOD_MINUTES });
}
function clearScanTick(): void {
  void chrome.alarms.clear(SCAN_TICK_ALARM);
}
function isScanStale(startedAt: number | null | undefined, now: number): boolean {
  if (startedAt == null) return true;
  return now - startedAt > SCAN_STALE_CUTOFF_MS;
}

/**
 * Resolve the owner's own id for the messages pass (for direction). From a
 * cookie (X `twid` → `u=<id>`) or a pre-fetch (LinkedIn `/voyager/api/me`,
 * `extract`-trimmed to the bare id). Returns "" when neither is configured (the
 * `selfIdPath` case is resolved lazily from the first page).
 */
async function resolveSelfId(
  recipe: ScanRecipe,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<string> {
  const m = recipe.messages;
  if (!m) return "";
  if (m.selfIdCookie) {
    try {
      const c = await chrome.cookies.get({ url: recipe.targetOrigin, name: m.selfIdCookie.name });
      const val = c?.value ? decodeURIComponent(c.value) : "";
      const match = val.match(new RegExp(m.selfIdCookie.pattern));
      if (match && match[1]) return match[1];
    } catch {
      // ignore — fall through
    }
  }
  if (m.selfIdSource) {
    const res = await fetchImpl(recipe.targetOrigin + m.selfIdSource.listPathTemplate, {
      credentials: "include",
      headers,
    });
    if (res.ok) {
      const json = await res.json();
      let v = String(getByPath(json, m.selfIdSource.idPath) ?? "");
      if (m.selfIdSource.extract) {
        const match = v.match(new RegExp(m.selfIdSource.extract));
        if (match && match[1]) v = match[1];
      }
      return v;
    }
  }
  return "";
}

/** Read the owner id from a cookie (X `twid` → `u=<id>`), regex group 1. */
async function resolveSelfIdFromCookie(
  targetOrigin: string,
  spec: { name: string; pattern: string },
): Promise<string> {
  try {
    const c = await chrome.cookies.get({ url: targetOrigin, name: spec.name });
    const val = c?.value ? decodeURIComponent(c.value) : "";
    const match = val.match(new RegExp(spec.pattern));
    if (match && match[1]) return match[1];
  } catch {
    // ignore — treat as unresolved
  }
  return "";
}

/**
 * NT-63 owner-profile pass (LinkedIn). Resolve the owner's own id, then GET each
 * recipe endpoint (with `{self}` interpolated) and collect its raw JSON keyed by
 * `endpoint.key`. The server maps the raw JSON — the extension stays
 * source-agnostic. Best-effort: any failure yields `undefined` (or a partial
 * object) and never blocks the connections import.
 */
async function runOwnerProfilePass(
  recipe: ScanRecipe,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | undefined> {
  const op = recipe.ownerProfile;
  if (!op) return undefined;

  const res = await fetchImpl(recipe.targetOrigin + op.selfIdSource.listPathTemplate, {
    credentials: "include",
    headers,
  });
  if (!res.ok) return undefined;
  const meJson = await res.json();
  let self = String(getByPath(meJson, op.selfIdSource.idPath) ?? "");
  if (op.selfIdSource.extract) {
    const match = self.match(new RegExp(op.selfIdSource.extract));
    if (match && match[1]) self = match[1];
  }
  if (!self) return undefined;

  const out: Record<string, unknown> = {};
  for (const ep of op.endpoints) {
    try {
      const r = await fetchImpl(recipe.targetOrigin + ep.pathTemplate.replaceAll("{self}", self), {
        credentials: "include",
        headers,
      });
      if (!r.ok) continue;
      out[ep.key] = await r.json();
    } catch {
      // best-effort per endpoint — skip a failing one
    }
  }
  return out;
}

/**
 * Twitter max_id backward pagination: the next page ends just before the oldest
 * id on this page (`min(id) - 1`). Returns null when no numeric id is present so
 * the paginator stops. Kept for user_timeline, which carries no cursor token.
 */
function nextMaxIdCursor(rawTweets: unknown[], tweetIdPath: string): string | null {
  let min: bigint | null = null;
  for (const tw of rawTweets) {
    try {
      const id = BigInt(String(getByPath(tw, tweetIdPath)));
      if (min === null || id < min) min = id;
    } catch {
      // non-numeric id — can't derive max_id from it
    }
  }
  return min === null ? null : (min - 1n).toString();
}

/**
 * NT-63 owner-tweets pass (X). Resolve the owner id (the `twid` cookie, as the
 * messages pass does), then page the owner's recent tweets into mention/reply
 * EDGE rows via `extractTweetEdges` — metadata only, never the tweet text.
 * Best-effort: any failure yields the rows gathered so far and never blocks the
 * connections import.
 */
async function runTweetsPass(
  recipe: ScanRecipe,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  selfId: string,
  sleep: (ms: number) => Promise<void>,
  jitter: () => number,
  maxPages: number,
): Promise<XTweetEdgeRow[]> {
  const t = recipe.tweets;
  if (!t) return [];
  let self = selfId;
  if (!self && t.selfIdCookie) self = await resolveSelfIdFromCookie(recipe.targetOrigin, t.selfIdCookie);
  if (!self) return [];

  const cap = Math.max(1, Math.min(maxPages, t.maxPagesPerSession ?? maxPages));
  const { scanConnections } = await import("./lib/fetch-engine");
  return scanConnections<XTweetEdgeRow>({
    fetchPage: async (cursor) => {
      const res = await fetchImpl(substituteCursor(t.listPathTemplate, recipe, cursor, self), {
        credentials: "include",
        headers,
      });
      if (!res.ok) throw new Error(`tweets page fetch failed: ${res.status}`);
      const json = await res.json();
      const raw = tweetsArrayOf(json, t.tweetFieldMap);
      const items = extractTweetEdges(json, t.tweetFieldMap);
      const nextCursor = t.cursorPath
        ? normalizeCursor(getByPath(json, t.cursorPath))
        : nextMaxIdCursor(raw, t.tweetFieldMap.tweetIdPath);
      return { items, rawCount: raw.length, nextCursor };
    },
    pageSize: t.pageSize,
    maxPages: cap,
    sleep,
    jitter,
    startAt: "", // first page: empty max_id → the latest tweets
  });
}

/**
 * NT-99 follow-up — the bounded per-conversation had_reply probe (LinkedIn).
 * The conversations summary carries no per-message senders, so we can't tell a
 * one-way DM from a real exchange. This pass does ONE conversations-list fetch to
 * learn which conversations exist, then — for up to `maxConversations` most-recent
 * ones — GETs the recipe's per-conversation events endpoint and reads only the
 * message SENDERS (never text) to compute had_reply = sawSelf && sawCounterpart.
 *
 * Ban-risk guardrails (v1.2.3 lesson): a hard conversation cap, a jittered delay
 * between probes, and NO retries — any per-conversation failure/over-cap
 * conversation simply omits had_reply (the server then keeps its legacy
 * log-everything behavior). Returns a map counterpartProfileUrl → had_reply for
 * the conversations it could determine. Best-effort: a total failure yields {}.
 *
 * DELTA-ONLY: verdicts are cached per conversation urn (`hadReplyByConversation`
 * in storage, stamped with the lastActivityAt they were computed at). A
 * conversation whose lastActivityAt is unchanged reuses its cached verdict with
 * NO fetch — so a re-scan only probes conversations that are new or have new
 * activity (a quiet inbox costs ~0 probe fetches). The cache is also
 * correctness-bearing: it keeps a previously-false (one-way) conversation
 * flagged on later scans instead of regressing to the server's legacy
 * log-everything path. A failed probe leaves no cache entry, so it is naturally
 * re-tried on the NEXT scan (never within one).
 */
async function runLinkedInMessageEventsPass(
  recipe: ScanRecipe,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  selfId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const m = recipe.messages;
  const me = m?.messageEvents;
  // No probe configured, or self unresolved (can't attribute senders) → omit all.
  if (!m || !me || !selfId) return out;
  const fieldMap = m.messageFieldMap;
  if (!("mode" in fieldMap) || fieldMap.mode !== "participantConversations") return out;

  // One conversations-list fetch to learn which conversations to probe.
  const listRes = await fetchImpl(substituteCursor(m.listPathTemplate, recipe, 0, selfId), {
    credentials: "include",
    headers,
  });
  if (!listRes.ok) return out;
  const listJson = await listRes.json();
  const targets = extractConversationEventTargets(listJson, fieldMap, me.conversationUrnPath, selfId)
    .sort((a, b) => b.lastActivityAtMs - a.lastActivityAtMs); // most-recent first

  // Split cached-and-unchanged (reuse the verdict, no fetch) from new/changed
  // (needs a probe). The cap bounds actual FETCHES, not cache reuse.
  const cache = (await getState()).hadReplyByConversation ?? {};
  const nextCache: Record<string, { at: number; had_reply: boolean }> = {};
  const needProbe: typeof targets = [];
  for (const t of targets) {
    const cached = cache[t.conversationUrn];
    if (cached && cached.at >= t.lastActivityAtMs) {
      out.set(t.counterpartProfileUrl, cached.had_reply);
      nextCache[t.conversationUrn] = cached;
    } else {
      needProbe.push(t);
    }
  }
  const probes = needProbe.slice(0, Math.max(0, me.maxConversations)); // hard cap

  const jitterMs = (): number =>
    me.jitterMinMs + Math.random() * Math.max(0, me.jitterMaxMs - me.jitterMinMs);

  let consecutiveFailures = 0;
  for (let i = 0; i < probes.length; i++) {
    if (i > 0) await sleep(jitterMs()); // paced between probes
    const t = probes[i]!;
    try {
      const url =
        recipe.targetOrigin +
        me.urlTemplate
          // Rest.li-safe, NOT encodeURIComponent: the urn contains parens, which
          // encodeURIComponent leaves literal → Rest.li reads them as a nested
          // object → HTTP 400 on every probe. See encodeRestliValue.
          .replaceAll("{conversationUrn}", encodeRestliValue(t.conversationUrn))
          .replaceAll("{self}", selfId);
      const res = await fetchImpl(url, { credentials: "include", headers });
      if (!res.ok) {
        // No retry — degrade to omitted (re-tried next scan). A streak of
        // failures means the endpoint itself is broken (rotated queryId):
        // trip the breaker instead of hammering every remaining conversation.
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) break;
        continue;
      }
      consecutiveFailures = 0;
      const json = await res.json();
      const hr = computeHadReplyFromEvents(json, me, selfId);
      if (hr !== undefined) {
        out.set(t.counterpartProfileUrl, hr);
        nextCache[t.conversationUrn] = { at: t.lastActivityAtMs, had_reply: hr };
      }
    } catch {
      // best-effort per conversation — a failure just omits had_reply, but a
      // streak (network-level, not just HTTP) also trips the breaker.
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) break;
    }
  }
  // Persist the pruned cache (only conversations still in the summary list) so
  // the next scan is delta-only and the cache stays bounded.
  await setState({ hadReplyByConversation: nextCache });
  return out;
}

/**
 * Resumable phase stepper. Reads the persisted checkpoint, walks the recipe's
 * phases (connection list(s) then messages), checkpoints to storage after EACH
 * page, and on completion finalizes (assembles + caches the per-source payload,
 * opens the handoff tab). Idempotent + re-entrant-safe.
 */
export async function continueScan(deps: RunScanDeps = {}): Promise<RunScanResult> {
  if (scanRunning) return { ok: true, note: "already-running" };
  scanRunning = true;
  try {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const sleep = deps.sleep ?? realSleep;
    const now = deps.nowMs ?? (() => Date.now());

    const state = await getState();
    const { noticedOrigin, testMode, scanInProgress, scanSource } = state;
    if (!scanInProgress || !scanSource) return { ok: true, note: "not-in-progress" };
    const recipe = recipesOf(state)[scanSource];
    if (!recipe) return { ok: false };

    if (isScanStale(state.scanStartedAt, now())) {
      await clearScanState();
      clearScanTick();
      return { ok: false, note: "stale" };
    }

    const headers = await buildCsrfHeaders(recipe);
    if (!headers) {
      await clearScanState({ needs: "network-signin" });
      clearScanTick();
      return { ok: false, needs: "network-signin" };
    }

    const jitter = deps.jitter ?? makeJitter(recipe);
    const { scanConnections } = await import("./lib/fetch-engine");
    const phases = planPhases(recipe);
    const effectiveMaxPages = testMode
      ? Math.min(2, recipe.pacing.maxPagesPerSession)
      : recipe.pacing.maxPagesPerSession;

    const results = state.scanPhaseResults ?? { connLists: [], messages: [] };
    let selfId = state.scanSelfId ?? "";
    let phaseIndex = state.scanPhaseIndex ?? 0;
    let resumeThisPhase = true; // only the FIRST phase iteration resumes from the checkpoint

    while (phaseIndex < phases.length) {
      const phase = phases[phaseIndex]!;
      const startAt = resumeThisPhase ? state.scanCursor ?? defaultStart(phase) : defaultStart(phase);
      const initialItems = resumeThisPhase ? (state.scanItems ?? []) : [];

      if (phase.kind === "messages") {
        const m = recipe.messages!;
        // Resolve the owner id once (cookie or pre-fetch) so direction works AND
        // {self} can be interpolated into the URL (LinkedIn mailboxUrn).
        if (!selfId) selfId = await resolveSelfId(recipe, headers, fetchImpl);
        const items = await scanConnections<ScanMessage>({
          fetchPage: async (cursor) => {
            const res = await fetchImpl(substituteCursor(m.listPathTemplate, recipe, cursor, selfId), {
              credentials: "include",
              headers,
            });
            if (!res.ok) throw new Error(`messages page fetch failed: ${res.status}`);
            const json = await res.json();
            if (!selfId && m.selfIdPath) selfId = String(getByPath(json, m.selfIdPath) ?? "");
            const items = extractMessages(json, m.messageFieldMap, selfId, m.excludeUnreplied ?? false);
            const rawCount = countMessageRaw(json, m.messageFieldMap);
            const nextCursor = m.cursorPath ? normalizeCursor(getByPath(json, m.cursorPath)) : undefined;
            return { items, rawCount, nextCursor };
          },
          pageSize: m.pageSize,
          maxPages: effectiveMaxPages,
          sleep,
          jitter,
          startAt: resumeThisPhase ? (state.scanCursor ?? 0) : 0,
          initialItems: initialItems as ScanMessage[],
          onPage: async (its, nextCursor) => {
            await setState({ scanPhaseIndex: phaseIndex, scanCursor: nextCursor, scanItems: its, scanSelfId: selfId });
          },
        });
        results.messages = items;
      } else {
        const items = await scanConnections<ScanConnection>({
          fetchPage: async (cursor) => {
            const res = await fetchImpl(substituteCursor(phase.listPathTemplate, recipe, cursor), {
              credentials: "include",
              headers,
            });
            if (!res.ok) throw new Error(`scan page fetch failed: ${res.status}`);
            const json = await res.json();
            const items = applyFieldMap(json, recipe.fieldMap);
            const raw = getByPath(json, recipe.fieldMap.elementsPath);
            const rawCount = Array.isArray(raw) ? raw.length : 0;
            const nextCursor = phase.cursorPath ? normalizeCursor(getByPath(json, phase.cursorPath)) : undefined;
            return { items, rawCount, nextCursor };
          },
          pageSize: recipe.paginationParams.pageSize,
          maxPages: effectiveMaxPages,
          sleep,
          jitter,
          startAt,
          initialItems: initialItems as ScanConnection[],
          onPage: async (its, nextCursor) => {
            await setState({ scanPhaseIndex: phaseIndex, scanCursor: nextCursor, scanItems: its, scanSelfId: selfId });
          },
        });
        results.connLists.push(items);
      }

      phaseIndex += 1;
      resumeThisPhase = false;
      await setState({
        scanPhaseIndex: phaseIndex,
        scanCursor: null,
        scanItems: [],
        scanPhaseResults: results,
        scanSelfId: selfId,
      });
    }

    // NT-99 follow-up — the bounded per-conversation had_reply probe (LinkedIn),
    // AFTER the message phase so a failure never aborts a completed scan. Merges
    // the two-way flag onto the summary rows by counterpart; unprobed/failed
    // conversations keep had_reply ABSENT (the server then keeps its legacy
    // log-everything behavior — presence-based back-compat).
    if (recipe.messages?.messageEvents && results.messages.length > 0) {
      const hadReplyByCounterpart = await runLinkedInMessageEventsPass(
        recipe,
        headers,
        fetchImpl,
        selfId,
        sleep,
      ).catch(() => new Map<string, boolean>());
      if (hadReplyByCounterpart.size > 0) {
        results.messages = results.messages.map((msg) =>
          hadReplyByCounterpart.has(msg.counterpartProfileUrl)
            ? { ...msg, had_reply: hadReplyByCounterpart.get(msg.counterpartProfileUrl) }
            : msg,
        );
      }
    }

    // NT-63 best-effort owner side-passes, AFTER the connection/message phases so
    // a failure here can never abort a completed connections scan. Each is wrapped
    // so a throw degrades to "no extra" rather than wedging the scan.
    const extras: ScanExtras = {};
    if (recipe.ownerProfile) {
      extras.ownerProfile = await runOwnerProfilePass(recipe, headers, fetchImpl).catch(() => undefined);
    }
    if (recipe.tweets) {
      extras.tweetEdges = await runTweetsPass(
        recipe,
        headers,
        fetchImpl,
        selfId,
        sleep,
        jitter,
        effectiveMaxPages,
      ).catch(() => []);
    }

    return finalizeScan(
      recipe,
      results.connLists,
      results.messages,
      selfId,
      noticedOrigin ?? null,
      now(),
      extras,
    );
  } finally {
    scanRunning = false;
  }
}

/** Clear the in-flight scan checkpoint (and optionally set a `needs`). */
async function clearScanState(extra?: { needs?: "network-signin" }): Promise<void> {
  await setState({
    scanInProgress: false,
    scanSource: null,
    scanPhaseIndex: null,
    scanCursor: null,
    scanItems: null,
    scanPhaseResults: null,
    scanSelfId: null,
    scanStartedAt: null,
    ...(extra?.needs !== undefined ? { needs: extra.needs } : {}),
  });
}

/** Persist the finished scan, hand off, and tear down the keepalive tick. */
async function finalizeScan(
  recipe: ScanRecipe,
  connLists: ScanConnection[][],
  messages: ScanMessage[],
  selfId: string,
  noticedOrigin: string | null,
  startedAt: number,
  extras: ScanExtras = {},
): Promise<RunScanResult> {
  clearScanTick();
  const source = sourceOf(recipe);
  const { ingestPath, payload, count } = assembleScanPayload(recipe, connLists, messages, selfId, extras);
  const pending: PendingScan = { source, ingestPath, payload, count };

  const state = await getState();
  const pendingScans = { ...(state.pendingScans ?? {}), [source]: pending };

  const cleared = {
    scanInProgress: false,
    scanSource: null,
    scanPhaseIndex: null,
    scanCursor: null,
    scanItems: null,
    scanPhaseResults: null,
    scanSelfId: null,
    scanStartedAt: null,
  } as const;

  if (!noticedOrigin) {
    await setState({ pendingScans, needs: null, lastScanStartedAt: startedAt, ...cleared });
    return { ok: true, count, note: "no-handoff-origin" };
  }

  await setState({ pendingScans, needs: "noticed-signin", lastScanStartedAt: startedAt, ...cleared });

  // E7 silent handoff: open /x/sync?ext_id=…&source=<src> in a BACKGROUND tab.
  const tab = await chrome.tabs.create({
    url: `${noticedOrigin}${SYNC_PATH}?ext_id=${chrome.runtime.id}&source=${encodeURIComponent(source)}`,
    active: false,
  });
  await setState({ syncTabId: tab?.id ?? null });
  return { ok: true, count };
}

/**
 * Kick off a scan for ONE source from scratch: build csrf headers up front (so a
 * missing network session fails fast), initialize the phase checkpoint, arm the
 * keepalive tick, then drive continueScan() to completion.
 */
export async function runScan(source?: string, deps: RunScanDeps = {}): Promise<RunScanResult> {
  const state = await getState();
  const recipes = recipesOf(state);
  const src = source ?? state.recipe?.source ?? Object.keys(recipes)[0] ?? DEFAULT_SOURCE;
  const recipe = recipes[src];
  if (!recipe) return { ok: false };

  const headers = await buildCsrfHeaders(recipe);
  if (!headers) {
    await setState({ needs: "network-signin" });
    return { ok: false, needs: "network-signin" };
  }

  const now = deps.nowMs ?? (() => Date.now());
  await setState({
    scanInProgress: true,
    scanSource: src,
    scanPhaseIndex: 0,
    scanCursor: null,
    scanItems: [],
    scanPhaseResults: { connLists: [], messages: [] },
    scanSelfId: null,
    scanStartedAt: now(),
    needs: null,
  });
  armScanTick();
  return continueScan(deps);
}

/**
 * Auto-scan every source whose host permission is already granted, at most once
 * per throttle window. The SHARED path for the monthly alarm AND auto-scan-on-
 * pair (NT-66) — a single implementation so the two can never drift.
 *
 * The `lastScanStartedAt` throttle is load-bearing for the pair path: the /x/sync
 * handoff page (SyncBroker) re-pairs after EVERY finished scan to refresh the
 * served recipe. Without the throttle that re-pair re-runs a full scan, which
 * finalizes → opens another /x/sync tab → re-pairs → scans …, an unbounded loop
 * that continuously hammers LinkedIn/X (account-ban risk). A user gesture
 * (scanNow) deliberately bypasses this.
 */
async function autoScanGrantedSources(): Promise<void> {
  const state = await getState();
  if (state.lastScanStartedAt != null && Date.now() - state.lastScanStartedAt < SCAN_THROTTLE_MS) return;
  for (const src of await grantedSources(recipesOf(state))) await runScan(src);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleExternal(
  message: ExternalMessage,
  origin: string,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  switch (message.type) {
    case "ping":
      sendResponse({ ok: true });
      return;
    case "pair": {
      // Store the per-source recipes + account and arm the monthly alarm. The
      // host permission is requested from a user gesture in the popup, not here.
      const list = message.recipes && message.recipes.length > 0 ? message.recipes : [message.recipe];
      const recipes: Record<string, ScanRecipe> = {};
      for (const r of list) if (r) recipes[sourceOf(r)] = r;
      await setState({
        recipe: message.recipe,
        recipes,
        account: message.account,
        noticedOrigin: origin,
      });
      chrome.alarms.create(SCAN_ALARM, { periodInMinutes: SCAN_PERIOD_MINUTES });
      sendResponse({ ok: true });
      // NT-66 auto-scan on pair: import the already-granted sources immediately so
      // a reconnect syncs with no manual click. This TRULY mirrors the monthly-
      // alarm path — including its throttle — via the shared helper, so the
      // /x/sync recipe-refresh re-pair (SyncBroker) can't re-trigger a scan loop.
      // First-time users (no host permission yet) are scanned by the popup's grant
      // gesture / permissions.onAdded instead. Fire-and-forget so the connect
      // page's ack isn't blocked on the scan.
      void autoScanGrantedSources();
      return;
    }
    case "getCachedScan": {
      const { pendingScans } = await getState();
      const src = message.source;
      const pending = src
        ? pendingScans?.[src]
        : Object.values(pendingScans ?? {})[0];
      if (!pending) {
        sendResponse({ ingestPath: null, payload: null });
        return;
      }
      sendResponse({ source: pending.source, ingestPath: pending.ingestPath, payload: pending.payload });
      return;
    }
    case "syncConfirmed": {
      const state = await getState();
      const src = message.source ?? Object.keys(state.pendingScans ?? {})[0];
      const pending = src ? state.pendingScans?.[src] : undefined;
      const count = pending?.count ?? 0;
      const pendingScans = { ...(state.pendingScans ?? {}) };
      if (src) delete pendingScans[src];
      const lastScanBySource = { ...(state.lastScanBySource ?? {}) };
      if (src) lastScanBySource[src] = { at: Date.now(), count };
      await setState({
        pendingScans,
        lastScanBySource,
        needs: null,
        lastScanAt: Date.now(),
        lastScanCount: count,
      });
      if (state.syncTabId != null) {
        await chrome.tabs.remove(state.syncTabId).catch(() => {});
        await setState({ syncTabId: null });
      }
      sendResponse({ ok: true });
      return;
    }
  }
}

async function handleInternal(
  message: InternalMessage,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  switch (message.type) {
    case "getStatus": {
      const state = await getState();
      const recipes = recipesOf(state);
      const granted = await grantedSources(recipes);
      const lastBy = state.lastScanBySource ?? {};
      const sources = Object.values(recipes).map((r) => {
        const s = sourceOf(r);
        return {
          source: s,
          networkLabel: r.networkLabel ?? s,
          targetOrigin: r.targetOrigin,
          granted: granted.includes(s),
          lastScanAt: lastBy[s]?.at ?? null,
          lastScanCount: lastBy[s]?.count ?? null,
        };
      });
      const lastScanAt = state.lastScanAt ?? null;
      sendResponse({
        account: state.account ?? null,
        recipe: state.recipe ?? null,
        sources,
        nextScanAt: lastScanAt != null ? lastScanAt + SCAN_PERIOD_MS : null,
        lastScanAt,
        lastScanCount: state.lastScanCount ?? null,
        needs: state.needs ?? null,
        testMode: state.testMode ?? false,
        scanning: state.scanInProgress === true,
        scanningSource: state.scanSource ?? null,
        scannedCount: state.scanItems?.length ?? 0,
      });
      return;
    }
    case "scanNow": {
      // Scan the named source, or every source whose host permission is granted.
      const state = await getState();
      const recipes = recipesOf(state);
      const targets = message.source ? [message.source] : await grantedSources(recipes);
      const list = targets.length > 0 ? targets : [state.recipe?.source ?? DEFAULT_SOURCE];
      const first = list[0]!;

      // Cause B (scan-twice): set the in-flight scan state + arm the keepalive tick
      // SYNCHRONOUSLY — before the CSRF cookie round-trip in runScan — and ack
      // immediately, so the popup's first getStatus after this ack already reads
      // scanning:true and its poller doesn't bail to idle while the scan runs.
      if (recipes[first]) {
        await setState({
          scanInProgress: true,
          scanSource: first,
          scanPhaseIndex: 0,
          scanCursor: null,
          scanItems: [],
          scanPhaseResults: { connLists: [], messages: [] },
          scanSelfId: null,
          scanStartedAt: Date.now(),
          needs: null,
        });
        armScanTick();
      }
      sendResponse({ ok: true });

      // Drive the scan(s) WITHOUT blocking the ack. continueScan picks up the state
      // set above (and self-clears + sets needs:network-signin on a missing session);
      // any remaining sources scan sequentially after it.
      void (async () => {
        if (recipes[first]) await continueScan();
        for (const src of list.slice(1)) await runScan(src);
      })();
      return;
    }
    case "setTestMode": {
      await setState({ testMode: message.value });
      sendResponse({ ok: true });
      return;
    }
    case "getSyncHistory": {
      const { noticedOrigin, recipe, recipes } = await getState();
      if (!noticedOrigin) {
        sendResponse({ runs: [] });
        return;
      }
      try {
        const res = await fetch(noticedOrigin + "/api/sync/runs", { credentials: "include" });
        if (res.status === 401) {
          sendResponse({ needs: "noticed-signin" });
          return;
        }
        if (!res.ok) {
          sendResponse({ runs: [], error: true });
          return;
        }
        const data = (await res.json()) as {
          runs?: Array<{ source?: string; itemCount?: number | null; startedAt?: string; finishedAt?: string }>;
        };
        // Hidden sources are recipe-driven config, never a hardcoded platform
        // string. Union the excludeSources of every paired recipe.
        const exclude = new Set<string>(recipe?.excludeSources ?? []);
        for (const r of Object.values(recipes ?? {})) (r.excludeSources ?? []).forEach((s) => exclude.add(s));
        const all = data.runs ?? [];
        const runs = all.filter((r) => !exclude.has(r.source ?? ""));
        await reconcileFromRuns(runs);
        sendResponse({ runs });
      } catch {
        sendResponse({ runs: [], error: true });
      }
      return;
    }
  }
}

/** Reconcile local sync state from the server's recorded runs (E5). */
async function reconcileFromRuns(
  runs: Array<{ itemCount?: number | null; startedAt?: string; finishedAt?: string }>,
): Promise<void> {
  let newest: { at: number; count: number } | null = null;
  for (const r of runs) {
    const stamp = r.finishedAt ?? r.startedAt;
    if (!stamp) continue;
    const at = new Date(stamp).getTime();
    if (Number.isNaN(at)) continue;
    if (!newest || at > newest.at) {
      newest = { at, count: typeof r.itemCount === "number" ? r.itemCount : 0 };
    }
  }
  if (!newest) return;
  const { lastScanAt, needs } = await getState();
  const patch: Record<string, unknown> = {};
  if (lastScanAt == null || newest.at > lastScanAt) {
    patch.lastScanAt = newest.at;
    patch.lastScanCount = newest.count;
  }
  if (needs === "noticed-signin") patch.needs = null;
  if (Object.keys(patch).length > 0) await setState(patch);
}

// ── Registration ──────────────────────────────────────────────────────────────

let registered = false;
let lastChrome: unknown;

export function registerListeners(): void {
  if (typeof chrome === "undefined") return;
  if (registered && lastChrome === chrome) return;
  registered = true;
  lastChrome = chrome;

  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const origin = senderOrigin(sender);
    if (!isNoticedOrigin(origin)) return;
    void handleExternal(message as ExternalMessage, origin as string, sendResponse);
    return true;
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void handleInternal(message as InternalMessage, sendResponse);
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SCAN_TICK_ALARM) {
      void (async () => {
        const { scanInProgress, scanStartedAt } = await getState();
        if (!scanInProgress) {
          clearScanTick();
          return;
        }
        if (isScanStale(scanStartedAt, Date.now())) {
          await clearScanState();
          clearScanTick();
          return;
        }
        await continueScan();
      })();
      return;
    }
    if (alarm.name !== SCAN_ALARM) return;
    void autoScanGrantedSources();
  });

  // Grant → scan. When the user approves "grant access", Chrome commonly
  // DISMISSES the extension popup as the permission prompt appears, so the
  // popup's own post-grant scanNow never runs — the grant would then sync
  // nothing until the 30-day alarm. The service worker is the durable context:
  // scan the newly-granted source(s) here so grant always completes a sync.
  // Skip if a scan is already in flight (the popup survived and sent scanNow) so
  // we never clobber an in-progress checkpoint.
  chrome.permissions.onAdded.addListener((perms) => {
    const added = perms?.origins ?? [];
    if (added.length === 0) return;
    void (async () => {
      const state = await getState();
      if (state.scanInProgress) return;
      const recipes = recipesOf(state);
      const targets = Object.entries(recipes)
        .filter(([, r]) => added.some((o) => grantCovers(o, r.targetOrigin)))
        .map(([src]) => src);
      for (const src of targets) await runScan(src);
    })();
  });

  void (async () => {
    const { scanInProgress, scanStartedAt } = await getState();
    if (!scanInProgress) return;
    if (isScanStale(scanStartedAt, Date.now())) {
      await clearScanState();
      clearScanTick();
      return;
    }
    armScanTick();
  })();
}

/** Test-only: force re-registration against the current `chrome` mock. */
export function registerListenersForTest(): void {
  registered = false;
  lastChrome = undefined;
  registerListeners();
}

// Auto-register at module load (the service worker entrypoint).
registerListeners();
