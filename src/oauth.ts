/**
 * OAuth 2.0 Device Flow against Google.
 *
 * The Device Flow exists precisely for clients that can't host a redirect
 * endpoint or open a system browser in a way that returns control to the
 * app. Obsidian's mobile webview qualifies, so we skip the entire
 * "deploy a Cloudflare Worker as a redirect bridge" route.
 *
 * Flow:
 *   1. POST to /device/code -> { device_code, user_code, verification_url }
 *   2. Show user_code + verification_url to the user.
 *   3. Poll /token with device_code until they complete consent in a browser.
 *   4. Receive { refresh_token, access_token }; persist refresh_token.
 *
 * Spec: https://developers.google.com/identity/protocols/oauth2/limited-input-device
 */

import { requestUrl } from "obsidian";

const DEVICE_CODE_ENDPOINT = "https://oauth2.googleapis.com/device/code";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface DeviceCodeResponse {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresAt: number;
    pollIntervalSec: number;
}

interface AccessTokenCacheEntry {
    accessToken: string;
    expiresAt: number;
}

/**
 * Module-level cache keyed by refresh token. Keying by token (rather than a
 * single global slot) prevents an access token minted for one Google account
 * from being served to another after the user reconnects with a different
 * account, or when two Obsidian vaults share the same plugin install.
 */
const accessTokenCache = new Map<string, AccessTokenCacheEntry>();

export async function startDeviceAuth(
    clientId: string
): Promise<DeviceCodeResponse> {
    const body = new URLSearchParams({
        client_id: clientId,
        scope: SCOPE,
    });
    const res = await requestUrl({
        url: DEVICE_CODE_ENDPOINT,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: body.toString(),
        throw: false,
    });
    if (res.status !== 200) {
        throw new Error(
            `Device code request failed (${res.status}): ${res.text.slice(0, 300)}`
        );
    }
    const json = res.json as {
        device_code: string;
        user_code: string;
        verification_url: string;
        expires_in: number;
        interval: number;
    };
    return {
        deviceCode: json.device_code,
        userCode: json.user_code,
        verificationUrl: json.verification_url,
        expiresAt: Date.now() + json.expires_in * 1000,
        pollIntervalSec: json.interval,
    };
}

/**
 * Poll the token endpoint. Resolves with the refresh token once the user
 * completes consent. Rejects if they cancel, the device code expires, or
 * the network fails repeatedly.
 *
 * The caller is expected to pass an AbortSignal so a closed modal cancels
 * the polling.
 */
export async function pollDeviceAuth(
    clientId: string,
    deviceCode: string,
    pollIntervalSec: number,
    expiresAt: number,
    signal: AbortSignal
): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
    while (Date.now() < expiresAt) {
        if (signal.aborted) throw new Error("Cancelled");
        await new Promise((r) => setTimeout(r, pollIntervalSec * 1000));
        if (signal.aborted) throw new Error("Cancelled");

        const body = new URLSearchParams({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        const res = await requestUrl({
            url: TOKEN_ENDPOINT,
            method: "POST",
            contentType: "application/x-www-form-urlencoded",
            body: body.toString(),
            throw: false,
        });

        if (res.status === 200) {
            const json = res.json as {
                refresh_token: string;
                access_token: string;
                expires_in: number;
            };
            return {
                refreshToken: json.refresh_token,
                accessToken: json.access_token,
                expiresIn: json.expires_in,
            };
        }

        const err = res.json as { error?: string } | null;
        if (err?.error === "authorization_pending") continue;
        if (err?.error === "slow_down") {
            pollIntervalSec += 5;
            continue;
        }
        if (err?.error === "expired_token") {
            throw new Error("Auth code expired. Try connecting again.");
        }
        if (err?.error === "access_denied") {
            throw new Error("User cancelled the Google consent screen.");
        }
        throw new Error(
            `Token poll failed (${res.status}): ${res.text.slice(0, 300)}`
        );
    }
    throw new Error("Auth code expired before user completed sign-in.");
}

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 * Cached until ~60s before expiry.
 */
export async function getAccessToken(
    refreshToken: string,
    clientId: string
): Promise<string> {
    if (!refreshToken) {
        throw new Error("Not authenticated. Run 'Connect to Google Drive'.");
    }

    const cached = accessTokenCache.get(refreshToken);
    if (cached && cached.expiresAt - Date.now() > 60_000) {
        return cached.accessToken;
    }

    const body = new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
    });
    const res = await requestUrl({
        url: TOKEN_ENDPOINT,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: body.toString(),
        throw: false,
    });
    if (res.status !== 200) {
        throw new Error(
            `Token refresh failed (${res.status}): ${res.text.slice(0, 300)}`
        );
    }
    const json = res.json as { access_token: string; expires_in: number };
    accessTokenCache.set(refreshToken, {
        accessToken: json.access_token,
        expiresAt: Date.now() + json.expires_in * 1000,
    });
    return json.access_token;
}

export function clearAccessTokenCache(refreshToken?: string): void {
    if (refreshToken === undefined) {
        accessTokenCache.clear();
    } else {
        accessTokenCache.delete(refreshToken);
    }
}
