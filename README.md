# Vault Drive

Sync vault attachments (non-Markdown files) to Google Drive. Companion plugin to [Vault Git](https://github.com/9mak/vault-git).

> **Status:** v0.1 scaffold. Not yet released to the community store. Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) for early testing.

## What it does (and what it doesn't)

| | |
|---|---|
| ✅ Markdown → Vault Git (text, diff-friendly, history) | ❌ Markdown is **not** synced through Vault Drive |
| ✅ Images, audio, video, PDFs → Vault Drive (Google Drive) | ❌ No diff/history for binaries — last-write-wins |
| ✅ Works on iOS / Android Obsidian | ❌ No background sync (manual "Sync Now" only) |
| ✅ Free Google Drive personal account | ❌ Shared drives, multi-account, encryption — all deferred |

The two plugins are **independent**: you can use Vault Drive without Vault Git (it just won't have a Markdown sync companion). You can also use Vault Git without Vault Drive (your binaries simply stay in the Git repo).

## How auth works (no server required)

Vault Drive uses Google's **OAuth 2.0 Device Flow**, the same protocol smart TVs use. There is no hosted "OAuth bridge" to maintain. The plugin shows you a short code; you enter it at https://www.google.com/device on any device that has a browser; once you approve, the plugin receives the credentials directly from Google.

The plugin requests the `drive.file` scope, which means **it can only see files it itself uploads** — your other Drive contents (Docs, photos from your phone, etc.) are invisible to it. This avoids Google's lengthy verification process for broad scopes and is the same pattern Remotely Save uses.

## Sync strategy (v0.1)

1. Walk the vault, keep paths matching `includeGlobs`, drop anything matching `excludeGlobs`. Default excludes `**/*.md`.
2. List the contents of the configured Drive folder (created automatically as `VaultDriveSync` on first sync).
3. For each file:
   - Local only → upload.
   - Remote only → download.
   - Both → keep the side with the newer modified timestamp; the loser is overwritten.
4. v0.1 only mirrors files at the top level of the Drive folder; subdirectories are not preserved. Conflict resolution is last-write-wins with a 1-second clock skew tolerance. Deletion propagation is **not** wired up — files removed locally remain on Drive until you delete them by hand.

These limits are intentional for a small first release. The roadmap (`v0.2+` ideas in the source) covers subdir mirroring, deletion propagation, content-hash conflict detection, encryption, and background sync.

## Install (BRAT)

1. In Obsidian, install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the community store.
2. Open BRAT settings → "Add Beta plugin" → paste `https://github.com/9mak/vault-drive`.
3. Enable Vault Drive in Settings → Community plugins.
4. Open Vault Drive settings → click **Connect** → follow the device-flow prompt.

## Build from source

```sh
pnpm install
pnpm run build  # writes main.js
```

Then drop `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/vault-drive/` and reload Obsidian.

## License

MIT — see [LICENSE](./LICENSE).
