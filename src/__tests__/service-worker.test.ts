import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMock } from "../../test/mocks/chrome";
import * as sw from "../service-worker";

// The chrome mock is installed per-test by test/setup.ts (globalThis.chrome).
function getChrome(): ChromeMock {
  return (globalThis as unknown as { chrome: ChromeMock }).chrome;
}

const recipe = {
  targetOrigin: "https://network.example.com",
  listPathTemplate: "/api/connections?start={start}&count={count}",
  paginationParams: { pageSize: 2 },
  pacing: { maxPagesPerSession: 5, minDelayMs: 10, maxDelayMs: 20 },
  csrfRule: { header: "x-token", cookie: "tok" },
  fieldMap: {
    elementsPath: "elements",
    firstName: "m.firstName",
    lastName: "m.lastName",
    profileUrl: "m.publicIdentifier",
    headline: "m.headline",
    connectedOn: "createdAt",
  },
  excludeSources: ["linkedin_export"],
};

const account = { id: "acct-1", displayName: "Test User" };

function makeElement(id: string) {
  return {
    m: { publicIdentifier: id, firstName: id.toUpperCase(), lastName: "X", headline: "h" },
    createdAt: "2024-01-01",
  };
}

// dispatch an external message and capture the response synchronously / async
function dispatchExternal(message: unknown, sender: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let resolved = false;
    getChrome().runtime.onMessageExternal.dispatch(message, sender, (r) => {
      resolved = true;
      resolve(r);
    });
    // If no listener called sendResponse, resolve undefined on next tick.
    queueMicrotask(() => {
      if (!resolved) setTimeout(() => !resolved && resolve(undefined), 30);
    });
  });
}

function dispatchInternal(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    getChrome().runtime.onMessage.dispatch(message, { id: "test-extension-id" }, (r) => resolve(r));
  });
}

const noticedSender = { origin: "https://app.noticed.so", url: "https://app.noticed.so/x/install" };

async function pair() {
  return dispatchExternal({ type: "pair", recipe, account }, noticedSender);
}

