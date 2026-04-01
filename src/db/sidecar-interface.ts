/**
 * @file vfsdriver-localfs/src/db/sidecar-interface.ts
 *
 * ISidecarDb — fully-async abstraction over the sidecar SQLite database.
 *
 * Two implementations:
 *   BetterSqliteSidecarDb  — Node.js/Electron, uses better-sqlite3 (sync → wrapped in Promise)
 *   TauriSqlSidecarDb      — Tauri WebView, uses @tauri-apps/plugin-sql (native async)
 *
 * All three stores (inode / meta / content) depend only on this interface,
 * making the backend swappable without touching store logic.
 */

// ── Shared row types ────────────────────────────────────────────────────────

export interface PathEntry {
    rel:  string;
    type: string;  // 'file' | 'directory'
}

/** Non-derivable metadata fields stored in the sidecar. */
export interface MetaExtRow {
    ino:            number;
    mime_type:      string | null;
    icon:           string | null;
    symlink_target: string | null;
    device_handler: string | null;
    asset_dir_ino:  number | null;
    owner_file_ino: number | null;
    is_asset_dir:   number;   // 0 | 1
    tags:           string | null;  // JSON array
    metadata:       string | null;  // JSON object
    extra:          string | null;  // JSON object
}

// ── Interface ───────────────────────────────────────────────────────────────

export interface ISidecarDb {
    // ── Ino counter ──────────────────────────────────────────────────────────
    allocateIno(): Promise<number>;

    // ── path_ino CRUD ─────────────────────────────────────────────────────────
    getEntry(ino: number): Promise<PathEntry | null>;
    getRelPath(ino: number): Promise<string | null>;
    getInoForRel(rel: string): Promise<number | null>;

    /**
     * Get or create an ino for a given rel path.
     * Idempotent: returns existing ino if rel is already tracked.
     */
    registerPath(rel: string, type: 'file' | 'directory', createdAt: number): Promise<number>;

    /** Insert with a specific ino (INSERT OR IGNORE — idempotent). */
    insertPath(ino: number, rel: string, type: 'file' | 'directory', createdAt: number): Promise<void>;

    /**
     * List direct children of a directory by its relative path.
     * Used to discover VFS-internal entries (asset dirs, __config/) that are
     * registered in the sidecar but not created on the real filesystem.
     */
    listDirectChildren(parentRel: string): Promise<Array<{ ino: number; name: string; type: 'file' | 'directory'; createdAt: number }>>;

    updateRel(ino: number, newRel: string): Promise<void>;
    deletePath(ino: number): Promise<void>;

    // ── Staging ───────────────────────────────────────────────────────────────
    getStagePath(ref: string): Promise<string | null>;
    setStage(ref: string, stagePath: string): Promise<void>;
    clearStage(ref: string): Promise<void>;
    allStaged(): Promise<Array<{ ref: string; path: string }>>;

    // ── meta_ext CRUD ─────────────────────────────────────────────────────────
    getMetaExt(ino: number): Promise<MetaExtRow | null>;
    upsertMetaExt(row: MetaExtRow): Promise<void>;
    deleteMetaExt(ino: number): Promise<void>;

    /** Replace the tag index for an ino (delete-all + re-insert). */
    syncTags(ino: number, tags: string[] | undefined): Promise<void>;
    queryByTag(tag: string): Promise<number[]>;
    /** Return all distinct tag strings currently in use. O(T). */
    getAllDistinctTags(): Promise<string[]>;
    queryByMetadata(jsonPath: string, value: string): Promise<number[]>;

    // ── Transaction ───────────────────────────────────────────────────────────
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;

    close(): Promise<void>;
}
