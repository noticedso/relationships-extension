import { describe, it, expect } from "vitest";
import { decodeChatEvent } from "../x-chat-metadata";
import { chatEvent } from "./fixtures/x-chat";

describe("current X Chat metadata envelope", () => {
  it("reads only the message identity, participant, timestamp and event kind", () => {
    expect(decodeChatEvent(chatEvent())).toEqual({
      sequenceId: "100", conversationId: "10:20", senderId: "10",
      occurredAt: "2026-08-21T09:32:00.000Z", kind: 1,
    });
  });
  it("distinguishes non-message events from message creation", () => {
    expect(decodeChatEvent(chatEvent({ kind: 12 })).kind).toBe(12);
  });
  it.each(["%%%", "CwAB/////w==", chatEvent().slice(0, -12)])("rejects malformed envelopes", (value) => {
    expect(() => decodeChatEvent(value)).toThrow();
  });
  it("rejects missing or invalid timestamps", () => {
    expect(() => decodeChatEvent(chatEvent({ time: "invalid" }))).toThrow();
  });
});
