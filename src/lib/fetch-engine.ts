/**
 * Pure pagination loop with all I/O injected so it is fully unit-testable
 * (no chrome/fetch/timers). Walks a paged list as the logged-in user, paced
 * with injected jittered delays and capped at `maxPages`.
 */
export async function scanConnections<T>(opts: {
  fetchPage: (start: number) => Promise<T[]>; // returns one page of items
  pageSize: number; // expected full-page length
  maxPages: number; // hard cap on pages fetched
  sleep: (ms: number) => Promise<void>; // injected delay
  jitter: () => number; // injected ms-to-sleep generator
}): Promise<T[]> {
  const { fetchPage, pageSize, maxPages, sleep, jitter } = opts;
  const all: T[] = [];
  let start = 0;
  for (let page = 0; page < maxPages; page++) {
    const items = await fetchPage(start);
    all.push(...items);
    const lastPage = items.length < pageSize;
    const capReached = page + 1 >= maxPages;
    if (lastPage || capReached) break;
    await sleep(jitter());
    start += pageSize;
  }
  return all;
}
