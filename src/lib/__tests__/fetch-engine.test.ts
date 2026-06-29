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

  // ── Checkpoint + resume (E1/E3) ────────────────────────────────────────────

  it("invokes onPage after EACH page with the accumulated items and the next cursor", async () => {
    const pages = [
      { items: [{ id: "a" }, { id: "b" }], rawCount: 2 },
      { items: [{ id: "c" }, { id: "d" }], rawCount: 2 },
      { items: [{ id: "e" }], rawCount: 1 }, // short raw page → stop
    ];
    let i = 0;
    const fetchPage = vi.fn().mockImplementation(async () => pages[i++] ?? { items: [], rawCount: 0 });
    const onPage = vi.fn();
    const out = await scanConnections<{ id: string }>({
      fetchPage,
      pageSize: 2,
      maxPages: 60,
      sleep: async () => {},
      jitter: () => 0,
      onPage,
    });
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e"]);
    // a checkpoint after every page (3 pages), each carrying the running total
    // and the cursor for the NEXT page-fetch
    expect(onPage).toHaveBeenCalledTimes(3);
    expect(onPage).toHaveBeenNthCalledWith(1, [{ id: "a" }, { id: "b" }], 2);
    expect(onPage).toHaveBeenNthCalledWith(2, [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], 4);
    expect(onPage).toHaveBeenNthCalledWith(3, [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }], 6);
  });

  it("resumes from startAt + an initial accumulator without re-fetching earlier pages", async () => {
    // We already fetched start=0 and start=40 (80 items) before the worker died.
    // Resume must continue at start=80 and prepend the recovered items.
    const recovered = Array(80).fill(0).map((_, n) => ({ n }));
    const pages = [
      { items: [{ n: 80 }, { n: 81 }], rawCount: 40 }, // start=80 (still full → keep going)
      { items: [{ n: 82 }], rawCount: 1 }, // short → stop
    ];
    let i = 0;
    const fetchPage = vi.fn().mockImplementation(async () => pages[i++] ?? { items: [], rawCount: 0 });
    const out = await scanConnections<{ n: number }>({
      fetchPage,
      pageSize: 40,
      maxPages: 60,
      sleep: async () => {},
      jitter: () => 0,
      startAt: 80,
      initialItems: recovered,
    });
    // first resumed fetch hits start=80, not 0
    expect(fetchPage).toHaveBeenNthCalledWith(1, 80);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 120);
    // no lost/duplicated items: 80 recovered + 3 new
    expect(out.length).toBe(83);
    expect(out[0]).toEqual({ n: 0 });
    expect(out[80]).toEqual({ n: 80 });
    expect(out[82]).toEqual({ n: 82 });
  });

  it("checkpoints the cap-reached page too, so a resume sees the full accumulator", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [{ x: 1 }, { x: 1 }], rawCount: 40 });
    const onPage = vi.fn();
    await scanConnections({ fetchPage, pageSize: 40, maxPages: 2, sleep: async () => {}, jitter: () => 0, onPage });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // both pages checkpointed (including the last/cap-reached one)
    expect(onPage).toHaveBeenCalledTimes(2);
    // last checkpoint carries all 4 items
    expect(onPage.mock.calls[1][0].length).toBe(4);
  });

  it("follows opaque cursor tokens and stops when nextCursor is null (X)", async () => {
    const pages: Record<string, { items: { id: number }[]; rawCount: number; nextCursor: string | null }> = {
      "0": { items: [{ id: 1 }, { id: 2 }], rawCount: 2, nextCursor: "CURSOR_A" },
      CURSOR_A: { items: [{ id: 3 }, { id: 4 }], rawCount: 2, nextCursor: "CURSOR_B" },
      CURSOR_B: { items: [{ id: 5 }], rawCount: 1, nextCursor: null }, // end
    };
    const seen: (number | string)[] = [];
    const fetchPage = vi.fn(async (cursor: number | string) => {
      seen.push(cursor);
      return pages[String(cursor)]!;
    });
    const onPage = vi.fn();
    const out = await scanConnections({
      fetchPage,
      pageSize: 2,
      maxPages: 50,
      sleep: async () => {},
      jitter: () => 0,
      startAt: "0",
      onPage,
    });
    expect(seen).toEqual(["0", "CURSOR_A", "CURSOR_B"]);
    expect(out.map((o) => (o as { id: number }).id)).toEqual([1, 2, 3, 4, 5]);
    // checkpoints record the NEXT token to resume from. The last page ends
    // (nextCursor null) so the scan finalizes; its checkpoint cursor is moot and
    // falls back to the just-fetched token (consistent with the offset path,
    // which records start+pageSize even on the final page).
    expect(onPage.mock.calls.map((c) => c[1])).toEqual(["CURSOR_A", "CURSOR_B", "CURSOR_B"]);
  });

  it("stops on a null cursor even when the page was full (no over-fetch)", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ x: 1 }, { x: 1 }], rawCount: 2, nextCursor: null });
    const out = await scanConnections({
      fetchPage,
      pageSize: 2,
      maxPages: 50,
      sleep: async () => {},
      jitter: () => 0,
      startAt: "0",
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(out.length).toBe(2);
  });
});
