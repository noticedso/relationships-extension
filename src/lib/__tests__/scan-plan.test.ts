import { describe, it, expect } from "vitest";
import { planPhases, intersectConnections, assembleScanPayload } from "../scan-plan";
import type { ScanRecipe } from "../storage";
import type { ScanConnection } from "../recipe";

const conn = (profileUrl: string, externalId?: string): ScanConnection => ({
  profileUrl,
  externalId: externalId ?? null,
  firstName: null,
  lastName: null,
  headline: null,
  connectedOn: null,
  pictureUrl: null,
});

const liRecipe = {
  source: "linkedin_extension",
  ingestPath: "/api/linkedin/import/extension",
  targetOrigin: "https://www.linkedin.com",
  listPathTemplate: "/conns?start={start}",
  paginationParams: { pageSize: 40 },
  pacing: { maxPagesPerSession: 250, minDelayMs: 0, maxDelayMs: 0 },
  csrfRule: { header: "csrf-token", cookie: "JSESSIONID" },
  fieldMap: { elementsPath: "elements", firstName: "f", lastName: "l", profileUrl: "p", headline: "h" },
  messages: {
    listPathTemplate: "/msgs",
    pageSize: 20,
    messageFieldMap: { elementsPath: "e", counterpartIdPath: "c", lastMessageAtPath: "t", lastSenderIdPath: "s" },
  },
} as ScanRecipe;

const xRecipe = {
  source: "x",
  ingestPath: "/api/x/import/extension",
  targetOrigin: "https://x.com",
  listPathTemplate: "/friends?cursor={cursor}",
  paginationParams: { pageSize: 200 },
  cursorPath: "next_cursor_str",
  pacing: { maxPagesPerSession: 100, minDelayMs: 0, maxDelayMs: 0 },
  csrfRule: { header: "x-csrf-token", cookie: "ct0" },
  fieldMap: { elementsPath: "users", firstName: "name", lastName: "", profileUrl: "screen_name", headline: "d", externalId: "id_str" },
  connectionLists: [
    { listPathTemplate: "/friends?cursor={cursor}", cursorPath: "next_cursor_str" },
    { listPathTemplate: "/followers?cursor={cursor}", cursorPath: "next_cursor_str" },
  ],
  intersectConnections: true,
  messages: {
    listPathTemplate: "/dm",
    pageSize: 50,
    selfIdPath: "user_id",
    excludeUnreplied: true,
    messageFieldMap: { elementsPath: "convos", counterpartIdPath: "cid", lastMessageAtPath: "t", lastSenderIdPath: "s", participantIdsPath: "ids" },
  },
} as ScanRecipe;

describe("planPhases", () => {
  it("LinkedIn: single connection list then messages", () => {
    const phases = planPhases(liRecipe);
    expect(phases.map((p) => p.kind)).toEqual(["connections", "messages"]);
    expect(phases[0]).toMatchObject({ kind: "connections", listPathTemplate: "/conns?start={start}" });
  });

  it("X: two follow lists (to intersect) then messages", () => {
    const phases = planPhases(xRecipe);
    expect(phases.map((p) => p.kind)).toEqual(["connections", "connections", "messages"]);
    expect(phases[0]).toMatchObject({ listPathTemplate: "/friends?cursor={cursor}" });
    expect(phases[1]).toMatchObject({ listPathTemplate: "/followers?cursor={cursor}" });
  });

  it("omits the messages phase when the recipe has none", () => {
    const r = { ...liRecipe, messages: undefined } as ScanRecipe;
    expect(planPhases(r).map((p) => p.kind)).toEqual(["connections"]);
  });
});

describe("intersectConnections", () => {
  it("keeps only ids present in ALL lists, keyed by externalId", () => {
    const following = [conn("alice", "1"), conn("bob", "2"), conn("carol", "3")];
    const followers = [conn("bob", "2"), conn("carol", "3"), conn("dave", "4")];
    const mutual = intersectConnections([following, followers]);
    expect(mutual.map((c) => c.externalId).sort()).toEqual(["2", "3"]);
  });

  it("falls back to profileUrl when there is no externalId (LinkedIn-shaped)", () => {
    const a = [conn("x"), conn("y")];
    const b = [conn("y"), conn("z")];
    expect(intersectConnections([a, b]).map((c) => c.profileUrl)).toEqual(["y"]);
  });
});

