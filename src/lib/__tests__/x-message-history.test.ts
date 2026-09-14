import { describe, it, expect } from "vitest";
import { scanXMessageHistory, type XHistoryCheckpoint } from "../x-message-history";
import { chatEvent } from "./fixtures/x-chat";

const config = {
  initialPath: "/initial", inboxPath: "/inbox", requestsPath: "/requests", conversationPath: "/conversation",
  legacyInitialPath: "/legacy", legacyInboxPath: "/legacy/{timeline}", legacyConversationPath: "/legacy/conversation/{conversation}",
};
const end = { __typename: "XChatGetInboxPageEndCursor", pull_finished: true };
const requestEnd = { __typename: "XChatGetMessageRequestsPageEndCursor", pull_finished: true };
const item = (id: string, events: string[], more = false) => ({
  conversation_detail: { conversation_id: id }, latest_message_events: events,
  latest_conversation_key_change_events: [], has_more: more, is_deleted_by_viewer: false,
});
const legacyEnd = { inbox_initial_state: { entries: [], conversations: {}, inbox_timelines: {
  trusted: { status: "AT_END" }, untrusted: { status: "AT_END" },
} } };
const requests = { data: { get_message_requests_page: { message_request_items: [], cursor: requestEnd } } };

function transport(pages: Record<string, unknown | ((url: URL) => unknown)>, seen: string[] = []) {
  return async (path: string) => {
    const url = new URL(path, "https://x.com");
    seen.push(path);
    const page = pages[url.pathname];
    if (!page) throw new Error(`Unexpected request ${url.pathname}`);
    return typeof page === "function" ? page(url) : page;
  };
}
const base = { config, ownerId: "10", maxPages: 20, sleep: async () => {}, jitter: () => 0 };

