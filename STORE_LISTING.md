# Chrome Web Store submission kit — noticed Relationships v1.0.0

Everything to paste into the Developer Dashboard for the **first** (manual) submission. After this,
releases auto-publish — see [PUBLISHING.md](./PUBLISHING.md).

## Package
- **Upload the release ZIP** from <https://github.com/noticedso/relationships-extension/releases> (it's
  hash-verified by CI). To rebuild locally: `node build.mjs && (cd dist && zip -rqX ../noticed-relationships-1.0.0.zip .)`.
- **Manifest:** v3, version `1.0.0`. Permissions: `storage`, `alarms`, `cookies`. Optional host:
  `*://*.linkedin.com/*` (requested at runtime). Host: `https://*.noticed.so/*`. `externally_connectable`:
  `https://*.noticed.so/*`.

## Store listing tab
- **Item name:** `noticed Relationships`
- **Summary (≤132):** `Import your own LinkedIn connections into noticed — privately, in your browser, as yourself.`
- **Category:** Productivity
- **Language:** English
- **Detailed description:**
  ```
  noticed Relationships imports your own LinkedIn connections into your noticed account — quickly and privately, right from your browser.

  How it works
  • Click Connect and sign in to noticed once.
  • The extension reads your own first-degree connection list as you (name, headline, profile link, connection date) and hands it to your signed-in noticed tab.
  • It refreshes about once a month so your network stays current.

  Privacy
  • It only reads your own connection list — never your messages or anyone else's data.
  • Your data goes only to your own noticed account over an encrypted connection.
  • The extension holds no password and no noticed login — it uses your existing signed-in noticed session.
  • We never sell or share your data, or use it to train AI.

  Open source: the extension is built in the open at github.com/noticedso/relationships-extension.
  ```
- **Icon:** 128×128 — `dist/icons/icon128.png` (already in the zip).
- **Screenshots (REQUIRED, ≥1):** `store-assets/screenshot-1.png` (1280×800) — ready to upload. Regenerate
  with `store-assets/promo.html` if needed.

## Privacy practices tab
- **Single purpose:**
  ```
  noticed Relationships imports the signed-in user's own first-degree LinkedIn connections into their noticed account and shows the import history.
  ```
- **Permission justifications** (one per item):
  - `storage` — `Stores the link to the user's noticed account (scan recipe + account summary) and the most recent pending import locally, so the popup can show status and the monthly import can run.`
  - `alarms` — `Runs the connection import about once a month so the user's network stays current without manual re-triggering.`
  - `cookies` — `Reads the user's own LinkedIn session cookie in the browser to authenticate the connection-list request as the signed-in user. The value is used only as the request's CSRF header — never sent to our servers or stored.`
  - Host `*://*.linkedin.com/*` (optional, requested at runtime) — `Reads the signed-in user's own first-degree connection list from LinkedIn (name, headline, profile link, connection date), only when the user clicks Connect or Scan. Requested at runtime, not at install.`
  - Host `https://*.noticed.so/*` — `Sends the user's imported connections to their own noticed account and reads their import history, using the user's existing noticed session.`
- **Remote code:** **No.** The extension fetches a JSON configuration ("recipe") and the user's data from noticed; it does not download or execute remote JavaScript.
- **Data usage — collected:**
  - ✅ **Personally identifiable information** (the user's connections' names/headlines/profile links; the user's own account name + email).
  - Everything else: **not collected** — explicitly NOT: financial info, health, authentication info (the LinkedIn cookie is used locally only, never transmitted/stored), personal communications (we never read messages), location, web history, user activity.
- **Disclosure certifications (check all three):**
  - I do not sell or transfer user data to third parties outside of approved use cases. ✅
  - I do not use or transfer user data for purposes unrelated to my item's single purpose. ✅
  - I do not use or transfer user data to determine creditworthiness or for lending purposes. ✅
- **Privacy policy URL (REQUIRED):** `https://www.noticed.so/privacy` — the policy includes §5
  "Browser extension (noticed Relationships)" covering this data handling (added in noticed monorepo
  PR #485; confirm it's deployed before submitting).

## To do before submit (human)
1. **Privacy policy** — confirm `noticed.so/privacy` is live with §5 (PR #485 deployed).
2. **Account page** — Trader declaration = Trader; add a public contact email + postal address (shown publicly for traders).
3. **Trusted testers (recommended)** — add your email under Account → Trusted testers and publish to testers first for a private install check.
4. Upload the release ZIP, fill the tabs above, submit for review.
5. After approval, grab the **item ID** and set up the auto-publish secrets ([PUBLISHING.md](./PUBLISHING.md)).

## Review-risk notes
- Optional host is scoped to `*://*.linkedin.com/*` (not all-sites) with a clear single purpose → low rejection risk.
- `cookies` + reading LinkedIn's session is the most scrutinized item; the justification stresses it's the user's own session, used locally only, never transmitted.
- The "recipe" is configuration/data, not code → answer "No" to remote code; if asked in review, explain the extension's behavior is fixed (import connections) and only the endpoint/field-mapping config is fetched.
