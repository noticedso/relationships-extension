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
});
