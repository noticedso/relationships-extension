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
import { extractMessages } from "./lib/message-extract";
import { planPhases, assembleScanPayload, type Phase } from "./lib/scan-plan";
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

    return finalizeScan(recipe, results.connLists, results.messages, selfId, noticedOrigin ?? null, now());
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
): Promise<RunScanResult> {
  clearScanTick();
  const source = sourceOf(recipe);
  const { ingestPath, payload, count } = assembleScanPayload(recipe, connLists, messages, selfId);
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
      let last: RunScanResult = { ok: true };
      for (const src of targets.length > 0 ? targets : [state.recipe?.source ?? DEFAULT_SOURCE]) {
        last = await runScan(src);
      }
      sendResponse(last.ok ? { ok: true } : last);
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
    void (async () => {
      const state = await getState();
      if (state.lastScanStartedAt != null && Date.now() - state.lastScanStartedAt < SCAN_THROTTLE_MS) return;
      // Auto-scan every source whose host permission is already granted.
      const granted = await grantedSources(recipesOf(state));
      for (const src of granted) await runScan(src);
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
