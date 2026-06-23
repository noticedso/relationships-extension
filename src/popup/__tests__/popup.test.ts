/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "../popup";

const popupSrcPath = resolve(process.cwd(), "src/popup/popup.ts");

const status = {
  account: { name: "Octo Cat", email: "o@c.com" },
  recipe: { networkLabel: "ExampleNet" },
  nextScanAt: 1735689600000,
  lastScanAt: 1707091200000,
  lastScanCount: 412,
  needs: "noticed-signin",
  testMode: true,
};

const NOTICED = "https://www.noticed.so";

function buildDom() {
  document.body.innerHTML = `
    <section id="connect" hidden><button id="connect-cta"></button></section>
    <div id="account-name"></div>
    <div id="account-email"></div>
    <div id="next-scan"></div>
    <div id="last-scan"></div>
    <button id="scan-now"></button>
    <label id="test-mode-toggle" hidden><input type="checkbox" id="test-mode" /></label>
    <div id="needs"></div>
    <button id="signin-cta" hidden></button>
    <div id="what-we-fetch"></div>
    <div id="privacy"></div>
    <section id="syncs"><h2 class="block-title">recent syncs</h2><ul id="sync-list" class="sync-list"></ul><p id="sync-empty" class="block-body" hidden>no syncs yet</p><button id="sync-more" type="button" class="sync-more" hidden>show more</button></section>
    <a id="repo-link"></a>
  `;
}

