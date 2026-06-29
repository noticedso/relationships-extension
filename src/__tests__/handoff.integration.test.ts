import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMock } from "../../test/mocks/chrome";
import * as sw from "../service-worker";

function getChrome(): ChromeMock {
  return (globalThis as unknown as { chrome: ChromeMock }).chrome;
}

const recipe = {
  source: "linkedin_extension",
  ingestPath: "/api/linkedin/import/extension",
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
};

// The handoff payload's connections live at pendingScans[source].payload.connections;
// getCachedScan returns { ingestPath, payload }.
function pendingConns(stored: Record<string, unknown>): Array<Record<string, unknown>> {
  const ps = stored.pendingScans as
    | Record<string, { payload?: { connections?: Array<Record<string, unknown>> } }>
    | undefined;
  return ps?.linkedin_extension?.payload?.connections ?? [];
}
function cachedConns(cached: Record<string, unknown>): Array<Record<string, unknown>> {
  return (cached.payload as { connections?: Array<Record<string, unknown>> })?.connections ?? [];
}

const account = { id: "acct-1", displayName: "Test User" };

function makeElement(id: string) {
  return {
    m: { publicIdentifier: id, firstName: id.toUpperCase(), lastName: "X", headline: "h" },
    createdAt: "2024-01-01",
  };
}

const noticedSender = { origin: "https://app.noticed.so", url: "https://app.noticed.so/x/sync" };

function dispatchExternal(message: unknown, sender: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let resolved = false;
    getChrome().runtime.onMessageExternal.dispatch(message, sender, (r) => {
      resolved = true;
      resolve(r);
    });
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

async function pair() {
  return dispatchExternal({ type: "pair", recipe, account }, noticedSender);
}

function makeFakeFetch() {
  let call = 0;
  return vi.fn(async () => {
    call += 1;
    const elements = call === 1 ? [makeElement("a"), makeElement("b")] : [];
    return { ok: true, json: async () => ({ elements }) } as Response;
  });
}

async function runFullScan() {
  const chrome = getChrome();
  vi.spyOn(chrome.cookies, "get").mockResolvedValue({ name: "tok", value: "abc" });
  return sw.runScan(undefined, {
    fetchImpl: makeFakeFetch() as unknown as typeof fetch,
    sleep: async () => {},
    jitter: () => 0,
  });
}

describe("SW ↔ /x/sync handoff integration", () => {
  beforeEach(() => {
    sw.registerListeners();
  });

  it("Scenario A: confirmed handoff clears pending + stamps lastScan", async () => {
    const chrome = getChrome();

    // 1. pair from first-party noticed page
    await pair();

    // 2. run the scan → pendingScan cached, needs "noticed-signin"
    const res = await runFullScan();
    expect(res.ok).toBe(true);
    expect(res.count).toBe(2);

    let stored = await chrome.storage.local.get(null);
    expect(pendingConns(stored).length).toBe(2);
    expect(stored.needs).toBe("noticed-signin");

    // 3. /x/sync page pulls the cached scan
    const cached = (await dispatchExternal({ type: "getCachedScan", source: "linkedin_extension" }, noticedSender)) as Record<
      string,
      unknown
    >;
    expect(cachedConns(cached).length).toBe(2);
    expect(cachedConns(cached)[0]).toMatchObject({ profileUrl: "a", firstName: "A" });

    // 4. /x/sync confirms
    const confirmed = (await dispatchExternal({ type: "syncConfirmed", source: "linkedin_extension" }, noticedSender)) as Record<
      string,
      unknown
    >;
    expect(confirmed).toMatchObject({ ok: true });

    // pending cleared via getCachedScan
    const afterCached = (await dispatchExternal({ type: "getCachedScan", source: "linkedin_extension" }, noticedSender)) as Record<
      string,
      unknown
    >;
    expect(cachedConns(afterCached).length).toBe(0);

    stored = await chrome.storage.local.get(null);
    expect((stored.pendingScans as Record<string, unknown>).linkedin_extension ?? null).toBeNull();
    expect(stored.needs ?? null).toBeNull();
    expect(typeof stored.lastScanAt).toBe("number");
    expect(stored.lastScanAt as number).toBeGreaterThan(0);
    expect(stored.lastScanCount).toBe(2);
  });

  it("Scenario B: no confirmation leaves pending + needs noticed-signin", async () => {
    const chrome = getChrome();

    // 1. pair + run scan
    await pair();
    const res = await runFullScan();
    expect(res.ok).toBe(true);

    let stored = await chrome.storage.local.get(null);
    expect(pendingConns(stored).length).toBe(2);
    expect(stored.needs).toBe("noticed-signin");

    // 2. do NOT dispatch syncConfirmed (user not signed into noticed)

    // 3. pending still present, getStatus reports noticed-signin
    const cached = (await dispatchExternal({ type: "getCachedScan", source: "linkedin_extension" }, noticedSender)) as Record<
      string,
      unknown
    >;
    expect(cachedConns(cached).length).toBe(2);

    const status = (await dispatchInternal({ type: "getStatus" })) as Record<string, unknown>;
    expect(status.needs).toBe("noticed-signin");

    stored = await chrome.storage.local.get(null);
    expect(pendingConns(stored).length).toBe(2);
  });
});