describe("service worker", () => {
  beforeEach(() => {
    // re-import side effects already ran at module load; listeners are registered
    // against the fresh per-test chrome mock via lazy registration.
    sw.registerListeners();
  });

  it("1. external pair from allowed origin stores state + creates alarm, acks, and does NOT request permissions (no user gesture in the SW)", async () => {
    const chrome = getChrome();
    const createAlarm = vi.spyOn(chrome.alarms, "create");
    const reqPerms = vi.spyOn(chrome.permissions, "request");

    const res = await pair();
    expect(res).toMatchObject({ ok: true });

    const stored = await chrome.storage.local.get(null);
    expect(stored.recipe).toMatchObject({ targetOrigin: recipe.targetOrigin });
    expect(stored.account).toMatchObject({ id: "acct-1" });
    expect(stored.noticedOrigin).toBe("https://app.noticed.so");

    expect(createAlarm).toHaveBeenCalledWith("scan", { periodInMinutes: 43200 });
    // pair must always ack — requesting permission here would throw (no gesture)
    // and leave the connect page hanging. Permission is requested in the popup.
    expect(reqPerms).not.toHaveBeenCalled();
  });

  it("2. external message from non-noticed origin is ignored", async () => {
    const chrome = getChrome();
    const res = await dispatchExternal(
      { type: "pair", recipe, account },
      { origin: "https://evil.com", url: "https://evil.com/x" },
    );
    expect(res).toBeUndefined();
    const stored = await chrome.storage.local.get(null);
    expect(stored.recipe).toBeUndefined();
    expect(stored.account).toBeUndefined();
  });

  it("3. getStatus after pair returns account + recipe + needs null + nextScanAt null", async () => {
    await pair();
    const res = (await dispatchInternal({ type: "getStatus" })) as Record<string, unknown>;
    expect(res.account).toMatchObject({ id: "acct-1" });
    expect(res.recipe).toMatchObject({ targetOrigin: recipe.targetOrigin });
    expect(res.needs).toBeNull();
    expect(res.nextScanAt).toBeNull();
    expect(res.lastScanAt).toBeNull();
  });

  it("4. scanNow with no cookie -> needs network-signin, fetch not called", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue(null);
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const res = (await dispatchInternal({ type: "scanNow" })) as Record<string, unknown>;
    expect(res.needs).toBe("network-signin");
    expect(fetchSpy).not.toHaveBeenCalled();

    const stored = await chrome.storage.local.get(null);
    expect(stored.needs).toBe("network-signin");
  });

  it("5. runScan with cookie caches pendingScan + opens handoff tab", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    const tabSpy = vi.spyOn(chrome.tabs, "create");

    let call = 0;
    const fakeFetch = vi.fn(async () => {
      call += 1;
      const elements = call === 1 ? [makeElement("a"), makeElement("b")] : [];
      return { ok: true, json: async () => ({ elements }) } as Response;
    });

    const res = await sw.runScan({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      sleep: async () => {},
      jitter: () => 0,
      nowMs: () => 123,
    });

    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);

    const stored = await chrome.storage.local.get(null);
    const pending = stored.pendingScan as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ profileUrl: "a", firstName: "A" });
    expect(stored.needs).toBe("noticed-signin");

    expect(tabSpy).toHaveBeenCalledWith({ url: `https://app.noticed.so/x/sync?ext_id=${getChrome().runtime.id}` });
  });

  it("7. test mode caps the scan to exactly 2 page-fetches even when maxPagesPerSession is large", async () => {
    const chrome = getChrome();
    const bigRecipe = { ...recipe, pacing: { ...recipe.pacing, maxPagesPerSession: 60 } };
    await dispatchExternal({ type: "pair", recipe: bigRecipe, account }, noticedSender);
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });

    // enable test mode via the internal handler
    const toggled = (await dispatchInternal({ type: "setTestMode", value: true })) as Record<
      string,
      unknown
    >;
    expect(toggled).toMatchObject({ ok: true });

    const pageSize = bigRecipe.paginationParams.pageSize;
    const fakeFetch = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ elements: Array(pageSize).fill({ m: { publicIdentifier: "x" } }) }),
      } as Response;
    });

    const res = await sw.runScan({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      sleep: async () => {},
      jitter: () => 0,
    });

    expect(res.ok).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(2);

    const status = (await dispatchInternal({ type: "getStatus" })) as Record<string, unknown>;
    expect(status.testMode).toBe(true);
  });

  it("8. without test mode, a full-page scan runs more than 2 pages up to the cap", async () => {
    const chrome = getChrome();
    const cappedRecipe = { ...recipe, pacing: { ...recipe.pacing, maxPagesPerSession: 3 } };
    await dispatchExternal({ type: "pair", recipe: cappedRecipe, account }, noticedSender);
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });

    const pageSize = cappedRecipe.paginationParams.pageSize;
    const fakeFetch = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ elements: Array(pageSize).fill({ m: { publicIdentifier: "x" } }) }),
      } as Response;
    });

    const res = await sw.runScan({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      sleep: async () => {},
      jitter: () => 0,
    });

    expect(res.ok).toBe(true);
    expect(fakeFetch.mock.calls.length).toBeGreaterThan(2);
  });

  it("9. alarm is throttled within the period and runs once the period has elapsed", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    const fetchSpy = vi.fn(
      async () => ({ ok: true, json: async () => ({ elements: [] }) }) as Response,
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const settle = () => new Promise((r) => setTimeout(r, 25));

    // a scan ran moments ago → an alarm fire is a duplicate/catch-up → skip it
    await chrome.storage.local.set({ lastScanStartedAt: Date.now() });
    chrome.alarms.onAlarm.dispatch({ name: "scan" });
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();

    // last automatic scan was > a period ago → the alarm runs a fresh scan
    fetchSpy.mockClear();
    await chrome.storage.local.set({ lastScanStartedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 });
    chrome.alarms.onAlarm.dispatch({ name: "scan" });
    await settle();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("6. getCachedScan returns pendingScan; syncConfirmed clears it + stamps lastScan", async () => {
    const chrome = getChrome();
    await pair();
    const conns = [{ profileUrl: "a", firstName: "A", lastName: null, headline: null, connectedOn: null }];
    await chrome.storage.local.set({ pendingScan: conns, needs: null });

    const cached = (await dispatchExternal({ type: "getCachedScan" }, noticedSender)) as Record<
      string,
      unknown
    >;
    expect(cached.connections).toEqual(conns);

    const confirmed = (await dispatchExternal(
      { type: "syncConfirmed" },
      noticedSender,
    )) as Record<string, unknown>;
    expect(confirmed).toMatchObject({ ok: true });

    const stored = await chrome.storage.local.get(null);
    expect(stored.pendingScan ?? null).toBeNull();
    expect(stored.needs ?? null).toBeNull();
    expect(stored.lastScanAt).not.toBeNull();
    expect(stored.lastScanCount).toBe(1);
  });

  it("10. getSyncHistory fetches /api/sync/runs and filters out the excluded source", async () => {
    await pair(); // noticedOrigin = https://app.noticed.so
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        runs: [
          { source: "linkedin_extension", kind: "relationships", itemCount: 5, status: "succeeded", startedAt: "t1", finishedAt: "t1" },
          { source: "linkedin_export", kind: "relationships", itemCount: 9, status: "succeeded", startedAt: "t0", finishedAt: "t0" },
        ],
      }),
    }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const res = (await dispatchInternal({ type: "getSyncHistory" })) as { runs: Array<{ source: string }> };
    expect(fetchSpy).toHaveBeenCalledWith("https://app.noticed.so/api/sync/runs", { credentials: "include" });
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0].source).toBe("linkedin_extension");
  });

  it("11. getSyncHistory surfaces noticed-signin on 401", async () => {
    await pair();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    const res = (await dispatchInternal({ type: "getSyncHistory" })) as { needs?: string };
    expect(res.needs).toBe("noticed-signin");
  });

  it("12. getSyncHistory with no noticedOrigin returns empty runs", async () => {
    // do NOT pair → noticedOrigin is unset
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const res = (await dispatchInternal({ type: "getSyncHistory" })) as { runs: unknown[] };
    expect(res.runs).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("13. getSyncHistory returns error on a non-401 failure", async () => {
    await pair();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const res = (await dispatchInternal({ type: "getSyncHistory" })) as { error?: boolean; runs: unknown[] };
    expect(res.error).toBe(true);
    expect(res.runs).toHaveLength(0);
  });

  it("14. getSyncHistory returns error when fetch throws", async () => {
    await pair();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const res = (await dispatchInternal({ type: "getSyncHistory" })) as { error?: boolean; runs: unknown[] };
    expect(res.error).toBe(true);
    expect(res.runs).toHaveLength(0);
  });

  // ── Checkpoint + resume (E1/E3) ─────────────────────────────────────────────

  // A full page each time → 3 full pages then a short page (cap is 5 here).
  function makeFullThenShortFetch(fullPages: number) {
    let call = 0;
    return vi.fn(async () => {
      call += 1;
      const elements =
        call <= fullPages
          ? [makeElement(`a${call}`), makeElement(`b${call}`)] // pageSize=2 → full
          : [makeElement(`z${call}`)]; // short → stop
      return { ok: true, json: async () => ({ elements }) } as Response;
    });
  }

  it("15. scanNow initializes scan state, arms the scan-tick alarm, then runs to completion", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    const createAlarm = vi.spyOn(chrome.alarms, "create");
    const clearAlarm = vi.spyOn(chrome.alarms, "clear");
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      makeFullThenShortFetch(1) as unknown as typeof fetch;

    const res = (await dispatchInternal({ type: "scanNow" })) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: true });

    // armed a short keepalive tick alarm
    expect(createAlarm).toHaveBeenCalledWith("scan-tick", { periodInMinutes: 0.5 });

    const stored = await chrome.storage.local.get(null);
    // finished → pendingScan set, scan state cleared, handoff state set
    expect((stored.pendingScan as unknown[]).length).toBe(3);
    expect(stored.scanInProgress ?? false).toBe(false);
    expect(stored.scanItems ?? null).toBeNull();
    expect(stored.scanCursor ?? null).toBeNull();
    expect(stored.needs).toBe("noticed-signin");
    // tick alarm cleared on finalize
    expect(clearAlarm).toHaveBeenCalledWith("scan-tick");
  });

  it("16. continueScan checkpoints partial progress to storage after each page", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });

    // Capture storage state right after the FIRST page is checkpointed by
    // making the SECOND fetch throw — partial progress must survive.
    let call = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      call += 1;
      if (call === 1)
        return { ok: true, json: async () => ({ elements: [makeElement("a"), makeElement("b")] }) } as Response;
      throw new Error("worker died mid-scan");
    }) as unknown as typeof fetch;

    // initialize scan state as scanNow would, then drive continueScan directly
    await chrome.storage.local.set({
      scanInProgress: true,
      scanCursor: 0,
      scanItems: [],
      scanStartedAt: Date.now(),
    });
    await sw.continueScan({ sleep: async () => {}, jitter: () => 0, nowMs: () => 1000 }).catch(() => {});

    const stored = await chrome.storage.local.get(null);
    // page 1 was checkpointed before page 2 blew up
    expect((stored.scanItems as unknown[]).length).toBe(2);
    expect(stored.scanCursor).toBe(2); // next page to fetch
    expect(stored.scanInProgress).toBe(true); // not finalized
  });

  it("17. continueScan resumes from a checkpoint without lost/duplicated items", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });

    // Simulate a mid-scan checkpoint: 2 items already fetched, cursor at 2.
    const recovered = [
      { profileUrl: "a", firstName: "A", lastName: null, headline: null, connectedOn: null, pictureUrl: null },
      { profileUrl: "b", firstName: "B", lastName: null, headline: null, connectedOn: null, pictureUrl: null },
    ];
    await chrome.storage.local.set({
      scanInProgress: true,
      scanCursor: 2,
      scanItems: recovered,
      scanStartedAt: Date.now(),
    });

    // Resume: the next fetch must be for start=2; one more full page, then short.
    const starts: number[] = [];
    let call = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async (url: string) => {
      const m = /start=(\d+)/.exec(url);
      if (m) starts.push(Number(m[1]));
      call += 1;
      const elements = call === 1 ? [makeElement("c"), makeElement("d")] : [makeElement("e")];
      return { ok: true, json: async () => ({ elements }) } as Response;
    }) as unknown as typeof fetch;

    await sw.continueScan({ sleep: async () => {}, jitter: () => 0, nowMs: () => 9 });

    // resumed at the checkpoint cursor, never re-fetched start=0
    expect(starts[0]).toBe(2);
    expect(starts).not.toContain(0);

    const stored = await chrome.storage.local.get(null);
    const pending = stored.pendingScan as Array<{ profileUrl: string }>;
    // 2 recovered + 3 new, in order, no dupes
    expect(pending.map((c) => c.profileUrl)).toEqual(["a", "b", "c", "d", "e"]);
    expect(stored.scanInProgress ?? false).toBe(false);
  });

  it("18. re-entrant continueScan returns early while one is already running in this SW instance", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });

    let inflight = 0;
    let maxConcurrent = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      inflight += 1;
      maxConcurrent = Math.max(maxConcurrent, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return { ok: true, json: async () => ({ elements: [makeElement("a"), makeElement("b")] }) } as Response;
    }) as unknown as typeof fetch;

    // arm scan state, then fire two continueScan calls "simultaneously"
    await chrome.storage.local.set({ scanInProgress: true, scanCursor: 0, scanItems: [], scanStartedAt: Date.now() });
    const a = sw.continueScan({ sleep: async () => {}, jitter: () => 0 });
    const b = sw.continueScan({ sleep: async () => {}, jitter: () => 0 });
    await Promise.all([a, b]);

    // the guard prevented overlapping page-fetches
    expect(maxConcurrent).toBe(1);
  });

  it("19. continueScan with no cookie -> needs network-signin and clears scan state", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue(null);
    const clearAlarm = vi.spyOn(chrome.alarms, "clear");
    await chrome.storage.local.set({ scanInProgress: true, scanCursor: 0, scanItems: [], scanStartedAt: Date.now() });

    const res = await sw.continueScan({ sleep: async () => {}, jitter: () => 0 });
    expect(res.needs).toBe("network-signin");

    const stored = await chrome.storage.local.get(null);
    expect(stored.needs).toBe("network-signin");
    expect(stored.scanInProgress ?? false).toBe(false);
    expect(clearAlarm).toHaveBeenCalledWith("scan-tick");
  });

  it("20. scan-tick alarm resumes an in-progress, non-stale scan", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    const fetchSpy = makeFullThenShortFetch(1);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const settle = () => new Promise((r) => setTimeout(r, 25));

    await chrome.storage.local.set({
      scanInProgress: true,
      scanCursor: 0,
      scanItems: [],
      scanStartedAt: Date.now(),
    });
    chrome.alarms.onAlarm.dispatch({ name: "scan-tick" });
    await settle();

    expect(fetchSpy).toHaveBeenCalled();
    const stored = await chrome.storage.local.get(null);
    expect(stored.scanInProgress ?? false).toBe(false); // resumed → finished
    expect(stored.needs).toBe("noticed-signin");
  });

  it("21. scan-tick alarm drops a stale scan (older than the cutoff) instead of resuming", async () => {
    const chrome = getChrome();
    await pair();
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const clearAlarm = vi.spyOn(chrome.alarms, "clear");
    const settle = () => new Promise((r) => setTimeout(r, 25));

    // started > 1h ago → stale zombie
    await chrome.storage.local.set({
      scanInProgress: true,
      scanCursor: 4,
      scanItems: [],
      scanStartedAt: Date.now() - 2 * 60 * 60 * 1000,
    });
    chrome.alarms.onAlarm.dispatch({ name: "scan-tick" });
    await settle();

    expect(fetchSpy).not.toHaveBeenCalled();
    const stored = await chrome.storage.local.get(null);
    expect(stored.scanInProgress ?? false).toBe(false); // dropped
    expect(clearAlarm).toHaveBeenCalledWith("scan-tick"); // tick disarmed
  });

  it("22. registerListeners re-arms the scan-tick alarm on startup for an in-progress non-stale scan", async () => {
    const chrome = getChrome();
    // simulate the SW being torn down mid-scan: state persisted, but a fresh
    // SW instance boots (registered flag reset via a brand-new chrome mock).
    await chrome.storage.local.set({
      scanInProgress: true,
      scanCursor: 2,
      scanItems: [],
      scanStartedAt: Date.now(),
    });
    const createAlarm = vi.spyOn(chrome.alarms, "create");

    sw.registerListenersForTest(); // force re-registration against this chrome
    // startup re-arm is async (reads storage) — let it settle
    await new Promise((r) => setTimeout(r, 10));

    expect(createAlarm).toHaveBeenCalledWith("scan-tick", { periodInMinutes: 0.5 });
  });

  it("23. getStatus exposes scanning + scannedCount while a scan is in progress (E2)", async () => {
    const chrome = getChrome();
    await pair();
    await chrome.storage.local.set({
      scanInProgress: true,
      scanCursor: 6,
      scanItems: [
        { profileUrl: "a" },
        { profileUrl: "b" },
        { profileUrl: "c" },
      ],
      scanStartedAt: Date.now(),
    });
    const res = (await dispatchInternal({ type: "getStatus" })) as Record<string, unknown>;
    expect(res.scanning).toBe(true);
    expect(res.scannedCount).toBe(3);
  });

  it("23b. getStatus reports scanning false + zero count when idle", async () => {
    await pair();
    const res = (await dispatchInternal({ type: "getStatus" })) as Record<string, unknown>;
    expect(res.scanning).toBe(false);
    expect(res.scannedCount).toBe(0);
  });

  // ── Reconcile from server history (E5) ──────────────────────────────────────

  it("24. getSyncHistory reconciles local state from the newest extension run: clears stale needs + stamps lastScanAt/lastScanCount", async () => {
    const chrome = getChrome();
    await pair(); // excludeSources = ["linkedin_export"]
    // local state is diverged: a stale noticed-signin + no lastScanAt, even
    // though the server recorded a successful extension sync.
    await chrome.storage.local.set({ needs: "noticed-signin", lastScanAt: null, lastScanCount: null });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        runs: [
          { source: "linkedin_extension", kind: "relationships", itemCount: 412, status: "succeeded", startedAt: "2026-06-20T00:00:00Z", finishedAt: "2026-06-20T00:00:00Z" },
          { source: "linkedin_export", kind: "relationships", itemCount: 9, status: "succeeded", startedAt: "2026-06-19T00:00:00Z", finishedAt: "2026-06-19T00:00:00Z" },
        ],
      }),
    })) as unknown as typeof fetch;

    const res = (await dispatchInternal({ type: "getSyncHistory" })) as { runs: Array<{ source: string }> };
    // still filters the excluded source out of the returned list
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0].source).toBe("linkedin_extension");

    const stored = await chrome.storage.local.get(null);
    // stale needs cleared + lastScan stamped from the newest extension run
    expect(stored.needs ?? null).toBeNull();
    expect(typeof stored.lastScanAt).toBe("number");
    expect(stored.lastScanAt as number).toBe(new Date("2026-06-20T00:00:00Z").getTime());
    expect(stored.lastScanCount).toBe(412);
  });

  it("25. getSyncHistory does NOT clobber a newer local lastScanAt with an older run", async () => {
    const chrome = getChrome();
    await pair();
    const newer = new Date("2026-06-23T00:00:00Z").getTime();
    await chrome.storage.local.set({ needs: null, lastScanAt: newer, lastScanCount: 500 });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        runs: [
          { source: "linkedin_extension", kind: "relationships", itemCount: 100, status: "succeeded", startedAt: "2026-06-20T00:00:00Z", finishedAt: "2026-06-20T00:00:00Z" },
        ],
      }),
    })) as unknown as typeof fetch;

    await dispatchInternal({ type: "getSyncHistory" });
    const stored = await chrome.storage.local.get(null);
    // local is newer → keep it
    expect(stored.lastScanAt).toBe(newer);
    expect(stored.lastScanCount).toBe(500);
  });
});
