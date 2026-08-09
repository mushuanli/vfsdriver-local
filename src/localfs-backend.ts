/**
 * @file vfsdriver-localfs/src/localfs-backend.ts
 * v4.1: Path-based IStorageBackend. No ino allocation, no path_ino table.
 *
 * Stores files directly in rootDir. Non-derivable metadata in sidecar SQLite.
 * Internal paths (__config/…) go to sidecarDir/vfs-internal/.
 */

import type {
    IStorageBackend,
    FSNode,
    FSFileNode,
    FSDirectoryNode,
    IRecordStore,
    IRecordTransaction,
    RecordValue,
    RecordQuery,
    RecordQueryOptions,
    RecordQueryResult,
    RecordWalkOptions,
} from '@itookit/stdio';
import type { ISidecarDb, MetaExtRow } from './db/sidecar-interface';
import type { IFsOps, StatResult } from './fs/fs-ops';
import { ensureDir, joinPath, hasInternalSegment } from './utils/fs-utils';

export interface LocalFSBackendOptions {
    rootDir: string;
    sidecarDir: string;
    createDb?: (dbPath: string) => Promise<ISidecarDb>;
    createFs?: () => IFsOps | Promise<IFsOps>;
}

export interface VerifyResult {
    /** True if no issues detected. */
    healthy: boolean;
    /** Whether all required directories exist. */
    dirsExist: boolean;
    /** Whether the SQLite database passes integrity check. */
    dbHealthy: boolean;
    /** meta_ext paths with no corresponding file on disk. */
    orphanMetaExt: string[];
    /** meta_tags entries (formatted as "path#tag") referencing missing meta_ext rows. */
    orphanMetaTags: string[];
    /** Total meta_ext rows checked. */
    totalMetaExt: number;
    /** Total meta_tags rows checked. */
    totalMetaTags: number;
}

export class LocalFSBackend implements IStorageBackend {
    readonly name = 'localfs';
    readonly records: IRecordStore;

    private db: ISidecarDb | null = null;
    private fsOps!: IFsOps;
    private readonly rootDir: string;
    private readonly sidecarDir: string;
    private readonly internalDir: string;
    private readonly _createDb: (dbPath: string) => Promise<ISidecarDb>;
    private readonly _createFs: () => IFsOps | Promise<IFsOps>;

    constructor(options: LocalFSBackendOptions) {
        this.rootDir = options.rootDir;
        this.sidecarDir = options.sidecarDir;
        this.internalDir = joinPath(this.sidecarDir, 'vfs-internal');
        this._createDb = options.createDb ?? defaultCreateDb;
        this._createFs = options.createFs ?? defaultCreateFs;
        this.records = new SidecarRecordStore(() => this.requireDb());
    }

    get dbFilePath(): string { return joinPath(this.sidecarDir, 'index.db'); }

    // ══ Lifecycle ═════════════════════════════════════════════════

    async init(): Promise<void> {
        if (this.db) return;
        this.fsOps = await this._createFs();
        await ensureDir(this.fsOps, this.rootDir);
        await ensureDir(this.fsOps, this.sidecarDir);
        await ensureDir(this.fsOps, this.internalDir);

        const dbPath = joinPath(this.sidecarDir, 'index.db');
        try {
            this.db = await this._createDb(dbPath);
        } catch (err) {
            // Check if DB is corrupted and try to recover
            const dbExists = await this.fsOps.exists(dbPath);
            if (dbExists) {
                // Test integrity with a raw connection (no DDL, no foreign_keys)
                // to avoid creating orphaned WAL files that conflict on retry.
                let corrupted = true;
                try {
                    const { default: Database } = await import('better-sqlite3');
                    const probe = new Database(dbPath, { readonly: true });
                    try {
                        const row = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
                        corrupted = row?.integrity_check !== 'ok';
                    } finally {
                        probe.close();
                    }
                } catch {
                    corrupted = true;
                }
                if (corrupted) {
                    await this.fsOps.unlink(dbPath);
                    await ensureDir(this.fsOps, this.sidecarDir);
                    this.db = await this._createDb(dbPath);
                } else {
                    throw err; // DB is healthy but _createDb still failed — rethrow
                }
            } else {
                throw err; // DB doesn't exist and creation failed — rethrow
            }
        }
    }

