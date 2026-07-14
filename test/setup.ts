import { beforeEach, afterEach, vi } from "vitest";
import { installChromeMock, resetChromeMock } from "./mocks/chrome";

// Build-time flag (esbuild `define` in build.mjs). Under test there's no esbuild
// define, so it resolves to this controllable global — default dev so the
// dev-only affordances are exercised; individual tests may override it.
beforeEach(() => {
  installChromeMock();
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = true;

  // Tests never touch a real browser — and never a real network either. Default
  // `fetch` to a hard failure so an un-stubbed request can't silently escape to
  // the internet (the service worker now GETs the recipe endpoint at scan start;
  // a test that doesn't stub it must see the offline fallback, not app.noticed.so).
  // Tests that care override globalThis.fetch themselves.
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => {
    throw new Error("network disabled in tests: stub globalThis.fetch");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  resetChromeMock();
});
