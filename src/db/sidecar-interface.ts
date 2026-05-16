/**
 * @file vfsdriver-localfs/src/db/sidecar-interface.ts
 * v4.1: Simplified ISidecarDb for path-based backend. No ino allocation or path_ino CRUD.
 */

export interface MetaExtRow {
    path:           string;
    icon:           string | null;
    device_handler: string | null;
    is_asset_dir:   number;   // 0 | 1
    tags:           string | null;
    metadata:       string | null;
    extra:          string | null;
}

export interface ISidecarDb {
    // ── meta_ext ──
    getMetaExt(path: string): Promise<MetaExtRow | null>;
    upsertMetaExt(row: MetaExtRow): Promise<void>;
    deleteMetaExt(path: string): Promise<void>;

    // ── tags ──
    syncTags(path: string, tags: string[] | undefined): Promise<void>;
    getAllDistinctTags(): Promise<string[]>;
    queryByTag(tag: string): Promise<string[]>;

    // ── staging ──
    getStagePath(ref: string): Promise<string | null>;
    setStage(ref: string, stagePath: string): Promise<void>;
    clearStage(ref: string): Promise<void>;
    allStaged(): Promise<Array<{ ref: string; path: string }>>;

    /** Run PRAGMA integrity_check etc. Returns { ok, error }. */
    healthCheck(): Promise<{ ok: boolean; error?: string }>;

    close(): Promise<void>;
}
