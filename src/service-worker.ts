/**
 * The extension's brain. Stores a recipe + account (from pairing with a
 * first-party noticed page), runs a paced connection scan as the logged-in
 * user against the recipe's target site, and hands results to a noticed page
 * that POSTs them — the extension never holds a noticed credential.
 *
 * No site specifics live here: everything site-shaped comes from the recipe
 * at runtime.
 *
 * Scan resilience (MV3): the service worker can be torn down mid-scan (the open
 * popup is its only natural keepalive, so closing the popup kills an in-flight
 * scan). To survive that, the scan is a CHECKPOINT-AND-RESUME stepper: progress
 * is persisted to chrome.storage.local after every page, a short keepalive tick
 * alarm re-drives the stepper, and on SW startup an interrupted scan auto-resumes.
 */
import { buildCsrfHeaders } from "./lib/cookies";
import { applyFieldMap, getByPath } from "./lib/recipe";
import type { ScanConnection } from "./lib/recipe";
import { getState, setState } from "./lib/storage";
import type { Account, ScanRecipe } from "./lib/storage";

const SCAN_ALARM = "scan";
const SCAN_PERIOD_MINUTES = 43200; // ~30 days
const SCAN_PERIOD_MS = SCAN_PERIOD_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// The automatic (alarm-triggered) path scans at most once per period. We treat
// any alarm fire within (period − 1 day) of the last automatic scan as a
// duplicate/catch-up fire and skip it, so a closed-browser catch-up alarm or a
// re-created alarm can never cause a second scan inside the same month.
const SCAN_THROTTLE_MS = SCAN_PERIOD_MS - DAY_MS;
const SYNC_PATH = "/x/sync";

// A short keepalive tick that re-drives a checkpointed scan. It is a SAFETY NET:
// scanNow runs continueScan() inline (the fast path); the tick only matters if
// the SW is torn down mid-scan, when the alarm re-spins it up and resumes from
// the last checkpoint. Cleared on finalize.
const SCAN_TICK_ALARM = "scan-tick";
const SCAN_TICK_PERIOD_MINUTES = 0.5;
// A scan whose checkpoint is older than this is a zombie (e.g. a network that
// never returns); drop it rather than resume forever.
const SCAN_STALE_CUTOFF_MS = 60 * 60 * 1000; // 1h

// ── Messages ────────────────────────────────────────────────────────────────

type ExternalMessage =
  | { type: "ping" }
  | { type: "pair"; recipe: ScanRecipe; account: Account }
  | { type: "getCachedScan" }
  | { type: "syncConfirmed" };

type InternalMessage =
  | { type: "getStatus" }
  | { type: "scanNow" }
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

function buildPageUrl(recipe: ScanRecipe, start: number): string {
  const path = recipe.listPathTemplate
    .replaceAll("{start}", String(start))
    .replaceAll("{count}", String(recipe.paginationParams.pageSize));
  return recipe.targetOrigin + path;
}

// Per-SW-instance re-entrancy guard: a second continueScan() (e.g. fired by the
// tick alarm while the inline run is still going) returns early instead of
// double-fetching. Module-level so it is shared across all callers in this
// service-worker instance (and naturally resets when the SW is torn down).
let scanRunning = false;

function armScanTick(): void {
  chrome.alarms.create(SCAN_TICK_ALARM, { periodInMinutes: SCAN_TICK_PERIOD_MINUTES });
}

function clearScanTick(): void {
  void chrome.alarms.clear(SCAN_TICK_ALARM);
}

/** Has an in-progress scan gone stale (older than the cutoff)? */
function isScanStale(startedAt: number | null | undefined, now: number): boolean {
  if (startedAt == null) return true;
  return now - startedAt > SCAN_STALE_CUTOFF_MS;
}

/**
 * Resumable scan stepper. Reads the persisted scan checkpoint, fetches pages
 * from the cursor, and checkpoints to storage after EACH page so a teardown
 * mid-scan loses at most the in-flight page. On completion (short page or the
 * per-session page cap) it finalizes: caches pendingScan, clears scan state,
 * disarms the tick alarm, and opens the handoff tab. Idempotent + re-entrant-safe.
 */