describe("assembleScanPayload", () => {
  it("LinkedIn: { source, connections, messages } posted to the LinkedIn ingest path", () => {
    const conns = [conn("janedoe")];
    const msgs = [{ counterpartProfileUrl: "https://www.linkedin.com/in/janedoe", lastMessageAt: "2026-06-20T10:30:00.000Z", direction: "sent" as const }];
    const out = assembleScanPayload(liRecipe, [conns], msgs, "self-li");
    expect(out.ingestPath).toBe("/api/linkedin/import/extension");
    expect(out.payload).toEqual({ source: "linkedin_extension", connections: conns, messages: msgs });
    expect(out.count).toBe(1);
  });

  it("LinkedIn: threads the per-conversation had_reply flag through unchanged (NT-99 follow-up)", () => {
    const conns = [conn("janedoe")];
    const msgs = [
      { counterpartProfileUrl: "https://www.linkedin.com/in/jane", lastMessageAt: "2026-06-20T10:30:00.000Z", direction: "sent" as const, had_reply: true },
      { counterpartProfileUrl: "https://www.linkedin.com/in/bob", lastMessageAt: "2026-06-20T10:30:00.000Z", direction: "sent" as const, had_reply: false },
      { counterpartProfileUrl: "https://www.linkedin.com/in/carol", lastMessageAt: "2026-06-20T10:30:00.000Z", direction: "received" as const },
    ];
    const out = assembleScanPayload(liRecipe, [conns], msgs, "self-li");
    expect(out.payload.messages).toEqual(msgs);
  });

  it("X: intersects mutuals + maps to {mutuals, messages, ownerAccountId}", () => {
    const following = [conn("alice", "1"), conn("bob", "2")];
    const followers = [conn("bob", "2"), conn("dave", "4")];
    const msgs = [{ counterpartProfileUrl: "2", lastMessageAt: "2026-06-20T10:30:00.000Z", direction: "received" as const }];
    const out = assembleScanPayload(xRecipe, [following, followers], msgs, "owner-99");
    expect(out.ingestPath).toBe("/api/x/import/extension");
    expect(out.payload.source).toBe("x");
    expect(out.payload.ownerAccountId).toBe("owner-99");
    expect(out.payload.mutuals).toEqual([{ accountId: "2", handle: "bob" }]);
    expect(out.payload.messages).toEqual([{ counterpartAccountId: "2", lastMessageAt: "2026-06-20T10:30:00.000Z", direction: "received" }]);
    // mentions is always present (empty by default) so the X ingest shape is stable
    expect(out.payload.mentions).toEqual([]);
    expect(out.count).toBe(2); // 1 mutual + 1 message
  });

  // ── NT-63 side-pass extras (owner profile + tweet edges) ──────────────────────

  it("LinkedIn: threads ownerProfile raw JSON through when provided, omits the key otherwise", () => {
    const conns = [conn("janedoe")];
    const owner = { profileView: { profile: { firstName: "Jane" } } };
    const withOwner = assembleScanPayload(liRecipe, [conns], [], "self-li", { ownerProfile: owner });
    expect(withOwner.payload.ownerProfile).toEqual(owner);
    // no extras → the LinkedIn payload shape is unchanged (no ownerProfile key)
    const without = assembleScanPayload(liRecipe, [conns], [], "self-li");
    expect("ownerProfile" in without.payload).toBe(false);
  });

  it("X: includes owner tweet edges as `mentions`, without inflating the count", () => {
    const following = [conn("alice", "1"), conn("bob", "2")];
    const followers = [conn("bob", "2"), conn("dave", "4")];
    const edges = [
      { tweetId: "20", createdAt: "2026-06-20T10:30:00.000Z", isReply: false, mentionedUserId: "77", mentionedScreenName: "kate", mentionedName: "Kate" },
    ];
    const out = assembleScanPayload(xRecipe, [following, followers], [], "owner-99", { tweetEdges: edges });
    expect(out.payload.mentions).toEqual(edges);
    // mentions are supplementary edges — the "synced" count stays connections+messages
    expect(out.count).toBe(1); // 1 mutual (bob), 0 messages
  });
});
