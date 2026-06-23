import { describe, it, expect } from "vitest";
import { applyFieldMap, getByPath } from "../recipe";

const fieldMap = {
  elementsPath: "elements",
  firstName: "m.firstName",
  lastName: "m.lastName",
  profileUrl: "m.publicIdentifier",
  headline: "m.headline",
  connectedOn: "createdAt",
};

describe("getByPath", () => {
  it("reads nested dotted paths and is undefined-safe", () => {
    expect(getByPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getByPath({}, "a.b")).toBeUndefined();
    expect(getByPath(null, "a.b")).toBeUndefined();
  });
});

describe("applyFieldMap", () => {
  it("normalizes one page into typed connections (epoch-ms → YYYY-MM-DD)", () => {
    const page = { elements: [{ m: { firstName: "Jane", lastName: "Doe", publicIdentifier: "jane-9", headline: "PM" }, createdAt: 1707091200000 }] };
    const out = applyFieldMap(page, fieldMap as any);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ firstName: "Jane", lastName: "Doe", profileUrl: "jane-9", headline: "PM" });
    expect(out[0].connectedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("passes through an ISO connectedOn string unchanged and accepts missing fields as null", () => {
    const page = { elements: [{ m: { publicIdentifier: "x" }, createdAt: "2024-02-17" }] };
    const out = applyFieldMap(page, fieldMap as any);
    expect(out[0]).toMatchObject({ profileUrl: "x", firstName: null, lastName: null, headline: null, connectedOn: "2024-02-17" });
  });

  it("drops elements that have no profileUrl", () => {
    const page = { elements: [{ m: { firstName: "NoId" } }, { m: { publicIdentifier: "keep" } }] };
    const out = applyFieldMap(page, fieldMap as any);
    expect(out).toHaveLength(1);
    expect(out[0].profileUrl).toBe("keep");
  });

  it("returns [] when the elements path is absent", () => {
    expect(applyFieldMap({}, fieldMap as any)).toEqual([]);
  });

  it("yields null for an invalid/NaN epoch instead of throwing", () => {
    const page = { elements: [{ m: { publicIdentifier: "x" }, createdAt: NaN }, { m: { publicIdentifier: "y" }, createdAt: Number.POSITIVE_INFINITY }] };
    const out = applyFieldMap(page, fieldMap as any);
    expect(out.map((c) => c.connectedOn)).toEqual([null, null]);
  });
});

// Locks the live contract validated in C1 (2026-06-22) against a real logged-in
// session: the production field map applied to the REAL non-normalized Voyager
// connections element shape. If the upstream schema rotates, this test trips.
describe("live connections contract (C1)", () => {
  // The production field map served by noticed (mirrors extension-recipe.ts fieldMap).
  const PROD_FIELD_MAP = {
    elementsPath: "elements",
    firstName: "connectedMemberResolutionResult.firstName",
    lastName: "connectedMemberResolutionResult.lastName",
    profileUrl: "connectedMemberResolutionResult.publicIdentifier",
    headline: "connectedMemberResolutionResult.headline",
    connectedOn: "createdAt",
  };

  // Real element shape captured from the live endpoint (values anonymized).
  const realPage = {
    paging: { count: 2, start: 0 },
    elements: [
      {
        connectedMemberResolutionResult: {
          firstName: "Sample",
          lastName: "Person",
          headline: "Creative media and marketing specialist",
          publicIdentifier: "sample-person-296389207",
          entityUrn: "urn:li:fsd_profile:ACoAADxxxx",
        },
        createdAt: 1781820040000,
        connectedMember: "urn:li:fsd_profile:ACoAADxxxx",
        entityUrn: "urn:li:fsd_connection:ACoAADxxxx",
        $recipeType: "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile",
      },
    ],
  };

  it("maps the real Voyager connection element to a ScanConnection", () => {
    const out = applyFieldMap(realPage, PROD_FIELD_MAP as any);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      firstName: "Sample",
      lastName: "Person",
      headline: "Creative media and marketing specialist",
      profileUrl: "sample-person-296389207",
    });
    // epoch-ms createdAt → YYYY-MM-DD
    expect(out[0].connectedOn).toBe("2026-06-18");
  });
});
