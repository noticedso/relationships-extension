import type { ScanConnection } from "./recipe";

/** Recipe shape the orchestrator needs. Site specifics live here, never in code. */
export type ScanRecipe = {
  targetOrigin: string;
  listPathTemplate: string;
  paginationParams: { pageSize: number };
  pacing: { maxPagesPerSession: number; minDelayMs: number; maxDelayMs: number };
  csrfRule: { header: string; cookie: string };
  fieldMap: {
    elementsPath: string;
    firstName: string;
    lastName: string;
    profileUrl: string;
    headline: string;
    connectedOn?: string;
    pictureRootUrl?: string;
    pictureArtifactsPath?: string;
  };
  /** Source values to hide from the sync history (recipe-driven, set at pair time). */
  excludeSources?: string[];
};

export type Account = {
  id: string;
  displayName?: string;
  [key: string]: unknown;
};

export type Needs = "network-signin" | "noticed-signin" | null;

export type State = {
  recipe: ScanRecipe | null;
  account: Account | null;
  noticedOrigin: string | null;
  pendingScan: ScanConnection[] | null;
  lastScanAt: number | null;
  lastScanCount: number | null;
  /** When the most recent automatic scan hit the network — drives the once-per-period throttle. */
  lastScanStartedAt: number | null;
  needs: Needs;
  testMode?: boolean;
};

const KEYS: (keyof State)[] = [
  "recipe",
  "account",
  "noticedOrigin",
  "pendingScan",
  "lastScanAt",
  "lastScanCount",
  "lastScanStartedAt",
  "needs",
  "testMode",
];

/** Typed read of the full stored state (any unset key is simply absent). */
export async function getState(): Promise<Partial<State>> {
  const raw = await chrome.storage.local.get(KEYS as string[]);
  return raw as Partial<State>;
}

/** Typed partial write. */
export async function setState(patch: Partial<State>): Promise<void> {
  await chrome.storage.local.set(patch as Record<string, unknown>);
}
