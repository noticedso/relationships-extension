# Publishing

Releases are driven by **git tags**. Tagging `vX.Y.Z` runs `.github/workflows/release.yml`:

1. tests → deterministic `build.mjs` → zip → SHA-256
2. creates a **GitHub Release** with the `.zip` + `SHA256SUMS.txt`
3. **if the Chrome Web Store secrets are set**, uploads the `.zip` to the store and publishes it

Step 3 is skipped automatically until you configure the secrets below, so tagging is always safe.

## One-time setup

### 1. Create the store item (manual, once)
The Web Store API can only **update** an existing item — it can't create one. So the first version is uploaded by hand:
- Developer Dashboard → **Items → Add new item** → upload the release `.zip`.
- Fill the listing (copy/screenshots/privacy URL — see the repo README + the noticed submission notes), set visibility, submit for review.
- Copy the **item ID** (the 32-char `a–p` id shown in the dashboard / item URL). This is `CHROME_EXTENSION_ID`.

### 2. Get Chrome Web Store API credentials
- In **Google Cloud Console**: create a project, **enable the "Chrome Web Store API"**, and create an **OAuth client ID** (type: Desktop app). This gives `CHROME_CLIENT_ID` + `CHROME_CLIENT_SECRET`.
- Generate a **refresh token** for the scope `https://www.googleapis.com/auth/chromewebstore`:
  1. Open (replace CLIENT_ID):
     `https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&redirect_uri=urn:ietf:wg:oauth:2.0:oob&client_id=CLIENT_ID`
  2. Approve → copy the `code`.
  3. Exchange it:
     ```bash
     curl -s "https://oauth2.googleapis.com/token" \
       -d "client_id=CLIENT_ID" -d "client_secret=CLIENT_SECRET" \
       -d "code=CODE" -d "grant_type=authorization_code" \
       -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob"
     ```
     The `refresh_token` in the response is `CHROME_REFRESH_TOKEN`.

### 3. Add the four repo secrets
`Settings → Secrets and variables → Actions → New repository secret`:

| Secret | Value |
|---|---|
| `CHROME_EXTENSION_ID` | the store item ID |
| `CHROME_CLIENT_ID` | OAuth client id |
| `CHROME_CLIENT_SECRET` | OAuth client secret |
| `CHROME_REFRESH_TOKEN` | the refresh token from step 2 |

## Cutting a release (after setup)

```bash
# bump BOTH versions to the same value, then tag v<that>
#   - manifest.json  "version"
#   - package.json   "version"
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z && git push origin vX.Y.Z
```

The workflow builds, publishes the GitHub Release, and uploads + publishes the new version to the Chrome Web Store. The store still does its own review before the update goes live.

## Notes
- The API publishes the **package** (the new `.zip`). Listing **copy and screenshots** are managed in the dashboard — they don't change per release unless you edit them there.
- `manifest.json` `version` must increase for the store to accept an update; keep it in sync with `package.json` and the tag.
- Publishing can fail review (e.g. permission changes). Watch the run + the dashboard's review status.
