// popup.ts — the user-facing trust surface for the relationships extension.
//
// It renders the user's noticed account, when the next sync runs, what we
// read and how, and how the data is kept private. The network name is NEVER
// hard-coded here: it is always rendered at runtime from
// `status.recipe.networkLabel`, so this extension stays platform-agnostic.

const REPO_URL = "https://github.com/noticedso/relationships-extension";
const LATEST_RELEASE_API = "https://api.github.com/repos/noticedso/relationships-extension/releases/latest";
// The "update available" notice sends users to the Chrome Web Store listing (the
// canonical install/update surface), not the raw GitHub .zip — store installs
// auto-update, and anyone behind gets the one-click store update from here.
const WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/noticed%20Relationships/hjckpjgbhjichgkbmgjfbbdibchghdaf";

// Numeric semver compare. Strips a leading "v", splits on ".", compares parts.
// Returns >0 if a is newer than b, <0 if older, 0 if equal.
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((p) => Number.parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Best-effort: ask GitHub for the latest release and reveal an "update available"
// notice when the installed version is behind. For GitHub / load-unpacked users
// who don't auto-update. The releases API returns `Access-Control-Allow-Origin: *`,
// so this works from a popup with no host permission. Never throws.
async function checkForUpdate(root: Document | HTMLElement): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.getManifest) return;
  const notice = root.querySelector<HTMLAnchorElement>("#update-notice");
  if (!notice) return;
  try {
    const installed = chrome.runtime.getManifest().version;
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { tag_name?: string };
    const latest = data?.tag_name;
    if (!latest || typeof latest !== "string") return;
    if (compareSemver(latest, installed) > 0) {
      notice.href = WEB_STORE_URL;
      notice.hidden = false;
    }
  } catch {
    // best-effort — leave the notice hidden on any fetch/parse error
  }
}

// E6: a persistent version indicator at the bottom of the panel that ALWAYS shows
// the installed version (e.g. "v1.0.3"), independent of the best-effort update check.
// Source: the manifest version. Guarded so it no-ops in non-extension/test contexts
// without a manifest. Never throws.
function setVersion(root: Document | HTMLElement): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.getManifest) return;
  const el = root.querySelector<HTMLElement>("#version");
  if (!el) return;
  try {
    el.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    // best-effort — leave the indicator empty on any error
  }
}

const NOTICED_ORIGIN = "https://www.noticed.so";
function openConnect(): void {
  const url = `${NOTICED_ORIGIN}/x/connect?ext_id=${chrome.runtime.id}`;
  if (chrome.tabs?.create) void chrome.tabs.create({ url });
  else window.open(url, "_blank");
}
function wireOnce(el: HTMLElement | null, fn: () => void): void {
  if (el && el.dataset.wired !== "1") {
    el.dataset.wired = "1";
    el.addEventListener("click", fn);
  }
}

// E4: a single source of truth for "show the noticed Sign-in button". A noticed
// sign-in can be signalled from EITHER getStatus (`status.needs`) OR getSyncHistory
// (`history.needs`, the /api/sync/runs 401 path); historically only the latter
// revealed the button, so a user could see the red "finish syncing" text with no
// way to act on it. When needed, we reveal + wire the actionable button (openConnect)
// and clear the dangling red text — the button is the affordance. When not needed,
// we hide the button and leave any other (e.g. network-signin) text in place.
function applyNoticedSigninState(root: Document | HTMLElement, needsNoticedSignin: boolean): void {
  const signin = root.querySelector<HTMLButtonElement>("#signin-cta");
  if (needsNoticedSignin) {
    if (signin) signin.hidden = false;
    wireOnce(signin, openConnect);
    // The button replaces the standalone red text so it never dangles alone.
    setText(root, "needs", "");
  } else if (signin) {
    signin.hidden = true;
  }
}

// Replaced at build time by esbuild (`define`): true only for local-development
// builds (EXT_DEV=1), false in the published artifact. `typeof` guard keeps it
// safe under test, where it resolves to a controllable global instead.
declare const __DEV__: boolean;
function isDevBuild(): boolean {
  return typeof __DEV__ !== "undefined" && __DEV__ === true;
}

