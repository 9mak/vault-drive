import { Modal, Notice, Setting, type App } from "obsidian";
import {
    pollDeviceAuth,
    startDeviceAuth,
    type DeviceCodeResponse,
} from "./oauth";

/**
 * Modal that walks the user through Google's device-flow OAuth.
 *
 * Shows the verification URL + user code, then polls in the background
 * until the user completes consent. On success, calls onSuccess with the
 * refresh token; the caller persists it to settings.
 */
export class ConnectModal extends Modal {
    private abort = new AbortController();

    constructor(
        app: App,
        private readonly clientId: string,
        private readonly onSuccess: (refreshToken: string) => Promise<void>
    ) {
        super(app);
    }

    async onOpen(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Connect to Google Drive" });

        const status = contentEl.createEl("p", {
            text: "Requesting authorization code from Google…",
        });

        let device: DeviceCodeResponse;
        try {
            device = await startDeviceAuth(this.clientId);
        } catch (e) {
            status.setText(
                `Failed: ${e instanceof Error ? e.message : String(e)}`
            );
            return;
        }
        if (this.abort.signal.aborted) return;

        contentEl.empty();
        contentEl.createEl("h2", { text: "Connect to Google Drive" });
        contentEl.createEl("p", {
            text: "1. Open the URL below in any browser (your phone, your PC, anywhere).",
        });
        const linkRow = new Setting(contentEl).setName(
            device.verificationUrl
        );
        linkRow.addButton((b) =>
            b.setButtonText("Copy URL").onClick(async () => {
                await navigator.clipboard.writeText(device.verificationUrl);
                new Notice("URL copied");
            })
        );
        linkRow.addButton((b) =>
            b
                .setButtonText("Open")
                .setCta()
                .onClick(() => window.open(device.verificationUrl, "_blank"))
        );

        contentEl.createEl("p", {
            text: "2. Enter this code on Google's page:",
        });
        const codeRow = contentEl.createEl("div", {
            cls: "vault-drive-device-code",
        });
        codeRow.style.fontSize = "2em";
        codeRow.style.fontFamily = "monospace";
        codeRow.style.letterSpacing = "0.2em";
        codeRow.style.textAlign = "center";
        codeRow.style.padding = "1em";
        codeRow.setText(device.userCode);
        new Setting(contentEl).addButton((b) =>
            b.setButtonText("Copy code").onClick(async () => {
                await navigator.clipboard.writeText(device.userCode);
                new Notice("Code copied");
            })
        );

        const statusLine = contentEl.createEl("p", {
            text: "Waiting for you to approve in the browser…",
            cls: "vault-drive-status-pending",
        });

        try {
            const tokens = await pollDeviceAuth(
                this.clientId,
                device.deviceCode,
                device.pollIntervalSec,
                device.expiresAt,
                this.abort.signal
            );
            statusLine.setText("Connected. Saving credentials…");
            statusLine.removeClass("vault-drive-status-pending");
            statusLine.addClass("vault-drive-status-good");
            await this.onSuccess(tokens.refreshToken);
            statusLine.setText("Done. You can close this dialog.");
            new Notice("Vault Drive: connected to Google Drive");
        } catch (e) {
            statusLine.setText(
                e instanceof Error ? e.message : String(e)
            );
            statusLine.removeClass("vault-drive-status-pending");
            statusLine.addClass("vault-drive-status-bad");
        }
    }

    onClose(): void {
        this.abort.abort();
        this.contentEl.empty();
    }
}
