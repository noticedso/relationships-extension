import { describe, expect, it, vi } from "vitest";
import type { ChromeMock } from "../../test/mocks/chrome";
import * as sw from "../service-worker";

function getChrome(): ChromeMock {
  return (globalThis as unknown as { chrome: ChromeMock }).chrome;
}

const SOURCE_ORIGINS = ["*://*.linkedin.com/*", "*://*.x.com/*", "*://*.twitter.com/*"];

/** Lets the click handler's promise chain finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("toolbar button", () => {
  it("asks for any withheld site access, then opens the connection page", async () => {
    const chrome = getChrome();
    const request = vi.spyOn(chrome.permissions, "request");
    const create = vi.spyOn(chrome.tabs, "create");
    sw.registerListeners();
    chrome.action.onClicked.dispatch({ id: 9 });
    await settle();
    expect(request).toHaveBeenCalledWith({ origins: SOURCE_ORIGINS });
    expect(create).toHaveBeenCalledWith({ url: "https://www.noticed.so/connect" });
  });

  it("focuses a connection page that is already open instead of opening another", async () => {
    const chrome = getChrome();
    vi.spyOn(chrome.tabs, "query").mockResolvedValue([
      { id: 4, windowId: 2, url: "https://www.noticed.so/connect?preview=ready" },
    ]);
    const update = vi.spyOn(chrome.tabs, "update");
    const focus = vi.spyOn(chrome.windows, "update");
    const create = vi.spyOn(chrome.tabs, "create");
    sw.registerListeners();
    chrome.action.onClicked.dispatch({ id: 9 });
    await settle();
    expect(update).toHaveBeenCalledWith(4, { active: true });
    expect(focus).toHaveBeenCalledWith(2, { focused: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("opens the noticed origin the extension was paired from, never another site", async () => {
    const chrome = getChrome();
    const create = vi.spyOn(chrome.tabs, "create");
    sw.registerListeners();
    await chrome.storage.local.set({ noticedOrigin: "https://app.noticed.so" });
    chrome.action.onClicked.dispatch({ id: 9 });
    await settle();
    expect(create).toHaveBeenLastCalledWith({ url: "https://app.noticed.so/connect" });

    await chrome.storage.local.set({ noticedOrigin: "https://evil.example" });
    chrome.action.onClicked.dispatch({ id: 9 });
    await settle();
    expect(create).toHaveBeenLastCalledWith({ url: "https://www.noticed.so/connect" });
  });

  it("asks for access synchronously in the click, before anything else can end the gesture", () => {
    const chrome = getChrome();
    const request = vi.spyOn(chrome.permissions, "request");
    sw.registerListeners();
    chrome.action.onClicked.dispatch({ id: 9 });
    // No await: Chrome only honours permissions.request during the click's gesture.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("still opens the page when the access prompt is dismissed", async () => {
    const chrome = getChrome();
    vi.spyOn(chrome.permissions, "request").mockRejectedValue(new Error("dismissed"));
    const create = vi.spyOn(chrome.tabs, "create");
    sw.registerListeners();
    chrome.action.onClicked.dispatch({ id: 9 });
    await settle();
    expect(create).toHaveBeenCalledWith({ url: "https://www.noticed.so/connect" });
  });
});