    async close(): Promise<void> {
        if (!this.db) return;
        await this.db.close();
        this.db = null;
    }

    // ══ Structure ════════════════════════════════════════════════

    async stat(path: string): Promise<FSNode | null> {
        const realPath = this.resolve(path);
        const stat = await this.fsOps.stat(realPath);
        if (!stat) return null;
        const ext = this.db ? await this.db.getMetaExt(path) : null;
        return toFSNode(path, stat, ext);
    }

    async list(dirPath: string): Promise<FSNode[]> {
        const p = dirPath === '/' ? '' : dirPath;
        const realDir = p === '' ? this.rootDir : this.resolve(p);
        const entries = await this.fsOps.readDir(realDir);

        const results: FSNode[] = [];
        for (const entry of entries) {
            const childPath = p === '' ? `/${entry.name}` : `${p}/${entry.name}`;
            const realChild = joinPath(realDir, entry.name);
            const stat = await this.fsOps.stat(realChild);
            if (!stat) continue;
            const ext = this.db ? await this.db.getMetaExt(childPath) : null;
            results.push(toFSNode(childPath, stat, ext));
        }
        return results;
    }

    async mkdir(path: string): Promise<FSNode> {
        const realPath = this.resolve(path);
        await this.fsOps.mkdir(realPath);
        const stat = await this.fsOps.stat(realPath);
        if (!stat) throw new Error(`mkdir failed: ${path}`);
        const node = toFSNode(path, stat, null);
        return node;
    }

    async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
        const realPath = this.resolve(path);
        const stat = await this.fsOps.stat(realPath);
        if (!stat) return;

        if (stat.isDirectory && options?.recursive) {
            await this._deleteDirRecursive(realPath);
        } else if (stat.isDirectory) {
            await this.fsOps.rmdir(realPath);
        } else {
            await this.fsOps.unlink(realPath);
        }

