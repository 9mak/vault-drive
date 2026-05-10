import { Notice, Plugin } from "obsidian";
import { ConnectModal } from "./connectModal";
import { ensureFolder } from "./gdrive";
import { getAccessToken } from "./oauth";
import { VaultDriveSettingsTab } from "./settings";
import { runSync } from "./sync";
import { DEFAULT_SETTINGS, type VaultDriveSettings } from "./types";

/**
 * The OAuth client id is the same for every install — it is the public
 * identifier of the Google Cloud project this plugin is registered under.
 * Embedded at build time. Treated as non-secret (Google explicitly says
 * public clients may ship the client id; the boundary is the redirect URI,
 * and we use the redirect-less device flow).
 *
 * TODO before first release: replace the placeholder with the real id from
 * the production GCP project.
 */
const OAUTH_CLIENT_ID =
    "892889814916-em9jusvgj0grck9k33kss93os04l02dh.apps.googleusercontent.com";

export default class VaultDrivePlugin extends Plugin {
    settings!: VaultDriveSettings;
    /** Exposed to the settings tab so it can pass it to ConnectModal. */
    readonly oauthClientId = OAUTH_CLIENT_ID;

    async onload(): Promise<void> {
        await this.loadSettings();

        this.addSettingTab(new VaultDriveSettingsTab(this.app, this));

        this.addCommand({
            id: "vault-drive-connect",
            name: "Connect to Google Drive",
            callback: () => {
                new ConnectModal(
                    this.app,
                    OAUTH_CLIENT_ID,
                    async (refreshToken) => {
                        this.settings.refreshToken = refreshToken;
                        this.settings.rootFolderId = "";
                        await this.saveSettings();
                    }
                ).open();
            },
        });

        this.addCommand({
            id: "vault-drive-sync-now",
            name: "Sync now",
            callback: () => {
                void this.syncNow();
            },
        });
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    private async syncNow(): Promise<void> {
        if (!this.settings.refreshToken) {
            new Notice(
                "Vault Drive: not connected. Run 'Connect to Google Drive' first."
            );
            return;
        }

        let accessToken: string;
        try {
            accessToken = await getAccessToken(
                this.settings.refreshToken,
                OAUTH_CLIENT_ID
            );
        } catch (e) {
            new Notice(
                `Vault Drive: token error: ${
                    e instanceof Error ? e.message : String(e)
                }`
            );
            return;
        }

        // Lazily create a root folder on the user's Drive on first sync.
        if (!this.settings.rootFolderId) {
            try {
                this.settings.rootFolderId = await ensureFolder(
                    accessToken,
                    "VaultDriveSync"
                );
                await this.saveSettings();
            } catch (e) {
                new Notice(
                    `Vault Drive: could not create root folder: ${
                        e instanceof Error ? e.message : String(e)
                    }`
                );
                return;
            }
        }

        new Notice("Vault Drive: sync started…");
        const result = await runSync(this.app.vault, this.settings, accessToken);

        this.settings.lastSyncAt = Date.now();
        await this.saveSettings();

        const summary = `${result.uploaded} up, ${result.downloaded} down, ${result.skipped} skipped`;
        if (result.errors.length > 0) {
            new Notice(
                `Vault Drive: finished with ${result.errors.length} error(s). ${summary}`
            );
            console.error("[Vault Drive] errors:", result.errors);
        } else {
            new Notice(`Vault Drive: ${summary} (${result.durationMs} ms)`);
        }
    }
}
