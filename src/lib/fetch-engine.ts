/**
 * Pure pagination loop with all I/O injected so it is fully unit-testable
 * (no chrome/fetch/timers). Walks a paged list as the logged-in user, paced
 * with injected jittered delays and capped at `maxPages`.
 *
 * Resumable: pass `startAt` + `initialItems` to continue a scan that was
 * interrupted (the MV3 service worker can be torn down mid-scan), and an
 * `onPage(items, nextStart)` callback that fires after EACH page so the caller
 * can checkpoint progress to durable storage between pages. The function itself
 * stays pure — persistence is the injected callback's job.
 */
/** A page cursor: a numeric offset (default) OR an opaque token string (X). */
export type PageCursor = number | string;

export async function scanConnections<T>(opts: {
  // rawCount = raw elements on the page, before mapping/filtering. `nextCursor`
  // is OPTIONAL: cursor-paginated sources (X) return the next token here (or
  // `null` to signal the end); offset sources omit it and the loop advances by
  // pageSize. This keeps the offset path byte-identical to the original.
  fetchPage: (
    cursor: PageCursor,
  ) => Promise<{ items: T[]; rawCount: number; nextCursor?: PageCursor | null }>;
  pageSize: number; // expected full-page length
  maxPages: number; // hard cap on pages fetched THIS session/run
  sleep: (ms: number) => Promise<void>; // injected delay
  jitter: () => number; // injected ms-to-sleep generator
  /** Cursor to resume from (offset, or opaque token). Default 0. */
  startAt?: PageCursor;
  /** Items already accumulated from earlier pages (resume). Default []. */
  initialItems?: T[];
  /**
   * Checkpoint hook fired after EACH fetched page, with the full running
   * accumulator and the cursor for the NEXT page-fetch. Lets the caller persist
   * progress so an interrupted scan can resume without lost/duplicated items.
   */
  onPage?: (items: T[], nextCursor: PageCursor) => void | Promise<void>;
}): Promise<T[]> {
  const { fetchPage, pageSize, maxPages, sleep, jitter, onPage } = opts;
  const all: T[] = opts.initialItems ? [...opts.initialItems] : [];
  let cursor: PageCursor = opts.startAt ?? 0;
  for (let page = 0; page < maxPages; page++) {
    const { items, rawCount, nextCursor } = await fetchPage(cursor);
    all.push(...items);
    // Advance: an explicit nextCursor wins; otherwise numeric offset + pageSize.
    const advanced: PageCursor =
      nextCursor !== undefined && nextCursor !== null
        ? nextCursor
        : typeof cursor === "number"
          ? cursor + pageSize
          : cursor;
    // Checkpoint AFTER every page (including the cap-reached/last one) so a
    // resume always sees the complete accumulator. Hand the callback a fresh
    // snapshot so it (or an async storage write) can't observe later mutations
    // of our running accumulator.
    if (onPage) await onPage([...all], advanced);
    // End of list: a short page, OR a cursor source signalling no more (null).
    const lastPage = rawCount < pageSize || nextCursor === null;
    const capReached = page + 1 >= maxPages;
    if (lastPage || capReached) break;
    await sleep(jitter());
    cursor = advanced;
  }
  return all;
}
