/** Website scan protocol v1. Keep this file identical in noticed and relationships-extension. */
export const WEBSITE_SCAN_CAPABILITIES = {
  websiteScan: 1,
  linkedinSourceAccount: 1,
} as const;
export const SCAN_NOW_ERRORS = [
  "account_mismatch",
  "unsupported_source",
  "not_connected",
  "source_busy",
  "permission_required",
  "network_signin_required",
  "request_failed",
] as const;
export type ScanNowError = (typeof SCAN_NOW_ERRORS)[number];
export type ScanNowRequest = {
  type: "scanNow";
  source: "linkedin_extension";
  accountId: string;
};
export type ScanNowResponse =
  | { ok: true; status: "started" | "already_running" }
  | { ok: false; error: ScanNowError };

/** Unknown/new replies remain unconfirmed rather than becoming a false success. */
export function parseScanNowResponse(value: unknown): ScanNowResponse | null {
  if (!value || typeof value !== "object") return null;
  const reply = value as Record<string, unknown>;
  if (
    reply.ok === true &&
    (reply.status === "started" || reply.status === "already_running")
  )
    return { ok: true, status: reply.status };
  if (
    reply.ok === false &&
    SCAN_NOW_ERRORS.includes(reply.error as ScanNowError)
  )
    return { ok: false, error: reply.error as ScanNowError };
  return null;
}
