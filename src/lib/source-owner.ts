import { getByPath } from "./recipe";
import type { ScanRecipe, State } from "./storage";

export class SourceAccountError extends Error {
  constructor(readonly reason: "changed" | "unavailable" | "unproven") {
    super(`source_account_${reason}`);
  }
}

export async function readSourceOwner(
  recipe: ScanRecipe, headers: Record<string, string>, fetchImpl: typeof fetch,
): Promise<{ memberId: string; username: string }> {
  const spec = recipe.ownerAccountSource!;
  try {
    const res = await fetchImpl(recipe.targetOrigin + spec.listPathTemplate,
    { credentials: "include", cache: "no-store", headers });
    if (!res.ok) throw new SourceAccountError("unavailable");
    const json = await res.json();
    const memberId = String(getByPath(json, spec.idPath) ?? "").split(":").pop()?.trim() ?? "";
    const username = String(getByPath(json, spec.usernamePath) ?? "").trim().toLowerCase();
    if (!memberId || !username) throw new SourceAccountError("unavailable");
    return { memberId, username };
  } catch (error) {
    if (error instanceof SourceAccountError) throw error;
    throw new SourceAccountError("unavailable");
  }
}

export function assertSourceOwner(expected: { memberId: string; username: string }, actual: { memberId: string; username: string }): void {
  if (expected.memberId !== actual.memberId || expected.username !== actual.username)
    throw new SourceAccountError("changed");
}

/** Credentials remain in Chrome; a changed session cannot contribute to an old checkpoint. */
export async function bindSourceSession(recipe: ScanRecipe, state: Partial<State>, fetchImpl: typeof fetch):
  Promise<{ fetch: typeof fetch; sessionHash?: string }> {
  const name = recipe.ownerAccountSource?.sessionCookie;
  if (!name) return { fetch: fetchImpl };
  const sessionHash = async () => {
    try {
      const cookie = await chrome.cookies.get({ url: recipe.targetOrigin, name });
      if (!cookie?.value) throw new SourceAccountError("unavailable");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookie.value));
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    } catch (error) {
      if (error instanceof SourceAccountError) throw error;
      throw new SourceAccountError("unavailable");
    }
  };
  const expected = await sessionHash();
  if (state.scanSourceSessionHash && state.scanSourceSessionHash !== expected)
    throw new SourceAccountError("changed");
  if (!state.scanSourceSessionHash && ((state.scanItems?.length ?? 0) > 0 || (state.scanPhaseIndex ?? 0) > 0))
    throw new SourceAccountError("unproven");
  return { sessionHash: expected, fetch: async (input, init) => {
    if (await sessionHash() !== expected) throw new SourceAccountError("changed");
    const response = await fetchImpl(input, init);
    if (await sessionHash() !== expected) throw new SourceAccountError("changed");
    return response;
  } };
}

export function sourceAccountFailureMessage(error: SourceAccountError): string {
  return error.reason === "changed"
    ? "The signed-in network account changed. Sign in to the original account and retry."
    : error.reason === "unproven"
      ? "This scan's network account could not be verified. Start a new scan."
      : "We couldn't verify the signed-in network account. Sign in to the network and retry.";
}
