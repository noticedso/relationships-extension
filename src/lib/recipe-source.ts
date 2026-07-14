/**
 * Where scan recipes COME FROM, and how a served response becomes stored state.
 *
 * Recipes are served live by noticed so endpoint drift (LinkedIn rotates its
 * GraphQL `queryId`s) can be fixed server-side without shipping a new extension.
 * They reach the extension by two paths:
 *
 *   1. `pair` — a first-party noticed page GETs `RECIPE_PATH` and hands the body
 *      to the service worker over `chrome.runtime.sendMessage`.
 *   2. the START of a scan — the service worker GETs `RECIPE_PATH` itself (the
 *      required `https://*.noticed.so/*` host permission + `credentials:"include"`
 *      carry the user's session), so a scan never runs on a stale recipe.
 *
 * Both paths land on `toRecipeRecord(recipeList(...))` — ONE mapping from the
 * served shape (`recipes` is an ARRAY) to the stored shape (a RECORD keyed by
 * source), so the two can never drift.
 */
import type { ScanRecipe } from "./storage";

/** The first-party endpoint that serves the live scan recipes. */
export const RECIPE_PATH = "/api/linkedin/extension/recipe";

/** Source key for a recipe that predates the multi-network `source` field. */
export const DEFAULT_SOURCE = "linkedin_extension";

export function sourceOf(recipe: ScanRecipe): string {
  return recipe.source ?? DEFAULT_SOURCE;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Loose structural guard for a served recipe. Deliberately checks only the
 * fields a scan cannot run without — it is a garbage filter, not a schema.
 *
 * The refresh path reads an HTTP response, which (unlike the origin-gated `pair`
 * message) can be a login redirect, an HTML error page, or a JSON error body. A
 * response that fails this guard must never overwrite a good cached recipe —
 * that would turn a transient server hiccup into a permanently broken scan.
 */
export function isValidScanRecipe(value: unknown): value is ScanRecipe {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;

  if (!isNonEmptyString(r.targetOrigin) || !r.targetOrigin.startsWith("https://")) return false;
  if (!isNonEmptyString(r.listPathTemplate)) return false;

  const pagination = r.paginationParams as Record<string, unknown> | undefined;
  if (!pagination || !isFiniteNumber(pagination.pageSize) || pagination.pageSize <= 0) return false;

  const pacing = r.pacing as Record<string, unknown> | undefined;
  if (!pacing) return false;
  if (!isFiniteNumber(pacing.maxPagesPerSession) || pacing.maxPagesPerSession <= 0) return false;
  if (!isFiniteNumber(pacing.minDelayMs) || !isFiniteNumber(pacing.maxDelayMs)) return false;

  const csrf = r.csrfRule as Record<string, unknown> | undefined;
  if (!csrf || !isNonEmptyString(csrf.header) || !isNonEmptyString(csrf.cookie)) return false;

  const fieldMap = r.fieldMap as Record<string, unknown> | undefined;
  if (!fieldMap || !isNonEmptyString(fieldMap.elementsPath) || !isNonEmptyString(fieldMap.profileUrl)) {
    return false;
  }

  return true;
}

/**
 * The served `{recipe, recipes}` pair → a flat list. `recipes` (the per-source
 * ARRAY) wins when present; the single `recipe` is the back-compat fallback.
 */
export function recipeList(
  recipe: ScanRecipe | undefined | null,
  recipes?: readonly ScanRecipe[] | null,
): ScanRecipe[] {
  if (recipes && recipes.length > 0) return recipes.filter(Boolean);
  return recipe ? [recipe] : [];
}

/** A recipe list → the stored per-source RECORD (last one wins per source). */
export function toRecipeRecord(list: readonly ScanRecipe[]): Record<string, ScanRecipe> {
  const out: Record<string, ScanRecipe> = {};
  for (const r of list) if (r) out[sourceOf(r)] = r;
  return out;
}

/**
 * Parse + validate a `RECIPE_PATH` response body into the stored shape.
 *
 * ATOMIC: if ANY served recipe fails validation the whole response is rejected
 * (`null`) rather than storing a partial set — a half-applied refresh could drop
 * a source or leave one network on a stale recipe, which is harder to reason
 * about than simply keeping the cache. `null` always means "keep what you have".
 */
export function parseServedRecipes(
  body: unknown,
): { recipe: ScanRecipe; recipes: Record<string, ScanRecipe> } | null {
  if (!body || typeof body !== "object") return null;
  const { recipe, recipes } = body as { recipe?: unknown; recipes?: unknown };

  const list = recipeList(
    recipe as ScanRecipe | undefined,
    Array.isArray(recipes) ? (recipes as ScanRecipe[]) : null,
  );
  if (list.length === 0) return null;
  if (!list.every(isValidScanRecipe)) return null;

  const record = toRecipeRecord(list);
  // Keep the back-compat single `recipe` pointing at the served one when it is
  // itself valid, else at the default source (else the first served recipe).
  const single = isValidScanRecipe(recipe)
    ? recipe
    : (record[DEFAULT_SOURCE] ?? list[0]!);

  return { recipe: single, recipes: record };
}
