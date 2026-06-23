// popup.ts — the user-facing trust surface for the relationships extension.
//
// It renders the user's noticed account, when the next sync runs, what we
// read and how, and how the data is kept private. The network name is NEVER
// hard-coded here: it is always rendered at runtime from
// `status.recipe.networkLabel`, so this extension stays platform-agnostic.

const REPO_URL = "https://github.com/noticedso/relationships-extension";

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

// Replaced at build time by esbuild (`define`): true only for local-development
// builds (EXT_DEV=1), false in the published artifact. `typeof` guard keeps it
// safe under test, where it resolves to a controllable global instead.
declare const __DEV__: boolean;
function isDevBuild(): boolean {
  return typeof __DEV__ !== "undefined" && __DEV__ === true;
}

type Status = {
  account?: { name?: string; email?: string } | null;
  recipe?: { networkLabel?: string } | null;
  nextScanAt?: number | null;
  lastScanAt?: number | null;
  lastScanCount?: number | null;
  needs?: string | null;
  testMode?: boolean | null;
};

function setText(root: Document | HTMLElement, id: string, text: string): void {
  const el = root.querySelector<HTMLElement>(`#${id}`);
  if (el) el.textContent = text;
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(ms));
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

async function getStatus(): Promise<Status> {
  return (await chrome.runtime.sendMessage({ type: "getStatus" })) as Status;
}

async function getSyncHistory(): Promise<SyncHistory> {
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

function render(root: Document | HTMLElement, status: Status): void {
  setText(root, "account-name", status.account?.name ?? "your noticed account");
  setText(root, "account-email", status.account?.email ?? "");

  if (status.nextScanAt) {
    setText(root, "next-scan", `next scan: ${formatDate(status.nextScanAt)}`);
  } else {
    setText(root, "next-scan", "next scan: after your first sync");
  }

  if (status.lastScanAt) {
    const count = status.lastScanCount ?? 0;
    setText(root, "last-scan", `${count} connections synced — ${formatDate(status.lastScanAt)}`);
  } else {
    setText(root, "last-scan", "no sync yet");
  }

  const label = status.recipe?.networkLabel ?? "professional network";
  setText(
    root,
    "what-we-fetch",
    `we read your ${label} connection list — name, headline, profile link, ` +
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

  if (status.needs === "network-signin") {
    const label2 = status.recipe?.networkLabel ?? "your professional network";
    setText(root, "needs", `sign in to ${label2} so we can read your connections.`);
  } else if (status.needs === "noticed-signin") {
    setText(root, "needs", "sign in to noticed to finish syncing.");
  } else {
    setText(root, "needs", "");
  }

  const repo = root.querySelector<HTMLAnchorElement>("#repo-link");
  if (repo) repo.href = REPO_URL;
}

export async function init(root: Document | HTMLElement = document): Promise<void> {
  // Bail when the extension API isn't available (e.g. module imported under test
  // before the chrome mock is installed, or any non-extension context).
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  const button = root.querySelector<HTMLButtonElement>("#scan-now");
  if (button && button.dataset.wired !== "1") {
    button.dataset.wired = "1";
    button.addEventListener("click", () => {
      void (async () => {
        await chrome.runtime.sendMessage({ type: "scanNow" });
        await init(root);
      })();
    });
  }

  const status = await getStatus();

  const connected = Boolean(status.recipe || status.account);
  const connectSection = root.querySelector<HTMLElement>("#connect");
  if (connectSection) connectSection.hidden = connected;
  for (const sel of ["#account", "#what-we-fetch", "#privacy", "#syncs"]) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el) el.hidden = !connected;
  }
  const statusCard = root.querySelector<HTMLElement>(".status");
  if (statusCard) statusCard.hidden = !connected;
  wireOnce(root.querySelector<HTMLElement>("#connect-cta"), openConnect);

  render(root, status);

  if (!connected) return;

  const history = await getSyncHistory();
  const signin = root.querySelector<HTMLButtonElement>("#signin-cta");
  if (history?.needs === "noticed-signin") {
    if (signin) signin.hidden = false;
    wireOnce(signin, openConnect);
    setText(root, "needs", "");
    renderSyncs(root, []);
  } else {
    if (signin) signin.hidden = true;
    renderSyncs(root, history?.runs ?? []);
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
