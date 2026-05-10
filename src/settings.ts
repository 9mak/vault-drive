import { type App, PluginSettingTab, Setting } from "obsidian";
import { ConnectModal } from "./connectModal";
import type VaultDrivePlugin from "./main";

export class VaultDriveSettingsTab extends PluginSettingTab {
    constructor(
        app: App,
        private readonly plugin: VaultDrivePlugin
    ) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Vault Drive" });
        containerEl.createEl("p", {
            text: "Sync vault attachments (non-Markdown files) to Google Drive. Pair this with Vault Git for a complete two-layer sync.",
        });

        const connected = !!this.plugin.settings.refreshToken;
        new Setting(containerEl)
            .setName("Google Drive connection")
            .setDesc(
                connected
                    ? "Connected. Use the button to re-authenticate or to switch accounts."
                    : "Not connected yet. Sign in with your Google account."
            )
            .addButton((btn) =>
                btn
                    .setButtonText(connected ? "Reconnect" : "Connect")
                    .setCta()
                    .onClick(() => {
                        new ConnectModal(
                            this.app,
                            this.plugin.oauthClientId,
                            async (refreshToken) => {
                                this.plugin.settings.refreshToken =
                                    refreshToken;
                                this.plugin.settings.rootFolderId = "";
                                await this.plugin.saveSettings();
                                this.display();
                            }
                        ).open();
                    })
            );

        if (connected) {
            new Setting(containerEl)
                .setName("Disconnect")
                .setDesc("Forget the stored Google credentials on this device.")
                .addButton((btn) =>
                    btn.setButtonText("Disconnect").onClick(async () => {
                        this.plugin.settings.refreshToken = "";
                        this.plugin.settings.rootFolderId = "";
                        await this.plugin.saveSettings();
                        this.display();
                    })
                );
        }

        new Setting(containerEl)
            .setName("Drive root folder ID")
            .setDesc(
                "Auto-populated on first sync. Leave empty to let the plugin create a folder named 'VaultDriveSync' on your Drive."
            )
            .addText((t) =>
                t
                    .setPlaceholder("auto")
                    .setValue(this.plugin.settings.rootFolderId)
                    .onChange(async (v) => {
                        this.plugin.settings.rootFolderId = v.trim();
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Include globs (one per line)")
            .setDesc(
                "Files matching any of these patterns are synced. Default: attachments/** plus common binary extensions."
            )
            .addTextArea((t) =>
                t
                    .setValue(this.plugin.settings.includeGlobs.join("\n"))
                    .onChange(async (v) => {
                        this.plugin.settings.includeGlobs = v
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean);
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Exclude globs (one per line)")
            .setDesc(
                "Files matching any of these are skipped. Default: **/*.md (so Markdown stays in Git)."
            )
            .addTextArea((t) =>
                t
                    .setValue(this.plugin.settings.excludeGlobs.join("\n"))
                    .onChange(async (v) => {
                        this.plugin.settings.excludeGlobs = v
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean);
                        await this.plugin.saveSettings();
                    })
            );

        const lastSync = this.plugin.settings.lastSyncAt;
        new Setting(containerEl).setName("Last sync").setDesc(
            lastSync ? new Date(lastSync).toLocaleString() : "never"
        );
    }
}
