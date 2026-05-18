/**
 * @file vfsdriver-localfs/src/db/sidecar.ts
 *
 * BetterSqliteSidecarDb — path-based sidecar SQLite (v4.1).
 * Only stores non-derivable metadata. No ino allocation or path_ino CRUD.
 */

import Database from 'better-sqlite3';
import type { ISidecarDb, MetaExtRow } from './sidecar-interface';
import { DDL } from './schema';

export class BetterSqliteSidecarDb implements ISidecarDb {
    private readonly db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('cache_size = -8000');
        this.db.pragma('busy_timeout = 5000');
        this.db.exec(DDL);
    }

    // ── meta_ext ─────────────────────────────────────────────────

    getMetaExt(path: string): Promise<MetaExtRow | null> {
        const row = this.db.prepare('SELECT * FROM meta_ext WHERE path = ?').get(path) as MetaExtRow | undefined;
        return Promise.resolve(row ?? null);
    }

    upsertMetaExt(row: MetaExtRow): Promise<void> {
        try {
            this.db.prepare(`
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
        this.db.prepare('DELETE FROM meta_ext WHERE path = ?').run(path);
        return Promise.resolve();
    }

    // ── tags ────────────────────────────────────────────────────

    syncTags(path: string, tags: string[] | undefined): Promise<void> {
        const del = this.db.prepare('DELETE FROM meta_tags WHERE path = ?');
        const ins = this.db.prepare('INSERT OR IGNORE INTO meta_tags (path, tag) VALUES (?, ?)');
        try {
            // Diagnostic: verify meta_ext row exists before inserting tags
            const parentExists = this.db.prepare('SELECT 1 FROM meta_ext WHERE path = ?').get(path);
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
        const rows = this.db.prepare('SELECT DISTINCT tag FROM meta_tags ORDER BY tag').all() as Array<{ tag: string }>;
        return Promise.resolve(rows.map(r => r.tag));
    }

    queryByTag(tag: string): Promise<string[]> {
        const rows = this.db.prepare('SELECT path FROM meta_tags WHERE tag = ?').all(tag) as Array<{ path: string }>;
        return Promise.resolve(rows.map(r => r.path));
    }

    // ── health ─────────────────────────────────────────────────

    healthCheck(): Promise<{ ok: boolean; error?: string }> {
        try {
            const row = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
            const ok = row?.integrity_check === 'ok';
            return Promise.resolve(ok ? { ok: true } : { ok: false, error: row?.integrity_check });
        } catch (e) {
            return Promise.resolve({ ok: false, error: String(e) });
        }
    }

    // ── lifecycle ───────────────────────────────────────────────

    close(): Promise<void> {
        this.db.close();
        return Promise.resolve();
    }
}
