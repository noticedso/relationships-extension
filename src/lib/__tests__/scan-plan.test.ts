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
    expect(out.count).toBe(2); // 1 mutual + 1 message
  });
});
