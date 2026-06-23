# noticed Relationships

A browser extension that imports **your own LinkedIn connections** into your [noticed](https://www.noticed.so) account — quickly and privately, right from your browser.

It's built in the open so you can verify exactly what it does.

## What it does

- Reads **your own first-degree LinkedIn connection list** (name, headline, profile link, connection date) as the signed-in you, and hands it to your own signed-in noticed tab.
- Refreshes about **once a month** so your network stays current.
- That's it — it never reads your messages, anyone else's data, or anything beyond your connection list.

## Privacy

- **Your data goes only to your own noticed account**, over an encrypted connection.
- The extension holds **no password and no noticed login** — it uses your existing signed-in noticed session.
- Your LinkedIn session cookie is read **only in your browser** to authenticate the request as you; it is **never sent to noticed or stored**.
- We never sell or share your data, or use it to train AI.
- Full policy: <https://www.noticed.so/privacy>

## How it's built for trust

- **Minimal permissions.** `storage`, `alarms`, `cookies`, plus a host permission for `*.linkedin.com` that is **requested at runtime** (not at install), and `*.noticed.so` to talk to your account.
- **No remote code.** The extension's behavior is fixed. It fetches a small JSON *config* ("recipe": which endpoint + field mapping + pacing) and your data from noticed — never executable code.
- **Reproducible build.** `node build.mjs` is deterministic; `node scripts/hash-artifact.mjs` prints a SHA-256 of the built artifact. Every [release](../../releases) publishes that hash so you can confirm the published `.zip` matches this source.

## Install

- **From the Chrome Web Store:** _(link added once published)_
- **From source (development):**
  ```bash
  npm ci
  node build.mjs          # outputs ./dist
  ```
  Then in Chrome/Helium: `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.

## Connecting it

1. Click the extension, then **Connect to noticed**.
2. Sign in to noticed if prompted — it opens `noticed.so/x/connect` and pairs back to this extension.
3. Approve the one-time LinkedIn access prompt, then **Scan now** (or wait for the monthly run).

## Updating

- **Installed from the Chrome Web Store:** updates automatically — Chrome polls the store and applies new versions for you. Nothing to do.
- **Installed from GitHub (load unpacked):** Chrome does **not** auto-update these. The popup shows an "update available" notice when a newer release exists. To update, download the latest release `.zip`, then reload at `chrome://extensions` — either **remove** the extension and **Load unpacked** the new folder again, or replace the folder's contents and click the reload icon on the extension card.
- Note: many fixes (for example, if LinkedIn changes its internal data shape) ship via the server-side recipe and need **no extension update at all**.

## Develop

```bash
npm ci
npm test                 # vitest (mocked chrome.*)
npx tsc --noEmit         # type-check
node build.mjs           # build → dist/
node scripts/hash-artifact.mjs   # deterministic artifact hash
```

## Releasing

Tag a version to build + publish a verifiable release:

```bash
npm version <new-version> --no-git-tag-version   # bump manifest is manual; see below
git tag v1.0.0 && git push origin v1.0.0
```

The `release` workflow runs tests, builds `dist/`, zips it, computes the SHA-256, and attaches both the `.zip` and the hash to a GitHub Release. Upload that same `.zip` to the Chrome Web Store; the published artifact hash should match the release hash.

> Keep `manifest.json` `version` and `package.json` `version` in sync, and tag `v<that version>`.

## License

MIT — see [LICENSE](./LICENSE).
