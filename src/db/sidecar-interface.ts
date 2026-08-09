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

    // ── SeqFile records ──
    getRecordField(path: string, field: string): Promise<unknown | undefined>;
    setRecordField(path: string, field: string, value: unknown): Promise<void>;
    deleteRecordField(path: string, field: string): Promise<void>;
    listRecordFields(path: string, prefix?: string): Promise<Array<{ field: string; value: unknown }>>;
    clearRecordFields(path: string): Promise<void>;

    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;

    /** Run PRAGMA integrity_check etc. Returns { ok, error }. */
    healthCheck(): Promise<{ ok: boolean; error?: string }>;

    close(): Promise<void>;
}
