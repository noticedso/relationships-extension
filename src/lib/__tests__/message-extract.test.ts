import { describe, it, expect } from "vitest";
import {
  extractDmEntries,
  extractParticipantConversations,
  extractMessages,
  extractTweetEdges,
  computeHadReplyFromEvents,
  extractConversationEventTargets,
  type DmEntriesFieldMap,
  type ParticipantConversationsFieldMap,
  type TweetEdgesFieldMap,
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

// ── X owner-timeline tweet edges (NT-63; mirrors statuses/user_timeline.json) ──
const tweetFieldMap: TweetEdgesFieldMap = {
  mode: "tweetEdges",
  tweetIdPath: "id_str",
  createdAtPath: "created_at",
  inReplyToUserIdPath: "in_reply_to_user_id_str",
  inReplyToScreenNamePath: "in_reply_to_screen_name",
  userMentionsPath: "entities.user_mentions",
  mentionIdPath: "id_str",
  mentionScreenNamePath: "screen_name",
  mentionNamePath: "name",
};
function tweet(opts: {
  id: string;
  createdAt: string;
  inReplyToUserId?: string;
  inReplyToScreenName?: string;
  mentions?: Array<{ id: string; screen: string; name: string }>;
}) {
  // full_text deliberately present to prove the extractor never reads the body.
  return {
    id_str: opts.id,
    created_at: opts.createdAt,
    full_text: "SECRET TWEET BODY",
    in_reply_to_user_id_str: opts.inReplyToUserId ?? null,
    in_reply_to_screen_name: opts.inReplyToScreenName ?? null,
    entities: {
      user_mentions: (opts.mentions ?? []).map((m) => ({ id_str: m.id, screen_name: m.screen, name: m.name })),
    },
  };
}

describe("extractTweetEdges (X)", () => {
  it("emits one edge per @-mention (isReply=false) and never the tweet text", () => {
    const page = [
      tweet({
        id: "1",
        createdAt: "2026-06-20T10:30:00.000Z",
        mentions: [
          { id: "100", screen: "alice", name: "Alice" },
          { id: "200", screen: "bob", name: "Bob" },
        ],
      }),
    ];
    const out = extractTweetEdges(page, tweetFieldMap);
    expect(out).toEqual([
      { tweetId: "1", createdAt: "2026-06-20T10:30:00.000Z", isReply: false, mentionedUserId: "100", mentionedScreenName: "alice", mentionedName: "Alice" },
      { tweetId: "1", createdAt: "2026-06-20T10:30:00.000Z", isReply: false, mentionedUserId: "200", mentionedScreenName: "bob", mentionedName: "Bob" },
    ]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("adds a reply-marker row (isReply=true, empty mention fields) for a reply tweet", () => {
    const page = [
      tweet({
        id: "2",
        createdAt: "2026-06-20T11:00:00.000Z",
        inReplyToUserId: "300",
        inReplyToScreenName: "carol",
        mentions: [{ id: "300", screen: "carol", name: "Carol" }],
      }),
    ];
    const out = extractTweetEdges(page, tweetFieldMap);
    expect(out).toHaveLength(2);
    expect(out).toContainEqual({ tweetId: "2", createdAt: "2026-06-20T11:00:00.000Z", isReply: false, mentionedUserId: "300", mentionedScreenName: "carol", mentionedName: "Carol" });
    expect(out).toContainEqual({ tweetId: "2", createdAt: "2026-06-20T11:00:00.000Z", isReply: true, inReplyToUserId: "300", inReplyToScreenName: "carol", mentionedUserId: "", mentionedScreenName: "", mentionedName: "" });
  });

  it("a reply with no mentions still yields exactly the reply-marker", () => {
    const page = [tweet({ id: "3", createdAt: "2026-06-20T12:00:00.000Z", inReplyToUserId: "400", inReplyToScreenName: "dave" })];
    expect(extractTweetEdges(page, tweetFieldMap)).toEqual([
      { tweetId: "3", createdAt: "2026-06-20T12:00:00.000Z", isReply: true, inReplyToUserId: "400", inReplyToScreenName: "dave", mentionedUserId: "", mentionedScreenName: "", mentionedName: "" },
    ]);
  });

  it("skips tweets missing id or created_at, and non-reply tweets with no mentions", () => {
    const page = [
      { id_str: "", created_at: "2026-06-20T10:30:00.000Z" }, // no id
      { id_str: "5", created_at: "" }, // no timestamp
      tweet({ id: "6", createdAt: "2026-06-20T10:30:00.000Z" }), // no mentions, not a reply
    ];
    expect(extractTweetEdges(page, tweetFieldMap)).toEqual([]);
  });

  it("reads the tweets array at tweetsPath when the page is not a bare array", () => {
    const nested = { data: { tweets: [tweet({ id: "7", createdAt: "2026-06-20T10:30:00.000Z", mentions: [{ id: "700", screen: "erin", name: "Erin" }] })] } };
    expect(extractTweetEdges(nested, { ...tweetFieldMap, tweetsPath: "data.tweets" })).toEqual([
      { tweetId: "7", createdAt: "2026-06-20T10:30:00.000Z", isReply: false, mentionedUserId: "700", mentionedScreenName: "erin", mentionedName: "Erin" },
    ]);
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

// ── NT-99 follow-up: per-conversation had_reply probe (LinkedIn) ──────────────
// The conversations summary carries no per-message senders, so a bounded probe
// fetches a per-conversation events page. computeHadReplyFromEvents reads ONLY
// the message SENDERS (never the text) and returns had_reply = sawSelf &&
// sawCounterpart, or undefined when it can't tell.
const eventsCfg = {
  elementsPath: "data.messengerMessagesByConversation.elements",
  senderIdPath: "sender.hostIdentityUrn",
};
function ev(senderUrn: string) {
  // `body` deliberately present to prove the probe never reads message text.
  return { sender: { hostIdentityUrn: senderUrn }, body: { text: "SECRET BODY" } };
}
const eventsPage = (senders: string[]) => ({
  data: { messengerMessagesByConversation: { elements: senders.map(ev) } },
});

describe("computeHadReplyFromEvents (LinkedIn per-conversation probe)", () => {
  const SELF = "ACoAACself";

  it("true when the conversation went BOTH ways (self AND counterpart sent)", () => {
    const page = eventsPage(["urn:li:fsd_profile:ACoAACself", "urn:li:fsd_profile:ACoAAAjane"]);
    expect(computeHadReplyFromEvents(page, eventsCfg, SELF)).toBe(true);
  });

  it("false when only self sent (outbound, unreplied)", () => {
    const page = eventsPage(["urn:li:fsd_profile:ACoAACself", "urn:li:fsd_profile:ACoAACself"]);
    expect(computeHadReplyFromEvents(page, eventsCfg, SELF)).toBe(false);
  });

  it("false when only the counterpart sent (inbound, never replied)", () => {
    const page = eventsPage(["urn:li:fsd_profile:ACoAAAjane", "urn:li:fsd_profile:ACoAAAjane"]);
    expect(computeHadReplyFromEvents(page, eventsCfg, SELF)).toBe(false);
  });

  it("undefined when the events array is empty or the path is missing (can't tell → omit)", () => {
    expect(computeHadReplyFromEvents(eventsPage([]), eventsCfg, SELF)).toBeUndefined();
    expect(computeHadReplyFromEvents({}, eventsCfg, SELF)).toBeUndefined();
  });

  it("undefined when selfId is unresolved (empty) — never guesses had_reply", () => {
    const page = eventsPage(["urn:li:fsd_profile:ACoAACself", "urn:li:fsd_profile:ACoAAAjane"]);
    expect(computeHadReplyFromEvents(page, eventsCfg, "")).toBeUndefined();
  });

  it("never reads the message body/text (senders only)", () => {
    const page = eventsPage(["urn:li:fsd_profile:ACoAACself", "urn:li:fsd_profile:ACoAAAjane"]);
    const out = computeHadReplyFromEvents(page, eventsCfg, SELF);
    expect(typeof out).toBe("boolean");
    // The function returns a scalar boolean — no text can leak by construction.
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
});

describe("extractConversationEventTargets (LinkedIn)", () => {
  const SELF = "ACoAACself";
  const conv = (opts: { urn: string; otherHandle: string; lastAt: number; groupChat?: boolean }) => ({
    entityUrn: opts.urn,
    groupChat: opts.groupChat ?? false,
    lastActivityAt: opts.lastAt,
    conversationParticipants: [
      { hostIdentityUrn: "urn:li:fsd_profile:ACoAACself", participantType: { member: { profileUrl: "https://www.linkedin.com/in/me" } } },
      { hostIdentityUrn: "urn:li:fsd_profile:ACoAAAother", participantType: { member: { profileUrl: opts.otherHandle } } },
    ],
  });
  const page = (arr: unknown[]) => ({ data: { messengerConversationsBySyncToken: { elements: arr } } });

  it("returns one target per 1:1 conversation with urn + counterpart + recency (prefix applied)", () => {
    const out = extractConversationEventTargets(
      page([
        conv({ urn: "urn:li:msg_conversation:(x,c1)", otherHandle: "https://www.linkedin.com/in/jane", lastAt: 1750000900000 }),
        conv({ urn: "urn:li:msg_conversation:(x,c2)", otherHandle: "https://www.linkedin.com/in/bob", lastAt: 1750000000000 }),
      ]),
      liFieldMap,
      "entityUrn",
      SELF,
    );
    expect(out).toEqual([
      { conversationUrn: "urn:li:msg_conversation:(x,c1)", counterpartProfileUrl: "https://www.linkedin.com/in/jane", lastActivityAtMs: 1750000900000 },
      { conversationUrn: "urn:li:msg_conversation:(x,c2)", counterpartProfileUrl: "https://www.linkedin.com/in/bob", lastActivityAtMs: 1750000000000 },
    ]);
  });

  it("skips group chats and conversations missing an urn or counterpart", () => {
    const out = extractConversationEventTargets(
      page([
        conv({ urn: "urn:li:msg_conversation:(x,g)", otherHandle: "in/g", lastAt: 1, groupChat: true }),
        { entityUrn: "", lastActivityAt: 2, conversationParticipants: [] }, // no urn / no counterpart
        conv({ urn: "urn:li:msg_conversation:(x,ok)", otherHandle: "in/ok", lastAt: 3 }),
      ]),
      liFieldMap,
      "entityUrn",
      SELF,
    );
    expect(out.map((t) => t.conversationUrn)).toEqual(["urn:li:msg_conversation:(x,ok)"]);
  });
});
