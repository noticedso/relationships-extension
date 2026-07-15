/**
 * Pure scan-planning helpers (NT-44/NT-45). Keep the source-shaped logic —
 * which lists to scan, how to intersect them, and what payload to POST — as
 * pure functions so the service-worker stays a thin orchestrator and the tricky
 * parts (X mutual-follow intersection, per-source payload shape) are unit-tested.
 */
import type { ScanConnection, ScanMessage } from "./recipe";
import type { XTweetEdgeRow } from "./message-extract";
import type { ScanRecipe } from "./storage";

/**
 * Best-effort side-pass outputs threaded into the final payload (NT-63):
 * the owner's own profile JSON (LinkedIn) and the owner's tweet edge rows (X).
 * Both are optional — a failed side-pass never blocks the connections import.
 */
export type ScanExtras = {
  ownerProfile?: Record<string, unknown>;
  tweetEdges?: XTweetEdgeRow[];
};

/** One step of a scan: a connection list to walk, or the messages pass. */
export type Phase =
  | { kind: "connections"; listPathTemplate: string; cursorPath?: string }
  | { kind: "messages" };

/**
 * The ordered phases for a recipe: each connection list (one for LinkedIn, two
 * to intersect for X) then the optional messages pass.
 */
export function planPhases(recipe: ScanRecipe): Phase[] {
  const lists =
    recipe.connectionLists && recipe.connectionLists.length > 0
      ? recipe.connectionLists
      : [{ listPathTemplate: recipe.listPathTemplate, cursorPath: recipe.cursorPath }];
  const phases: Phase[] = lists.map((l) => ({
    kind: "connections",
    listPathTemplate: l.listPathTemplate,
    cursorPath: l.cursorPath,
  }));
  if (recipe.messages) phases.push({ kind: "messages" });
  return phases;
}

/** The identity key for intersection: the stable external id, else the handle. */
function connKey(c: ScanConnection): string {
  return (c.externalId ?? c.profileUrl ?? "").toString();
}

/**
 * Mutual follows = the connections present in EVERY list (followers ∩
 * following). Returns the matching rows from the FIRST list (richest record).
 */
export function intersectConnections(lists: ScanConnection[][]): ScanConnection[] {
  if (lists.length === 0) return [];
  if (lists.length === 1) return lists[0]!;
  const keySets = lists.map((l) => new Set(l.map(connKey)));
  const seen = new Set<string>();
  const out: ScanConnection[] = [];
  for (const c of lists[0]!) {
    const k = connKey(c);
    if (k === "" || seen.has(k)) continue;
    if (keySets.every((s) => s.has(k))) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/**
 * Build the exact first-party POST body for a finished scan. LinkedIn posts
 * `{ source, connections, messages }`; X intersects to mutual follows and posts
 * `{ source, mutuals, messages, ownerAccountId }` (account-id keyed). The broker
 * just posts `payload` to `ingestPath`.
 */
export function assembleScanPayload(
  recipe: ScanRecipe,
  connLists: ScanConnection[][],
  messages: ScanMessage[],
  selfId: string,
  extras: ScanExtras = {},
): { ingestPath: string; payload: Record<string, unknown>; count: number } {
  const connections =
    recipe.intersectConnections && connLists.length >= 2
      ? intersectConnections(connLists)
      : (connLists[0] ?? []);
  const source = recipe.source ?? "linkedin_extension";
  const ingestPath = recipe.ingestPath ?? "/api/linkedin/import/extension";

  if (source === "x") {
    const mutuals = connections.map((c) => ({
      accountId: (c.externalId ?? c.profileUrl) ?? "",
      handle: c.profileUrl,
    }));
    // NT-107 — `had_reply` must survive the X re-map: `false` (an unreplied DM)
    // is the whole point of the change, so dropping the key here would silently
    // un-do it. Spread it only when the extractor produced a verdict — ABSENT is
    // the wire signal the server reads as "unknown / legacy, score as today".
    const msgs = messages.map((m) => ({
      counterpartAccountId: m.counterpartProfileUrl,
      lastMessageAt: m.lastMessageAt,
      direction: m.direction,
      ...(m.had_reply !== undefined ? { had_reply: m.had_reply } : {}),
    }));
    // Owner-tweet mention/reply edges (NT-63) ride along as `mentions` — the
    // server maps them into interaction signal. Always present (empty by default)
    // so the ingest shape is stable.
    const mentions = extras.tweetEdges ?? [];
    return {
      ingestPath,
      payload: { source, mutuals, messages: msgs, mentions, ownerAccountId: selfId },
      count: mutuals.length + msgs.length,
    };
  }

  // Owner-profile raw JSON (NT-63) rides along only when the pass produced it,
  // so the LinkedIn ingest shape is unchanged when the recipe has no ownerProfile.
  return {
    ingestPath,
    payload: {
      source,
      connections,
      messages,
      ...(extras.ownerProfile !== undefined ? { ownerProfile: extras.ownerProfile } : {}),
    },
    count: connections.length,
  };
}
