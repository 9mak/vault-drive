/**
 * Thin Google Drive v3 client used by the sync logic.
 *
 * Scope is `drive.file`, so we can only see files this plugin itself
 * created. That keeps the Google verification footprint to zero.
 *
 * v0.1 scope: list / upload / download / delete. Move/rename and resumable
 * uploads are deferred.
 */

import { requestUrl } from "obsidian";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    /** Drive's modifiedTime as epoch ms. */
    modifiedAt: number;
    /** Bytes; absent for folders. */
    size?: number;
    md5Checksum?: string;
}

interface RawDriveFile {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    size?: string;
    md5Checksum?: string;
}

/** Wrap requestUrl with auth + a basic 429 retry. */
async function driveRequest(
    accessToken: string,
    url: string,
    init: {
        method?: string;
        contentType?: string;
        body?: string | ArrayBuffer;
        headers?: Record<string, string>;
    } = {}
): Promise<{ status: number; text: string; json: unknown }> {
    const maxAttempts = 4;
    let lastErr: { status: number; text: string; json: unknown } | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const res = await requestUrl({
            url,
            method: init.method ?? "GET",
            contentType: init.contentType,
            body: init.body,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                ...(init.headers ?? {}),
            },
            throw: false,
        });

        if (res.status !== 429 && res.status < 500) {
            return { status: res.status, text: res.text, json: res.json };
        }

        // 429 / 5xx: exponential backoff up to ~8s.
        lastErr = { status: res.status, text: res.text, json: res.json };
        const delayMs = Math.min(8000, 250 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, delayMs));
    }

    return lastErr ?? { status: 0, text: "request failed", json: null };
}

function decodeFile(raw: RawDriveFile): DriveFile {
    return {
        id: raw.id,
        name: raw.name,
        mimeType: raw.mimeType,
        modifiedAt: Date.parse(raw.modifiedTime),
        size: raw.size === undefined ? undefined : Number(raw.size),
        md5Checksum: raw.md5Checksum,
    };
}

/** List children of a folder, paginating until exhausted. */
export async function listFolder(
    accessToken: string,
    folderId: string
): Promise<DriveFile[]> {
    const results: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
        const params = new URLSearchParams({
            q: `'${folderId}' in parents and trashed=false`,
            fields: "files(id,name,mimeType,modifiedTime,size,md5Checksum),nextPageToken",
            pageSize: "200",
        });
        if (pageToken) params.set("pageToken", pageToken);

        const res = await driveRequest(
            accessToken,
            `${DRIVE_API}/files?${params}`
        );
        if (res.status !== 200) {
            throw new Error(
                `listFolder failed (${res.status}): ${res.text.slice(0, 300)}`
            );
        }
        const json = res.json as {
            files: RawDriveFile[];
            nextPageToken?: string;
        };
        for (const f of json.files) results.push(decodeFile(f));
        pageToken = json.nextPageToken;
    } while (pageToken);

    return results;
}

/**
 * Find a folder by name under a parent, creating it if missing.
 * Returns the folder ID.
 */
export async function ensureFolder(
    accessToken: string,
    name: string,
    parentId: string | "root" = "root"
): Promise<string> {
    const params = new URLSearchParams({
        q: `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
        fields: "files(id)",
    });
    const lookup = await driveRequest(
        accessToken,
        `${DRIVE_API}/files?${params}`
    );
    if (lookup.status !== 200) {
        throw new Error(
            `ensureFolder lookup failed (${lookup.status}): ${lookup.text.slice(0, 300)}`
        );
    }
    const found = (lookup.json as { files: { id: string }[] }).files;
    if (found.length > 0) return found[0].id;

    const created = await driveRequest(accessToken, `${DRIVE_API}/files`, {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({
            name,
            mimeType: FOLDER_MIME,
            parents: [parentId],
        }),
    });
    if (created.status !== 200) {
        throw new Error(
            `ensureFolder create failed (${created.status}): ${created.text.slice(0, 300)}`
        );
    }
    return (created.json as { id: string }).id;
}

/**
 * 32-hex-char random boundary derived from crypto.getRandomValues so the
 * envelope can never collide with binary file content (the previous
 * `Math.random()` 11-char boundary had a non-trivial collision probability
 * for attacker-controlled inputs).
 */
function multipartBoundary(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return "----vault-drive-" + hex;
}

function buildMultipartBody(
    metadata: string,
    content: ArrayBuffer
): { boundary: string; body: ArrayBuffer } {
    const boundary = multipartBoundary();
    const enc = new TextEncoder();
    const head = enc.encode(
        `--${boundary}\r\n` +
            "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
            metadata +
            "\r\n" +
            `--${boundary}\r\n` +
            "Content-Type: application/octet-stream\r\n\r\n"
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + content.byteLength + tail.length);
    body.set(head, 0);
    body.set(new Uint8Array(content), head.length);
    body.set(tail, head.length + content.byteLength);
    return { boundary, body: body.buffer };
}

/** Multipart upload of binary content. v0.1 scope. */
export async function uploadFile(
    accessToken: string,
    parentId: string,
    name: string,
    content: ArrayBuffer
): Promise<DriveFile> {
    const { boundary, body } = buildMultipartBody(
        JSON.stringify({ name, parents: [parentId] }),
        content
    );
    const res = await driveRequest(
        accessToken,
        `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,md5Checksum`,
        {
            method: "POST",
            contentType: `multipart/related; boundary=${boundary}`,
            body,
        }
    );
    if (res.status !== 200) {
        throw new Error(
            `uploadFile failed (${res.status}): ${res.text.slice(0, 300)}`
        );
    }
    return decodeFile(res.json as RawDriveFile);
}

/**
 * Update the content of an existing Drive file in place. Used by the sync
 * planner instead of delete-then-upload so a transient upload failure does
 * not leave the user with no remote copy at all.
 */
export async function updateFile(
    accessToken: string,
    fileId: string,
    content: ArrayBuffer
): Promise<DriveFile> {
    const { boundary, body } = buildMultipartBody(
        // Empty metadata patch — we're only changing content, not the name
        // or parents. PATCH with no fields leaves the existing metadata
        // intact while replacing the file's media.
        "{}",
        content
    );
    const res = await driveRequest(
        accessToken,
        `${DRIVE_UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,md5Checksum`,
        {
            method: "PATCH",
            contentType: `multipart/related; boundary=${boundary}`,
            body,
        }
    );
    if (res.status !== 200) {
        throw new Error(
            `updateFile failed (${res.status}): ${res.text.slice(0, 300)}`
        );
    }
    return decodeFile(res.json as RawDriveFile);
}

export async function downloadFile(
    accessToken: string,
    fileId: string
): Promise<ArrayBuffer> {
    const res = await requestUrl({
        url: `${DRIVE_API}/files/${fileId}?alt=media`,
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
    });
    if (res.status !== 200) {
        throw new Error(
            `downloadFile failed (${res.status}): ${res.text.slice(0, 300)}`
        );
    }
    return res.arrayBuffer;
}

export async function deleteFile(
    accessToken: string,
    fileId: string
): Promise<void> {
    const res = await driveRequest(
        accessToken,
        `${DRIVE_API}/files/${fileId}`,
        { method: "DELETE" }
    );
    if (res.status !== 204 && res.status !== 200) {
        throw new Error(
            `deleteFile failed (${res.status}): ${res.text.slice(0, 300)}`
        );
    }
}
