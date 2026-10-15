import { describe, expect, it } from "vitest";
import {
  SCAN_NOW_ERRORS,
  parseScanNowResponse,
} from "../website-scan-contract";

describe("website scan protocol v1", () => {
  it.each(["started", "already_running"])(
    "accepts %s acknowledgement",
    (status) => {
      expect(parseScanNowResponse({ ok: true, status })).toEqual({
        ok: true,
        status,
      });
    },
  );
  it.each(SCAN_NOW_ERRORS)("accepts defined failure %s", (error) => {
    expect(parseScanNowResponse({ ok: false, error })).toEqual({
      ok: false,
      error,
    });
  });
  it.each([
    null,
    {},
    { ok: "yes", status: "started" },
    { ok: true, status: "future" },
    { ok: false, error: "future" },
  ])("leaves unknown replies unconfirmed: %j", (reply) => {
    expect(parseScanNowResponse(reply)).toBeNull();
  });
});