        // Clean up sidecar metadata
        if (this.db) {
            await this.db.deleteMetaExt(path);
        }
    }

    private async _deleteDirRecursive(realPath: string): Promise<void> {
        const entries = await this.fsOps.readDir(realPath);
        for (const entry of entries) {
            const childPath = joinPath(realPath, entry.name);
            if (entry.isDirectory) {
                await this._deleteDirRecursive(childPath);
            } else {
                await this.fsOps.unlink(childPath);
            }
        }
        await this.fsOps.rmdir(realPath);
    }

    async rename(fromPath: string, toPath: string): Promise<void> {
        const oldPath = this.resolve(fromPath);
        const newPath = this.resolve(toPath);
        await this.fsOps.rename(oldPath, newPath);

        // Update sidecar metadata path
        if (this.db) {
            try {
                const ext = await this.db.getMetaExt(fromPath);
                if (ext) {
                    await this.db.deleteMetaExt(fromPath);
                    await this.db.upsertMetaExt({ ...ext, path: toPath });
                }
            } catch (e) {
                console.error(`[LocalFS] rename metadata update failed from=${fromPath} to=${toPath}`, e);
                throw e;
            }
        }
    }

    // ══ Content ══════════════════════════════════════════════════

    async read(path: string, options?: { offset?: number; length?: number }): Promise<Uint8Array> {
        const realPath = this.resolve(path);
        const data = await this.fsOps.readFile(realPath);
        if (!data) throw new Error(`ENOENT: ${path}`);
        const bytes = new Uint8Array(data);
        if (options?.offset !== undefined) {
            return bytes.slice(options.offset, options.length ? options.offset + options.length : undefined);
        }
        return bytes;
    }

    async write(path: string, content: Uint8Array): Promise<FSNode> {
        const realPath = this.resolve(path);

        // IFsOps.writeFile is contractually atomic (temp-rename on POSIX).
        // No staging/DB round-trip needed — the filesystem is the authority.
        await this.fsOps.writeFile(realPath, content.buffer as ArrayBuffer);

        const stat = await this.fsOps.stat(realPath);
        if (!stat) throw new Error(`write failed: ${path}`);
        const ext = this.db ? await this.db.getMetaExt(path) : null;
        return toFSNode(path, stat, ext);
    }

    // ══ Metadata ═════════════════════════════════════════════════

    async updateMetadata(path: string, metadata: Record<string, unknown>): Promise<void> {
        const realPath = this.resolve(path);
        if (!(await this.fsOps.exists(realPath))) return;
        const existing = this.db ? await this.db.getMetaExt(path) : null;
        const merged = existing?.metadata ? { ...JSON.parse(existing.metadata), ...metadata } : metadata;
        await this._upsertMeta(path, { metadata: JSON.stringify(merged) }, existing);
    }

    async setTags(path: string, tags: string[]): Promise<void> {
        try {
            await this._upsertMeta(path, { tags: JSON.stringify(tags) });
            if (this.db) await this.db.syncTags(path, tags);
        } catch (e) {
            console.error(`[LocalFS] setTags failed path=${path} tags=${JSON.stringify(tags)}`, e);
            throw e;
        }
    }

    async getAllTags(): Promise<string[]> {
        return this.db ? this.db.getAllDistinctTags() : [];
    }

    private async _upsertMeta(
        path: string,
        partial: Partial<MetaExtRow>,
        existing?: MetaExtRow | null,
    ): Promise<void> {
        if (!this.db) return;
        const prev = existing ?? await this.db.getMetaExt(path);
        const row: MetaExtRow = {
            path,
            icon: partial.icon !== undefined ? partial.icon : (prev?.icon ?? null),
            device_handler: partial.device_handler ?? prev?.device_handler ?? null,
            is_asset_dir: partial.is_asset_dir ?? prev?.is_asset_dir ?? 0,
            tags: partial.tags !== undefined ? partial.tags : (prev?.tags ?? null),
            metadata: partial.metadata !== undefined ? partial.metadata : (prev?.metadata ?? null),
            extra: partial.extra ?? prev?.extra ?? null,
        };
        await this.db.upsertMetaExt(row);
    }

    // ══ Transaction ══════════════════════════════════════════════

    async transaction<T>(fn: (tx: IStorageBackend) => Promise<T>): Promise<T> {
        // Filesystem ops are individually atomic (writeFile uses temp-rename).
        // For cross-operation ACID, a full transactional backend would be needed.
        return fn(this);
    }

    // ══ Health ═══════════════════════════════════════════════════

    async verify(): Promise<VerifyResult> {
        const result: VerifyResult = {
            healthy: true,
            dirsExist: true,
            dbHealthy: true,
            orphanMetaExt: [],
            orphanMetaTags: [],
            totalMetaExt: 0,
            totalMetaTags: 0,
        };

        // 1. Check directories exist
        if (!(await this.fsOps.exists(this.rootDir))
            || !(await this.fsOps.exists(this.sidecarDir))
            || !(await this.fsOps.exists(this.internalDir))) {
            result.dirsExist = false;
            result.healthy = false;
            return result;
        }

        // 2. Check DB health
        if (!this.db) {
            result.dbHealthy = false;
            result.healthy = false;
            return result;
        }
        const health = await this.db.healthCheck();
        result.dbHealthy = health.ok;
        if (!health.ok) result.healthy = false;

        // 3. Check meta_ext entries have corresponding files on disk
        // Use a raw read-only connection to avoid DDL/WAL side effects
        const dbPath = joinPath(this.sidecarDir, 'index.db');
        const { default: SqliteDb } = await import('better-sqlite3');
        const probeDb = new SqliteDb(dbPath, { readonly: true });
        try {
            const rows = probeDb.prepare('SELECT path FROM meta_ext').all() as Array<{ path: string }>;
            result.totalMetaExt = rows.length;

            for (const row of rows) {
                const realPath = this.resolve(row.path);
                if (!(await this.fsOps.exists(realPath))) {
                    result.orphanMetaExt.push(row.path);
                    result.healthy = false;
                }
            }

            // 4. Check meta_tags entries have corresponding meta_ext rows
            const tagRows = probeDb.prepare('SELECT path, tag FROM meta_tags').all() as Array<{ path: string; tag: string }>;
            result.totalMetaTags = tagRows.length;

            const metaPaths = new Set(rows.map(r => r.path));
            for (const tr of tagRows) {
                if (!metaPaths.has(tr.path)) {
                    result.orphanMetaTags.push(`${tr.path}#${tr.tag}`);
                    result.healthy = false;
                }
            }

        } finally {
            probeDb.close();
        }

        return result;
    }

    async repair(issues?: VerifyResult): Promise<{ fixedMetaExt: number; fixedMetaTags: number }> {
        const problems = issues ?? await this.verify();
        let fixedMetaExt = 0;
        let fixedMetaTags = 0;

        if (!this.db) return { fixedMetaExt, fixedMetaTags };

        // Fix orphan meta_ext entries
        if (problems.orphanMetaExt.length > 0) {
            for (const path of problems.orphanMetaExt) {
                await this.db.deleteMetaExt(path);
                fixedMetaExt++;
            }
        }

        // Fix orphan meta_tags entries
        if (problems.orphanMetaTags.length > 0) {
            const dbPath = joinPath(this.sidecarDir, 'index.db');
            const { default: SqliteDb } = await import('better-sqlite3');
            const probeDb = new SqliteDb(dbPath);
            try {
                probeDb.pragma('foreign_keys = OFF'); // allow deleting tags without parent
                for (const entry of problems.orphanMetaTags) {
                    const [path, tag] = entry.split('#');
                    probeDb.prepare('DELETE FROM meta_tags WHERE path = ? AND tag = ?').run(path, tag);
                    fixedMetaTags++;
                }
            } finally {
                probeDb.close();
            }
        }

        return { fixedMetaExt, fixedMetaTags };
    }

    // ══ Helpers ══════════════════════════════════════════════════

    /** Resolve a relative VFS path to an absolute filesystem path. */
    private resolve(rel: string): string {
        const p = rel.startsWith('/') ? rel.slice(1) : rel;
        if (!p) return this.rootDir;
        return hasInternalSegment(p)
            ? joinPath(this.internalDir, p)
            : joinPath(this.rootDir, p);
    }

    private requireDb(): ISidecarDb {
        if (!this.db) throw new Error('LocalFS sidecar database is not initialized');
        return this.db;
    }
}