export async function continueScan(deps: RunScanDeps = {}): Promise<RunScanResult> {
  if (scanRunning) return { ok: true, note: "already-running" };
  scanRunning = true;
  try {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const sleep = deps.sleep ?? realSleep;
    const now = deps.nowMs ?? (() => Date.now());

    const state = await getState();
    const { recipe, noticedOrigin, testMode, scanInProgress } = state;
    if (!recipe) return { ok: false };
    if (!scanInProgress) return { ok: true, note: "not-in-progress" };

    // Stale guard: drop a zombie scan rather than resume it forever.
    if (isScanStale(state.scanStartedAt, now())) {
      await clearScanState();
      clearScanTick();
      return { ok: false, note: "stale" };
    }

    const headers = await buildCsrfHeaders(recipe);
    if (!headers) {
      // Lost the network session: clear scan progress and surface the need.
      await clearScanState({ needs: "network-signin" });
      clearScanTick();
      return { ok: false, needs: "network-signin" };
    }

    const jitter = deps.jitter ?? makeJitter(recipe);

    const fetchPage = async (
      start: number,
    ): Promise<{ items: ScanConnection[]; rawCount: number }> => {
      const res = await fetchImpl(buildPageUrl(recipe, start), {
        credentials: "include",
        headers,
      });
      if (!res.ok) throw new Error(`scan page fetch failed: ${res.status}`);
      const json = await res.json();
      const rawElements = getByPath(json, recipe.fieldMap.elementsPath);
      const rawCount = Array.isArray(rawElements) ? rawElements.length : 0;
      return { items: applyFieldMap(json, recipe.fieldMap), rawCount };
    };

    // Test mode caps the scan to at most 2 page-fetches so testing against a live
    // network stays well under any rate/abuse threshold.
    const effectiveMaxPages = testMode
      ? Math.min(2, recipe.pacing.maxPagesPerSession)
      : recipe.pacing.maxPagesPerSession;

    const { scanConnections } = await import("./lib/fetch-engine");
    const connections = await scanConnections<ScanConnection>({
      fetchPage,
      pageSize: recipe.paginationParams.pageSize,
      maxPages: effectiveMaxPages,
      sleep,
      jitter,
      startAt: state.scanCursor ?? 0,
      initialItems: state.scanItems ?? [],
      // Checkpoint after each page so a torn-down SW resumes from here, not 0.
      onPage: async (items, nextStart) => {
        await setState({ scanItems: items, scanCursor: nextStart });
      },
    });

    return finalizeScan(connections, noticedOrigin ?? null, now());
  } finally {
    scanRunning = false;
  }
}

/** Clear the in-flight scan checkpoint (and optionally set a `needs`). */
async function clearScanState(extra?: { needs?: "network-signin" }): Promise<void> {
  await setState({
    scanInProgress: false,
    scanCursor: null,
    scanItems: null,
    scanStartedAt: null,
    ...(extra?.needs !== undefined ? { needs: extra.needs } : {}),
  });
}

/** Persist the finished scan, hand off, and tear down the keepalive tick. */
async function finalizeScan(
  connections: ScanConnection[],
  noticedOrigin: string | null,
  startedAt: number,
): Promise<RunScanResult> {
  // Stamp when this scan actually hit the network — the monthly alarm throttle
  // reads lastScanStartedAt to enforce ≤ once per period, independent of whether
  // the noticed POST later confirms (which is what lastScanAt tracks).
  clearScanTick();

  if (!noticedOrigin) {
    // No handoff target: nothing to await confirmation from.
    await setState({
      pendingScan: connections,
      needs: null,
      lastScanStartedAt: startedAt,
      scanInProgress: false,
      scanCursor: null,
      scanItems: null,
      scanStartedAt: null,
    });
    return { ok: true, count: connections.length, note: "no-handoff-origin" };
  }

  // Scanned — now awaiting the user's signed-in noticed tab to confirm the POST.
  // If /x/sync redirects to signin and never confirms, this state is retained.
  await setState({
    pendingScan: connections,
    needs: "noticed-signin",
    lastScanStartedAt: startedAt,
    scanInProgress: false,
    scanCursor: null,
    scanItems: null,
    scanStartedAt: null,
  });

  await chrome.tabs.create({ url: `${noticedOrigin}${SYNC_PATH}?ext_id=${chrome.runtime.id}` });
  // lastScanAt is stamped on syncConfirmed, not here — the POST may not have happened yet.
  return { ok: true, count: connections.length };
}

/**
 * Kick off a scan from scratch: build csrf headers up front (so a missing
 * network session fails fast), initialize the scan checkpoint, arm the keepalive
 * tick, then drive continueScan() to completion. Kept as the public entry the
 * monthly alarm + scanNow call; tests inject fetch/sleep/jitter/now through deps.
 */
