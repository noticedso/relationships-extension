import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE,
  RECIPE_PATH,
  isValidScanRecipe,
  parseServedRecipes,
  recipeList,
  sourceOf,
  toRecipeRecord,
} from "../recipe-source";
import type { ScanRecipe } from "../storage";

function makeRecipe(over: Partial<ScanRecipe> = {}): ScanRecipe {
  return {
    source: "linkedin_extension",
    targetOrigin: "https://www.linkedin.com",
    listPathTemplate: "/api/connections?start={start}&count={count}",
    paginationParams: { pageSize: 40 },
    pacing: { maxPagesPerSession: 25, minDelayMs: 800, maxDelayMs: 2000 },
    csrfRule: { header: "csrf-token", cookie: "JSESSIONID" },
    fieldMap: {
      elementsPath: "elements",
      firstName: "m.firstName",
      lastName: "m.lastName",
      profileUrl: "m.publicIdentifier",
      headline: "m.headline",
    },
    ...over,
  } as ScanRecipe;
}

describe("recipe-source", () => {
  it("points at the first-party recipe endpoint the noticed connect page reads", () => {
    expect(RECIPE_PATH).toBe("/api/linkedin/extension/recipe");
  });

  describe("isValidScanRecipe", () => {
    it("accepts a well-formed recipe", () => {
      expect(isValidScanRecipe(makeRecipe())).toBe(true);
    });

    // The refresh path reads an HTTP response — a login redirect / HTML error page
    // / JSON error body must NEVER be stored over a good cached recipe.
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a string (an HTML error page)", "<!doctype html><title>Sign in</title>"],
      ["a number", 42],
      ["an empty object", {}],
      ["an API error body", { error: "unauthorized" }],
    ])("rejects %s", (_label, value) => {
      expect(isValidScanRecipe(value)).toBe(false);
    });

    it.each([
      ["targetOrigin missing", { targetOrigin: undefined }],
      ["targetOrigin not https", { targetOrigin: "http://www.linkedin.com" }],
      ["listPathTemplate missing", { listPathTemplate: "" }],
      ["pageSize not a number", { paginationParams: { pageSize: "40" } }],
      ["pageSize zero", { paginationParams: { pageSize: 0 } }],
      ["pacing missing", { pacing: undefined }],
      ["maxPagesPerSession zero", { pacing: { maxPagesPerSession: 0, minDelayMs: 1, maxDelayMs: 2 } }],
      ["csrfRule missing", { csrfRule: undefined }],
      ["csrfRule.cookie empty", { csrfRule: { header: "csrf-token", cookie: "" } }],
      ["fieldMap missing", { fieldMap: undefined }],
      ["fieldMap.elementsPath missing", { fieldMap: { profileUrl: "m.publicIdentifier" } }],
    ])("rejects a recipe with %s", (_label, over) => {
      expect(isValidScanRecipe(makeRecipe(over as Partial<ScanRecipe>))).toBe(false);
    });
  });

  describe("recipeList + toRecipeRecord (the ONE array → record mapping)", () => {
    it("prefers the per-source `recipes` ARRAY over the single `recipe`", () => {
      const li = makeRecipe();
      const x = makeRecipe({ source: "x", targetOrigin: "https://x.com" });
      expect(recipeList(li, [li, x])).toEqual([li, x]);
    });

    it("falls back to the single `recipe` when the array is absent/empty", () => {
      const li = makeRecipe();
      expect(recipeList(li, [])).toEqual([li]);
      expect(recipeList(li, null)).toEqual([li]);
      expect(recipeList(null, null)).toEqual([]);
    });

    it("keys the record by source, defaulting a source-less recipe", () => {
      const li = makeRecipe();
      const x = makeRecipe({ source: "x", targetOrigin: "https://x.com" });
      expect(toRecipeRecord([li, x])).toEqual({ linkedin_extension: li, x });

      const legacy = makeRecipe({ source: undefined });
      expect(sourceOf(legacy)).toBe(DEFAULT_SOURCE);
      expect(toRecipeRecord([legacy])).toEqual({ [DEFAULT_SOURCE]: legacy });
    });
  });

  describe("parseServedRecipes", () => {
    it("maps the served {recipe, recipes:[…]} body into the stored record shape", () => {
      const li = makeRecipe();
      const x = makeRecipe({ source: "x", targetOrigin: "https://x.com" });

      const parsed = parseServedRecipes({ recipe: li, recipes: [li, x], account: { plan: "free" } });

      expect(parsed).not.toBeNull();
      expect(parsed!.recipes).toEqual({ linkedin_extension: li, x });
      expect(parsed!.recipe).toEqual(li); // back-compat single recipe preserved
    });

    it("carries a NEW probe (a rotated queryId) straight through", () => {
      const fresh = makeRecipe({
        messages: {
          listPathTemplate: "/voyager/api/messaging/conversations?q=x",
          pageSize: 20,
          messageFieldMap: { mode: "participantConversations" },
          messageEvents: {
            urlTemplate: "/voyager/api/graphql?queryId=NEW_ROTATED_ID&urn={conversationUrn}",
            conversationUrnPath: "entityUrn",
            maxConversations: 25,
            jitterMinMs: 400,
            jitterMaxMs: 900,
          },
        },
      } as unknown as Partial<ScanRecipe>);

      const parsed = parseServedRecipes({ recipe: fresh, recipes: [fresh] });

      expect(parsed!.recipes.linkedin_extension!.messages!.messageEvents!.urlTemplate).toContain(
        "NEW_ROTATED_ID",
      );
    });

    // "null" is the contract for "keep the cached recipe".
    it.each([
      ["a non-object body", "<!doctype html>"],
      ["null", null],
      ["an empty body", {}],
      ["an error body", { error: "unauthorized" }],
      ["an empty recipes array with no recipe", { recipes: [] }],
      ["a malformed single recipe", { recipe: { targetOrigin: "https://x" } }],
    ])("returns null for %s (never overwrite a good cache)", (_label, body) => {
      expect(parseServedRecipes(body)).toBeNull();
    });

    it("is ATOMIC — one bad recipe in the array rejects the whole response", () => {
      const good = makeRecipe();
      const bad = { source: "x", targetOrigin: "https://x.com" }; // no pacing/csrf/fieldMap

      expect(parseServedRecipes({ recipe: good, recipes: [good, bad] })).toBeNull();
    });

    it("derives the single `recipe` from the array when the body omits it", () => {
      const li = makeRecipe();
      const parsed = parseServedRecipes({ recipes: [li] });
      expect(parsed!.recipe).toEqual(li);
    });
  });
});
