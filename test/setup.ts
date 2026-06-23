import { beforeEach, afterEach } from "vitest";
import { installChromeMock, resetChromeMock } from "./mocks/chrome";

// Build-time flag (esbuild `define` in build.mjs). Under test there's no esbuild
// define, so it resolves to this controllable global — default dev so the
// dev-only affordances are exercised; individual tests may override it.
beforeEach(() => {
  installChromeMock();
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = true;
});

afterEach(() => {
  resetChromeMock();
});
