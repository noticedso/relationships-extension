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

  it("pictureUrl is null for a field map without the picture paths (back-compat)", () => {
    const page = { elements: [{ m: { publicIdentifier: "x" } }] };
    const out = applyFieldMap(page, fieldMap as any);
    expect(out[0].pictureUrl).toBeNull();
  });
});

describe("applyFieldMap picture composition", () => {
  const pictureFieldMap = {
    elementsPath: "elements",
    firstName: "m.firstName",
    lastName: "m.lastName",
    profileUrl: "m.publicIdentifier",
    headline: "m.headline",
    pictureRootUrl: "m.profilePicture.displayImageReference.vectorImage.rootUrl",
    pictureArtifactsPath: "m.profilePicture.displayImageReference.vectorImage.artifacts",
  };

  it("composes the width-400 artifact onto the root url", () => {
    const page = {
      elements: [
        {
          m: {
            publicIdentifier: "pic-1",
            profilePicture: {
              displayImageReference: {
                vectorImage: {
                  rootUrl: "https://media.example/dms/image/x/photo_",
                  artifacts: [
                    { width: 100, fileIdentifyingUrlPathSegment: "100" },
                    { width: 400, fileIdentifyingUrlPathSegment: "400seg" },
                    { width: 800, fileIdentifyingUrlPathSegment: "800" },
                  ],
                },
              },
            },
          },
        },
      ],
    };
    const out = applyFieldMap(page, pictureFieldMap as any);
    expect(out[0].pictureUrl).toBe("https://media.example/dms/image/x/photo_400seg");
  });

  it("falls back to the largest artifact when 400 is absent", () => {
    const page = {
      elements: [
        {
          m: {
            publicIdentifier: "pic-2",
            profilePicture: {
              displayImageReference: {
                vectorImage: {
                  rootUrl: "https://media.example/r_",
                  artifacts: [
                    { width: 100, fileIdentifyingUrlPathSegment: "100" },
                    { width: 800, fileIdentifyingUrlPathSegment: "800seg" },
                  ],
                },
              },
            },
          },
        },
      ],
    };
    const out = applyFieldMap(page, pictureFieldMap as any);
    expect(out[0].pictureUrl).toBe("https://media.example/r_800seg");
  });

  it("pictureUrl is null when the connection has no profile picture", () => {
    const page = { elements: [{ m: { publicIdentifier: "pic-3" } }] };
    const out = applyFieldMap(page, pictureFieldMap as any);
    expect(out[0].pictureUrl).toBeNull();
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
    pictureRootUrl: "connectedMemberResolutionResult.profilePicture.displayImageReference.vectorImage.rootUrl",
    pictureArtifactsPath: "connectedMemberResolutionResult.profilePicture.displayImageReference.vectorImage.artifacts",
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
          profilePicture: {
            displayImageReference: {
              vectorImage: {
                rootUrl: "https://media.example/dms/image/x/photo_",
                artifacts: [
                  { width: 100, fileIdentifyingUrlPathSegment: "100" },
                  { width: 400, fileIdentifyingUrlPathSegment: "400seg" },
                  { width: 800, fileIdentifyingUrlPathSegment: "800" },
                ],
              },
            },
          },
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
    // vector image composed at width 400
    expect(out[0].pictureUrl).toBe("https://media.example/dms/image/x/photo_400seg");
  });
});
