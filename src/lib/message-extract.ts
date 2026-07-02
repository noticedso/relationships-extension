/**
 * Source-specific 1:1 message-metadata extraction (NT-44/NT-45). Each network's
 * messaging API has a different shape, so the recipe selects a `mode` and the
 * extractor turns it into `ScanMessage[]` — counterpart + last-message timestamp
 * + direction, METADATA ONLY (no message text is ever read or returned).
 *
 *  - "dmEntries" (X): a flat list of message events, each carrying sender_id,
 *    recipient_id, time and conversation_id. We group by conversation, take the
 *    last message, derive counterpart + direction from sender/recipient vs self,
 *    and (for excludeUnreplied) keep only conversations with ≥1 message each way.
 *  - "participantConversations" (LinkedIn): a list of conversations, each with a
 *    participants array + a last-activity timestamp. Counterpart = the
 *    participant that isn't self. The conversations API does not expose the last
 *    sender, so direction is a heuristic from the unread count.
 *  - "embedded" (default): the flat per-conversation field map (applyMessageFieldMap).
 */
import {
  applyMessageFieldMap,
  getByPath,
  toIso,
  type MessageFieldMap,
  type ScanMessage,
} from "./recipe";

export type DmEntriesFieldMap = {
  mode: "dmEntries";
  /** Path to the flat array of message events. */
  entriesPath: string;
  /** Entry-relative paths. */
  conversationIdPath: string;
  senderIdPath: string;
  recipientIdPath: string;
  /** Epoch-ms (number or string) or ISO. */
  timePath: string;
  counterpartUrlPrefix?: string;
};

export type ParticipantConversationsFieldMap = {
  mode: "participantConversations";
  /** Path to the conversations array. */
  elementsPath: string;
  /** Conversation-relative path to the participants array. */
  participantsPath: string;
  /** Participant-relative path to an id compared against `selfId` (substring match). */
  participantSelfIdPath: string;
  /** Participant-relative path to the counterpart handle/url. */
  participantHandlePath: string;
  /** Conversation-relative path to the last-activity timestamp. */
  lastActivityAtPath: string;
  /** Conversation-relative path to a group-chat flag → skipped when true (1:1 only). */
  groupChatPath?: string;
  /** Conversation-relative unread count → direction heuristic (unread>0 ⇒ received). */
  unreadCountPath?: string;
  counterpartUrlPrefix?: string;
};

/**
 * Owner-timeline EDGE extraction (NT-63, X). A tweet carries who the owner
 * @-mentioned and who they replied to — relationship signal, never the text.
 * Paths are tweet-relative (`userMentionsPath` points at the mentions array,
 * the `mention*Path`s are mention-relative).
 */
export type TweetEdgesFieldMap = {
  mode: "tweetEdges";
  /** Path to the tweets array; absent → the page IS the array (user_timeline). */
  tweetsPath?: string;
  tweetIdPath: string;
  createdAtPath: string;
  inReplyToUserIdPath: string;
  inReplyToScreenNamePath: string;
  userMentionsPath: string;
  mentionIdPath: string;
  mentionScreenNamePath: string;
  mentionNamePath: string;
};

export type AnyMessageFieldMap =
  | MessageFieldMap
  | DmEntriesFieldMap
  | ParticipantConversationsFieldMap;

/**
 * A single owner→other EDGE derived from one of the owner's tweets. METADATA
 * ONLY — the tweet text is never read or returned. One row per @-mention, plus
 * a reply-marker row per reply tweet (isReply=true, empty mention fields).
 */
export type XTweetEdgeRow = {
  tweetId: string;
  createdAt: string; // ISO 8601
  isReply: boolean;
  inReplyToUserId?: string;
  inReplyToScreenName?: string;
  mentionedUserId: string;
  mentionedScreenName: string;
  mentionedName: string;
};

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** The raw tweet array on a timeline page: the page itself, or `tweetsPath`. */
export function tweetsArrayOf(page: unknown, fieldMap: TweetEdgesFieldMap): unknown[] {
  if (Array.isArray(page)) return page;
  if (fieldMap.tweetsPath) {
    const raw = getByPath(page, fieldMap.tweetsPath);
    if (Array.isArray(raw)) return raw;
  }
  return [];
}

/**
 * X owner timeline → mention/reply EDGE rows (NT-63). For every tweet: one row
 * per `user_mentions[]` entry (isReply=false), plus — when the tweet is a reply
 * — a reply-marker row (isReply=true) carrying the in-reply-to ids with the
 * mention fields left empty. Never reads or returns the tweet body.
 */
export function extractTweetEdges(
  page: unknown,
  fieldMap: TweetEdgesFieldMap,
): XTweetEdgeRow[] {
  const tweets = tweetsArrayOf(page, fieldMap);
  const out: XTweetEdgeRow[] = [];
  for (const tw of tweets) {
    const tweetId = str(getByPath(tw, fieldMap.tweetIdPath));
    if (tweetId === "") continue;
    const createdAt = toIso(getByPath(tw, fieldMap.createdAtPath));
    if (!createdAt) continue;

    const inReplyToUserId = str(getByPath(tw, fieldMap.inReplyToUserIdPath));
    const inReplyToScreenName = str(getByPath(tw, fieldMap.inReplyToScreenNamePath));
    const isReply = inReplyToUserId !== "" || inReplyToScreenName !== "";

    // One edge per @-mention.
    const mentionsRaw = getByPath(tw, fieldMap.userMentionsPath);
    const mentions = Array.isArray(mentionsRaw) ? mentionsRaw : [];
    for (const mention of mentions) {
      const mentionedUserId = str(getByPath(mention, fieldMap.mentionIdPath));
      const mentionedScreenName = str(getByPath(mention, fieldMap.mentionScreenNamePath));
      const mentionedName = str(getByPath(mention, fieldMap.mentionNamePath));
      if (mentionedUserId === "" && mentionedScreenName === "") continue;
      out.push({
        tweetId,
        createdAt,
        isReply: false,
        mentionedUserId,
        mentionedScreenName,
        mentionedName,
      });
    }

    // A reply-marker so the owner→repliedTo edge is explicit even if the
    // replied-to account is absent from user_mentions.
    if (isReply) {
      out.push({
        tweetId,
        createdAt,
        isReply: true,
        inReplyToUserId,
        inReplyToScreenName,
        mentionedUserId: "",
        mentionedScreenName: "",
        mentionedName: "",
      });
    }
  }
  return out;
}

