/**
 * Sync planning + execution.
 *
 * v0.1 strategy: "last-write-wins, skip Markdown, attachments only".
 *  - Walk the vault, filter via the include/exclude globs.
 *  - List remote children of the configured root folder.
 *  - For each local-only file -> upload. Each remote-only file -> download.
 *    Each in both -> keep newer mtime.
 *
 * v0.2+ ideas: subdirectory mirroring, deletion propagation, content-hash
 * conflict detection, encryption, background sync.
 */

import type { Vault, TFile } from "obsidian";
import { TFolder } from "obsidian";
import * as drive from "./gdrive";
import type {
    SyncConflict,
    SyncRunResult,
    VaultDriveSettings,
} from "./types";

interface PlanItem {
    kind: "upload" | "download" | "noop";
    localPath?: string;
    remoteId?: string;
    reason?: string;
}

/**
 * Tiny glob matcher: `*` matches anything except `/`, `**` matches across
 * directory boundaries. Sufficient for the include/exclude patterns shipped
 * in v0.1 defaults; replace with a battle-tested impl if we expand.
 */
function globMatch(pattern: string, path: string): boolean {
    let re = "";
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === "*") {
            if (pattern[i + 1] === "*") {
                re += ".*";
                i += 2;
            } else {
                re += "[^/]*";
                i += 1;
            }
        } else if (".+^${}()|[]\\".includes(c)) {
            re += "\\" + c;
            i += 1;
        } else {
            re += c;
            i += 1;
        }
    }
    return new RegExp("^" + re + "$").test(path);
}

function matchAny(path: string, patterns: string[]): boolean {
    return patterns.some((pat) => globMatch(pat, path));
}

function shouldSync(path: string, settings: VaultDriveSettings): boolean {
    if (matchAny(path, settings.excludeGlobs)) return false;
    return matchAny(path, settings.includeGlobs);
}

async function listVaultFiles(
    vault: Vault,
    settings: VaultDriveSettings
): Promise<TFile[]> {
    const out: TFile[] = [];
    const walk = (folder: TFolder) => {
        for (const child of folder.children) {
            if (child instanceof TFolder) walk(child);
            else if (
                "stat" in child &&
                shouldSync((child as TFile).path, settings)
            ) {
                out.push(child as TFile);
            }
        }
    };
    walk(vault.getRoot());
    return out;
}

export async function runSync(
    vault: Vault,
    settings: VaultDriveSettings,
    accessToken: string
): Promise<SyncRunResult> {
    const start = Date.now();
    const result: SyncRunResult = {
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        skipped: 0,
        conflicts: [] as SyncConflict[],
        errors: [],
        durationMs: 0,
    };

    if (!settings.rootFolderId) {
        result.errors.push(
            "rootFolderId not configured - run 'Connect to Google Drive' first."
        );
        result.durationMs = Date.now() - start;
        return result;
    }

    let local: TFile[];
    let remote: drive.DriveFile[];
    try {
        [local, remote] = await Promise.all([
            listVaultFiles(vault, settings),
            drive.listFolder(accessToken, settings.rootFolderId),
        ]);
    } catch (e) {
        result.errors.push(e instanceof Error ? e.message : String(e));
        result.durationMs = Date.now() - start;
        return result;
    }

    // v0.1 only handles files at the top level of the configured root folder
    // (no subdirectory mirroring). Local paths are flattened to basename for
    // matching; the docs warn about this.
    const remoteByName = new Map<string, drive.DriveFile>();
    for (const r of remote) {
        if (r.mimeType !== "application/vnd.google-apps.folder") {
            remoteByName.set(r.name, r);
        }
    }

    // Detect local files that share a basename. Without per-path namespacing
    // on Drive, syncing them would silently overwrite each other. Skip the
    // entire group and surface the collision to the user.
    const localByBasename = new Map<string, string[]>();
    for (const file of local) {
        const name = file.path.split("/").pop()!;
        const existing = localByBasename.get(name);
        if (existing) existing.push(file.path);
        else localByBasename.set(name, [file.path]);
    }
    const collidingBasenames = new Set<string>();
    for (const [name, paths] of localByBasename.entries()) {
        if (paths.length > 1) {
            collidingBasenames.add(name);
            result.errors.push(
                `Skipped basename collision "${name}": ${paths.join(", ")}. ` +
                    `Vault Drive v0.1 mirrors files by basename only — rename ` +
                    `one of these or move it outside the include patterns.`
            );
            result.skipped += paths.length;
        }
    }

    const plan: PlanItem[] = [];
    const seenRemoteIds = new Set<string>();

    for (const file of local) {
        const name = file.path.split("/").pop()!;
        if (collidingBasenames.has(name)) continue;
        const remoteMatch = remoteByName.get(name);
        if (!remoteMatch) {
            plan.push({ kind: "upload", localPath: file.path });
            continue;
        }
        seenRemoteIds.add(remoteMatch.id);
        const localMtime = file.stat.mtime;
        const remoteMtime = remoteMatch.modifiedAt;
        if (localMtime > remoteMtime + 1000) {
            plan.push({
                kind: "upload",
                localPath: file.path,
                remoteId: remoteMatch.id,
                reason: "local newer",
            });
        } else if (remoteMtime > localMtime + 1000) {
            plan.push({
                kind: "download",
                localPath: file.path,
                remoteId: remoteMatch.id,
                reason: "remote newer",
            });
        } else {
            plan.push({ kind: "noop", localPath: file.path });
        }
    }

    for (const r of remote) {
        if (r.mimeType === "application/vnd.google-apps.folder") continue;
        if (!seenRemoteIds.has(r.id)) {
            // Strip path traversal segments before letting Obsidian write
            // — Drive could (in principle) return any string as `name`.
            const safeName = r.name.replace(/^[./\\]+/, "").replace(/\.\./g, "");
            if (safeName.length === 0 || safeName !== r.name) {
                result.errors.push(
                    `Skipping unsafe remote name: ${JSON.stringify(r.name)}`
                );
                result.skipped++;
                continue;
            }
            plan.push({ kind: "download", localPath: safeName, remoteId: r.id });
        }
    }

    for (const item of plan) {
        try {
            if (item.kind === "upload" && item.localPath) {
                const file = vault.getFileByPath(item.localPath);
                if (!file) {
                    result.skipped++;
                    continue;
                }
                const buf = await vault.readBinary(file);
                if (item.remoteId) {
                    // Update content in place via PATCH so a transient
                    // failure leaves the existing remote copy untouched
                    // (the previous delete-then-upload could lose remote
                    // data on upload failure).
                    await drive.updateFile(accessToken, item.remoteId, buf);
                } else {
                    const name = item.localPath.split("/").pop()!;
                    await drive.uploadFile(
                        accessToken,
                        settings.rootFolderId,
                        name,
                        buf
                    );
                }
                result.uploaded++;
            } else if (
                item.kind === "download" &&
                item.localPath &&
                item.remoteId
            ) {
                const buf = await drive.downloadFile(
                    accessToken,
                    item.remoteId
                );
                const existing = vault.getFileByPath(item.localPath);
                if (existing) {
                    await vault.modifyBinary(existing, buf);
                } else {
                    await vault.createBinary(item.localPath, buf);
                }
                result.downloaded++;
            } else {
                result.skipped++;
            }
        } catch (e) {
            result.errors.push(
                `${item.localPath ?? item.remoteId ?? "?"}: ${
                    e instanceof Error ? e.message : String(e)
                }`
            );
        }
    }

    result.durationMs = Date.now() - start;
    return result;
}
