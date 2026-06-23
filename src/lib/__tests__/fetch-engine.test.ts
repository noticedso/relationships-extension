import { describe, it, expect, vi } from "vitest";
import { scanConnections } from "../fetch-engine";

describe("scanConnections", () => {
  it("paginates until a short page, sleeping between pages with jittered ms", async () => {
    const pages = [Array(40).fill(0), Array(40).fill(0), Array(5).fill(0)];
    let i = 0;
    const fetchPage = vi.fn().mockImplementation(async () => pages[i++] ?? []);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await scanConnections({ fetchPage, pageSize: 40, maxPages: 60, sleep, jitter: () => 1000 });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(out.length).toBe(85);
    expect(sleep).toHaveBeenCalledTimes(2); // between the 3 pages, not after the last
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 40);
    expect(fetchPage).toHaveBeenNthCalledWith(3, 80);
  });

  it("stops at the page cap even if full pages keep coming", async () => {
    const fetchPage = vi.fn().mockResolvedValue(Array(40).fill(0));
    const out = await scanConnections({ fetchPage, pageSize: 40, maxPages: 2, sleep: async () => {}, jitter: () => 0 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(out.length).toBe(80);
  });

  it("handles an empty first page", async () => {
    const fetchPage = vi.fn().mockResolvedValue([]);
    const out = await scanConnections({ fetchPage, pageSize: 40, maxPages: 60, sleep: async () => {}, jitter: () => 0 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
  });
});