/** X DM inbox: group message events by conversation; last message per convo. */
export function extractDmEntries(
  page: unknown,
  fieldMap: DmEntriesFieldMap,
  selfId: string,
  excludeUnreplied: boolean,
): ScanMessage[] {
  const entries = getByPath(page, fieldMap.entriesPath);
  if (!Array.isArray(entries)) return [];

  type Acc = { counterpart: string; ts: number; iso: string; direction: "sent" | "received"; sawSelf: boolean; sawCounterpart: boolean };
  const byConv = new Map<string, Acc>();

  for (const e of entries) {
    const cid = str(getByPath(e, fieldMap.conversationIdPath));
    if (cid === "") continue;
    const sender = str(getByPath(e, fieldMap.senderIdPath));
    const recipient = str(getByPath(e, fieldMap.recipientIdPath));
    const iso = toIso(getByPath(e, fieldMap.timePath));
    if (!iso) continue;
    const ts = Date.parse(iso);
    const fromSelf = sender === selfId;
    const counterpart = fromSelf ? recipient : sender;
    if (counterpart === "" || counterpart === selfId) continue;

    const prev = byConv.get(cid);
    const acc: Acc = prev ?? { counterpart, ts: -1, iso, direction: "received", sawSelf: false, sawCounterpart: false };
    acc.sawSelf = acc.sawSelf || fromSelf;
    acc.sawCounterpart = acc.sawCounterpart || !fromSelf;
    if (ts >= acc.ts) {
      acc.ts = ts;
      acc.iso = iso;
      acc.direction = fromSelf ? "sent" : "received";
      acc.counterpart = counterpart;
    }
    byConv.set(cid, acc);
  }

  const out: ScanMessage[] = [];
  for (const acc of byConv.values()) {
    if (excludeUnreplied && !(acc.sawSelf && acc.sawCounterpart)) continue; // never-replied
    out.push({
      counterpartProfileUrl: (fieldMap.counterpartUrlPrefix ?? "") + acc.counterpart,
      lastMessageAt: acc.iso,
      direction: acc.direction,
    });
  }
  return out;
}

/** LinkedIn conversations: counterpart = the participant that isn't self. */
export function extractParticipantConversations(
  page: unknown,
  fieldMap: ParticipantConversationsFieldMap,
  selfId: string,
): ScanMessage[] {
  const elements = getByPath(page, fieldMap.elementsPath);
  if (!Array.isArray(elements)) return [];

  const out: ScanMessage[] = [];
  for (const el of elements) {
    if (fieldMap.groupChatPath && getByPath(el, fieldMap.groupChatPath) === true) continue; // 1:1 only
    const participants = getByPath(el, fieldMap.participantsPath);
    if (!Array.isArray(participants)) continue;

    // The counterpart is the participant whose self-id path does NOT contain
    // selfId (self's hostIdentityUrn is urn:li:fsd_profile:<selfId>).
    let counterpartHandle = "";
    for (const p of participants) {
      const pid = str(getByPath(p, fieldMap.participantSelfIdPath));
      if (selfId !== "" && pid.includes(selfId)) continue; // this is self
      const handle = str(getByPath(p, fieldMap.participantHandlePath));
      if (handle !== "") {
        counterpartHandle = handle;
        break;
      }
    }
    if (counterpartHandle === "") continue;

    const iso = toIso(getByPath(el, fieldMap.lastActivityAtPath));
    if (!iso) continue;

    // The conversations API does not carry the last sender, so direction is a
    // heuristic: an unread thread's last message was RECEIVED; otherwise assume
    // we spoke last. Recency (the primary signal) is exact regardless.
    const unread = fieldMap.unreadCountPath ? Number(getByPath(el, fieldMap.unreadCountPath) ?? 0) : 0;
    const direction: "sent" | "received" = unread > 0 ? "received" : "sent";

    out.push({
      counterpartProfileUrl: (fieldMap.counterpartUrlPrefix ?? "") + counterpartHandle,
      lastMessageAt: iso,
      direction,
    });
  }
  return out;
}

/** Dispatch by the recipe's message mode (default = the flat embedded map). */
export function extractMessages(
  page: unknown,
  fieldMap: AnyMessageFieldMap,
  selfId: string,
  excludeUnreplied: boolean,
): ScanMessage[] {
  if ("mode" in fieldMap && fieldMap.mode === "dmEntries") {
    return extractDmEntries(page, fieldMap, selfId, excludeUnreplied);
  }
  if ("mode" in fieldMap && fieldMap.mode === "participantConversations") {
    return extractParticipantConversations(page, fieldMap, selfId);
  }
  return applyMessageFieldMap(page, fieldMap as MessageFieldMap, selfId, excludeUnreplied);
}