describe("complete X DM history", () => {
  it("follows a short current inbox page, retains every message and resumes at its checkpoint", async () => {
    const pages = {
      "/initial": { data: { get_initial_chat_page: { items: [item("10:20", [chatEvent()], true)],
        inboxCursor: { __typename: "XChatGetInboxPageContinueCursor", cursor_id: "next", graph_snapshot_id: "snapshot" } } } },
      "/inbox": { data: { get_inbox_page: { items: [item("10:30", [chatEvent({ conversation: "10:30", sequence: "300" })])], inboxCursor: end } } },
      "/requests": requests,
      "/legacy": legacyEnd,
      "/conversation": (url: URL) => {
        const vars = JSON.parse(url.searchParams.get("variables")!);
        expect(vars.min_local_sequence_id).toBe("100");
        return { data: { get_conversation_page: { encoded_message_events: [chatEvent({ sequence: "99", sender: "20", time: "1787218320000" })], has_more: false } } };
      },
    };
    let checkpoint: XHistoryCheckpoint | undefined;
    const firstSeen: string[] = [];
    const first = await scanXMessageHistory({ ...base, maxPages: 1, fetchJson: transport(pages, firstSeen), onPage: async (c) => { checkpoint = c; } });
    expect(first.complete).toBe(false);
    expect(checkpoint).toBeDefined();
    const seen: string[] = [];
    const result = await scanXMessageHistory({ ...base, checkpoint, fetchJson: transport(pages, seen) });
    expect(seen.some((url) => url.startsWith("/initial?"))).toBe(false);
    expect(seen.some((url) => url.startsWith("/inbox?"))).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.messages).toHaveLength(3);
    expect(result.messages.filter((m) => m.counterpartProfileUrl === "20").map((m) => m.had_reply)).toEqual([true, true]);
    expect(JSON.stringify(checkpoint)).not.toContain("private-");
  });

  it("fetches legacy trusted and untrusted history and older conversation pages", async () => {
    const event = (id: string, sender: string, time: string) => ({ message: {
      id, conversation_id: "10-40", message_data: { sender_id: sender, recipient_id: sender === "10" ? "40" : "10", time },
    } });
    const pages = {
      "/initial": { data: { get_initial_chat_page: { items: [], inboxCursor: end } } },
      "/requests": requests,
      "/legacy": { inbox_initial_state: { entries: [], conversations: {}, inbox_timelines: {
        trusted: { status: "HAS_MORE", min_entry_id: "200" }, untrusted: { status: "HAS_MORE", min_entry_id: "300" },
      } } },
      "/legacy/trusted": { inbox_timeline: { status: "AT_END", entries: [event("100", "10", "1787304720000")], conversations: { "10-40": { type: "ONE_TO_ONE" } } } },
      "/legacy/untrusted": { inbox_timeline: { status: "AT_END", entries: [], conversations: {} } },
      "/legacy/conversation/10-40": (url: URL) => ({ conversation_timeline: url.searchParams.has("max_id")
        ? { status: "AT_END", entries: [event("99", "40", "1787218320000")] }
        : { status: "HAS_MORE", min_entry_id: "100", entries: [event("100", "10", "1787304720000")] } }),
    };
    const seen: string[] = [];
    const result = await scanXMessageHistory({ ...base, fetchJson: transport(pages, seen) });
    expect(result.complete).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.messages.every((m) => m.had_reply)).toBe(true);
    expect(seen.some((s) => s.includes("/legacy/untrusted?max_id=300"))).toBe(true);
  });

  it("includes message requests but excludes groups, self conversations, deleted conversations and non-message events", async () => {
    const pages = {
      "/initial": { data: { get_initial_chat_page: { inboxCursor: end, items: [
        item("10:10", [chatEvent({ conversation: "10:10" })]),
        item("group", [chatEvent({ conversation: "group" })]),
        { ...item("10:20", [chatEvent()]), is_deleted_by_viewer: true },
        item("10:40", [chatEvent({ conversation: "10:40", kind: 12 })]),
      ] } } },
      "/requests": { data: { get_message_requests_page: { cursor: requestEnd, message_request_items: [{ conversation_id: "10:30", latest_message_events: [chatEvent({ conversation: "10:30", sender: "30" })] }] } } },
      "/conversation": { data: { get_conversation_page: { encoded_message_events: [], has_more: false } } },
      "/legacy": legacyEnd,
    };
    const result = await scanXMessageHistory({ ...base, fetchJson: transport(pages) });
    expect(result.messages).toEqual([{ counterpartProfileUrl: "30", lastMessageAt: "2026-08-21T09:32:00.000Z", direction: "received", had_reply: false }]);
  });

  it.each([
    { errors: [{ message: "failed" }], data: null },
    { data: { get_initial_chat_page: { items: [], inboxCursor: {} } } },
  ])("fails without claiming completion on API errors or unrecognized cursors", async (page) => {
    await expect(scanXMessageHistory({ ...base, fetchJson: async () => page })).rejects.toThrow();
  });

  it("rejects cross-account checkpoints", async () => {
    let checkpoint: XHistoryCheckpoint | undefined;
    await scanXMessageHistory({ ...base, maxPages: 1, fetchJson: transport({ "/initial": { data: { get_initial_chat_page: { items: [], inboxCursor: end } } } }), onPage: async (c) => { checkpoint = c; } });
    await expect(scanXMessageHistory({ ...base, ownerId: "99", checkpoint, fetchJson: async () => ({}) })).rejects.toThrow("x_history_account_changed");
  });
});

it("accepts the live inbox end cursor, which has a snapshot id and no pull_finished field", async () => {
  const result = await scanXMessageHistory({ ...base, fetchJson: transport({
    "/initial": { data: { get_initial_chat_page: { items: [], inboxCursor: { __typename: "XChatGetInboxPageEndCursor", graph_snapshot_id: "snapshot" } } } },
    "/requests": requests, "/legacy": legacyEnd,
  }) });
  expect(result.complete).toBe(true);
});
