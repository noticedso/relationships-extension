import { describe, it, expect, vi } from "vitest";
import { buildCsrfHeaders } from "../cookies";
const recipe = { targetOrigin: "https://www.example.com", csrfRule: { header: "csrf-token", cookie: "JSESSIONID" } };

describe("buildCsrfHeaders", () => {
  it("reads the cookie at the target origin and strips wrapping quotes", async () => {
    (chrome.cookies.get as any) = vi.fn().mockResolvedValue({ value: '"ajax:123"' });
    const headers = await buildCsrfHeaders(recipe as any);
    expect(chrome.cookies.get).toHaveBeenCalledWith({ url: "https://www.example.com", name: "JSESSIONID" });
    expect(headers).toEqual({ "csrf-token": "ajax:123" });
  });

  it("leaves an unquoted value as-is", async () => {
    (chrome.cookies.get as any) = vi.fn().mockResolvedValue({ value: "plain" });
    expect(await buildCsrfHeaders(recipe as any)).toEqual({ "csrf-token": "plain" });
  });

  it("returns null when the cookie is absent", async () => {
    (chrome.cookies.get as any) = vi.fn().mockResolvedValue(null);
    expect(await buildCsrfHeaders(recipe as any)).toBeNull();
  });

  it("returns null when the cookie has an empty value", async () => {
    (chrome.cookies.get as any) = vi.fn().mockResolvedValue({ value: "" });
    expect(await buildCsrfHeaders(recipe as any)).toBeNull();
  });
});
