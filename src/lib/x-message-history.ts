import { decodeChatEvent, type ChatEventMetadata } from "./x-chat-metadata";
import { toIso, type ScanMessage } from "./recipe";

export type XHistoryConfig = {
  initialPath: string; inboxPath: string; requestsPath: string; conversationPath: string;
  legacyInitialPath: string; legacyInboxPath: string; legacyConversationPath: string;
};
type Job = {
  kind: "initial" | "inbox" | "requests" | "conversation" | "legacyInitial" | "legacyInbox" | "legacyConversation";
  cursor?: Record<string, string | boolean> | string;
  conversation?: string;
  timeline?: "trusted" | "untrusted";
};
type Observation = { messageId?: string; conversationId?: string; counterpart: string; time: string; direction: "sent" | "received" };
export type XHistoryCheckpoint = {
  version: 1;
  ownerId: string;
  jobs: Job[];
  messages: Record<string, Observation>;
  conversations: string[];
  excluded: string[];
  visited: string[];
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("x_history_invalid_response");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("x_history_invalid_response");
  return value;
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function counterpart(id: string, owner: string): string | null {
  const ids = id.split(/[:-]/);
  if (ids.length !== 2 || ids.some((i) => !/^\d+$/.test(i)) || !ids.includes(owner) || ids[0] === ids[1]) return null;
  return ids.find((i) => i !== owner) ?? null;
}
const settings = { inbox_conversation_limit: 100, inbox_conversation_event_limit: 5, conversation_event_limit: 200 };
function withQuery(path: string, name: string, value: string): string {
  const url = new URL(path, "https://recipe.invalid");
  url.searchParams.set(name, value);
  return /^[a-z][a-z0-9+.-]*:|^\/\//i.test(path)
    ? url.href : `${url.pathname}${url.search}${url.hash}`;
}
function requestPath(job: Job, config: XHistoryConfig): string {
  let path: string;
  let variables: Record<string, unknown>;
  switch (job.kind) {
    case "initial": path = config.initialPath; variables = { max_local_sequence_id: "0", query_settings: settings }; break;
    case "inbox": path = config.inboxPath; variables = { continue_cursor: job.cursor, query_settings: settings }; break;
    case "requests": path = config.requestsPath; variables = { cursor: job.cursor ?? { descending: true }, query_settings: settings }; break;
    case "conversation": path = config.conversationPath; variables = { conversation_id: job.conversation, min_local_sequence_id: job.cursor, min_conversation_key_version: "0", query_settings: settings }; break;
    case "legacyInitial": return config.legacyInitialPath;
    case "legacyInbox": return withQuery(config.legacyInboxPath.replace("{timeline}", job.timeline!), "max_id", String(job.cursor));
    case "legacyConversation": {
      const path = config.legacyConversationPath.replace("{conversation}", encodeURIComponent(job.conversation!));
      return job.cursor ? withQuery(path, "max_id", String(job.cursor)) : path;
    }
  }
  return withQuery(path, "variables", JSON.stringify(variables));
}
function nextInboxCursor(raw: unknown, requests = false): Record<string, string | boolean> | null {
  const cursor = object(raw);
  const prefix = requests ? "XChatGetMessageRequestsPage" : "XChatGetInboxPage";
  if (cursor.__typename === prefix + "EndCursor" && (!requests || cursor.pull_finished === true)) return null;
  if (cursor.__typename !== prefix + "ContinueCursor" || !text(cursor.cursor_id)) throw new Error("x_history_unknown_cursor");
  if (requests) {
    if (typeof cursor.descending !== "boolean") throw new Error("x_history_unknown_cursor");
    return { cursor_id: text(cursor.cursor_id), descending: cursor.descending };
  }
  if (!text(cursor.graph_snapshot_id)) throw new Error("x_history_unknown_cursor");
  return { cursor_id: text(cursor.cursor_id), graph_snapshot_id: text(cursor.graph_snapshot_id) };
}

/**
 * Walk both current Chat and legacy DM history. A bounded invocation checkpoints
 * after each page and yields with complete=false; the service worker resumes it
 * on its next tick. A page cap, malformed page, HTTP error or repeated cursor can
 * never produce a completed import. Only metadata enters the checkpoint.
 */
export async function scanXMessageHistory(opts: {
  config: XHistoryConfig; ownerId: string; maxPages: number;
  fetchJson: (path: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>; jitter: () => number;
  checkpoint?: XHistoryCheckpoint;
  onPage?: (checkpoint: XHistoryCheckpoint) => Promise<void>;
}): Promise<{ complete: boolean; messages: ScanMessage[] }> {
  if (!/^\d+$/.test(opts.ownerId)) throw new Error("x_history_owner_required");
  if (opts.checkpoint && (opts.checkpoint.version !== 1 || opts.checkpoint.ownerId !== opts.ownerId)) throw new Error("x_history_account_changed");
  // Old checkpoints already collapsed same-time messages; rescan instead of
  // claiming complete provider history from lossy timestamp-only observations.
  const reusable = opts.checkpoint && Object.values(opts.checkpoint.messages).every((m) => m.messageId && m.conversationId);
  const state: XHistoryCheckpoint = reusable ? structuredClone(opts.checkpoint!) : {
    version: 1, ownerId: opts.ownerId,
    jobs: [{ kind: "initial" }, { kind: "requests" }, { kind: "legacyInitial" }],
    messages: {}, conversations: [], excluded: [], visited: [],
  };
  const add = (id: string, sender: string, time: string, messageId: string) => {
    const other = counterpart(id, opts.ownerId);
    if (!other || state.excluded.includes(other)) return;
    if (sender !== opts.ownerId && sender !== other) throw new Error("x_history_invalid_sender");
    const direction = sender === opts.ownerId ? "sent" : "received";
    if (!messageId || messageId.length > 128) throw new Error("x_history_missing_message_id");
    const conversationId = id.replace(":", "-");
    state.messages[JSON.stringify([conversationId, messageId])] = { counterpart: other, time, direction, messageId, conversationId };
    if (Object.keys(state.messages).length > 10_000) throw new Error("x_history_message_limit");
  };
  const events = (raw: unknown, id: string): ChatEventMetadata[] => array(raw).map((value) => {
    if (typeof value !== "string") throw new Error("x_history_invalid_event");
    const event = decodeChatEvent(value);
    if (event.conversationId !== id) throw new Error("x_history_conversation_mismatch");
    if (event.kind === 1) add(id, event.senderId, event.occurredAt, event.messageId);
    return event;
  });
  const minimum = (entries: ChatEventMetadata[]): string => {
    if (!entries.length) throw new Error("x_history_missing_cursor");
    return entries.reduce((min, e) => BigInt(e.sequenceId) < BigInt(min) ? e.sequenceId : min, entries[0]!.sequenceId);
  };
  const enqueueConversation = (id: string, entries: ChatEventMetadata[], more: boolean) => {
    if (!more || !counterpart(id, opts.ownerId) || state.conversations.includes(id)) return;
    state.conversations.push(id);
    state.jobs.push({ kind: "conversation", conversation: id, cursor: entries.length ? minimum(entries) : "9223372036854775807" });
  };
  const legacyEntries = (page: Record<string, unknown>) => {
    for (const raw of array(page.entries ?? [])) {
      const entry = object(raw);
      if (!entry.message) continue;
      const message = object(entry.message), data = object(message.message_data);
      const id = text(message.conversation_id);
      if (!counterpart(id, opts.ownerId)) continue;
      const time = toIso(data.time);
      if (!time) throw new Error("x_history_invalid_time");
      add(id, text(data.sender_id), time, text(data.id) || text(message.id));
    }
    const conversations = object(page.conversations ?? {});
    for (const [id, raw] of Object.entries(conversations)) {
      if (!counterpart(id, opts.ownerId) || state.conversations.includes(id) || state.excluded.includes(counterpart(id, opts.ownerId)!)) continue;
      if (object(raw).type !== "ONE_TO_ONE") continue;
      state.conversations.push(id);
      state.jobs.push({ kind: "legacyConversation", conversation: id });
    }
  };
  const legacyCursor = (page: Record<string, unknown>): string | null => {
    if (page.status === "AT_END") return null;
    if (page.status !== "HAS_MORE" || !/^\d+$/.test(text(page.min_entry_id))) throw new Error("x_history_unknown_cursor");
    return text(page.min_entry_id);
  };

  for (let pageNumber = 0; pageNumber < opts.maxPages && state.jobs.length; pageNumber++) {
    const job = state.jobs.shift()!;
    const path = requestPath(job, opts.config);
    if (state.visited.includes(path)) throw new Error("x_history_repeated_cursor");
    if (state.visited.length >= 5_000) throw new Error("x_history_page_limit");
    const raw = object(await opts.fetchJson(path));
    if (raw.errors !== undefined) throw new Error("x_history_api_error");
    switch (job.kind) {
      case "initial": case "inbox": {
        const data = object(object(raw.data)[job.kind === "initial" ? "get_initial_chat_page" : "get_inbox_page"]);
        for (const rawItem of array(data.items)) {
          const item = object(rawItem), id = text(object(item.conversation_detail).conversation_id);
          const other = counterpart(id, opts.ownerId);
          if (!other) continue;
          if (item.is_deleted_by_viewer === true) { state.excluded.push(other); continue; }
          const entries = events(item.latest_message_events, id);
          // Key-change records may be the only events in an otherwise empty
          // summary. Their sequence still gives us a history cursor.
          entries.push(...events(item.latest_conversation_key_change_events ?? [], id));
          if (typeof item.has_more !== "boolean") throw new Error("x_history_missing_completion");
          enqueueConversation(id, entries, item.has_more);
        }
        const cursor = nextInboxCursor(data.inboxCursor);
        if (cursor) state.jobs.unshift({ kind: "inbox", cursor });
        break;
      }
      case "requests": {
        const data = object(object(raw.data).get_message_requests_page);
        for (const rawItem of array(data.message_request_items)) {
          const item = object(rawItem), id = text(item.conversation_id);
          if (!counterpart(id, opts.ownerId)) continue;
          const entries = events(item.latest_message_events ?? (item.encoded_message_create_event ? [item.encoded_message_create_event] : []), id);
          enqueueConversation(id, entries, true);
        }
        const cursor = nextInboxCursor(data.cursor, true);
        if (cursor) state.jobs.unshift({ kind: "requests", cursor });
        break;
      }
      case "conversation": {
        const data = object(object(raw.data).get_conversation_page);
        const entries = events(data.encoded_message_events, job.conversation!);
        if (typeof data.has_more !== "boolean") throw new Error("x_history_missing_completion");
        if (data.has_more) {
          const cursor = minimum(entries);
          if (BigInt(cursor) >= BigInt(String(job.cursor))) throw new Error("x_history_repeated_cursor");
          state.jobs.unshift({ ...job, cursor });
        }
        break;
      }
      case "legacyInitial": {
        const data = object(raw.inbox_initial_state);
        legacyEntries(data);
        const timelines = object(data.inbox_timelines);
        for (const timeline of ["trusted", "untrusted"] as const) {
          const cursor = legacyCursor(object(timelines[timeline]));
          if (cursor) state.jobs.unshift({ kind: "legacyInbox", timeline, cursor });
        }
        break;
      }
      case "legacyInbox": case "legacyConversation": {
        const data = object(raw[job.kind === "legacyInbox" ? "inbox_timeline" : "conversation_timeline"]);
        legacyEntries(data);
        const cursor = legacyCursor(data);
        if (cursor) {
          if (job.cursor && BigInt(cursor) >= BigInt(String(job.cursor))) throw new Error("x_history_repeated_cursor");
          state.jobs.unshift({ ...job, cursor });
        }
        break;
      }
    }
    state.visited.push(path);
    await opts.onPage?.(structuredClone(state));
    if (state.jobs.length) await opts.sleep(opts.jitter());
  }
  if (state.jobs.length) return { complete: false, messages: [] };
  const observations = Object.values(state.messages).filter((m) => !state.excluded.includes(m.counterpart));
  const directions = new Map<string, Set<string>>();
  for (const m of observations) {
    const set = directions.get(m.counterpart) ?? new Set<string>();
    set.add(m.direction); directions.set(m.counterpart, set);
  }
  return { complete: true, messages: observations.map((m) => ({
    messageId: m.messageId, conversationId: m.conversationId,
    counterpartProfileUrl: m.counterpart, lastMessageAt: m.time, direction: m.direction,
    had_reply: directions.get(m.counterpart)!.size === 2,
  })) };
}