type SourceStatus = {
  source: string;
  networkLabel?: string;
  targetOrigin?: string;
  granted?: boolean;
};

type Status = {
  account?: { name?: string; email?: string } | null;
  recipe?: { networkLabel?: string; targetOrigin?: string } | null;
  // Per-source view (NT-45 multi-network). Absent on legacy SWs → fall back to recipe.
  sources?: SourceStatus[] | null;
  nextScanAt?: number | null;
  lastScanAt?: number | null;
  lastScanCount?: number | null;
  needs?: string | null;
  testMode?: boolean | null;
  // Progress (E2): set by the SW while a checkpoint-and-resume scan is running.
  scanning?: boolean | null;
  scannedCount?: number | null;
};

/** Origins of every paired source, or just the recipe's (legacy single-source). */
function sourceOrigins(status: Status): string[] {
  if (status.sources && status.sources.length > 0) {
    return status.sources.map((s) => s.targetOrigin).filter((o): o is string => Boolean(o));
  }
  return status.recipe?.targetOrigin ? [status.recipe.targetOrigin] : [];
}

/** Human network labels of every paired source, or the recipe's (legacy single). */
function sourceLabels(status: Status): string[] {
  if (status.sources && status.sources.length > 0) {
    return status.sources.map((s) => s.networkLabel).filter((l): l is string => Boolean(l));
  }
  return status.recipe?.networkLabel ? [status.recipe.networkLabel] : [];
}

// A human, localized "A and B" join of the paired network labels, with a generic
// fallback when none are known. Used by both the fetch disclosure and the grant
// explainer so they name the same networks — always from runtime status (their
// networkLabel), never a hard-coded platform literal, so the purity guard stays
// green.
function networkList(status: Status): string {
  const labels = sourceLabels(status);
  return labels.length > 0
    ? new Intl.ListFormat(undefined, { style: "long", type: "conjunction" }).format(labels)
    : "professional network";
}

// The "grant access" explainer: spell out what the one-time host permission
// actually does, naming the paired networks.
function grantExplainerText(status: Status): string {
  const list = networkList(status);
  return (
    `“grant access” lets this extension read your ${list} connections and profiles — ` +
    `names, headlines, and profile links — and hand them to your signed-in noticed tab. ` +
    `it's a one-time browser permission, and you can revoke it anytime.`
  );
}

function setText(root: Document | HTMLElement, id: string, text: string): void {
  const el = root.querySelector<HTMLElement>(`#${id}`);
  if (el) el.textContent = text;
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(ms));
}

// The "last sync" line: a count + date when we have one, else "no sync yet".
function setLastScanLine(
  root: Document | HTMLElement,
  lastScanAt: number | null,
  lastScanCount: number | null,
): void {
  if (lastScanAt != null) {
    const count = lastScanCount ?? 0;
    setText(root, "last-scan", `${count} connections synced — ${formatDate(lastScanAt)}`);
  } else {
    setText(root, "last-scan", "no sync yet");
  }
}

type SyncRun = {
  source: string;
  label?: string;
  kind?: string | null;
  itemCount?: number | null;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
};

type SyncHistory = { runs?: SyncRun[]; needs?: string };

// These can be reached by a polling tick (pollScanProgress) that outlives the
// page/context, so guard against the extension API having gone away.
async function getStatus(): Promise<Status> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return {};
  return (await chrome.runtime.sendMessage({ type: "getStatus" })) as Status;
}

async function getSyncHistory(): Promise<SyncHistory> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return { runs: [] };
  return (await chrome.runtime.sendMessage({ type: "getSyncHistory" })) as SyncHistory;
}

