# Vault Drive — Operator Setup Guide

What you need to do once before publishing the plugin. After this, normal users just install and click "Connect" — none of the steps below apply to them.

## 1. Push the local scaffold to GitHub

```sh
cd ~/Desktop/vault-drive
git remote add origin https://github.com/9mak/vault-drive.git
git push -u origin master
```

## 2. Create the Google Cloud OAuth Client

We need a single OAuth client that every Vault Drive install shares. The client id is public; there is no secret to leak (Device Flow uses a public client type). **OAuth Client creation cannot be scripted via `gcloud`** — Google requires the web console for this. The project + API enable steps below can be scripted; the OAuth steps are manual.

### Scriptable parts (gcloud)

```sh
gcloud projects create vault-drive --name="Vault Drive"
gcloud config set project vault-drive
gcloud services enable drive.googleapis.com
```

### Manual parts (web console)

1. Go to https://console.cloud.google.com/apis/credentials/consent (project: vault-drive).
   - **User type:** External.
   - **App name:** `Vault Drive`.
   - **Support email:** your email.
   - **Authorized domains:** leave empty for now.
   - **Scopes:** add `.../auth/drive.file` only — do NOT add the broad `drive` scope.
   - **Test users:** add your own Google account.
   - Save through to the end. Leave the app in "Testing" status (capped at 100 users — fine for now).
2. https://console.cloud.google.com/apis/credentials → **Create credentials → OAuth client ID**.
   - **Application type: TVs and Limited Input devices** (this is the magic value — marks the client as public, no secret required).
   - **Name:** `Vault Drive (device)`.
   - Create.
   - Copy the generated **Client ID** (looks like `123456789-abcde...apps.googleusercontent.com`).
3. Paste the client id into `src/main.ts` — replace the `REPLACE_BEFORE_RELEASE.apps.googleusercontent.com` placeholder.

## 3. Tag a release

```sh
cd ~/Desktop/vault-drive
pnpm install
pnpm run build   # produces main.js with the real client id baked in
git add main.js src/main.ts
git commit -m "chore: bake production OAuth client id"
git tag 0.1.0
git push origin master 0.1.0
```

For the GitHub Release, attach `main.js`, `manifest.json`, and `styles.css` manually, or copy `releases.yml` from vault-git and adjust `PLUGIN_NAME` to `vault-drive`.

## 4. Test path

1. **Desktop:** copy `main.js` / `manifest.json` / `styles.css` into `<test-vault>/.obsidian/plugins/vault-drive/`. Reload Obsidian, enable the plugin, click **Connect**, run **Sync now**.
2. **Mobile (BRAT):** install BRAT from the community store, add this repo as a Beta plugin, enable Vault Drive, repeat the connect+sync test.

## 5. Promote to community store

Once you're happy with the behavior:
1. Bump version to a stable number (e.g. 1.0.0) in `manifest.json`, `package.json`, and `versions.json`.
2. Submit a PR to `obsidianmd/obsidian-releases` adding an entry to `community-plugins.json`:
   ```json
   {
     "id": "vault-drive",
     "name": "Vault Drive",
     "author": "9mak",
     "description": "Sync vault attachments to Google Drive. Companion to Vault Git.",
     "repo": "9mak/vault-drive"
   }
   ```
3. Move the OAuth consent screen from "Testing" → "In production" so the 100-user cap is lifted. Google will require a privacy policy URL, an icon, and possibly a homepage.

## Troubleshooting

- **"Auth code expired":** the user took longer than 5 minutes to enter the code. Just retry.
- **"slow_down" errors during polling:** the plugin handles them automatically (raises the poll interval). If you see them in production, it usually means a buggy retry loop.
- **First sync silently does nothing:** check that include globs match actual file paths. The default patterns assume a top-level `attachments/` folder; if your vault doesn't use that, edit the include globs in settings.
