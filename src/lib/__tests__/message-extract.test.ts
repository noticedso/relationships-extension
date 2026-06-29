import { describe, it, expect } from "vitest";
import {
  extractDmEntries,
  extractParticipantConversations,
  extractMessages,
  type DmEntriesFieldMap,
  type ParticipantConversationsFieldMap,
} from "../message-extract";

// ── X DM entries (mirrors /i/api/1.1/dm/inbox_initial_state.json) ─────────────
const xFieldMap: DmEntriesFieldMap = {
  mode: "dmEntries",
  entriesPath: "inbox_initial_state.entries",
  conversationIdPath: "message.conversation_id",
  senderIdPath: "message.message_data.sender_id",
  recipientIdPath: "message.message_data.recipient_id",
  timePath: "message.message_data.time",
};
function xEntry(conv: string, sender: string, recipient: string, time: number) {
  // message_data deliberately also has `text` to prove we never read it.
  return { message: { conversation_id: conv, message_data: { sender_id: sender, recipient_id: recipient, time: String(time), text: "SECRET BODY" } } };
}

describe("extractDmEntries (X)", () => {
  const SELF = "999";

  it("groups by conversation, takes the LAST message, derives counterpart + direction", () => {
    const page = {
      inbox_initial_state: {
        entries: [
          xEntry("c1", "100", "999", 1750000000000), // received (older)
          xEntry("c1", "999", "100", 1750000900000), // sent (newer → last)
          xEntry("c2", "200", "999", 1750000500000), // received only
          xEntry("c2", "999", "200", 1750000800000), // sent → c2 also two-way, last sent
        ],
      },
    };
    const out = extractDmEntries(page, xFieldMap, SELF, false).sort((a, b) =>
      a.counterpartProfileUrl.localeCompare(b.counterpartProfileUrl),
    );
    expect(out).toEqual([
      { counterpartProfileUrl: "100", lastMessageAt: "2025-06-15T15:21:40.000Z", direction: "sent" },
      { counterpartProfileUrl: "200", lastMessageAt: "2025-06-15T15:20:00.000Z", direction: "sent" },
    ]);
  });

  it("never returns message text", () => {
    const page = { inbox_initial_state: { entries: [xEntry("c1", "100", "999", 1750000000000), xEntry("c1", "999", "100", 1750000900000)] } };
    const out = extractDmEntries(page, xFieldMap, SELF, false);
    for (const m of out) expect(Object.keys(m).sort()).toEqual(["counterpartProfileUrl", "direction", "lastMessageAt"]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("excludeUnreplied drops one-sided conversations (never replied, either direction)", () => {
    const page = {
      inbox_initial_state: {
        entries: [
          xEntry("c1", "999", "100", 1750000000000), // only self sent → drop
          xEntry("c2", "200", "999", 1750000000000), // only counterpart sent → drop
          xEntry("c3", "999", "300", 1750000000000), // two-way → keep
          xEntry("c3", "300", "999", 1750000900000),
        ],
      },
    };
    const out = extractDmEntries(page, xFieldMap, SELF, true);
    expect(out.map((m) => m.counterpartProfileUrl)).toEqual(["300"]);
  });

  it("derives counterpart correctly whether self is sender or recipient", () => {
    const page = { inbox_initial_state: { entries: [xEntry("c1", "999", "100", 1)] } };
    expect(extractDmEntries(page, xFieldMap, SELF, false)[0]!.counterpartProfileUrl).toBe("100");
    const page2 = { inbox_initial_state: { entries: [xEntry("c1", "100", "999", 1)] } };
    expect(extractDmEntries(page2, xFieldMap, SELF, false)[0]!.counterpartProfileUrl).toBe("100");
  });
});

// ── LinkedIn participant conversations (mirrors messengerConversations) ───────
const liFieldMap: ParticipantConversationsFieldMap = {
  mode: "participantConversations",
  elementsPath: "data.messengerConversationsBySyncToken.elements",
  participantsPath: "conversationParticipants",
  participantSelfIdPath: "hostIdentityUrn",
  participantHandlePath: "participantType.member.profileUrl",
  lastActivityAtPath: "lastActivityAt",
  groupChatPath: "groupChat",
  unreadCountPath: "unreadCount",
};
function liConv(opts: { selfUrn: string; otherUrn: string; otherHandle: string; lastAt: number; groupChat?: boolean; unread?: number }) {
  return {
    groupChat: opts.groupChat ?? false,
    unreadCount: opts.unread ?? 0,
    lastActivityAt: opts.lastAt,
    conversationParticipants: [
      { hostIdentityUrn: opts.selfUrn, participantType: { member: { profileUrl: "https://www.linkedin.com/in/me" } } },
      { hostIdentityUrn: opts.otherUrn, participantType: { member: { profileUrl: opts.otherHandle } } },
    ],
  };
}

describe("extractParticipantConversations (LinkedIn)", () => {
  const SELF = "ACoAACself";
  const els = (arr: unknown[]) => ({ data: { messengerConversationsBySyncToken: { elements: arr } } });

  it("counterpart = the non-self participant; recency from lastActivityAt", () => {
    const page = els([
      liConv({ selfUrn: "urn:li:fsd_profile:ACoAACself", otherUrn: "urn:li:fsd_profile:ACoAAAjane", otherHandle: "https://www.linkedin.com/in/jane", lastAt: 1750000900000, unread: 0 }),
    ]);
    expect(extractParticipantConversations(page, liFieldMap, SELF)).toEqual([
      { counterpartProfileUrl: "https://www.linkedin.com/in/jane", lastMessageAt: "2025-06-15T15:21:40.000Z", direction: "sent" },
    ]);
  });

  it("direction heuristic: unread>0 ⇒ received, else sent", () => {
    const page = els([
      liConv({ selfUrn: "urn:li:fsd_profile:ACoAACself", otherUrn: "urn:li:fsd_profile:ACoAAAbob", otherHandle: "in/bob", lastAt: 1750000000000, unread: 2 }),
    ]);
    expect(extractParticipantConversations(page, liFieldMap, SELF)[0]!.direction).toBe("received");
  });

  it("skips group chats (1:1 only)", () => {
    const page = els([
      liConv({ selfUrn: "urn:li:fsd_profile:ACoAACself", otherUrn: "urn:li:fsd_profile:ACoAAAg", otherHandle: "in/g", lastAt: 1, groupChat: true }),
    ]);
    expect(extractParticipantConversations(page, liFieldMap, SELF)).toHaveLength(0);
  });
});

describe("extractMessages dispatch", () => {
  it("routes by mode", () => {
    const x = { inbox_initial_state: { entries: [xEntry("c1", "100", "999", 1), xEntry("c1", "999", "100", 2)] } };
    expect(extractMessages(x, xFieldMap, "999", false)).toHaveLength(1);
    const li = { data: { messengerConversationsBySyncToken: { elements: [liConv({ selfUrn: "urn:li:fsd_profile:ACoAACself", otherUrn: "urn:li:fsd_profile:ACoAAAj", otherHandle: "in/j", lastAt: 1750000000000 })] } } };
    expect(extractMessages(li, liFieldMap, "ACoAACself", false)).toHaveLength(1);
  });
});