// Render a source value into a human label WITHOUT any hard-coded platform
// name: split on "_", title-case each word, rejoin. The source string is
// runtime data from the server, never a literal in this bundle, so the
// platform-name purity guard stays satisfied.
function prettifySource(source: string): string {
  return source
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function renderSyncs(root: Document | HTMLElement, runs: SyncRun[]): void {
  const list = root.querySelector<HTMLElement>("#sync-list");
  const empty = root.querySelector<HTMLElement>("#sync-empty");
  const more = root.querySelector<HTMLButtonElement>("#sync-more");
  if (!list || !empty || !more) return;

  if (runs.length === 0) {
    list.replaceChildren();
    empty.hidden = false;
    more.hidden = true;
    return;
  }
  empty.hidden = true;

  const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const buildRow = (r: SyncRun): HTMLLIElement => {
    const li = document.createElement("li");
    li.className = "sync-row";
    const stamp = r.finishedAt ?? r.startedAt;
    let when = "";
    if (stamp) {
      const d = new Date(stamp);
      if (!Number.isNaN(d.getTime())) when = dateFmt.format(d);
    }
    const count = typeof r.itemCount === "number" ? `${r.itemCount} ` : "";
    li.textContent = `${r.label ?? prettifySource(r.source)} · ${count}${r.kind ?? "items"}${when ? ` · ${when}` : ""}`;
    if (r.status && r.status !== "succeeded") li.dataset.status = r.status;
    return li;
  };

  list.replaceChildren(...runs.slice(0, 3).map(buildRow));
  const rest = runs.slice(3);
  more.hidden = rest.length === 0;

  // Re-wire each render so the closure captures the current `rest`.
  const next = more.cloneNode(true) as HTMLButtonElement;
  more.replaceWith(next);
  next.addEventListener("click", () => {
    for (const r of rest) list.appendChild(buildRow(r));
    next.hidden = true;
  });
}

// E5: the newest recorded run's timestamp + count, so the popup can show a
// "synced" line even when local lastScanAt diverged (the syncConfirmed message
// was lost because the SW died / the tab closed). Returns null if no run has a
// usable timestamp.
function newestRunLastSync(runs: SyncRun[]): { at: number; count: number } | null {
  let best: { at: number; count: number } | null = null;
  for (const r of runs) {
    const stamp = r.finishedAt ?? r.startedAt;
    if (!stamp) continue;
    const at = new Date(stamp).getTime();
    if (Number.isNaN(at)) continue;
    if (!best || at > best.at) best = { at, count: typeof r.itemCount === "number" ? r.itemCount : 0 };
  }
  return best;
}

function render(root: Document | HTMLElement, status: Status): void {
  setText(root, "account-name", status.account?.name ?? "your noticed account");
  setText(root, "account-email", status.account?.email ?? "");

  if (status.nextScanAt) {
    setText(root, "next-scan", `next scan: ${formatDate(status.nextScanAt)}`);
  } else {
    setText(root, "next-scan", "next scan: after your first sync");
  }

  setLastScanLine(root, status.lastScanAt ?? null, status.lastScanCount ?? null);

  const list = networkList(status);
  const listWord = sourceLabels(status).length > 1 ? "lists" : "list";
  setText(
    root,
    "what-we-fetch",
    `we read your ${list} connection ${listWord} — name, headline, profile link, ` +
      `connection date — as you, paced like a human, about once a month. ` +
      `we never read messages or anything else.`,
  );

  setText(
    root,
    "privacy",
    "everything goes only to your noticed account over an encrypted connection. " +
      "we never sell it, share it, or train AI on it. this extension holds no " +
      "password and no noticed login — it hands data to your own signed-in noticed tab.",
  );

  // The noticed-signin case is handled in init() via a single source of truth
  // (applyNoticedSigninState) so the red "finish syncing" text never appears
  // without the actionable #signin-cta button beside it (E4). Here we only render
  // the network-signin case — a sign-in to the user's professional network, which
  // is informative-only (not actionable via this button).
  if (status.needs === "network-signin") {
    const label2 = status.recipe?.networkLabel ?? "your professional network";
    setText(root, "needs", `sign in to ${label2} so we can read your connections.`);
  } else if (status.needs !== "noticed-signin") {
    setText(root, "needs", "");
  }

  const repo = root.querySelector<HTMLAnchorElement>("#repo-link");
  if (repo) repo.href = REPO_URL;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// E2: show live scan progress. A checkpoint-and-resume scan can run for a
// minute+ (and outlive the popup), so while it's in progress we poll getStatus
// and update the button to "scanned N…". When scanning ends we re-render via
// init() so the freshly-cached sync + "scan now" affordance appear. The poll
// delay + sleep are injectable so tests don't wait real seconds.
export async function pollScanProgress(
  root: Document | HTMLElement = document,
  opts: { pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 1500;
  const sleep = opts.sleep ?? realSleep;
  const btn = root.querySelector<HTMLButtonElement>("#scan-now");
  const spinner = root.querySelector<HTMLElement>("#scan-spinner");
  // Bound the loop so a wedged SW can't spin forever (≈ the per-session cap of
  // pages × pacing, with generous headroom): 1.5s × 800 ≈ 20 min.
  for (let i = 0; i < 800; i++) {
    const s = await getStatus();
    if (!s.scanning) {
      // Done (or never started) → re-render the full popup with fresh state.
      await init(root);
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = `scanned ${s.scannedCount ?? 0}…`;
    }
    if (spinner) spinner.hidden = false;
    await sleep(pollMs);
  }
}

// Kick off a scan and show live progress. Sets the in-progress UI SYNCHRONOUSLY
// (before the first await, so it's observable immediately) and AWAITS the scanNow
// ack so the service worker has set scanning:true before we start polling — Cause
// B of the scan-twice bug, where the poller could read scanning:false on its first
// tick and bail to idle while the scan ran invisibly. Then polls until it finishes.
async function startScan(
  root: Document | HTMLElement,
  btn: HTMLButtonElement,
  spinner: HTMLElement | null,
): Promise<void> {
  btn.disabled = true;
  btn.textContent = "scanning…";
  if (spinner) spinner.hidden = false;
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    await chrome.runtime.sendMessage({ type: "scanNow" });
  }
  await pollScanProgress(root);
}

export async function init(root: Document | HTMLElement = document): Promise<void> {
  // Bail when the extension API isn't available (e.g. module imported under test
  // before the chrome mock is installed, or any non-extension context).
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  // Footer (E6): always stamp the installed version; best-effort update check
  // (own try/catch) reveals the bottom "update available" notice when behind.
  setVersion(root);
  void checkForUpdate(root);

  const status = await getStatus();

  const connected = Boolean(status.recipe || status.account);
  const connectSection = root.querySelector<HTMLElement>("#connect");
  if (connectSection) connectSection.hidden = connected;
  // Note: #what-we-fetch + #privacy always show (pre- and post-connect) — they
  // are informational and render() fills them every call with a generic label
  // fallback when there's no recipe.
  for (const sel of ["#account", "#syncs"]) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el) el.hidden = !connected;
  }
  const statusCard = root.querySelector<HTMLElement>(".status");
  if (statusCard) statusCard.hidden = !connected;
  wireOnce(root.querySelector<HTMLElement>("#connect-cta"), openConnect);

  render(root, status);

  if (!connected) return;

  // Two explicit scan-now states, gated on whether the host permission(s) are
  // already granted. Requesting a host permission from a popup CLOSES the popup,
  // so we never request-then-scan in one click: that scan would never run.
  // Multi-network (NT-45): grant covers EVERY paired source origin at once.
  const origins = sourceOrigins(status);
  const grantPatterns = origins.map((o) => `${o}/*`);
  const granted =
    grantPatterns.length === 0 || !chrome.permissions?.contains
      ? true // no origin / no API → don't gate
      : (
          await Promise.all(
            grantPatterns.map((p) => chrome.permissions.contains({ origins: [p] })),
          )
        ).every(Boolean);

  const scanBtn = root.querySelector<HTMLButtonElement>("#scan-now");
  if (scanBtn) {
    // Re-wire each render by cloning to clear stale listeners.
    const next = scanBtn.cloneNode(true) as HTMLButtonElement;
    scanBtn.replaceWith(next);
    const spinner = root.querySelector<HTMLElement>("#scan-spinner");
    // The grant-access explainer is shown ONLY in the grant state; default it hidden.
    const explainer = root.querySelector<HTMLElement>("#grant-explainer");
    if (explainer) explainer.hidden = true;
    if (!granted && grantPatterns.length > 0) {
      next.textContent = "grant access";
      if (explainer) {
        explainer.textContent = grantExplainerText(status);
        explainer.hidden = false;
      }
      next.addEventListener("click", () => {
        void (async () => {
          // A popup click is a user gesture, so chrome.permissions.request works
          // (it can't in the service worker). Cause A of the scan-twice bug: when
          // the grant resolves while the popup is still open, KICK OFF the scan
          // right away ("1 open + 1 click → grant + import") instead of only
          // re-rendering and making the user click a second time. If the prompt
          // closed the popup, the SW's pair/alarm path covers the scan on re-open.
          const ok = await chrome.permissions.request({ origins: grantPatterns });
          if (ok) await startScan(root, next, spinner);
          else await init(root);
        })();
      });
    } else if (status.scanning) {
      // A scan is already in flight (it may have outlived a previous popup —
      // the checkpoint-and-resume scan survives the SW being torn down). Show
      // live progress and poll until it finishes (E2).
      next.disabled = true;
      next.textContent = `scanned ${status.scannedCount ?? 0}…`;
      if (spinner) spinner.hidden = false;
      void pollScanProgress(root);
    } else {
      // cloneNode copies the disabled flag from a mid-scan button — reset it so
      // the idle "scan now" state is always clickable, and hide any leftover
      // spinner from a finished poll.
      next.disabled = false;
      next.textContent = "scan now";
      if (spinner) spinner.hidden = true;
      next.addEventListener("click", () => {
        // A real scan paces pagination over a minute+ and can outlive this popup:
        // startScan sets the in-progress UI synchronously, awaits the scanNow ack
        // (Cause B), then polls getStatus for "scanned N…" updates (E1/E2).
        void startScan(root, next, spinner);
      });
    }
  }

  const history = await getSyncHistory();
  // E4: unify the two disagreeing sign-in signals. A noticed sign-in is needed if
  // EITHER getStatus or the history fetch says so — both now route through the same
  // actionable button (the red "finish syncing" text never shows without it).
  const needsNoticedSignin = status.needs === "noticed-signin" || history?.needs === "noticed-signin";
  applyNoticedSigninState(root, needsNoticedSignin);

  if (history?.needs === "noticed-signin") {
    // 401 from /api/sync/runs — we have no usable run history to show.
    renderSyncs(root, []);
  } else {
    const runs = history?.runs ?? [];
    renderSyncs(root, runs);
    // E5: the SW reconciles local state from these runs, but the status we
    // already rendered may predate that. If a recorded sync is newer than the
    // local stamp, reflect it here so the popup never shows "no sync yet" while
    // a run is listed.
    const fromRuns = newestRunLastSync(runs);
    const localAt = status.lastScanAt ?? null;
    if (fromRuns && (localAt == null || fromRuns.at > localAt)) {
      setLastScanLine(root, fromRuns.at, fromRuns.count);
    }
  }

  // Test mode is a development-only affordance — reveal + wire it only in dev builds.
  if (isDevBuild()) {
    const toggleWrap = root.querySelector<HTMLElement>("#test-mode-toggle");
    if (toggleWrap) toggleWrap.hidden = false;
    const testMode = root.querySelector<HTMLInputElement>("#test-mode");
    if (testMode) {
      testMode.checked = Boolean(status.testMode);
      if (testMode.dataset.wired !== "1") {
        testMode.dataset.wired = "1";
        testMode.addEventListener("change", () => {
          void chrome.runtime.sendMessage({ type: "setTestMode", value: testMode.checked });
        });
      }
    }
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  // Module scripts are deferred, so by the time this runs the document is
  // usually already parsed (readyState "interactive"/"complete"). Run init now
  // in that case; only wait for DOMContentLoaded if parsing is still going.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init());
  } else {
    void init();
  }
}
