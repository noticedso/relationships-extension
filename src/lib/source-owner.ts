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

type SourceOwner = { memberId: string; username: string };

/** A session cookie may be re-issued this many times in one scan step. */
export const MAX_SESSION_ROTATIONS = 3;

export interface SessionRotationOptions {
  /** CSRF headers for the owner re-read. */
  headers: () => Record<string, string>;
  /** The owner this scan is bound to, once known. */
  owner: () => SourceOwner | undefined;
  /** Persists the adopted session hash so a resumed step accepts it. */
  onRotate?: (sessionHash: string) => Promise<void>;
}

/**
 * Credentials remain in Chrome; a changed session cannot contribute to an old
 * checkpoint. Sites re-issue their session cookie for the SAME signed-in
 * account (LinkedIn refreshes `li_at` after the browser sleeps), so a changed
 * cookie is not by itself an account switch: the owner is read again, and the
 * new session is adopted only when it still belongs to the scan's owner.
 */
export async function bindSourceSession(
  recipe: ScanRecipe,
  state: Partial<State>,
  fetchImpl: typeof fetch,
  rotation?: SessionRotationOptions,
): Promise<{ fetch: typeof fetch; sessionHash?: string }> {
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
  let expected = await sessionHash();
  let rotations = 0;
  // Adopt a re-issued session only after proving it is still the scan's owner.
  // Without a known owner there is nothing collected to protect yet (a fresh
  // scan reads its owner next, and the final owner check compares against it).
  const adopt = async (next: string, known: SourceOwner | undefined) => {
    if (!rotation || ++rotations > MAX_SESSION_ROTATIONS) throw new SourceAccountError("changed");
    if (known) assertSourceOwner(known, await readSourceOwner(recipe, rotation.headers(), fetchImpl));
    if (await sessionHash() !== next) throw new SourceAccountError("changed");
    expected = next;
    await rotation.onRotate?.(next);
  };
  if (!state.scanSourceSessionHash && ((state.scanItems?.length ?? 0) > 0 || (state.scanPhaseIndex ?? 0) > 0))
    throw new SourceAccountError("unproven");
  if (state.scanSourceSessionHash && state.scanSourceSessionHash !== expected) {
    // A resumed step must prove its stored owner before reusing a checkpoint.
    if (!state.scanOwnerAccount) throw new SourceAccountError("changed");
    await adopt(expected, state.scanOwnerAccount);
  }
  const verify = async () => {
    const current = await sessionHash();
    if (current !== expected) await adopt(current, rotation?.owner());
  };
  return { sessionHash: expected, fetch: async (input, init) => {
    await verify();
    const response = await fetchImpl(input, init);
    await verify();
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
