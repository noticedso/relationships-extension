/**
 * The extension's brain. Stores a recipe + account (from pairing with a
 * first-party noticed page), runs a paced connection scan as the logged-in
 * user against the recipe's target site, and hands results to a noticed page
 * that POSTs them — the extension never holds a noticed credential.
 *
 * No site specifics live here: everything site-shaped comes from the recipe
 * at runtime.
 */
import { buildCsrfHeaders } from "./lib/cookies";
import { applyFieldMap } from "./lib/recipe";
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

export async function runScan(deps: RunScanDeps = {}): Promise<RunScanResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? realSleep;

  const { recipe, noticedOrigin, testMode } = await getState();
  if (!recipe) return { ok: false };

  const headers = await buildCsrfHeaders(recipe);
  if (!headers) {
    await setState({ needs: "network-signin" });
    return { ok: false, needs: "network-signin" };
  }

  const jitter = deps.jitter ?? makeJitter(recipe);

  const fetchPage = async (start: number): Promise<ScanConnection[]> => {
    const res = await fetchImpl(buildPageUrl(recipe, start), {
      credentials: "include",
      headers,
    });
    if (!res.ok) throw new Error(`scan page fetch failed: ${res.status}`);
    const json = await res.json();
    return applyFieldMap(json, recipe.fieldMap);
  };

  // Imported lazily-free: scanConnections is pure I/O-injected pagination.
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
  });

  // Stamp when this scan actually hit the network — the alarm throttle reads
  // this to enforce ≤ once per period, independent of whether the noticed POST
  // later confirms (which is what lastScanAt tracks).
  const startedAt = (deps.nowMs ?? (() => Date.now()))();

  if (!noticedOrigin) {
    // No handoff target: nothing to await confirmation from.
    await setState({ pendingScan: connections, needs: null, lastScanStartedAt: startedAt });
    return { ok: true, count: connections.length, note: "no-handoff-origin" };
  }

  // Scanned — now awaiting the user's signed-in noticed tab to confirm the POST.
  // If /x/sync redirects to signin and never confirms, this state is retained.
  await setState({
    pendingScan: connections,
    needs: "noticed-signin",
    lastScanStartedAt: startedAt,
  });

  await chrome.tabs.create({ url: `${noticedOrigin}${SYNC_PATH}?ext_id=${chrome.runtime.id}` });
  // lastScanAt is stamped on syncConfirmed, not here — the POST may not have happened yet.
  return { ok: true, count: connections.length };
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
      sendResponse({
        account: state.account ?? null,
        recipe: state.recipe ?? null,
        nextScanAt,
        lastScanAt,
        lastScanCount: state.lastScanCount ?? null,
        needs: state.needs ?? null,
        testMode: state.testMode ?? false,
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
        const data = (await res.json()) as { runs?: Array<{ source?: string }> };
        // Which source values to hide is recipe-driven config (set at pair time),
        // never a hardcoded platform string in shipped code.
        const exclude = recipe?.excludeSources ?? [];
        const runs = (data.runs ?? []).filter((r) => !exclude.includes(r.source ?? ""));
        sendResponse({ runs });
      } catch {
        sendResponse({ runs: [], error: true });
      }
      return;
    }
  }
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
    if (alarm.name !== SCAN_ALARM) return;
    void (async () => {
      // Throttle: skip if an automatic scan already ran inside this period.
      const { lastScanStartedAt } = await getState();
      if (lastScanStartedAt != null && Date.now() - lastScanStartedAt < SCAN_THROTTLE_MS) return;
      await runScan();
    })();
  });
}

// Auto-register at module load (the service worker entrypoint).
registerListeners();