export async function runScan(deps: RunScanDeps = {}): Promise<RunScanResult> {
  const { recipe } = await getState();
  if (!recipe) return { ok: false };

  const headers = await buildCsrfHeaders(recipe);
  if (!headers) {
    await setState({ needs: "network-signin" });
    return { ok: false, needs: "network-signin" };
  }

  const now = deps.nowMs ?? (() => Date.now());
  await setState({
    scanInProgress: true,
    scanCursor: 0,
    scanItems: [],
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
    case "pair":
      // Store the recipe + account and arm the monthly alarm. We do NOT request
      // the host permission here: pair runs from the noticed page's message, with
      // no user gesture in the service worker, so chrome.permissions.request would
      // throw and the ack below would never be sent (leaving the connect page stuck
      // on "Connecting…"). The host permission is requested from a user gesture in
      // the popup's "Scan now" click instead.
      await setState({
        recipe: message.recipe,
        account: message.account,
        noticedOrigin: origin,
      });
      chrome.alarms.create(SCAN_ALARM, { periodInMinutes: SCAN_PERIOD_MINUTES });
      sendResponse({ ok: true });
      return;
    case "getCachedScan": {
      const { pendingScan } = await getState();
      sendResponse({ connections: pendingScan ?? null });
      return;
    }
    case "syncConfirmed": {
      const { pendingScan } = await getState();
      const count = pendingScan?.length ?? 0;
      await setState({
        pendingScan: null,
        needs: null,
        lastScanAt: Date.now(),
        lastScanCount: count,
      });
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
      const lastScanAt = state.lastScanAt ?? null;
      const nextScanAt = lastScanAt != null ? lastScanAt + SCAN_PERIOD_MS : null;
      const scanning = state.scanInProgress === true;
      sendResponse({
        account: state.account ?? null,
        recipe: state.recipe ?? null,
        nextScanAt,
        lastScanAt,
        lastScanCount: state.lastScanCount ?? null,
        needs: state.needs ?? null,
        testMode: state.testMode ?? false,
        // Progress (E2): the popup polls this while scanning to show "scanned N…".
        scanning,
        scannedCount: state.scanItems?.length ?? 0,
      });
      return;
    }
    case "scanNow": {
      const result = await runScan();
      sendResponse(result.ok ? { ok: true } : result);
      return;
    }
    case "setTestMode": {
      await setState({ testMode: message.value });
      sendResponse({ ok: true });
      return;
    }
    case "getSyncHistory": {
      const { noticedOrigin, recipe } = await getState();
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
        // Which source values to hide is recipe-driven config (set at pair time),
        // never a hardcoded platform string in shipped code.
        const exclude = recipe?.excludeSources ?? [];
        const all = data.runs ?? [];
        const runs = all.filter((r) => !exclude.includes(r.source ?? ""));
        // Reconcile local state from the server (E5): if a recorded extension
        // sync is newer than (or fills a gap in) local lastScanAt, stamp it and
        // clear a stale "noticed-signin" — otherwise the popup falsely shows
        // "no sync yet" while a run is listed.
        await reconcileFromRuns(runs);
        sendResponse({ runs });
      } catch {
        sendResponse({ runs: [], error: true });
      }
      return;
    }
  }
}

/**
 * Reconcile local sync state from the server's recorded runs (E5). The runs are
 * already filtered to this extension's sources (excludeSources removed). When the
 * newest such run is newer than the locally-stamped lastScanAt, adopt it: stamp
 * lastScanAt/lastScanCount and clear a stale "noticed-signin" need (the POST that
 * produced the run must have succeeded, so a lingering need is stale).
 */
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
  // A recorded extension run means the handoff completed → drop a stale signin need.
  if (needs === "noticed-signin") patch.needs = null;
  if (Object.keys(patch).length > 0) await setState(patch);
}

// ── Registration ──────────────────────────────────────────────────────────────

let registered = false;
let lastChrome: unknown;

/**
 * Register all listeners. Idempotent per chrome instance — re-binds when the
 * global `chrome` is swapped (the test harness installs a fresh mock per test).
 */
export function registerListeners(): void {
  // No-op if the extension API isn't present yet (e.g. at module eval in tests
  // before the harness installs its mock).
  if (typeof chrome === "undefined") return;
  if (registered && lastChrome === chrome) return;
  registered = true;
  lastChrome = chrome;

  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const origin = senderOrigin(sender);
    if (!isNoticedOrigin(origin)) return; // ignore non-noticed senders
    void handleExternal(message as ExternalMessage, origin as string, sendResponse);
    return true; // keep the message channel open for the async response
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void handleInternal(message as InternalMessage, sendResponse);
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SCAN_TICK_ALARM) {
      // Keepalive tick: resume an in-progress, non-stale scan (drops a zombie).
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
      // Throttle: skip if an automatic scan already ran inside this period.
      const { lastScanStartedAt } = await getState();
      if (lastScanStartedAt != null && Date.now() - lastScanStartedAt < SCAN_THROTTLE_MS) return;
      await runScan();
    })();
  });

  // SW startup: if a scan was interrupted by a teardown and is still fresh,
  // re-arm the tick so it auto-resumes; if it went stale meanwhile, drop it.
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
