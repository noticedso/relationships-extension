import { describe, it, expect } from "vitest";
import { applyMessageFieldMap, type MessageFieldMap } from "../recipe";

/**
 * Maps a conversation-list response → ScanMessage[] METADATA ONLY (counterpart,
 * last-message timestamp, direction). The field map has NO content path, so
 * message text can never be mapped. Direction = (last sender === self) ? sent :
 * received. With excludeUnreplied, a conversation whose messages are all from one
 * party (no reply) is dropped (the X "never replied" rule).
 */
describe("applyMessageFieldMap", () => {
  const fieldMap: MessageFieldMap = {
    elementsPath: "conversations",
    counterpartIdPath: "counterpart.id",
    lastMessageAtPath: "lastAt",
    lastSenderIdPath: "lastSenderId",
    participantIdsPath: "senderIds",
    counterpartUrlPrefix: "https://x.com/i/user/",
  };

  it("maps each conversation to counterpart + ISO timestamp + direction", () => {
    const page = {
      conversations: [
        { counterpart: { id: "100" }, lastAt: 1750412400000, lastSenderId: "999", senderIds: ["999", "100"] },
        { counterpart: { id: "200" }, lastAt: 1750412400000, lastSenderId: "200", senderIds: ["999", "200"] },
      ],
    };
    const out = applyMessageFieldMap(page, fieldMap, "999", false);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      counterpartProfileUrl: "https://x.com/i/user/100",
      lastMessageAt: "2025-06-20T09:40:00.000Z",
      direction: "sent", // last sender is self (999)
    });
    expect(out[1]!.direction).toBe("received"); // last sender is counterpart (200)
  });

  it("never emits message text (only the three metadata fields)", () => {
    const page = { conversations: [{ counterpart: { id: "100" }, lastAt: 1750412400000, lastSenderId: "999", senderIds: ["999", "100"] }] };
    const out = applyMessageFieldMap(page, fieldMap, "999", false);
    expect(Object.keys(out[0]!).sort()).toEqual(["counterpartProfileUrl", "direction", "lastMessageAt"]);
  });

  it("excludeUnreplied drops one-sided conversations (no reply, either direction)", () => {
    const page = {
      conversations: [
        { counterpart: { id: "100" }, lastAt: 1750412400000, lastSenderId: "999", senderIds: ["999"] }, // only self sent → drop
        { counterpart: { id: "200" }, lastAt: 1750412400000, lastSenderId: "200", senderIds: ["200"] }, // only counterpart sent → drop
        { counterpart: { id: "300" }, lastAt: 1750412400000, lastSenderId: "300", senderIds: ["999", "300"] }, // two-way → keep
      ],
    };
    const out = applyMessageFieldMap(page, fieldMap, "999", true);
    expect(out.map((m) => m.counterpartProfileUrl)).toEqual(["https://x.com/i/user/300"]);
  });

  it("keeps all conversations when excludeUnreplied is false (LinkedIn)", () => {
    const page = {
      conversations: [{ counterpart: { id: "100" }, lastAt: 1750412400000, lastSenderId: "999", senderIds: ["999"] }],
    };
    expect(applyMessageFieldMap(page, fieldMap, "999", false)).toHaveLength(1);
  });

  it("uses the raw counterpart id when no url prefix is set", () => {
    const fm: MessageFieldMap = { ...fieldMap, counterpartUrlPrefix: undefined };
    const page = { conversations: [{ counterpart: { id: "jane-doe" }, lastAt: 1750412400000, lastSenderId: "999", senderIds: ["999", "jane-doe"] }] };
    expect(applyMessageFieldMap(page, fm, "999", false)[0]!.counterpartProfileUrl).toBe("jane-doe");
  });

  it("skips conversations missing a counterpart or a timestamp", () => {
    const page = {
      conversations: [
        { counterpart: { id: "" }, lastAt: 1750412400000, lastSenderId: "999", senderIds: ["999", "1"] },
        { counterpart: { id: "100" }, lastAt: null, lastSenderId: "999", senderIds: ["999", "100"] },
        { counterpart: { id: "200" }, lastAt: 1750412400000, lastSenderId: "999", senderIds: ["999", "200"] },
      ],
    };
    expect(applyMessageFieldMap(page, fieldMap, "999", false)).toHaveLength(1);
  });

  it("accepts a keyed object/map of conversations (X inbox_initial_state shape)", () => {
    const page = {
      conversations: {
        "100-999": { counterpart: { id: "100" }, lastAt: 1750412400000, lastSenderId: "100", senderIds: ["999", "100"] },
        "200-999": { counterpart: { id: "200" }, lastAt: 1750412400000, lastSenderId: "999", senderIds: ["999", "200"] },
      },
    };
    const out = applyMessageFieldMap(page, fieldMap, "999", false);
    expect(out.map((m) => m.counterpartProfileUrl).sort()).toEqual([
      "https://x.com/i/user/100",
      "https://x.com/i/user/200",
    ]);
  });

  it("parses ISO-string timestamps as well as epoch ms", () => {
    const page = { conversations: [{ counterpart: { id: "100" }, lastAt: "2025-06-20T11:00:00.000Z", lastSenderId: "100", senderIds: ["999", "100"] }] };
    expect(applyMessageFieldMap(page, fieldMap, "999", false)[0]!.lastMessageAt).toBe("2025-06-20T11:00:00.000Z");
  });
});
