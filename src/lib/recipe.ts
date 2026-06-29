export type ScanConnection = {
  profileUrl: string;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  connectedOn: string | null;
  pictureUrl: string | null;
  /** A stable external id (X rest_id) when profileUrl is a handle. Null elsewhere. */
  externalId?: string | null;
};

export type FieldMap = {
  elementsPath: string;
  firstName: string;
  lastName: string;
  profileUrl: string;
  headline: string;
  connectedOn?: string;
  pictureRootUrl?: string;
  pictureArtifactsPath?: string;
  externalId?: string;
};

export function getByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function toConnectedOn(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}

function composePictureUrl(element: unknown, fieldMap: FieldMap): string | null {
  if (!fieldMap.pictureRootUrl || !fieldMap.pictureArtifactsPath) return null;
  const root = toStringOrNull(getByPath(element, fieldMap.pictureRootUrl));
  const arts = getByPath(element, fieldMap.pictureArtifactsPath);
  if (!root || !Array.isArray(arts) || arts.length === 0) return null;

  let chosen: unknown = null;
  let bestWidth = -Infinity;
  for (const art of arts) {
    const width = (art as Record<string, unknown>)?.width;
    if (typeof width !== "number") continue;
    if (width === 400) {
      chosen = art;
      break;
    }
    if (width > bestWidth) {
      bestWidth = width;
      chosen = art;
    }
  }
  if (chosen === null) return null;

  const seg = toStringOrNull(getByPath(chosen, "fileIdentifyingUrlPathSegment"));
  return root && seg ? root + seg : null;
}

// ── Message metadata (NT-44/NT-45) ───────────────────────────────────────────

/**
 * 1:1 conversation METADATA — the only message shape that ever leaves the
 * extension. There is no content field, so message text cannot be captured.
 */
export type ScanMessage = {
  counterpartProfileUrl: string;
  lastMessageAt: string; // ISO 8601
  direction: "sent" | "received";
};

/**
 * Element-relative paths into a conversation-list response. NO content path
 * exists by design. `lastSenderIdPath` + the owner's `selfId` derive direction;
 * `participantIdsPath` (distinct senders in the conversation) drives the
 * "never replied" exclusion.
 */
export type MessageFieldMap = {
  elementsPath: string;
  counterpartIdPath: string;
  lastMessageAtPath: string;
  lastSenderIdPath: string;
  participantIdsPath?: string;
  counterpartUrlPrefix?: string;
};

/** Epoch-ms (number or numeric string) or an ISO/date string → ISO 8601, or null. */
export function toIso(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const t = value.trim();
    const d = /^\d+$/.test(t) ? new Date(Number(t)) : new Date(t);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * Map a conversation-list page → ScanMessage[]. `selfId` is the owner's own id
 * (so direction can be derived); `excludeUnreplied` drops one-sided
 * conversations (only one participant ever sent — the X "never replied" rule).
 */
export function applyMessageFieldMap(
  page: unknown,
  fieldMap: MessageFieldMap,
  selfId: string,
  excludeUnreplied: boolean,
): ScanMessage[] {
  // Conversation lists come as arrays (LinkedIn) OR a keyed object/map (X's
  // inbox_initial_state.conversations) — normalize both to a list of elements.
  const raw = getByPath(page, fieldMap.elementsPath);
  const elements = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>)
      : null;
  if (!elements) return [];

  const out: ScanMessage[] = [];
  for (const el of elements) {
    const counterpartId = toStringOrNull(getByPath(el, fieldMap.counterpartIdPath));
    if (!counterpartId) continue;
    const lastMessageAt = toIso(getByPath(el, fieldMap.lastMessageAtPath));
    if (!lastMessageAt) continue;

    if (excludeUnreplied && fieldMap.participantIdsPath) {
      const senders = getByPath(el, fieldMap.participantIdsPath);
      const unique = Array.isArray(senders)
        ? new Set(senders.map((s) => String(s)))
        : new Set<string>();
      if (unique.size < 2) continue; // one-sided → never replied, exclude
    }

    const lastSenderId = toStringOrNull(getByPath(el, fieldMap.lastSenderIdPath));
    const direction: "sent" | "received" =
      lastSenderId !== null && lastSenderId === selfId ? "sent" : "received";
    out.push({
      counterpartProfileUrl: fieldMap.counterpartUrlPrefix
        ? fieldMap.counterpartUrlPrefix + counterpartId
        : counterpartId,
      lastMessageAt,
      direction,
    });
  }
  return out;
}

export function applyFieldMap(page: unknown, fieldMap: FieldMap): ScanConnection[] {
  const elements = getByPath(page, fieldMap.elementsPath);
  if (!Array.isArray(elements)) return [];

  const out: ScanConnection[] = [];
  for (const element of elements) {
    const profileUrl = toStringOrNull(getByPath(element, fieldMap.profileUrl));
    if (!profileUrl) continue;

    out.push({
      profileUrl,
      firstName: toStringOrNull(getByPath(element, fieldMap.firstName)),
      lastName: toStringOrNull(getByPath(element, fieldMap.lastName)),
      headline: toStringOrNull(getByPath(element, fieldMap.headline)),
      connectedOn: fieldMap.connectedOn
        ? toConnectedOn(getByPath(element, fieldMap.connectedOn))
        : null,
      pictureUrl: composePictureUrl(element, fieldMap),
      externalId: fieldMap.externalId
        ? toStringOrNull(getByPath(element, fieldMap.externalId))
        : null,
    });
  }
  return out;
}
