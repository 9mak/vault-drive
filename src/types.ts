/**
 * Persisted plugin settings.
 *
 * `refreshToken` is the long-lived Google OAuth credential. It is treated as
 * a secret and only stored in Obsidian's per-vault data file (never
 * synced or logged).
 */
export interface VaultDriveSettings {
    /** Refresh token returned by Google after the device-flow consent. */
    refreshToken: string;
    /** ID of the GDrive folder this plugin owns (created on first sync). */
    rootFolderId: string;
    /** Glob patterns to include in sync. Markdown is excluded by default. */
    includeGlobs: string[];
    /** Glob patterns to exclude. */
    excludeGlobs: string[];
    /** Epoch ms of last completed sync run. */
    lastSyncAt: number | null;
}

export const DEFAULT_SETTINGS: VaultDriveSettings = {
    refreshToken: "",
    rootFolderId: "",
    includeGlobs: ["attachments/**", "*.png", "*.jpg", "*.pdf", "*.mp4"],
    excludeGlobs: ["**/*.md"],
    lastSyncAt: null,
};

/** Result row written to the conflict log. */
export interface SyncConflict {
    path: string;
    /** What we did with the conflict: `kept-local`, `kept-remote`, `duplicated`. */
    resolution: "kept-local" | "kept-remote" | "duplicated";
    detectedAt: number;
}

/** Aggregated outcome of a single sync run. */
export interface SyncRunResult {
    uploaded: number;
    downloaded: number;
    deleted: number;
    skipped: number;
    conflicts: SyncConflict[];
    errors: string[];
    durationMs: number;
}
