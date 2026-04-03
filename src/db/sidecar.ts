/**
 * @file vfsdriver-localfs/src/db/sidecar.ts
 *
 * BetterSqliteSidecarDb — ISidecarDb backed by better-sqlite3.
 *
 * All better-sqlite3 calls are synchronous; they are wrapped in async methods
 * to satisfy the ISidecarDb interface. Callers get already-resolved Promises
 * with no actual I/O delay.
 *
 * ## Atomicity
 *
 * Methods that issue multiple SQL statements (syncTags, registerPath) use
 * better-sqlite3's native db.transaction() wrapper, which:
 *   - Issues BEGIN IMMEDIATE / COMMIT automatically (synchronous)
 *   - Is re-entrant: nested calls within an active transaction run directly
 *     without issuing another BEGIN (savepoint semantics)
 *   - Rolls back automatically on throw
 *
 * LocalFSBackend.txQueue serializes all runInTransaction callers, so no two
 * operations run concurrently. Combined with per-method sync transactions,
 * SQLITE_BUSY is impossible in the Node.js / Electron environment.
 *
 * WAL mode is enabled to allow concurrent reads without blocking writes.
 * busy_timeout is set so brief contention (e.g. external readers) is retried.
 */

import Database from 'better-sqlite3';
import type { ISidecarDb, PathEntry, MetaExtRow } from './sidecar-interface';
import { DDL, SCHEMA_VERSION } from './schema';

export class BetterSqliteSidecarDb implements ISidecarDb {
    readonly db: Database.Database;

    // ── Pre-compiled statements ────────────────────────────────────────────────

    private readonly stmtAllocate:      Database.Statement;
    private readonly stmtGetEntry:      Database.Statement;
    private readonly stmtGetInoByRel:   Database.Statement;
    private readonly stmtInsertPath:    Database.Statement;
    private readonly stmtUpdateRel:     Database.Statement;
    private readonly stmtDeletePath:    Database.Statement;

    private readonly stmtGetStage:      Database.Statement;
    private readonly stmtSetStage:      Database.Statement;
    private readonly stmtClearStage:    Database.Statement;
    private readonly stmtAllStage:      Database.Statement;

    private readonly stmtListChildrenRoot: Database.Statement;
    private readonly stmtListChildrenDir:  Database.Statement;

    private readonly stmtGetMetaExt:    Database.Statement;
    private readonly stmtUpsertMetaExt: Database.Statement;
    private readonly stmtDeleteMetaExt: Database.Statement;
    private readonly stmtDelTags:       Database.Statement;
    private readonly stmtInsTags:       Database.Statement;
    private readonly stmtQueryByTag:    Database.Statement;
    private readonly stmtAllDistinctTags: Database.Statement;

    // ── Pre-compiled transaction wrappers for multi-statement operations ────────

    /**
     * Atomic register: get-or-create an ino for a path. Re-entrant (safe to
     * call inside or outside an existing better-sqlite3 transaction).
     */
    private readonly _registerPathTx: (rel: string, type: 'file' | 'directory', createdAt: number) => number;

