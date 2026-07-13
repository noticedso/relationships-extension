import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMock } from "../../test/mocks/chrome";
import * as sw from "../service-worker";

// The chrome mock is installed per-test by test/setup.ts (globalThis.chrome).
function getChrome(): ChromeMock {
  return (globalThis as unknown as { chrome: ChromeMock }).chrome;
}

const recipe = {
  source: "linkedin_extension",
  ingestPath: "/api/linkedin/import/extension",
  networkLabel: "LinkedIn",
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

// The finished payload for the (messages-free) LinkedIn fixture is
// pendingScans.linkedin_extension.payload.connections.
function pendingConns(stored: Record<string, unknown>): Array<Record<string, unknown>> {
  const ps = stored.pendingScans as
    | Record<string, { payload?: { connections?: Array<Record<string, unknown>> } }>
    | undefined;
  return ps?.linkedin_extension?.payload?.connections ?? [];
}

// In-flight checkpoint as runScan would initialize it (single connection phase).
function inProgress(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scanInProgress: true,
    scanSource: "linkedin_extension",
    scanPhaseIndex: 0,
    scanCursor: 0,
    scanItems: [],
    scanPhaseResults: { connLists: [], messages: [] },
    scanStartedAt: Date.now(),
    ...extra,
  };
}

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

  it("4. scanNow with no cookie -> acks immediately, then continueScan sets needs network-signin (no fetch)", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue(null);
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const settle = () => new Promise((r) => setTimeout(r, 25));

    // Cause B: scanNow sets the scan state synchronously + acks {ok:true}, then
    // drives continueScan without blocking; a missing network session resolves in
    // the background (clears state, sets needs:network-signin), never fetching.
    const res = (await dispatchInternal({ type: "scanNow" })) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: true });
    await settle();

    expect(fetchSpy).not.toHaveBeenCalled();
    const stored = await chrome.storage.local.get(null);
    expect(stored.needs).toBe("network-signin");
    expect(stored.scanInProgress ?? false).toBe(false);
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

    const res = await sw.runScan(undefined, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      sleep: async () => {},
      jitter: () => 0,
      nowMs: () => 123,
    });

    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);

    const stored = await chrome.storage.local.get(null);
    const pending = pendingConns(stored);
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ profileUrl: "a", firstName: "A" });
    expect(stored.needs).toBe("noticed-signin");

    // E7: the handoff tab opens in the BACKGROUND (active: false) so it never
    // steals focus, carries the source it scanned, and its id is persisted so
    // syncConfirmed can close it.
    expect(tabSpy).toHaveBeenCalledWith({
      url: `https://app.noticed.so/x/sync?ext_id=${getChrome().runtime.id}&source=linkedin_extension`,
      active: false,
    });
    expect(stored.syncTabId).toBe(1);
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

    const res = await sw.runScan(undefined, {
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

    const res = await sw.runScan(undefined, {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      sleep: async () => {},
      jitter: () => 0,
    });

    expect(res.ok).toBe(true);
    expect(fakeFetch.mock.calls.length).toBeGreaterThan(2);
  });

  it("9. alarm is throttled within the period and runs once the period has elapsed", async () => {
    const chrome = getChrome();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    // The monthly alarm auto-scans every source whose host permission is granted.
    vi.spyOn(chrome.permissions, "contains").mockResolvedValue(true);
    const fetchSpy = vi.fn(
      async () => ({ ok: true, json: async () => ({ elements: [] }) }) as Response,
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const settle = () => new Promise((r) => setTimeout(r, 25));

    // A scan ran moments ago → pairing is itself throttled (shared with the alarm).
    await chrome.storage.local.set({ lastScanStartedAt: Date.now() });
    await pair();
    await settle();
    fetchSpy.mockClear(); // isolate the alarm from any pair-path activity

    // an alarm fire is now a duplicate/catch-up within the period → skip it
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

  // A finished, source-shaped pending scan as finalizeScan would store it.
  function pending(payloadConns: Array<Record<string, unknown>>, count = payloadConns.length) {
    return {
      pendingScans: {
        linkedin_extension: {
          source: "linkedin_extension",
          ingestPath: "/api/linkedin/import/extension",
          payload: { source: "linkedin_extension", connections: payloadConns, messages: [] },
          count,
        },
      },
    };
  }

  it("6. getCachedScan returns {ingestPath, payload}; syncConfirmed clears it + stamps lastScan", async () => {
    const chrome = getChrome();
    await pair();
    const conns = [{ profileUrl: "a", firstName: "A", lastName: null, headline: null, connectedOn: null }];
    await chrome.storage.local.set({ ...pending(conns), needs: null });

    const cached = (await dispatchExternal(
      { type: "getCachedScan", source: "linkedin_extension" },
      noticedSender,
    )) as Record<string, unknown>;
    expect(cached.ingestPath).toBe("/api/linkedin/import/extension");
    expect((cached.payload as { connections: unknown }).connections).toEqual(conns);

    const confirmed = (await dispatchExternal(
      { type: "syncConfirmed", source: "linkedin_extension" },
      noticedSender,
    )) as Record<string, unknown>;
    expect(confirmed).toMatchObject({ ok: true });

    const stored = await chrome.storage.local.get(null);
    expect((stored.pendingScans as Record<string, unknown>).linkedin_extension ?? null).toBeNull();
    expect(stored.needs ?? null).toBeNull();
    expect(stored.lastScanAt).not.toBeNull();
    expect(stored.lastScanCount).toBe(1);
  });

  it("6b. syncConfirmed closes the background handoff tab and clears syncTabId (E7)", async () => {
    const chrome = getChrome();
    await pair();
    const removeSpy = vi.spyOn(chrome.tabs, "remove");
    await chrome.storage.local.set({ ...pending([{ profileUrl: "a" }]), needs: "noticed-signin", syncTabId: 42 });

    const confirmed = (await dispatchExternal({ type: "syncConfirmed", source: "linkedin_extension" }, noticedSender)) as Record<
      string,
      unknown
    >;
    expect(confirmed).toMatchObject({ ok: true });

    // closed the background tab by its stored id, then cleared the id
    expect(removeSpy).toHaveBeenCalledWith(42);
    const stored = await chrome.storage.local.get(null);
    expect(stored.syncTabId ?? null).toBeNull();
  });

  it("6c. syncConfirmed with no syncTabId does NOT call tabs.remove (no stored handoff tab)", async () => {
    const chrome = getChrome();
    await pair();
    const removeSpy = vi.spyOn(chrome.tabs, "remove");
    await chrome.storage.local.set({ ...pending([{ profileUrl: "a" }]), needs: "noticed-signin" });

    const confirmed = (await dispatchExternal({ type: "syncConfirmed", source: "linkedin_extension" }, noticedSender)) as Record<
      string,
      unknown
    >;
    expect(confirmed).toMatchObject({ ok: true });
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("6d. syncConfirmed still acks when the handoff tab is already gone (tabs.remove rejects)", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.tabs, "remove").mockRejectedValue(new Error("No tab with id: 42"));
    await chrome.storage.local.set({ ...pending([{ profileUrl: "a" }]), needs: "noticed-signin", syncTabId: 42 });

    const confirmed = (await dispatchExternal({ type: "syncConfirmed", source: "linkedin_extension" }, noticedSender)) as Record<
      string,
      unknown
    >;
    // a rejected remove must not break confirmation
    expect(confirmed).toMatchObject({ ok: true });
    const stored = await chrome.storage.local.get(null);
    expect((stored.pendingScans as Record<string, unknown>).linkedin_extension ?? null).toBeNull();
    expect(stored.lastScanCount).toBe(1);
    expect(stored.syncTabId ?? null).toBeNull();
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
    const settle = () => new Promise((r) => setTimeout(r, 25));

    const res = (await dispatchInternal({ type: "scanNow" })) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: true });

    // armed a short keepalive tick alarm SYNCHRONOUSLY (before the ack, Cause B)
    expect(createAlarm).toHaveBeenCalledWith("scan-tick", { periodInMinutes: 0.5 });
    // the scan drives async after the ack — let it run to completion
    await settle();

    const stored = await chrome.storage.local.get(null);
    // finished → pendingScans set, scan state cleared, handoff state set
    expect(pendingConns(stored).length).toBe(3);
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
    await chrome.storage.local.set(inProgress());
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
    await chrome.storage.local.set(inProgress({ scanCursor: 2, scanItems: recovered }));

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
    const pending = pendingConns(stored) as Array<{ profileUrl: string }>;
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
    await chrome.storage.local.set(inProgress());
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
    await chrome.storage.local.set(inProgress());

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

    await chrome.storage.local.set(inProgress());
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
    await chrome.storage.local.set(
      inProgress({ scanCursor: 4, scanStartedAt: Date.now() - 2 * 60 * 60 * 1000 }),
    );
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
    await chrome.storage.local.set(inProgress({ scanCursor: 2 }));
    const createAlarm = vi.spyOn(chrome.alarms, "create");

    sw.registerListenersForTest(); // force re-registration against this chrome
    // startup re-arm is async (reads storage) — let it settle
    await new Promise((r) => setTimeout(r, 10));

    expect(createAlarm).toHaveBeenCalledWith("scan-tick", { periodInMinutes: 0.5 });
  });

  it("23. getStatus exposes scanning + scannedCount while a scan is in progress (E2)", async () => {
    const chrome = getChrome();
    await pair();
    await chrome.storage.local.set(
      inProgress({
        scanCursor: 6,
        scanItems: [{ profileUrl: "a" }, { profileUrl: "b" }, { profileUrl: "c" }],
      }),
    );
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

  // ── NT-66 auto-scan on pair + scan-twice fix (Cause B) ──────────────────────

  it("26. pair auto-scans every source whose host permission is already granted (reconnect needs no click)", async () => {
    const chrome = getChrome();
    // permission already granted + a valid network session BEFORE pairing
    vi.spyOn(chrome.permissions, "contains").mockResolvedValue(true);
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    const fetchSpy = makeFullThenShortFetch(1);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const settle = () => new Promise((r) => setTimeout(r, 25));

    await pair();
    await settle(); // let the fire-and-forget auto-scan run

    // the granted source was scanned with no manual click → a pending scan exists
    expect(fetchSpy).toHaveBeenCalled();
    const stored = await chrome.storage.local.get(null);
    expect(pendingConns(stored).length).toBeGreaterThan(0);
    expect(stored.needs).toBe("noticed-signin");
  });

  it("26b. pair does NOT auto-scan when no host permission is granted (first-time user)", async () => {
    const chrome = getChrome();
    // contains defaults to false in the mock; cookies present but irrelevant
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const settle = () => new Promise((r) => setTimeout(r, 25));

    await pair();
    await settle();

    expect(fetchSpy).not.toHaveBeenCalled();
    const stored = await chrome.storage.local.get(null);
    expect(stored.pendingScans ?? null).toBeNull();
  });

  it("26c. pair auto-scan respects the scan throttle — a recipe-refresh re-pair right after a scan does NOT re-scan (prevents the /x/sync → re-pair → scan loop)", async () => {
    const chrome = getChrome();
    // Host granted + a valid session, exactly as when the /x/sync handoff page
    // (SyncBroker) re-pairs after a finished scan to refresh the served recipe.
    vi.spyOn(chrome.permissions, "contains").mockResolvedValue(true);
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    // A valid (empty) response so the buggy path fully scans rather than throwing
    // — the only signal we assert on is whether fetch was called at all.
    const fetchSpy = vi.fn(
      async () => ({ ok: true, json: async () => ({ elements: [] }) }) as Response,
    );
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const settle = () => new Promise((r) => setTimeout(r, 25));

    // A scan finalized moments ago (finalizeScan stamps lastScanStartedAt).
    await chrome.storage.local.set({ lastScanStartedAt: Date.now() });

    await pair(); // the SyncBroker recipe-refresh re-pair
    await settle();

    // Throttled just like the monthly alarm → no re-scan. Otherwise the re-pair
    // scans → finalizes → opens another /x/sync tab → re-pairs → scans …, an
    // unbounded loop that hammers LinkedIn/X (account-ban risk).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("27. scanNow sets scanInProgress + arms the tick SYNCHRONOUSLY and acks before the CSRF cookie round-trip (Cause B)", async () => {
    const chrome = getChrome();
    await pair();
    // freeze the scan at buildCsrfHeaders so we can observe the state set BEFORE it.
    let releaseCookie: () => void = () => {};
    vi.spyOn(chrome.cookies, "get").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCookie = () => resolve({ name: "tok", value: "abc" });
        }),
    );
    const createAlarm = vi.spyOn(chrome.alarms, "create");
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      makeFullThenShortFetch(1) as unknown as typeof fetch;

    const res = (await dispatchInternal({ type: "scanNow" })) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: true });
    // armed synchronously — before the (still-pending) cookie read resolves
    expect(createAlarm).toHaveBeenCalledWith("scan-tick", { periodInMinutes: 0.5 });

    // a getStatus right after the ack already sees scanning:true (poller won't bail)
    const mid = (await dispatchInternal({ type: "getStatus" })) as Record<string, unknown>;
    expect(mid.scanning).toBe(true);
    expect(mid.scanningSource).toBe("linkedin_extension");

    // now let the frozen scan proceed to completion
    releaseCookie();
    await new Promise((r) => setTimeout(r, 25));
    const stored = await chrome.storage.local.get(null);
    expect(stored.scanInProgress ?? false).toBe(false);
    expect(pendingConns(stored).length).toBeGreaterThan(0);
  });

  // ── NT-63 owner-profile pass (LinkedIn) + tweets pass (X) ────────────────────

  it("28. LinkedIn owner-profile pass fetches the recipe endpoints ({self} interpolated) and threads raw JSON as ownerProfile", async () => {
    const chrome = getChrome();
    const opRecipe = {
      ...recipe,
      ownerProfile: {
        selfIdSource: { listPathTemplate: "/voyager/api/me", idPath: "miniProfile.publicIdentifier" },
        endpoints: [{ key: "profileView", pathTemplate: "/voyager/api/identity/profiles/{self}/profileView" }],
      },
    };
    await dispatchExternal({ type: "pair", recipe: opRecipe, account }, noticedSender);
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });

    let connCall = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/voyager/api/me"))
        return { ok: true, json: async () => ({ miniProfile: { publicIdentifier: "me-vanity" } }) } as Response;
      if (url.includes("/profileView"))
        return { ok: true, json: async () => ({ profile: { firstName: "Jane" } }) } as Response;
      connCall += 1;
      const elements = connCall === 1 ? [makeElement("a"), makeElement("b")] : [];
      return { ok: true, json: async () => ({ elements }) } as Response;
    });

    const res = await sw.runScan(undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      jitter: () => 0,
      nowMs: () => 1,
    });
    expect(res.ok).toBe(true);

    const stored = await chrome.storage.local.get(null);
    const payload = (stored.pendingScans as Record<string, { payload: Record<string, unknown> }>).linkedin_extension.payload;
    expect(payload.ownerProfile).toEqual({ profileView: { profile: { firstName: "Jane" } } });
    // {self} was interpolated with the id resolved from selfIdSource.idPath
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/profiles/me-vanity/profileView"),
      expect.anything(),
    );
    // connections still imported normally alongside the best-effort owner pass
    expect(pendingConns(stored).length).toBe(2);
  });

  it("28b. a failing owner-profile pass does NOT fail the connections import (best-effort)", async () => {
    const chrome = getChrome();
    const opRecipe = {
      ...recipe,
      ownerProfile: {
        selfIdSource: { listPathTemplate: "/voyager/api/me", idPath: "miniProfile.publicIdentifier" },
        endpoints: [{ key: "profileView", pathTemplate: "/voyager/api/identity/profiles/{self}/profileView" }],
      },
    };
    await dispatchExternal({ type: "pair", recipe: opRecipe, account }, noticedSender);
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });

    let connCall = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/voyager/api/me")) throw new Error("me endpoint down");
      connCall += 1;
      const elements = connCall === 1 ? [makeElement("a"), makeElement("b")] : [];
      return { ok: true, json: async () => ({ elements }) } as Response;
    });

    const res = await sw.runScan(undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      jitter: () => 0,
      nowMs: () => 1,
    });
    expect(res.ok).toBe(true);
    const stored = await chrome.storage.local.get(null);
    const payload = (stored.pendingScans as Record<string, { payload: Record<string, unknown> }>).linkedin_extension.payload;
    expect(pendingConns(stored).length).toBe(2); // connections survived
    expect("ownerProfile" in payload).toBe(false); // failed pass → key omitted
  });

  // ── NT-99 follow-up: LinkedIn per-conversation had_reply probe ──────────────

  const liMessagesRecipe = {
    ...recipe,
    messages: {
      listPathTemplate: "/msg/conversations?self={self}",
      pageSize: 100,
      selfIdSource: { listPathTemplate: "/voyager/api/me", idPath: "miniProfile.entityUrn", extract: "([^:]+)$" },
      excludeUnreplied: false,
      messageFieldMap: {
        mode: "participantConversations",
        elementsPath: "data.messengerConversationsBySyncToken.elements",
        participantsPath: "conversationParticipants",
        participantSelfIdPath: "hostIdentityUrn",
        participantHandlePath: "participantType.member.profileUrl",
        lastActivityAtPath: "lastActivityAt",
        groupChatPath: "groupChat",
        unreadCountPath: "unreadCount",
        counterpartUrlPrefix: "",
      },
      messageEvents: {
        urlTemplate: "/msg/events?conversationUrn={conversationUrn}",
        conversationUrnPath: "entityUrn",
        elementsPath: "data.messengerMessagesByConversation.elements",
        senderIdPath: "sender.hostIdentityUrn",
        maxConversations: 150,
        jitterMinMs: 0,
        jitterMaxMs: 0,
      },
    },
  };
  const convo = (urn: string, handle: string, lastAt: number) => ({
    entityUrn: urn,
    groupChat: false,
    unreadCount: 0,
    lastActivityAt: lastAt,
    conversationParticipants: [
      { hostIdentityUrn: "urn:li:fsd_profile:ACoAACself", participantType: { member: { profileUrl: "https://www.linkedin.com/in/me" } } },
      { hostIdentityUrn: "urn:li:fsd_profile:ACoAAA" + handle, participantType: { member: { profileUrl: "https://www.linkedin.com/in/" + handle } } },
    ],
  });
  const conversationsPage = {
    data: {
      messengerConversationsBySyncToken: {
        elements: [
          convo("urn:li:msg_conversation:jane", "jane", 1750000900000),
          convo("urn:li:msg_conversation:bob", "bob", 1750000000000),
        ],
      },
    },
  };
  // `body` present on every event to prove the probe never reads message text.
  const evt = (senderUrn: string) => ({ sender: { hostIdentityUrn: senderUrn }, body: { text: "SECRET BODY" } });
  const eventsFor = (urn: string) => {
    const senders = urn.includes("jane")
      ? ["urn:li:fsd_profile:ACoAACself", "urn:li:fsd_profile:ACoAAAjane"] // two-way
      : ["urn:li:fsd_profile:ACoAACself"]; // bob: outbound only, unreplied
    return { data: { messengerMessagesByConversation: { elements: senders.map(evt) } } };
  };
  function messagesPayload(stored: Record<string, unknown>): Array<Record<string, unknown>> {
    const ps = stored.pendingScans as Record<string, { payload?: { messages?: Array<Record<string, unknown>> } }> | undefined;
    return ps?.linkedin_extension?.payload?.messages ?? [];
  }

  it("29-li. probes recent conversations for had_reply (two-way=true, one-way=false) and never captures message text", async () => {
    const chrome = getChrome();
    await dispatchExternal({ type: "pair", recipe: liMessagesRecipe, account }, noticedSender);
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });

    let connCall = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/voyager/api/me"))
        return { ok: true, json: async () => ({ miniProfile: { entityUrn: "urn:li:fsd_profile:ACoAACself" } }) } as Response;
      if (url.includes("/msg/events")) {
        const urn = decodeURIComponent(url);
        return { ok: true, json: async () => eventsFor(urn) } as Response;
      }
      if (url.includes("/msg/conversations"))
        return { ok: true, json: async () => conversationsPage } as Response;
      connCall += 1;
      const elements = connCall === 1 ? [makeElement("a"), makeElement("b")] : [];
      return { ok: true, json: async () => ({ elements }) } as Response;
    });

    const res = await sw.runScan(undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      jitter: () => 0,
      nowMs: () => 1,
    });
    expect(res.ok).toBe(true);

    const stored = await chrome.storage.local.get(null);
    const msgs = messagesPayload(stored);
    const byCp = Object.fromEntries(msgs.map((m) => [m.counterpartProfileUrl, m.had_reply]));
    expect(byCp["https://www.linkedin.com/in/jane"]).toBe(true);
    expect(byCp["https://www.linkedin.com/in/bob"]).toBe(false);
    // Connections still imported alongside the best-effort probe.
    expect(pendingConns(stored).length).toBe(2);
    // No message text ever leaves the extension.
    expect(JSON.stringify(stored.pendingScans)).not.toContain("SECRET");
  });

  it("29-li-b. a failing events probe degrades gracefully: had_reply omitted, messages + connections still import", async () => {
    const chrome = getChrome();
    await dispatchExternal({ type: "pair", recipe: liMessagesRecipe, account }, noticedSender);
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });

    let connCall = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/voyager/api/me"))
        return { ok: true, json: async () => ({ miniProfile: { entityUrn: "urn:li:fsd_profile:ACoAACself" } }) } as Response;
      if (url.includes("/msg/events")) throw new Error("events endpoint down");
      if (url.includes("/msg/conversations"))
        return { ok: true, json: async () => conversationsPage } as Response;
      connCall += 1;
      const elements = connCall === 1 ? [makeElement("a"), makeElement("b")] : [];
      return { ok: true, json: async () => ({ elements }) } as Response;
    });

    const res = await sw.runScan(undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      jitter: () => 0,
      nowMs: () => 1,
    });
    expect(res.ok).toBe(true);

    const stored = await chrome.storage.local.get(null);
    const msgs = messagesPayload(stored);
    expect(msgs.length).toBe(2); // conversations still captured (summary)
    for (const m of msgs) expect("had_reply" in m).toBe(false); // probe failed → omitted
    expect(pendingConns(stored).length).toBe(2);
  });

  // Build a scan-scoped fetchImpl over a mutable conversations page + per-urn
  // events responder, so each scan's probe fetches can be counted independently.
  function liFetchImpl(
    page: () => unknown,
    events: (decodedUrl: string) => unknown,
    connCallRef: { n: number },
  ) {
    return vi.fn(async (url: string) => {
      if (url.includes("/voyager/api/me"))
        return { ok: true, json: async () => ({ miniProfile: { entityUrn: "urn:li:fsd_profile:ACoAACself" } }) } as Response;
      if (url.includes("/msg/events"))
        return { ok: true, json: async () => events(decodeURIComponent(url)) } as Response;
      if (url.includes("/msg/conversations"))
        return { ok: true, json: async () => page() } as Response;
      connCallRef.n += 1;
      const elements = connCallRef.n === 1 ? [makeElement("a"), makeElement("b")] : [];
      return { ok: true, json: async () => ({ elements }) } as Response;
    });
  }
  const eventsFetchCount = (f: ReturnType<typeof vi.fn>) =>
    f.mock.calls.filter((c) => String(c[0]).includes("/msg/events")).length;

  it("29-li-c. re-scan with NO new activity probes zero conversations and re-attaches cached had_reply verdicts", async () => {
    const chrome = getChrome();
    await dispatchExternal({ type: "pair", recipe: liMessagesRecipe, account }, noticedSender);
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    const deps = { sleep: async () => {}, jitter: () => 0, nowMs: () => 1 };

    // Scan 1: both conversations probed (empty cache).
    const conn1 = { n: 0 };
    const fetch1 = liFetchImpl(() => conversationsPage, eventsFor, conn1);
    expect((await sw.runScan(undefined, { ...deps, fetchImpl: fetch1 as unknown as typeof fetch })).ok).toBe(true);
    expect(eventsFetchCount(fetch1)).toBe(2);
    const stored1 = await chrome.storage.local.get(null);
    const cache = stored1.hadReplyByConversation as Record<string, { at: number; had_reply: boolean }>;
    expect(cache["urn:li:msg_conversation:jane"]).toMatchObject({ had_reply: true });
    expect(cache["urn:li:msg_conversation:bob"]).toMatchObject({ had_reply: false });

    // Scan 2: identical conversations page (no new activity) → ZERO events
    // fetches, but the payload still carries the cached verdicts (a one-way
    // conversation must not silently regress to legacy log-everything).
    const conn2 = { n: 0 };
    const fetch2 = liFetchImpl(() => conversationsPage, eventsFor, conn2);
    expect((await sw.runScan(undefined, { ...deps, fetchImpl: fetch2 as unknown as typeof fetch })).ok).toBe(true);
    expect(eventsFetchCount(fetch2)).toBe(0);
    const stored2 = await chrome.storage.local.get(null);
    const byCp = Object.fromEntries(messagesPayload(stored2).map((m) => [m.counterpartProfileUrl, m.had_reply]));
    expect(byCp["https://www.linkedin.com/in/jane"]).toBe(true);
    expect(byCp["https://www.linkedin.com/in/bob"]).toBe(false);
  });

  it("29-li-d. only a conversation with NEW activity is re-probed; its verdict updates, others come from cache", async () => {
    const chrome = getChrome();
    await dispatchExternal({ type: "pair", recipe: liMessagesRecipe, account }, noticedSender);
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    const deps = { sleep: async () => {}, jitter: () => 0, nowMs: () => 1 };

    // Scan 1: jane two-way, bob one-way.
    const conn1 = { n: 0 };
    const fetch1 = liFetchImpl(() => conversationsPage, eventsFor, conn1);
    expect((await sw.runScan(undefined, { ...deps, fetchImpl: fetch1 as unknown as typeof fetch })).ok).toBe(true);

    // Scan 2: bob has NEW activity (he finally replied) — jane unchanged.
    const bumped = {
      data: {
        messengerConversationsBySyncToken: {
          elements: [
            convo("urn:li:msg_conversation:jane", "jane", 1750000900000),
            convo("urn:li:msg_conversation:bob", "bob", 1750009999000),
          ],
        },
      },
    };
    const bobNowTwoWay = (urn: string) =>
      urn.includes("bob")
        ? { data: { messengerMessagesByConversation: { elements: [evt("urn:li:fsd_profile:ACoAACself"), evt("urn:li:fsd_profile:ACoAAAbob")] } } }
        : eventsFor(urn);
    const conn2 = { n: 0 };
    const fetch2 = liFetchImpl(() => bumped, bobNowTwoWay, conn2);
    expect((await sw.runScan(undefined, { ...deps, fetchImpl: fetch2 as unknown as typeof fetch })).ok).toBe(true);

    // Only bob was re-probed; jane's verdict came from the cache.
    expect(eventsFetchCount(fetch2)).toBe(1);
    expect(String(fetch2.mock.calls.find((c) => String(c[0]).includes("/msg/events"))?.[0])).toContain("bob");
    const stored = await chrome.storage.local.get(null);
    const byCp = Object.fromEntries(messagesPayload(stored).map((m) => [m.counterpartProfileUrl, m.had_reply]));
    expect(byCp["https://www.linkedin.com/in/bob"]).toBe(true); // updated verdict
    expect(byCp["https://www.linkedin.com/in/jane"]).toBe(true); // cached
  });

  it("29. X tweets pass resolves self from the twid cookie, pages via max_id, and rides along as `mentions` (no text)", async () => {
    const chrome = getChrome();
    const xRecipe = {
      source: "x",
      ingestPath: "/api/x/import/extension",
      networkLabel: "X",
      targetOrigin: "https://x.com",
      listPathTemplate: "/friends?cursor={cursor}",
      paginationParams: { pageSize: 2 },
      cursorPath: "next_cursor_str",
      pacing: { maxPagesPerSession: 5, minDelayMs: 0, maxDelayMs: 0 },
      csrfRule: { header: "x-csrf-token", cookie: "ct0" },
      staticHeaders: { authorization: "Bearer x" },
      fieldMap: { elementsPath: "users", firstName: "name", lastName: "", profileUrl: "screen_name", headline: "d", externalId: "id_str" },
      connectionLists: [
        { listPathTemplate: "/friends?cursor={cursor}", cursorPath: "next_cursor_str" },
        { listPathTemplate: "/followers?cursor={cursor}", cursorPath: "next_cursor_str" },
      ],
      intersectConnections: true,
      tweets: {
        listPathTemplate: "/statuses/user_timeline.json?user_id={self}&count=2&max_id={cursor}",
        pageSize: 2,
        selfIdCookie: { name: "twid", pattern: "u=([0-9]+)" },
        maxPagesPerSession: 5,
        tweetFieldMap: {
          mode: "tweetEdges",
          tweetIdPath: "id_str",
          createdAtPath: "created_at",
          inReplyToUserIdPath: "in_reply_to_user_id_str",
          inReplyToScreenNamePath: "in_reply_to_screen_name",
          userMentionsPath: "entities.user_mentions",
          mentionIdPath: "id_str",
          mentionScreenNamePath: "screen_name",
          mentionNamePath: "name",
        },
      },
    };
    await dispatchExternal({ type: "pair", recipe: xRecipe, account }, noticedSender);

    vi.spyOn(chrome.cookies, "get").mockImplementation(async ({ name }: { url: string; name: string }) => {
      if (name === "ct0") return { name, value: "csrf" };
      if (name === "twid") return { name, value: "u=555" };
      return null;
    });

    const timelineUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/friends") || url.includes("/followers"))
        return { ok: true, json: async () => ({ users: [{ id_str: "2", name: "Bob", screen_name: "bob", d: "" }], next_cursor_str: "0" }) } as Response;
      if (url.includes("/user_timeline")) {
        timelineUrls.push(url);
        if (timelineUrls.length === 1)
          return {
            ok: true,
            json: async () => [
              { id_str: "20", created_at: "2026-06-20T10:30:00.000Z", full_text: "SECRET", in_reply_to_user_id_str: null, entities: { user_mentions: [{ id_str: "77", screen_name: "kate", name: "Kate" }] } },
              { id_str: "10", created_at: "2026-06-20T09:00:00.000Z", full_text: "SECRET", in_reply_to_user_id_str: "88", in_reply_to_screen_name: "leo", entities: { user_mentions: [] } },
            ],
          } as Response;
        return { ok: true, json: async () => [] } as Response; // short page → stop
      }
      return { ok: false } as Response;
    });

    const res = await sw.runScan("x", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      jitter: () => 0,
      nowMs: () => 1,
    });
    expect(res.ok).toBe(true);

    const stored = await chrome.storage.local.get(null);
    const payload = (stored.pendingScans as Record<string, { payload: Record<string, unknown> }>).x.payload;
    expect(payload.mentions).toEqual([
      { tweetId: "20", createdAt: "2026-06-20T10:30:00.000Z", isReply: false, mentionedUserId: "77", mentionedScreenName: "kate", mentionedName: "Kate" },
      { tweetId: "10", createdAt: "2026-06-20T09:00:00.000Z", isReply: true, inReplyToUserId: "88", inReplyToScreenName: "leo", mentionedUserId: "", mentionedScreenName: "", mentionedName: "" },
    ]);
    // self resolved from twid (u=555); page 2 paginated via max_id = min(id)-1 = 9
    expect(timelineUrls[0]).toContain("user_id=555");
    expect(timelineUrls[1]).toContain("max_id=9");
    expect(JSON.stringify(payload.mentions)).not.toContain("SECRET");
  });

  // ── Grant → scan via permissions.onAdded (popup dismissed by the prompt) ──────

  it("30. permissions.onAdded auto-scans the newly-granted source so grant → sync completes even when the prompt dismissed the popup (no scanNow)", async () => {
    const chrome = getChrome();
    await pair(); // first-time user: no host permission yet → pair does NOT auto-scan (26b)
    // The user approves "grant access": the network session is present and the
    // host permission now contains — but the popup that requested it was closed
    // by the permission prompt, so it never sent scanNow.
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    vi.spyOn(chrome.permissions, "contains").mockResolvedValue(true);
    const fetchSpy = makeFullThenShortFetch(1);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const settle = () => new Promise((r) => setTimeout(r, 25));

    // Chrome fires onAdded on the grant regardless of the popup's fate.
    chrome.permissions.onAdded.dispatch({ origins: [recipe.targetOrigin + "/*"] });
    await settle();

    // the service worker (durable context) picked it up and ran the scan
    expect(fetchSpy).toHaveBeenCalled();
    const stored = await chrome.storage.local.get(null);
    expect(pendingConns(stored).length).toBeGreaterThan(0);
    expect(stored.needs).toBe("noticed-signin");
  });

  it("31. permissions.onAdded ignores an origin that matches no paired source", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const settle = () => new Promise((r) => setTimeout(r, 25));

    chrome.permissions.onAdded.dispatch({ origins: ["https://unrelated.example/*"] });
    await settle();

    expect(fetchSpy).not.toHaveBeenCalled();
    const stored = await chrome.storage.local.get(null);
    expect(stored.pendingScans ?? null).toBeNull();
  });

  it("32. permissions.onAdded does not start a second scan when one is already in progress (popup path already ran scanNow)", async () => {
    const chrome = getChrome();
    await pair();
    vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
    const fetchSpy = makeFullThenShortFetch(1);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const settle = () => new Promise((r) => setTimeout(r, 25));

    // A scan is already mid-flight (the popup survived and sent scanNow).
    await chrome.storage.local.set(inProgress());
    chrome.permissions.onAdded.dispatch({ origins: [recipe.targetOrigin + "/*"] });
    await settle();

    // onAdded must not clobber the in-flight checkpoint by re-initializing a scan.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
