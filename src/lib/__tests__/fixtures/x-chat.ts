/** Synthetic Thrift binary fixtures. No production messages or keys. */
export function thriftString(id: number, value: string): Buffer {
  const data = Buffer.from(value);
  const header = Buffer.alloc(7);
  header[0] = 11;
  header.writeInt16BE(id, 1);
  header.writeInt32BE(data.length, 3);
  return Buffer.concat([header, data]);
}
export function thriftStruct(id: number, ...fields: Buffer[]): Buffer {
  const header = Buffer.alloc(3);
  header[0] = 12;
  header.writeInt16BE(id, 1);
  return Buffer.concat([header, ...fields, Buffer.from([0])]);
}
export function chatEvent(options: {
  sequence?: string; sender?: string; conversation?: string; time?: string; kind?: number;
} = {}): string {
  return Buffer.concat([
    thriftString(1, options.sequence ?? "100"),
    thriftString(2, "message-uuid"),
    thriftString(3, options.sender ?? "10"),
    thriftString(4, options.conversation ?? "10:20"),
    thriftString(5, "private-conversation-token"),
    thriftString(6, options.time ?? "1787304720000"),
    thriftStruct(7, thriftStruct(options.kind ?? 1, thriftString(100, "private-encrypted-message"))),
    Buffer.from([0]),
  ]).toString("base64");
}
