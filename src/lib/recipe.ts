export type ScanConnection = {
  profileUrl: string;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  connectedOn: string | null;
};

export type FieldMap = {
  elementsPath: string;
  firstName: string;
  lastName: string;
  profileUrl: string;
  headline: string;
  connectedOn?: string;
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
    });
  }
  return out;
}
