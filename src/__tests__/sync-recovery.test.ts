import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChromeMock } from "../../test/mocks/chrome";
import { registerListenersForTest } from "../service-worker";

afterEach(() => vi.restoreAllMocks());
const browser = () => (globalThis as unknown as { chrome: ChromeMock }).chrome;
const recipe = { source: "x", ingestPath: "/api/x/import/extension", networkLabel: "X", targetOrigin: "https://x.com", listPathTemplate: "/connections", paginationParams: { pageSize: 2 }, pacing: { maxPagesPerSession: 5, minDelayMs: 1, maxDelayMs: 2 }, csrfRule: { header: "x-token", cookie: "tok" }, fieldMap: { elementsPath: "elements", firstName: "first", lastName: "last", profileUrl: "url", headline: "headline" } };
const sender = { origin: "https://www.noticed.so" };
const account = { id: "a1" };
const incomplete = { mutuals: [], messages: [] };
const complete = { ...incomplete, messageHistory: { version: 1, complete: true } };
async function send(message: unknown): Promise<any> {
  return new Promise(resolve => {
    browser().runtime.onMessageExternal.dispatch(message, sender, resolve);
    setTimeout(() => resolve(undefined), 100);
  });
}
const settle = () => new Promise(r => setTimeout(r, 30));
async function seed(payload = complete, extra = {}) {
  await browser().storage.local.set({ account, recipe, recipes: { x: recipe }, noticedOrigin: sender.origin, pendingScans: { x: { source: "x", ingestPath: recipe.ingestPath, payload, count: 0, accountKey: "id:a1", id: "scan-1" } }, syncTabIds: { x: 42 }, ...extra });
}
beforeEach(async () => { registerListenersForTest(); await settle(); });

it("acknowledges durable upload retries and bounds them across worker restarts", async () => {
  await seed();
  const remove = vi.spyOn(browser().tabs, "remove");
  const create = vi.spyOn(browser().tabs, "create");
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  for (let n = 1; n <= 3; n++) {
    const state = await browser().storage.local.get(null) as any;
    const message = { type: "syncFailed", source: "x", accountId: "a1", scanId: state.pendingScans.x.id, reason: "temporary" };
    expect(await send(message)).toMatchObject({ ok: true, recovery: n < 3 ? "retrying" : "needs_attention" });
    await send(message); // duplicate failure delivery cannot spend another retry
    if (n < 3) {
      now += 61_000;
      browser().alarms.onAlarm.dispatch({ name: "handoff-retry" });
      await settle();
    }
  }
  const opened = create.mock.calls.length;
  registerListenersForTest(); await settle();
  const state = await browser().storage.local.get(null);
  expect(state.scanFailures).toMatchObject({ x: { message: expect.stringContaining("Try again") } });
  expect(state.lastScanAt).toBeUndefined();
  expect(remove).toHaveBeenCalledWith(42);
  expect(create).toHaveBeenCalledTimes(opened);
  expect(opened).toBe(2);
});

it("rejects a failure ack for another account or replaced scan", async () => {
  await seed();
  for (const overrides of [{ accountId: "other" }, { scanId: "old-scan" }]) {
    expect(await send({ type: "syncFailed", source: "x", accountId: "a1", scanId: "scan-1", reason: "temporary", ...overrides })).toMatchObject({ ok: false });
  }
  expect((await browser().storage.local.get(null)).syncTabIds).toEqual({ x: 42 });
});

it("upgrade replaces obsolete cached history with one durable recovery scan", async () => {
  await seed(incomplete as typeof complete, { lastScanStartedAt: Date.now() });
  // Keep another source running: recovery must queue without interrupting it.
  await browser().storage.local.set({ scanInProgress: true, scanSource: "linkedin_extension", scanAccountId: "id:a1", scanStartedAt: Date.now() });
  browser().runtime.onInstalled.dispatch({ reason: "update", previousVersion: "1.2.15" });
  await settle();
  const state = await browser().storage.local.get(null);
  expect(state.pendingScans).toEqual({});
  expect(state.scanQueue).toEqual(["x"]);
  expect(state.scanSource).toBe("linkedin_extension");
  expect(state.syncRecovery).toMatchObject({ x: { rescans: 1, status: "retrying" } });
  registerListenersForTest(); await settle();
  expect((await browser().storage.local.get(null)).scanQueue).toEqual(["x"]);
});

