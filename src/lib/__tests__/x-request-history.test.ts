import assert from "node:assert/strict";
import { it as test } from "vitest";
import { assembleScanPayload } from "../scan-plan";
import type { ScanRecipe } from "../storage";
import { scanXMessageHistory } from "../x-message-history";

function thriftString(id: number, value: string) {
  const data = Buffer.from(value);
  const header = Buffer.alloc(7);
  header[0] = 11;
  header.writeInt16BE(id, 1);
  header.writeInt32BE(data.length, 3);
  return Buffer.concat([header, data]);
}

function event(sequence: string, messageId: string, time: string, conversation = "10:20") {
  return Buffer.concat([
    thriftString(1, sequence),
    thriftString(2, messageId),
    thriftString(3, conversation.split(":")[1]!),
    thriftString(4, conversation),
    thriftString(6, time),
    Buffer.from([12, 0, 7, 12, 0, 1, 0, 0, 0]),
  ]).toString("base64");
}

const config = {
  initialPath: "/initial", inboxPath: "/inbox", requestsPath: "/requests", conversationPath: "/conversation",
  legacyInitialPath: "/legacy", legacyInboxPath: "/legacy/{timeline}", legacyConversationPath: "/legacy/conversation/{conversation}",
};

test("retains request status on every message from the request thread across pages", async () => {
  const messages = {
    "/initial": { data: { get_initial_chat_page: { items: [
      { conversation_detail: { conversation_id: "10:30" }, latest_message_events: [event("300", "inbox", "1787304720000", "10:30")], has_more: false },
    ], inboxCursor: { __typename: "XChatGetInboxPageEndCursor" } } } },
    "/requests": { data: { get_message_requests_page: {
      message_request_items: [{ conversation_id: "10:20", encoded_message_create_event: event("200", "request", "1787304720459") }],
      cursor: { __typename: "XChatGetMessageRequestsPageEndCursor", pull_finished: true },
    } } },
    "/legacy": { inbox_initial_state: { inbox_timelines: {
      trusted: { status: "AT_END" }, untrusted: { status: "AT_END" },
    } } },
    "/conversation": { data: { get_conversation_page: {
      encoded_message_events: [event("100", "older", "1787304000000")], has_more: false,
    } } },
  };
  const result = await scanXMessageHistory({
    config, ownerId: "10", maxPages: 20, sleep: async () => {}, jitter: () => 0,
    fetchJson: async (path) => messages[new URL(path, "https://x.com").pathname as keyof typeof messages],
  });
  const wire = assembleScanPayload({ source: "x" } as ScanRecipe, [], result.messages, "10").payload.messages;
  assert.ok(Array.isArray(wire));
  assert.deepEqual(wire.map(({ messageId, request_status, had_reply }) => ({ messageId, request_status, had_reply })), [
    { messageId: "inbox", request_status: "inbox", had_reply: false },
    { messageId: "request", request_status: "pending", had_reply: false },
    { messageId: "older", request_status: "pending", had_reply: false },
  ]);
});

test("keeps the precise timestamp when Chat and legacy share a message sequence", async () => {
  const pages = {
    "/initial": { data: { get_initial_chat_page: { items: [{
      conversation_detail: { conversation_id: "10:20" },
      latest_message_events: [event("200", "chat-id", "1787304720459"), event("201", "distinct", "1787304720799")],
      has_more: false,
    }], inboxCursor: { __typename: "XChatGetInboxPageEndCursor" } } } },
    "/requests": { data: { get_message_requests_page: {
      message_request_items: [],
      cursor: { __typename: "XChatGetMessageRequestsPageEndCursor", pull_finished: true },
    } } },
    "/legacy": { inbox_initial_state: {
      entries: [{ message: {
        id: "200", conversation_id: "10-20",
        message_data: { sender_id: "20", time: "1787304720000" },
      } }],
      inbox_timelines: { trusted: { status: "AT_END" }, untrusted: { status: "AT_END" } },
    } },
  };
  const result = await scanXMessageHistory({
    config, ownerId: "10", maxPages: 20, sleep: async () => {}, jitter: () => 0,
    fetchJson: async (path) => pages[new URL(path, "https://x.com").pathname as keyof typeof pages],
  });
  assert.deepEqual(result.messages.map(({ messageId, legacyMessageId, lastMessageAt }) => ({ messageId, legacyMessageId, lastMessageAt })), [
    { messageId: "chat-id", legacyMessageId: "200", lastMessageAt: "2026-08-21T09:32:00.459Z" },
    { messageId: "distinct", legacyMessageId: undefined, lastMessageAt: "2026-08-21T09:32:00.799Z" },
  ]);
});
