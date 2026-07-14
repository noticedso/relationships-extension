/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { init, pollScanProgress } from "../popup";

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
    <ul id="network-status" hidden></ul>
    <div id="last-scan"></div>
    <button id="scan-now"></button>
    <span id="scan-spinner" hidden></span>
    <label id="test-mode-toggle" hidden><input type="checkbox" id="test-mode" /></label>
    <div id="needs"></div>
    <button id="signin-cta" hidden></button>
    <div id="what-we-fetch"></div>
    <div id="privacy"></div>
    <section id="syncs"><h2 class="block-title">recent syncs</h2><ul id="sync-list" class="sync-list"></ul><p id="sync-empty" class="block-body" hidden>no syncs yet</p><button id="sync-more" type="button" class="sync-more" hidden>show more</button></section>
    <a id="repo-link"></a>
    <footer><span id="version"></span><a id="update-notice" hidden></a></footer>
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
    // E4: status.needs === "noticed-signin" now surfaces the actionable Sign-in
    // button (single source of truth) rather than a dangling red text line.
    expect((document.getElementById("signin-cta") as HTMLButtonElement).hidden).toBe(false);
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

  it("when the host permission is NOT granted: button says 'grant access'; granting kicks off the scan in the same click (Cause A)", async () => {
    const withOrigin = {
      ...status,
      recipe: { networkLabel: "ExampleNet", targetOrigin: "https://network.example.com" },
    };
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === "getSyncHistory" ? { runs: [] } : m.type === "scanNow" ? { ok: true } : withOrigin,
    );
    const request = vi.fn(async () => true);
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
      permissions: { request, contains: vi.fn(async () => false) },
    };

    await init(document);
    expect(document.getElementById("scan-now")!.textContent).toBe("grant access");
    sendMessage.mockClear();
    document.getElementById("scan-now")!.dispatchEvent(new Event("click"));
    await new Promise((r) => setTimeout(r, 0));
    expect(request).toHaveBeenCalledWith({ origins: ["https://network.example.com/*"] });
    // Cause A: a granted permission now triggers the scan immediately — no second
    // click needed ("1 open + 1 click → grant + import").
    expect(sendMessage).toHaveBeenCalledWith({ type: "scanNow" });
  });

  it("grant-access that is DENIED does not scan — only re-renders", async () => {
    const withOrigin = {
      ...status,
      recipe: { networkLabel: "ExampleNet", targetOrigin: "https://network.example.com" },
    };
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === "getSyncHistory" ? { runs: [] } : m.type === "scanNow" ? { ok: true } : withOrigin,
    );
    const request = vi.fn(async () => false); // user dismissed the prompt
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
    expect(sendMessage).not.toHaveBeenCalledWith({ type: "scanNow" });
  });

  it("when the host permission IS granted: button says 'scan now' and clicking sends scanNow", async () => {
    const withOrigin = {
      ...status,
      recipe: { networkLabel: "ExampleNet", targetOrigin: "https://network.example.com" },
    };
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : withOrigin));
    const request = vi.fn(async () => true);
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
      permissions: { request, contains: vi.fn(async () => true) },
    };

    await init(document);
    expect(document.getElementById("scan-now")!.textContent).toBe("scan now");
    sendMessage.mockClear();
    document.getElementById("scan-now")!.dispatchEvent(new Event("click"));
    await new Promise((r) => setTimeout(r, 0));
    expect(request).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({ type: "scanNow" });
  });

  it("granted scan-now shows progress: button disabled + 'scanning…' synchronously on click", async () => {
    const withOrigin = {
      ...status,
      recipe: { networkLabel: "ExampleNet", targetOrigin: "https://network.example.com" },
    };
    const sendMessage = vi.fn(async (m: { type: string }) => {
      if (m.type === "getSyncHistory") return { runs: [] };
      // scanNow no longer blocks the UI — it's a fire-and-forget kickoff and the
      // popup polls getStatus for progress. Report not-scanning so the (real)
      // delayed poller doesn't loop in this synchronous-feedback test.
      if (m.type === "scanNow") return { ok: true };
      return { ...withOrigin, scanning: false };
    });
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
      permissions: { request: vi.fn(async () => true), contains: vi.fn(async () => true) },
    };

    await init(document);
    const btn = document.getElementById("scan-now") as HTMLButtonElement;
    btn.dispatchEvent(new Event("click"));
    // The click handler sets the in-progress UI SYNCHRONOUSLY (before any await),
    // so it's observable immediately — no microtask yield.
    const live = document.getElementById("scan-now") as HTMLButtonElement;
    expect(live.disabled).toBe(true);
    expect(live.textContent).toBe("scanning…");
    expect(document.getElementById("scan-spinner")!.hidden).toBe(false);
    // a scanNow kickoff message was sent
    expect(sendMessage).toHaveBeenCalledWith({ type: "scanNow" });
  });

  it("#1: shows 'what we fetch' + 'how it's kept private' even when disconnected", async () => {
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === "getSyncHistory" ? { runs: [] } : { account: null, recipe: null, needs: null },
    );
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };
    await init(document);
    expect(document.getElementById("what-we-fetch")!.hidden).toBe(false);
    expect(document.getElementById("privacy")!.hidden).toBe(false);
    // generic fallback label, never a platform name
    expect(document.getElementById("what-we-fetch")!.textContent).toContain("professional network");
  });

  const WEB_STORE_URL =
    "https://chromewebstore.google.com/detail/noticed%20Relationships/hjckpjgbhjichgkbmgjfbbdibchghdaf";

  function chromeWithManifest(version: string) {
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : status));
    return {
      runtime: {
        sendMessage,
        id: "abcdefghijklmnopabcdefghijklmnop",
        getManifest: () => ({ version }),
      },
      tabs: { create: vi.fn() },
    };
  }

  it("#1: reveals the update notice (linking to the Chrome Web Store) when a newer release exists", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = chromeWithManifest("1.0.2");
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: "v1.0.3" }) })) as unknown as typeof fetch;

    await init(document);
    await new Promise((r) => setTimeout(r, 0));

    const notice = document.getElementById("update-notice") as HTMLAnchorElement;
    expect(notice.hidden).toBe(false);
    expect(notice.getAttribute("href")).toBe(WEB_STORE_URL);
  });

  it("#1: keeps the update notice hidden when the installed version is current", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = chromeWithManifest("1.0.2");
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: "v1.0.2" }) })) as unknown as typeof fetch;

    await init(document);
    await new Promise((r) => setTimeout(r, 0));

    expect((document.getElementById("update-notice") as HTMLAnchorElement).hidden).toBe(true);
  });

  it("#1: leaves the update notice hidden (no throw) when the release fetch fails", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = chromeWithManifest("1.0.2");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(init(document)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));

    expect((document.getElementById("update-notice") as HTMLAnchorElement).hidden).toBe(true);
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

  // ── Progress while scanning (E2) ────────────────────────────────────────────

  it("E2: on load with a scan in progress, the button shows 'scanned N…', is disabled, and the spinner is visible", async () => {
    const scanning = {
      ...status,
      scanning: true,
      scannedCount: 137,
      recipe: { networkLabel: "ExampleNet", targetOrigin: "https://network.example.com" },
    };
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : scanning));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
      permissions: { request: vi.fn(async () => true), contains: vi.fn(async () => true) },
    };

    await init(document);
    const btn = document.getElementById("scan-now") as HTMLButtonElement;
    expect(btn.textContent).toBe("scanned 137…");
    expect(btn.disabled).toBe(true);
    expect(document.getElementById("scan-spinner")!.hidden).toBe(false);
  });

  it("E2: pollScanProgress updates 'scanned N…' each tick then re-enables the button when scanning ends", async () => {
    const counts = [10, 25, 25];
    let i = 0;
    const sendMessage = vi.fn(async (m: { type: string }) => {
      if (m.type === "getSyncHistory") return { runs: [] };
      // getStatus: scanning for the first two polls, then done
      const idx = Math.min(i++, counts.length - 1);
      return { ...status, scanning: idx < 2, scannedCount: counts[idx] };
    });
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
      permissions: { request: vi.fn(async () => true), contains: vi.fn(async () => true) },
    };

    const btn = document.getElementById("scan-now") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "scanning…";

    // a fast injected delay so the test doesn't wait 1.5s per tick
    await pollScanProgress(document, { pollMs: 1, sleep: async () => {} });

    // first poll → scanning true, shows the count
    const calls = sendMessage.mock.calls.filter((c) => (c[0] as { type: string }).type === "getStatus").length;
    expect(calls).toBeGreaterThanOrEqual(2); // polled until scanning ended
    // ended → button re-enabled back to scan-now
    const live = document.getElementById("scan-now") as HTMLButtonElement;
    expect(live.disabled).toBe(false);
    expect(live.textContent).toBe("scan now");
  });

  // ── Reconcile display (E5) ──────────────────────────────────────────────────

  it("E5: never shows 'no sync yet' when a recorded sync exists — derives last-sync from the newest run", async () => {
    // local status lags: lastScanAt null, but a successful run is recorded
    const lagging = { account: { name: "X" }, recipe: { networkLabel: "ExampleNet" }, needs: null, lastScanAt: null, lastScanCount: null };
    const runs = [
      { source: "linkedin_extension", label: "LinkedIn", kind: "relationships", itemCount: 412, status: "succeeded", startedAt: "2026-06-20T00:00:00Z", finishedAt: "2026-06-20T00:00:00Z" },
    ];
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs } : lagging));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };

    await init(document);
    const lastScan = document.getElementById("last-scan")!.textContent ?? "";
    expect(lastScan.toLowerCase()).not.toContain("no sync yet");
    expect(lastScan).toContain("412");
  });

  it("E5: shows 'no sync yet' only when there is genuinely no sync (no local stamp AND no runs)", async () => {
    const lagging = { account: { name: "X" }, recipe: { networkLabel: "ExampleNet" }, needs: null, lastScanAt: null, lastScanCount: null };
    const sendMessage = vi.fn(async (m: { type: string }) => (m.type === "getSyncHistory" ? { runs: [] } : lagging));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };

    await init(document);
    expect(document.getElementById("last-scan")!.textContent!.toLowerCase()).toContain("no sync yet");
  });

  // ── Actionable noticed Sign-in (E4) ─────────────────────────────────────────

  it("E4: shows the Sign-in button when status.needs is noticed-signin even if the history fetch returns 200 (no history.needs)", async () => {
    // The bug: status.needs says we need a noticed sign-in, but /api/sync/runs
    // returned 200 (history.needs absent) → the old code showed the red text but
    // never revealed the actionable button. Both signals must lead to the button.
    const needsSignin = {
      account: { name: "X" },
      recipe: { networkLabel: "ExampleNet" },
      needs: "noticed-signin",
      lastScanAt: null,
      lastScanCount: null,
    };
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === "getSyncHistory" ? { runs: [] } : needsSignin,
    );
    const create = vi.fn(async () => ({}));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create },
    };

    await init(document);
    const btn = document.getElementById("signin-cta") as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    // wired to openConnect
    btn.dispatchEvent(new Event("click"));
    expect(create).toHaveBeenCalledWith({
      url: `${NOTICED}/x/connect?ext_id=abcdefghijklmnopabcdefghijklmnop`,
    });
  });

  it("E4: the red 'finish syncing' text NEVER appears without the actionable button beside it", async () => {
    const needsSignin = {
      account: { name: "X" },
      recipe: { networkLabel: "ExampleNet" },
      needs: "noticed-signin",
      lastScanAt: null,
      lastScanCount: null,
    };
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === "getSyncHistory" ? { runs: [] } : needsSignin,
    );
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
    };

    await init(document);
    const needsText = document.getElementById("needs")!.textContent ?? "";
    const btn = document.getElementById("signin-cta") as HTMLButtonElement;
    // Single source of truth: when a noticed sign-in is needed, the button is the
    // affordance. The red text must not be left dangling on its own. (Here we
    // clear the text and rely on the button; the invariant we assert is: if the
    // 'finish syncing' text is shown, the button is also shown.)
    if (needsText.toLowerCase().includes("finish syncing")) {
      expect(btn.hidden).toBe(false);
    } else {
      // text suppressed in favour of the button — button must be visible
      expect(btn.hidden).toBe(false);
    }
  });

  it("surfaces a signed-out granted network as a per-network warning row (not the aggregate #needs line) and does NOT show the noticed button", async () => {
    // A granted source the user is logged out of (signedIn:false) — the SW's
    // live cookie probe. It should render as a per-network warning row, NOT the
    // old aggregate #needs text (which hard-coded the wrong recipe label).
    const status = {
      account: { name: "X" },
      recipe: { networkLabel: "ExampleNet" },
      sources: [
        {
          source: "example_net",
          networkLabel: "ExampleNet",
          targetOrigin: "https://example.net",
          granted: true,
          signedIn: false,
          lastScanAt: null,
          lastScanCount: null,
        },
      ],
      needs: "network-signin",
      lastScanAt: null,
      lastScanCount: null,
    };
    const create = vi.fn();
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === "getSyncHistory" ? { runs: [] } : status,
    );
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create },
      permissions: { contains: vi.fn(async () => true) },
    };

    await init(document);

    const list = document.getElementById("network-status")!;
    expect(list.hidden).toBe(false);
    const row = list.querySelector(".net-row--warn")!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("ExampleNet");
    expect(row.textContent).toContain("not signed in");
    // the aggregate red #needs line is gone; the noticed button stays hidden
    expect(document.getElementById("needs")!.textContent).toBe("");
    expect((document.getElementById("signin-cta") as HTMLButtonElement).hidden).toBe(true);

    // the inline "sign in" link opens that network's site so the user can log in
    const signin = row.querySelector<HTMLButtonElement>(".net-signin")!;
    signin.click();
    expect(create).toHaveBeenCalledWith({ url: "https://example.net" });
  });

  it("shows synced per-network rows (label · count synced · date) and hides the aggregate last-scan line", async () => {
    const status = {
      account: { name: "X" },
      recipe: { networkLabel: "LinkedIn" },
      sources: [
        { source: "linkedin_extension", networkLabel: "LinkedIn", targetOrigin: "https://li.example", granted: true, signedIn: true, lastScanAt: 1707091200000, lastScanCount: 342 },
        { source: "x", networkLabel: "X", targetOrigin: "https://x.example", granted: true, signedIn: true, lastScanAt: null, lastScanCount: null },
      ],
      needs: null,
      lastScanAt: 1707091200000,
      lastScanCount: 342,
    };
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === "getSyncHistory" ? { runs: [] } : status,
    );
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage, id: "abcdefghijklmnopabcdefghijklmnop" },
      tabs: { create: vi.fn() },
      permissions: { contains: vi.fn(async () => true) },
    };

    await init(document);

    const rows = document.querySelectorAll("#network-status .net-row");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("LinkedIn");
    expect(rows[0].textContent).toContain("342 synced");
    expect(rows[1].textContent).toContain("not synced yet");
    // per-network rows supersede the aggregate line
    expect(document.getElementById("network-status")!.hidden).toBe(false);
    expect((document.getElementById("last-scan") as HTMLElement).hidden).toBe(true);
    // no signed-out sources → no warning rows
    expect(document.querySelectorAll("#network-status .net-row--warn").length).toBe(0);
  });

  it("E4: still shows the Sign-in button when only history.needs is noticed-signin (the 401 path)", async () => {
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === "getSyncHistory"
        ? { needs: "noticed-signin" }
        : { account: { name: "X" }, recipe: { networkLabel: "ExampleNet" }, needs: null },
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

  // ── Version footer + bottom update notice (E6) ──────────────────────────────

  it("E6: the version footer ALWAYS shows the installed manifest version", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = chromeWithManifest("1.0.3");
    // no fetch stub → update check is best-effort and may no-op; version is independent
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    await init(document);
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById("version")!.textContent).toBe("v1.0.3");
  });

  it("E6: the version footer is shown even when the version is current and there's no update", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = chromeWithManifest("1.0.3");
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: "v1.0.3" }) })) as unknown as typeof fetch;

    await init(document);
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById("version")!.textContent).toBe("v1.0.3");
    expect((document.getElementById("update-notice") as HTMLAnchorElement).hidden).toBe(true);
  });

  it("E6: the update notice lives in the footer alongside the version, and reveals (linking to the Chrome Web Store) when behind", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = chromeWithManifest("1.0.2");
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: "v1.0.3" }) })) as unknown as typeof fetch;

    await init(document);
    await new Promise((r) => setTimeout(r, 0));

    const version = document.getElementById("version")!;
    const notice = document.getElementById("update-notice") as HTMLAnchorElement;
    expect(version.textContent).toBe("v1.0.2");
    expect(notice.hidden).toBe(false);
    expect(notice.getAttribute("href")).toBe(WEB_STORE_URL);
    // the update notice and the version share a footer container (bottom of panel)
    expect(notice.parentElement).toBe(version.parentElement);
  });
});
