/**
 * Metadata-only reader for X Chat's Thrift binary MessageEvent envelope.
 * Field numbers verified against X's public xchat-kmp client (2026-09-14).
 * Strings 1/2/3/4/6 identify sequence, message ID, sender, conversation and time. Field 7 is
 * the event union (1 = message creation). Bodies, keys, tokens and signatures
 * are skipped by byte length; they are never decoded or returned.
 */
export type ChatEventMetadata = {
  sequenceId: string;
  messageId: string;
  conversationId: string;
  senderId: string;
  occurredAt: string;
  kind: number;
};

export function decodeChatEvent(encoded: string): ChatEventMetadata {
  if (encoded.length > 4_000_000) throw new Error("x_chat_event_too_large");
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const take = (length: number): number => {
    if (!Number.isInteger(length) || length < 0 || offset + length > bytes.length) {
      throw new Error("x_chat_invalid_event");
    }
    const start = offset;
    offset += length;
    return start;
  };
  const byte = () => view.getUint8(take(1));
  const short = () => view.getInt16(take(2));
  const size = () => {
    const n = view.getInt32(take(4));
    if (n < 0 || n > bytes.length) throw new Error("x_chat_invalid_event");
    return n;
  };
  const skip = (type: number, depth = 0): void => {
    if (depth > 32) throw new Error("x_chat_invalid_event");
    switch (type) {
      case 2: case 3: take(1); return;
      case 6: take(2); return;
      case 8: take(4); return;
      case 4: case 10: take(8); return;
      case 11: take(size()); return;
      case 12: {
        for (let t = byte(); t !== 0; t = byte()) {
          short();
          skip(t, depth + 1);
        }
        return;
      }
      case 13: {
        const key = byte(), value = byte(), count = size();
        for (let i = 0; i < count; i++) { skip(key, depth + 1); skip(value, depth + 1); }
        return;
      }
      case 14: case 15: {
        const element = byte(), count = size();
        for (let i = 0; i < count; i++) skip(element, depth + 1);
        return;
      }
      default: throw new Error("x_chat_unknown_field_type");
    }
  };
  const fields: Record<number, string> = {};
  let kind = 0;
  for (let type = byte(); type !== 0; type = byte()) {
    const id = short();
    if (type === 11 && [1, 2, 3, 4, 6].includes(id)) {
      const n = size();
      if (n > 128) throw new Error("x_chat_invalid_metadata");
      const start = take(n);
      fields[id] = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, start + n));
    } else if (id === 7 && type === 12) {
      for (let detailType = byte(); detailType !== 0; detailType = byte()) {
        if (kind !== 0) throw new Error("x_chat_invalid_event_union");
        kind = short();
        if (detailType !== 12) throw new Error("x_chat_invalid_event_union");
        skip(detailType);
      }
    } else skip(type);
  }
  const sequenceId = fields[1] ?? "";
  const messageId = fields[2] ?? "";
  const senderId = fields[3] ?? "";
  const conversationId = fields[4] ?? "";
  const time = fields[6] ?? "";
  const date = new Date(Number(time));
  if (offset !== bytes.length || !/^[0-9]+$/.test(sequenceId) || !/^[0-9]+$/.test(time)
    || Number.isNaN(date.getTime()) || !conversationId || !kind || (kind === 1 && !messageId)) {
    throw new Error("x_chat_invalid_metadata");
  }
  return { sequenceId, messageId, senderId, conversationId, occurredAt: date.toISOString(), kind };
}
