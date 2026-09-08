/**
 * @file vfsdriver-localfs/src/db/sidecar.ts
 *
 * BetterSqliteSidecarDb — path-based sidecar SQLite (v4.1).
 * Only stores non-derivable metadata. No ino allocation or path_ino CRUD.
 */

import Database from 'better-sqlite3';
import type { ISidecarDb, MetaExtRow } from './sidecar-interface';
import { DDL, SCHEMA_VERSION } from './schema';
import { PATH_DATA_EXISTS, movePathStatements } from './path-data';

export class BetterSqliteSidecarDb implements ISidecarDb {
    private readonly db: Database.Database;
    // SQL here is a fixed set of parameterized templates. Retain prepared statements
    // for the connection lifetime instead of churning native objects on every record read.
    private readonly statements = new Map<string, Database.Statement>();

    private prepare(sql: string): Database.Statement {
        let statement = this.statements.get(sql);
        if (!statement) {
            statement = this.db.prepare(sql);
            this.statements.set(sql, statement);
        }
        return statement;
    }

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('cache_size = -8000');
        this.db.pragma('busy_timeout = 5000');
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        if (tables.length) {
            const versions = tables.some(table => table.name === '_schema_version') ? this.db.prepare('SELECT version FROM _schema_version').all() as Array<{ version: number }> : [];
            if (versions.length !== 1 || versions[0].version !== SCHEMA_VERSION) { this.db.close(); throw new Error('Filesystem database version incompatible'); }
        }
        this.db.exec(DDL);
    }

    // ── meta_ext ─────────────────────────────────────────────────

    getMetaExt(path: string): Promise<MetaExtRow | null> {
        const row = this.prepare('SELECT * FROM meta_ext WHERE path = ?').get(path) as MetaExtRow | undefined;
        return Promise.resolve(row ?? null);
    }

    upsertMetaExt(row: MetaExtRow): Promise<void> {
        try {
            this.prepare(`
                INSERT INTO meta_ext (path, icon, device_handler, is_asset_dir, tags, metadata, extra)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    icon=excluded.icon, device_handler=excluded.device_handler,
                    is_asset_dir=excluded.is_asset_dir, tags=excluded.tags,
                    metadata=excluded.metadata, extra=excluded.extra
            `).run(row.path, row.icon, row.device_handler, row.is_asset_dir, row.tags, row.metadata, row.extra);
        } catch (e) {
            console.error(`[LocalFS:DB] upsertMetaExt FAILED path="${row.path}"`, e);
            throw e;
        }
        return Promise.resolve();
    }

    deleteMetaExt(path: string): Promise<void> {
        this.prepare("DELETE FROM meta_ext WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'").run(path, path, path);
        return Promise.resolve();
    }

    async assertPathDataVacant(path: string): Promise<void> {
        if (this.prepare(PATH_DATA_EXISTS).get(path, path, path, path, path, path)) throw new Error(`Destination has durable data: ${path}`);
    }



    async movePathData(from: string, to: string): Promise<void> {
        for (const { sql, values } of movePathStatements(from, to)) this.prepare(sql).run(...values);
    }

    // ── tags ────────────────────────────────────────────────────

    syncTags(path: string, tags: string[] | undefined): Promise<void> {
        const del = this.prepare('DELETE FROM meta_tags WHERE path = ?');
        const ins = this.prepare('INSERT OR IGNORE INTO meta_tags (path, tag) VALUES (?, ?)');
        try {
            // Diagnostic: verify meta_ext row exists before inserting tags
            const parentExists = this.prepare('SELECT 1 FROM meta_ext WHERE path = ?').get(path);
            if (!parentExists) {
                console.error(`[LocalFS:DB] syncTags: meta_ext row MISSING for path="${path}" — INSERT will fail FK`);
            }
            const tx = this.db.transaction(() => {
                del.run(path);
                if (tags) for (const t of tags) ins.run(path, t);
            });
            tx();
        } catch (e) {
            console.error(`[LocalFS:DB] syncTags FAILED path="${path}" tags=${JSON.stringify(tags)}`, e);
            throw e;
        }
        return Promise.resolve();
    }

    getAllDistinctTags(): Promise<string[]> {
        const rows = this.prepare('SELECT DISTINCT tag FROM meta_tags ORDER BY tag').all() as Array<{ tag: string }>;
        return Promise.resolve(rows.map(r => r.tag));
    }

    async listTagEntries(): Promise<Array<{ path: string; tag: string }>> {
        return this.db.prepare('SELECT path, tag FROM meta_tags ORDER BY path, tag').all() as Array<{ path: string; tag: string }>;
    }

    queryByTag(tag: string): Promise<string[]> {
        const rows = this.prepare('SELECT path FROM meta_tags WHERE tag = ?').all(tag) as Array<{ path: string }>;
        return Promise.resolve(rows.map(r => r.path));
    }

    getRecordField(path: string, field: string): Promise<unknown | undefined> {
        const row = this.prepare('SELECT value FROM records WHERE path = ? AND field = ?')
            .get(path, field) as { value: string } | undefined;
        return Promise.resolve(row ? JSON.parse(row.value) : undefined);
    }

    setRecordField(path: string, field: string, value: unknown): Promise<void> {
        this.prepare(`INSERT INTO records(path, field, value) VALUES (?, ?, ?)
            ON CONFLICT(path, field) DO UPDATE SET value = excluded.value`)
            .run(path, field, JSON.stringify(value));
        return Promise.resolve();
    }

    deleteRecordField(path: string, field: string): Promise<void> {
        this.prepare('DELETE FROM records WHERE path = ? AND field = ?').run(path, field);
        return Promise.resolve();
    }

    listRecordFields(path: string, prefix = ''): Promise<Array<{ field: string; value: unknown }>> {
        const rows = this.prepare(`SELECT field, value FROM records
            WHERE path = ? AND field LIKE ? ESCAPE '\\' ORDER BY field`)
            .all(path, `${escapeLike(prefix)}%`) as Array<{ field: string; value: string }>;
        return Promise.resolve(rows.map(row => ({ field: row.field, value: JSON.parse(row.value) })));
    }

    clearRecordFields(path: string): Promise<void> {
        this.prepare('DELETE FROM records WHERE path = ?').run(path);
        return Promise.resolve();
    }

    begin(): Promise<void> { this.db.exec('BEGIN IMMEDIATE'); return Promise.resolve(); }
    commit(): Promise<void> { this.db.exec('COMMIT'); return Promise.resolve(); }
    rollback(): Promise<void> { this.db.exec('ROLLBACK'); return Promise.resolve(); }

    // ── health ─────────────────────────────────────────────────

    healthCheck(): Promise<{ ok: boolean; error?: string }> {
        try {
            const row = this.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
            const ok = row?.integrity_check === 'ok';
            return Promise.resolve(ok ? { ok: true } : { ok: false, error: row?.integrity_check });
        } catch (e) {
            return Promise.resolve({ ok: false, error: String(e) });
        }
    }

    // ── lifecycle ───────────────────────────────────────────────

    close(): Promise<void> {
        this.db.close();
        this.statements.clear();
        return Promise.resolve();
    }
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, match => `\\${match}`);
}