describe("popup", () => {
  beforeEach(() => {
    buildDom();
  });

  it("renders account, scans, fetch copy, and needs from runtime status", async () => {
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : status));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };

    await init(document);

    expect(document.getElementById("account-email")!.textContent).toContain("o@c.com");
    expect(document.getElementById("account-name")!.textContent).toContain("Octo Cat");
    // a formatted medium date — at least contains a 4-digit year
    expect(document.getElementById("next-scan")!.textContent).toMatch(/\d{4}/);
    expect(document.getElementById("last-scan")!.textContent).toContain("412");
    const fetched = document.getElementById("what-we-fetch")!.textContent ?? "";
    expect(fetched).toContain("ExampleNet");
    expect(fetched.toLowerCase()).not.toContain("linkedin");
    expect(document.getElementById("needs")!.textContent!.toLowerCase()).toContain("noticed");
    expect(document.getElementById("privacy")!.textContent).toContain("never sell it");
  });

  it("reflects testMode in the checkbox and toggles it on change (dev build)", async () => {
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : status));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };

    await init(document);
    expect(document.getElementById("test-mode-toggle")!.hidden).toBe(false); // revealed in dev
    const checkbox = document.getElementById("test-mode") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    sendMessage.mockClear();
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    expect(sendMessage).toHaveBeenCalledWith({ type: "setTestMode", value: false });
  });

  it("hides + never wires the test-mode toggle in a production build (__DEV__ false)", async () => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false; // simulate the published artifact
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : status));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };

    await init(document);
    expect(document.getElementById("test-mode-toggle")!.hidden).toBe(true); // stays hidden

    sendMessage.mockClear();
    const checkbox = document.getElementById("test-mode") as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(sendMessage).not.toHaveBeenCalled(); // not wired in production
  });

  it("wires scan-now to send a scanNow message (no targetOrigin → no permission prompt)", async () => {
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : status));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };

    await init(document);
    sendMessage.mockClear();
    document.getElementById("scan-now")!.dispatchEvent(new Event("click"));
    await new Promise((r) => setTimeout(r, 0));
    expect(sendMessage).toHaveBeenCalledWith({ type: "scanNow" });
  });

  it("requests the host permission on the scan click (user gesture) before scanning", async () => {
    const withOrigin = {
      ...status,
      recipe: { networkLabel: "ExampleNet", targetOrigin: "https://network.example.com" },
    };
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : withOrigin));
    const request = vi.fn(async () => true);
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
      permissions: { request, contains: vi.fn(async () => false) },
    };

    await init(document);
    sendMessage.mockClear();
    document.getElementById("scan-now")!.dispatchEvent(new Event("click"));
    await new Promise((r) => setTimeout(r, 0));
    expect(request).toHaveBeenCalledWith({ origins: ["https://network.example.com/*"] });
    expect(sendMessage).toHaveBeenCalledWith({ type: "scanNow" });
  });

  it("does not scan if the host permission is denied", async () => {
    const withOrigin = {
      ...status,
      recipe: { networkLabel: "ExampleNet", targetOrigin: "https://network.example.com" },
    };
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : withOrigin));
    const request = vi.fn(async () => false);
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
      permissions: { request, contains: vi.fn(async () => false) },
    };

    await init(document);
    sendMessage.mockClear();
    document.getElementById("scan-now")!.dispatchEvent(new Event("click"));
    await new Promise((r) => setTimeout(r, 0));
    expect(request).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith({ type: "scanNow" });
  });

  it("source names no platform", () => {
    const src = readFileSync(popupSrcPath, "utf8").toLowerCase();
    expect(src).not.toContain("linkedin");
    expect(src).not.toContain("voyager");
  });

  // Regression: module scripts are deferred, so when the popup module evaluates
  // the document is already parsed (readyState "complete"). The auto-run guard
  // MUST still fire init() in that case — otherwise the real popup renders blank.
  it("auto-runs init on a deferred-module (readyState complete) load", async () => {
    buildDom();
    expect(document.readyState).toBe("complete"); // jsdom default
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : status));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };

    vi.resetModules();
    await import("../popup"); // evaluating the module should call init() itself
    await new Promise((r) => setTimeout(r, 0)); // let the async init settle

    expect(sendMessage).toHaveBeenCalledWith({ type: "getStatus" });
    expect(document.getElementById("account-email")!.textContent).toContain("o@c.com");
  });

  it("renders last 3 syncs and reveals the rest on show more", async () => {
    const runs = [1, 2, 3, 4, 5].map((n) => ({
      source: "linkedin_extension",
      label: "LinkedIn",
      kind: "relationships",
      itemCount: n * 10,
      status: "succeeded",
      startedAt: `2026-06-1${n}T00:00:00Z`,
      finishedAt: `2026-06-1${n}T00:00:00Z`,
    }));
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs } : status));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };
    await init(document);
    const list = document.getElementById("sync-list")!;
    expect(list.querySelectorAll("li").length).toBe(3);
    expect(list.textContent).toContain("relationships");
    expect(list.textContent).toContain("LinkedIn");
    const more = document.getElementById("sync-more") as HTMLButtonElement;
    expect(more.hidden).toBe(false);
    more.dispatchEvent(new Event("click"));
    expect(list.querySelectorAll("li").length).toBe(5);
  });

  it("shows an empty state when there are no syncs", async () => {
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : status));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };
    await init(document);
    expect(document.getElementById("syncs")!.textContent!.toLowerCase()).toContain("no syncs yet");
  });

  it("shows a Connect button (opens /x/connect with the extension id) when not paired", async () => {
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === "getSyncHistory" ? { runs: [] } : { account: null, recipe: null, needs: null },
    );
    const create = vi.fn(async () => ({}));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create },
    };
    await init(document);
    const btn = document.getElementById("connect-cta") as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    btn.dispatchEvent(new Event("click"));
    expect(create).toHaveBeenCalledWith({
      url: `${NOTICED}/x/connect?ext_id=abcdefghijklmnopabcdefghijklmnop`,
    });
  });

  it("shows a Sign-in button when the noticed session is expired", async () => {
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === "getSyncHistory" ? { needs: "noticed-signin" } : { account: { name: "X" }, recipe: { networkLabel: "LinkedIn" }, needs: null },
    );
    const create = vi.fn(async () => ({}));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create },
    };
    await init(document);
    const btn = document.getElementById("signin-cta") as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    btn.dispatchEvent(new Event("click"));
    expect(create).toHaveBeenCalledWith({
      url: `${NOTICED}/x/connect?ext_id=abcdefghijklmnopabcdefghijklmnop`,
    });
  });
});