    /**
     * Atomic tag sync: DELETE existing tags then INSERT new ones in one
     * transaction. Re-entrant.
     */
    private readonly _syncTagsTx: (ino: number, tags: string[] | undefined) => void;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);

        // WAL mode: readers don't block writers; writers don't block readers.
        this.db.pragma('journal_mode = WAL');
        // Retry up to 5 s on lock contention (e.g. external SQLite browser).
        this.db.pragma('busy_timeout = 5000');

        this.db.exec(DDL);

        const hasVersion = this.db
            .prepare('SELECT 1 FROM _schema_version WHERE version = ?')
            .get(SCHEMA_VERSION);
        if (!hasVersion) {
            this.db.prepare('INSERT OR REPLACE INTO _schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
        }

        this.stmtAllocate    = this.db.prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value');
        this.stmtGetEntry    = this.db.prepare('SELECT rel, type FROM path_ino WHERE ino = ?');
        this.stmtGetInoByRel = this.db.prepare('SELECT ino FROM path_ino WHERE rel = ?');
        this.stmtInsertPath  = this.db.prepare('INSERT OR IGNORE INTO path_ino (ino, rel, type, created_at) VALUES (?, ?, ?, ?)');
        this.stmtUpdateRel   = this.db.prepare('UPDATE path_ino SET rel = ? WHERE ino = ?');
        this.stmtDeletePath  = this.db.prepare('DELETE FROM path_ino WHERE ino = ?');

        this.stmtGetStage    = this.db.prepare('SELECT path FROM staging WHERE ref = ?');
        this.stmtSetStage    = this.db.prepare('INSERT OR REPLACE INTO staging (ref, path) VALUES (?, ?)');
        this.stmtClearStage  = this.db.prepare('DELETE FROM staging WHERE ref = ?');
        this.stmtAllStage    = this.db.prepare('SELECT ref, path FROM staging');

        // Direct children queries — used to find VFS-internal dirs not present on real FS.
        // Root children: non-empty rel with no slash.
        // Subdir children: rel matches 'parent/*' but not 'parent/*/*'.
        this.stmtListChildrenRoot = this.db.prepare(
            `SELECT ino, rel, type, created_at FROM path_ino WHERE rel != '' AND rel NOT GLOB '*/*'`,
        );
        this.stmtListChildrenDir = this.db.prepare(
            `SELECT ino, rel, type, created_at FROM path_ino WHERE rel GLOB ? AND rel NOT GLOB ?`,
        );

        this.stmtGetMetaExt    = this.db.prepare('SELECT * FROM meta_ext WHERE ino = ?');
        this.stmtUpsertMetaExt = this.db.prepare(`
            INSERT INTO meta_ext
                (ino, mime_type, icon, symlink_target, device_handler,
                 asset_dir_ino, owner_file_ino, is_asset_dir, tags, metadata, extra)
            VALUES
                (@ino, @mime_type, @icon, @symlink_target, @device_handler,
                 @asset_dir_ino, @owner_file_ino, @is_asset_dir, @tags, @metadata, @extra)
            ON CONFLICT(ino) DO UPDATE SET
                mime_type      = excluded.mime_type,
                icon           = excluded.icon,
                symlink_target = excluded.symlink_target,
                device_handler = excluded.device_handler,
                asset_dir_ino  = excluded.asset_dir_ino,
                owner_file_ino = excluded.owner_file_ino,
                is_asset_dir   = excluded.is_asset_dir,
                tags           = excluded.tags,
                metadata       = excluded.metadata,
                extra          = excluded.extra
        `);
        this.stmtDeleteMetaExt = this.db.prepare('DELETE FROM meta_ext WHERE ino = ?');
        this.stmtDelTags       = this.db.prepare('DELETE FROM meta_tags WHERE ino = ?');
        this.stmtInsTags       = this.db.prepare('INSERT OR IGNORE INTO meta_tags (ino, tag) VALUES (?, ?)');
        this.stmtQueryByTag    = this.db.prepare('SELECT ino FROM meta_tags WHERE tag = ?');
        this.stmtAllDistinctTags = this.db.prepare('SELECT DISTINCT tag FROM meta_tags');

        // Pre-compile transaction wrappers. better-sqlite3 .transaction() is
        // re-entrant: if called while already inside a transaction, the wrapped
        // function runs directly without issuing a nested BEGIN.
        this._registerPathTx = this.db.transaction(
            (rel: string, type: 'file' | 'directory', createdAt: number): number => {
                const existing = this.stmtGetInoByRel.get(rel) as { ino: number } | undefined;
                if (existing) return existing.ino;
                const ino = (this.stmtAllocate.get('ino') as { value: number }).value;
                this.stmtInsertPath.run(ino, rel, type, createdAt);
                return ino;
            },
        );

        this._syncTagsTx = this.db.transaction(
            (ino: number, tags: string[] | undefined) => {
                this.stmtDelTags.run(ino);
                if (tags) {
                    for (const tag of tags) this.stmtInsTags.run(ino, tag);
                }
            },
        );
    }

    // ── Ino counter ────────────────────────────────────────────────────────────

    async allocateIno(): Promise<number> {
        return (this.stmtAllocate.get('ino') as { value: number }).value;
    }

    // ── path_ino ───────────────────────────────────────────────────────────────

    async getEntry(ino: number): Promise<PathEntry | null> {
        return (this.stmtGetEntry.get(ino) as PathEntry | undefined) ?? null;
    }

    async getRelPath(ino: number): Promise<string | null> {
        const row = this.stmtGetEntry.get(ino) as { rel: string } | undefined;
        return row?.rel ?? null;
    }

    async getInoForRel(rel: string): Promise<number | null> {
        const row = this.stmtGetInoByRel.get(rel) as { ino: number } | undefined;
        return row?.ino ?? null;
    }

    async registerPath(rel: string, type: 'file' | 'directory', createdAt: number): Promise<number> {
        return this._registerPathTx(rel, type, createdAt);
    }

    async insertPath(ino: number, rel: string, type: 'file' | 'directory', createdAt: number): Promise<void> {
        this.stmtInsertPath.run(ino, rel, type, createdAt);
    }

    async listDirectChildren(parentRel: string): Promise<Array<{ ino: number; name: string; type: 'file' | 'directory'; createdAt: number }>> {
        type Row = { ino: number; rel: string; type: string; created_at: number };
        const rows: Row[] = parentRel === ''
            ? this.stmtListChildrenRoot.all() as Row[]
            : this.stmtListChildrenDir.all(`${parentRel}/*`, `${parentRel}/*/*`) as Row[];
        const prefixLen = parentRel === '' ? 0 : parentRel.length + 1;
        return rows.map(r => ({
            ino: r.ino,
            name: r.rel.slice(prefixLen),
            type: r.type as 'file' | 'directory',
            createdAt: r.created_at,
        }));
    }

    async updateRel(ino: number, newRel: string): Promise<void> {
        this.stmtUpdateRel.run(newRel, ino);
    }

    async deletePath(ino: number): Promise<void> {
        this.stmtDeletePath.run(ino);
    }

    // ── Staging ────────────────────────────────────────────────────────────────

    async getStagePath(ref: string): Promise<string | null> {
        const row = this.stmtGetStage.get(ref) as { path: string } | undefined;
        return row?.path ?? null;
    }

    async setStage(ref: string, stagePath: string): Promise<void> {
        this.stmtSetStage.run(ref, stagePath);
    }

    async clearStage(ref: string): Promise<void> {
        this.stmtClearStage.run(ref);
    }

    async allStaged(): Promise<Array<{ ref: string; path: string }>> {
        return this.stmtAllStage.all() as Array<{ ref: string; path: string }>;
    }

    // ── meta_ext ───────────────────────────────────────────────────────────────

    async getMetaExt(ino: number): Promise<MetaExtRow | null> {
        return (this.stmtGetMetaExt.get(ino) as MetaExtRow | undefined) ?? null;
    }

    async upsertMetaExt(row: MetaExtRow): Promise<void> {
        this.stmtUpsertMetaExt.run(row);
    }

    async deleteMetaExt(ino: number): Promise<void> {
        this.stmtDeleteMetaExt.run(ino);
    }

    async syncTags(ino: number, tags: string[] | undefined): Promise<void> {
        this._syncTagsTx(ino, tags);
    }

    async queryByTag(tag: string): Promise<number[]> {
        return (this.stmtQueryByTag.all(tag) as Array<{ ino: number }>).map(r => r.ino);
    }

    async getAllDistinctTags(): Promise<string[]> {
        return (this.stmtAllDistinctTags.all() as Array<{ tag: string }>).map(r => r.tag);
    }

    async queryByMetadata(jsonPath: string, value: string): Promise<number[]> {
        const rows = this.db
            .prepare('SELECT ino FROM meta_ext WHERE json_extract(metadata, ?) = ?')
            .all(jsonPath, value) as Array<{ ino: number }>;
        return rows.map(r => r.ino);
    }

    // ── Transaction (ISidecarDb) ───────────────────────────────────────────────
    // LocalFSBackend no longer calls begin/commit/rollback across async
    // boundaries. These no-ops satisfy the ISidecarDb interface.

    async begin(): Promise<void>    { /* no-op */ }
    async commit(): Promise<void>   { /* no-op */ }
    async rollback(): Promise<void> { /* no-op */ }
    async close(): Promise<void>    { this.db.close(); }
}

/** Backward-compatible alias. */
export { BetterSqliteSidecarDb as SidecarDb };