class SidecarRecordStore implements IRecordStore {
    private tail: Promise<void> = Promise.resolve();

    constructor(private readonly db: () => ISidecarDb) {}

    getRecordField(path: string, field: string): Promise<RecordValue | undefined> {
        return this.db().getRecordField(path, field) as Promise<RecordValue | undefined>;
    }
    setRecordField(path: string, field: string, value: RecordValue): Promise<void> {
        return this.db().setRecordField(path, field, value);
    }
    deleteRecordField(path: string, field: string): Promise<void> {
        return this.db().deleteRecordField(path, field);
    }
    async setAllRecordFields(path: string, fields: Record<string, RecordValue>): Promise<void> {
        await this.transaction(async tx => {
            await this.db().clearRecordFields(path);
            for (const [field, value] of Object.entries(fields)) await tx.setRecordField(path, field, value);
        });
    }
    clearRecordFields(path: string): Promise<void> { return this.db().clearRecordFields(path); }
    async createRecordIndex(): Promise<void> {}
    async deleteRecordIndex(): Promise<void> {}
    async queryRecordFields(
        path: string,
        query: RecordQuery,
        options?: RecordQueryOptions,
    ): Promise<RecordQueryResult[]> {
        const rows = await this.db().listRecordFields(path, query.field);
        const matched = rows.filter(row => row.field === query.field && recordMatches(row.value as RecordValue, query));
        const offset = options?.offset ?? 0;
        return matched.slice(offset, offset + (options?.limit ?? matched.length)) as RecordQueryResult[];
    }
    async walkRecordFields(
        path: string,
        callback: (field: string, value: RecordValue) => boolean | Promise<boolean>,
        options?: RecordWalkOptions,
    ): Promise<{ total: number; processed: number }> {
        const rows = await this.db().listRecordFields(path, options?.prefix);
        let processed = 0;
        const limit = options?.limit ?? Number.POSITIVE_INFINITY;
        for (const row of rows.slice(options?.offset ?? 0)) {
            if (processed >= limit || !(await callback(row.field, row.value as RecordValue))) break;
            processed++;
        }
        return { total: rows.length, processed };
    }
    async walkRecordFieldNames(
        path: string,
        callback: (field: string) => boolean | Promise<boolean>,
        options?: { prefix?: string; limit?: number },
    ): Promise<number> {
        let processed = 0;
        await this.walkRecordFields(path, async field => {
            if (!(await callback(field))) return false;
            processed++;
            return true;
        }, options);
        return processed;
    }
    transaction<T>(operation: (tx: IRecordTransaction) => Promise<T>): Promise<T> {
        const run = async (): Promise<T> => {
            const db = this.db();
            await db.begin();
            try {
                const result = await operation(this);
                await db.commit();
                return result;
            } catch (error) {
                await db.rollback();
                throw error;
            }
        };
        const result = this.tail.then(run, run);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}

function recordMatches(value: RecordValue, query: RecordQuery): boolean {
    const expected = query.value;
    switch (query.operator) {
        case '=': return value === expected;
        case '!=': return value !== expected;
        case '<': return typeof value === 'number' && typeof expected === 'number' && value < expected;
        case '<=': return typeof value === 'number' && typeof expected === 'number' && value <= expected;
        case '>': return typeof value === 'number' && typeof expected === 'number' && value > expected;
        case '>=': return typeof value === 'number' && typeof expected === 'number' && value >= expected;
        case 'in': return Array.isArray(expected) && expected.includes(value);
        case 'contains': return typeof value === 'string' && typeof expected === 'string'
            ? value.includes(expected)
            : Array.isArray(value) && value.includes(expected);
    }
}

// ══ Factory ══════════════════════════════════════════════════════

export async function openLocalFSBackend(options: LocalFSBackendOptions): Promise<LocalFSBackend> {
    const backend = new LocalFSBackend(options);
    await backend.init();
    return backend;
}

async function defaultCreateDb(dbPath: string): Promise<ISidecarDb> {
    const { BetterSqliteSidecarDb } = await import('./db/sidecar');
    return new BetterSqliteSidecarDb(dbPath);
}

async function defaultCreateFs(): Promise<IFsOps> {
    const { NodeFsOps } = await import('./fs/node-fs-ops');
    return new NodeFsOps();
}

// ══ FSNode Factory ══════════════════════════════════════════════

function toFSNode(path: string, stat: StatResult, ext: MetaExtRow | null): FSNode {
    const name = path === '/' ? '' : path.split('/').pop()!;
    const parentPath = path === '/' ? null : path.substring(0, path.lastIndexOf('/')) || '/';
    const modifiedAt = stat.mtimeMs;
    const base = {
        parentPath,
        name,
        path,
        createdAt: stat.birthtimeMs,
        modifiedAt,
        version: Math.floor(modifiedAt),
        icon: ext?.icon ?? undefined,
        tags: ext?.tags ? (JSON.parse(ext.tags) as string[]) : [],
        metadata: ext?.metadata ? (JSON.parse(ext.metadata) as Record<string, unknown>) : {},
    };

    if (stat.isDirectory) {
        return { ...base, type: 'directory' } as FSDirectoryNode;
    }

    return {
        ...base,
        type: 'file',
        size: stat.size,
        contentHash: undefined,
        assetDirPath: undefined,
    } as FSFileNode;
}
