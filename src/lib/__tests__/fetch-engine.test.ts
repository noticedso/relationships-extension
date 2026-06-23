import { describe, it, expect, vi } from "vitest";
import { scanConnections } from "../fetch-engine";

describe("scanConnections", () => {
  const page = (n: number) => ({ items: Array(n).fill(0), rawCount: n });

  it("paginates until a short page, sleeping between pages with jittered ms", async () => {
    const pages = [page(40), page(40), page(5)];
    let i = 0;
    const fetchPage = vi.fn().mockImplementation(async () => pages[i++] ?? page(0));
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
    const fetchPage = vi.fn().mockResolvedValue(page(40));
    const out = await scanConnections({ fetchPage, pageSize: 40, maxPages: 2, sleep: async () => {}, jitter: () => 0 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(out.length).toBe(80);
  });

  it("handles an empty first page", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page(0));
    const out = await scanConnections({ fetchPage, pageSize: 40, maxPages: 60, sleep: async () => {}, jitter: () => 0 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
  });

  it("does NOT stop on a full raw page whose mapped items were dropped (rawCount drives the stop)", async () => {
    // Page 1: full raw page (40) but only 3 mapped items survived (dropped
    // elements without a profileUrl). The OLD code stopped here (3 < 40);
    // the fix keeps going because rawCount === pageSize.
    const pages = [
      { items: Array(3).fill(0), rawCount: 40 },
      { items: Array(40).fill(0), rawCount: 40 },
      { items: Array(2).fill(0), rawCount: 2 }, // short raw page → stop
    ];
    let i = 0;
    const fetchPage = vi.fn().mockImplementation(async () => pages[i++] ?? { items: [], rawCount: 0 });
    const out = await scanConnections({ fetchPage, pageSize: 40, maxPages: 60, sleep: async () => {}, jitter: () => 0 });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(out.length).toBe(45);
  });
});