it("does not rescan fresh incomplete history forever", async () => {
  await seed(incomplete as typeof complete, { syncRecovery: { x: { rescans: 1, uploads: 0, status: "retrying" } } });
  expect(await send({ type: "syncFailed", source: "x", accountId: "a1", scanId: "scan-1", reason: "history-incomplete" })).toMatchObject({ ok: true, recovery: "needs_attention" });
  expect((await browser().storage.local.get(null)).scanFailures).toMatchObject({ x: { message: expect.stringContaining("Try again") } });
});

it("only the matching successful upload clears recovery", async () => {
  await seed(complete, { syncRecovery: { x: { rescans: 1, uploads: 1, status: "retrying" } } });
  await send({ type: "syncConfirmed", source: "x", accountId: "a1", scanId: "old" });
  expect((await browser().storage.local.get(null)).pendingScans).toHaveProperty("x");
  await send({ type: "syncConfirmed", source: "x", accountId: "a1", scanId: "scan-1" });
  const state = await browser().storage.local.get(null);
  expect(state.pendingScans).toEqual({});
  expect(state.syncRecovery).toEqual({});
  expect(state.lastScanAt).toBeTypeOf("number");
});

it("account switches discard recovery state", async () => {
  await seed(complete, { syncRecovery: { x: { rescans: 1, uploads: 2, status: "needs_attention" } } });
  await send({ type: "pair", recipe, account: { id: "a2" } });
  expect((await browser().storage.local.get(null)).syncRecovery).toEqual({});
});

it("a user retry becomes visible as recovery and requests a fresh recipe after sign-in", async () => {
  await seed(complete, { scanFailures: { x: { message: "Try again." } }, syncRecovery: { x: { rescans: 1, uploads: 2, status: "needs_attention" } } });
  const fetcher = vi.fn(async () => ({ ok:true, json:async () => ({recipe,account}) }) as Response);
  globalThis.fetch = fetcher;
  let release!: (value: null) => void;
  vi.spyOn(browser().cookies, "get").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  expect(await send({type:"retrySync",source:"x",accountId:"a1"})).toMatchObject({ok:true});
  await settle();
  const state = await browser().storage.local.get(null) as any;
  expect(state.syncRecovery.x.status).toBe("retrying");
  expect(state.scanFailures?.x).toBeUndefined();
  expect(state.scanNeedsRecipeRefresh).toBe(true);
  expect(fetcher).not.toHaveBeenCalled(); // recipe refresh follows the cookie gate
  release(null); await settle();
});

it("a failed X upload never closes another source's legacy tab", async () => {
  await seed(complete, { syncTabIds: { linkedin_extension: 77 }, syncTabId: 77 });
  const remove = vi.spyOn(browser().tabs, "remove");
  await send({type:"syncFailed", source:"x",accountId:"a1",scanId:"scan-1",reason:"temporary"});
  expect(remove).not.toHaveBeenCalledWith(77);
  expect((await browser().storage.local.get(null)).syncTabIds).toEqual({linkedin_extension:77});
});

it("obsolete data without a source recipe stops with a useful failure", async () => {
  await seed(incomplete as typeof complete, { recipes: {}, recipe: null });
  await send({type:"syncFailed",source:"x",accountId:"a1",scanId:"scan-1",reason:"history-incomplete"});
  await settle();
  expect((await browser().storage.local.get(null)).syncRecovery).toMatchObject({x:{status:"needs_attention"}});
});

it("an obsolete import with an old recipe and expired session stays actionable across restart and pair", async () => {
  await seed(incomplete as typeof complete, { lastScanStartedAt: Date.now() });
  vi.spyOn(browser().cookies, "get").mockResolvedValue(null);
  browser().runtime.onInstalled.dispatch({ reason:"update",previousVersion:"1.2.15" });
  await settle();
  let state = await browser().storage.local.get(null);
  expect(state.scanInProgress).toBe(false);
  expect(state.syncRecovery).toMatchObject({x:{status:"needs_attention"}});
  expect(state.scanFailures).toMatchObject({x:{message:expect.stringContaining("Sign in")}});
  registerListenersForTest(); await settle();
  await send({type:"pair",recipe,account}); await settle();
  state = await browser().storage.local.get(null);
  expect(state.syncRecovery).toMatchObject({x:{status:"needs_attention"}});
  expect(state.scanInProgress).toBe(false);
});
