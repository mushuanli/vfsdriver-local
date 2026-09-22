/**
 * @file vfsdriver-localfs/src/localfs-backend.ts
 * v4.1: Path-based IStorageBackend. No ino allocation, no path_ino table.
 *
 * Stores files directly in rootDir. Non-derivable metadata in sidecar SQLite.
 * File paths map literally beneath rootDir; metadata stays in the sidecar database.
 */

import type {
    IStorageBackend,
    FSNode,
    FSFileNode,
    FSDirectoryNode,
    DirEntry,
    IRecordStore,
    IRecordTransaction,
    RecordValue,
    RecordQuery,
    RecordQueryOptions,
    RecordQueryResult,
    RecordWalkOptions,
} from '@itookit/vfs-core';
import { FSError } from '@itookit/vfs-core';
import type { ISidecarDb, MetaExtRow } from './db/sidecar-interface';
import { SIDECAR_OPERATIONS, countSidecarOperations, type SidecarOperation } from './db/sidecar-stats';
import type { IFsOps, StatResult } from './fs/fs-ops';
import { ensureDir, joinPath } from './utils/fs-utils';

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
    private readonly _createDb: (dbPath: string) => Promise<ISidecarDb>;
    private readonly _createFs: () => IFsOps | Promise<IFsOps>;
    private readonly sidecarCounts = new Map<string, number>();
    /** Pending type-only stats for one event-loop tick; flushed as a single `statMany`. */
    private statTypeBatch?: {
        paths: string[];
        resolve: Array<(value: { type: 'file' | 'directory' } | null) => void>;
        reject: Array<(error: unknown) => void>;
        pending: Map<string, Promise<{ type: 'file' | 'directory' } | null>>;
    };

    constructor(options: LocalFSBackendOptions) {
        this.rootDir = options.rootDir;
        this.sidecarDir = options.sidecarDir;
        this._createDb = options.createDb ?? defaultCreateDb;
        this._createFs = options.createFs ?? defaultCreateFs;
        this.records = new SidecarRecordStore(() => this.requireDb(), db => this.recoverRename(db), false);
    }

    get dbFilePath(): string { return joinPath(this.sidecarDir, 'index.db'); }

    /** Per-operation sidecar call counts, cumulative since open or the last reset. */
    get sidecarStats(): Readonly<Record<SidecarOperation, number>> {
        return Object.freeze(Object.fromEntries(
            SIDECAR_OPERATIONS.map(operation => [operation, this.sidecarCounts.get(operation) ?? 0]),
        )) as Readonly<Record<SidecarOperation, number>>;
    }

    /** Clear the sidecar call counters (hosts use deltas, not absolutes). */
    resetSidecarStats(): void { this.sidecarCounts.clear(); }

    private bumpSidecar(operation: string): void {
        this.sidecarCounts.set(operation, (this.sidecarCounts.get(operation) ?? 0) + 1);
    }

    private async openSidecar(dbPath: string): Promise<ISidecarDb> {
        const db = await this._createDb(dbPath);
        return countSidecarOperations(db, operation => this.bumpSidecar(operation));
    }

    // ══ Lifecycle ═════════════════════════════════════════════════

    async init(): Promise<void> {
        if (this.db) return;
        this.fsOps = await this._createFs();
        await ensureDir(this.fsOps, this.rootDir);
        await ensureDir(this.fsOps, this.sidecarDir);

        const dbPath = joinPath(this.sidecarDir, 'index.db');
        try {
            this.db = await this.openSidecar(dbPath);
        } catch (error) {
            if (!await this.fsOps.exists(dbPath) || !await confirmedCorruption(dbPath)) throw error;
            await this.fsOps.unlink(dbPath);
            await ensureDir(this.fsOps, this.sidecarDir);
            this.db = await this.openSidecar(dbPath);
        }
        try {
            await this.withDb(async () => undefined);
        } catch (error) {
            try { await this.close(); } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], 'Filesystem initialization and cleanup failed', { cause: error });
            }
            throw error;
        }
    }

    private withDb<T>(operation: (db: ISidecarDb) => Promise<T>): Promise<T> {
        return (this.records as SidecarRecordStore).withDb(operation);
    }

    /** Reads retain the same transactional recovery boundary as writes. */
    private withDbRead<T>(operation: (db: ISidecarDb) => Promise<T>): Promise<T> {
        return (this.records as SidecarRecordStore).withDbRead(operation);
    }

    async close(): Promise<void> {
        if (!this.db) return;
        await this.db.close();
        this.db = null;
    }



    // ══ Structure ════════════════════════════════════════════════

    async stat(path: string): Promise<FSNode | null> {
        return this.withDbRead(async db => {
            const stat = await this.fsOps.stat(this.resolve(path));
            if (!stat) return null;
            return toFSNode(path, stat, await db.getMetaExt(path));
        });
    }

    /**
     * Type-only stat for capability checks (`FileSystemView.noLinks`): same type source as `stat`,
     * but skips the sidecar `getMetaExt` round trip. Prefix walks issue their segment checks
     * concurrently, so they are coalesced here into one host round trip (`fsOps.statMany`).
     */
    async statType(path: string): Promise<{ type: 'file' | 'directory' } | null> {
        const direct = async () => {
            const stat = await this.fsOps.stat(this.resolve(path));
            return checkedNodeType(stat);
        };
        if (!this.fsOps.statMany) return direct();
        const batch: NonNullable<typeof this.statTypeBatch> = (this.statTypeBatch ??= { paths: [], resolve: [], reject: [], pending: new Map() });
        const pending = batch.pending.get(path);
        if (pending) return pending;
        const work = new Promise<{ type: 'file' | 'directory' } | null>((resolve, reject) => {
            batch.paths.push(path); batch.resolve.push(resolve); batch.reject.push(reject);
            if (batch.paths.length === 1) queueMicrotask(() => { void this.flushStatTypes(); });
        });
        batch.pending.set(path, work);
        return work;
    }

    /** Flush the coalesced type-only stats in one `fsOps.statMany` call. */
    private async flushStatTypes(): Promise<void> {
        const batch = this.statTypeBatch;
        this.statTypeBatch = undefined;
        if (!batch || !this.fsOps.statMany) return;
        try {
            const stats = await this.fsOps.statMany(batch.paths.map(path => this.resolve(path)));
            if (stats.length !== batch.paths.length) throw new Error('Invalid batched stat response length');
            stats.forEach((stat, index) => {
                try { batch.resolve[index](checkedNodeType(stat)); } catch (error) { batch.reject[index](error); }
            });
        } catch (error) {
            for (const reject of batch.reject) reject(error);
        }
    }

    async list(dirPath: string): Promise<FSNode[]> {
        return this.listNodes(dirPath, async (path, stat) => toFSNode(path, stat, this.db ? await this.db.getMetaExt(path) : null));
    }

    async listEntries(dirPath: string): Promise<DirEntry[]> {
        return this.listNodes(dirPath, async (path, stat) => ({ path, name: path.slice(path.lastIndexOf('/') + 1),
            type: stat.isDirectory ? 'directory' : 'file', modifiedAt: stat.mtimeMs,
            ...(stat.isDirectory ? {} : { size: stat.size }) }));
    }

    private async listNodes<T>(dirPath: string, project: (path: string, stat: StatResult) => Promise<T>): Promise<T[]> {
        const p = dirPath === '/' ? '' : dirPath;
        const realDir = p === '' ? this.rootDir : this.resolve(p);
        const entries = await this.fsOps.readDir(realDir);
        const results: T[] = [];
        for (let start = 0; start < entries.length; start += 64) {
            const batch = entries.slice(start, start + 64);
            const paths = batch.map(entry => joinPath(realDir, entry.name));
            const stats = this.fsOps.statMany ? await this.fsOps.statMany(paths)
                : await Promise.all(paths.map(path => this.fsOps.stat(path)));
            if (stats.length !== batch.length) throw new Error('Invalid batch stat response');
            const nodes = await Promise.all(batch.map(async (entry, index) => {
                const stat = stats[index];
                // Listing safe siblings must not follow links or expose device nodes.
                if (!stat || stat.isSymbolicLink || (!stat.isDirectory && stat.isFile === false)) return null;
                const childPath = `${p}/${entry.name}`;
                return project(childPath, stat);
            }));
            for (const node of nodes) if (node) results.push(node);
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
        if (!stat) { await this.withDb(db => db.deleteMetaExt(path)); return; }

        if (stat.isDirectory && options?.recursive) {
            await this._deleteDirRecursive(realPath);
        } else if (stat.isDirectory) {
            await this.fsOps.rmdir(realPath);
        } else {
            await this.fsOps.unlink(realPath);
        }

        // Clean up sidecar metadata
        await this.withDb(db => db.deleteMetaExt(path));
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
        if (fromPath === toPath) return;
        for (const path of [fromPath, toPath]) {
            if (!path.startsWith('/') || path === '/' || path.split('/').slice(1).some(part => !part || part === '.' || part === '..')) throw new Error('Rename requires canonical non-root paths');
        }
        if (toPath.startsWith(`${fromPath}/`) || fromPath.startsWith(`${toPath}/`)) throw new Error('Cannot rename overlapping subtrees');
        // The committed intent survives a crash between filesystem rename and SQL commit.
        const operationId = await this.withDb(async db => {
            if (!db.movePathData || !db.assertPathDataVacant) throw new Error('Sidecar lacks recoverable rename support');
            if (!(await this.fsOps.exists(this.resolve(fromPath)))) throw new Error(`Rename source missing: ${fromPath}`);
            if (await this.fsOps.exists(this.resolve(toPath))) throw new Error(`Rename destination exists: ${toPath}`);
            await db.assertPathDataVacant(toPath);
            const id = Number(await db.getRecordField(RENAME_JOURNAL, 'next-rename') ?? 0) + 1;
            if (!Number.isSafeInteger(id)) throw new Error('Rename sequence exhausted');
            await db.setRecordField(RENAME_JOURNAL, 'next-rename', id);
            await db.setRecordField(RENAME_JOURNAL, 'intent', { id, fromPath, toPath });
            return id;
        });
        // Another process can help either rename; each caller observes its own receipt.
        const result = await this.withDb(async db => {
            const key = `rename-result/${operationId}`;
            const receipt = await db.getRecordField(RENAME_JOURNAL, key) as { error?: string } | undefined;
            if (!receipt) throw new Error('Rename receipt missing');
            await db.deleteRecordField(RENAME_JOURNAL, key);
            return receipt;
        });
        if (result.error) throw new Error(result.error);
    }

    private async recoverRename(db: ISidecarDb): Promise<void> {
        // Another process may commit a rename intent after this connection opens.
        // Probe under the same transaction as the operation; local clean state is insufficient.
        const intent = await db.getRecordField(RENAME_JOURNAL, 'intent') as { id: number; fromPath: string; toPath: string } | undefined;
        if (!intent) return;
        if (!db.movePathData) throw new Error('Sidecar lacks recoverable rename support');
        const from = this.resolve(intent.fromPath), to = this.resolve(intent.toPath);
        const sourceExists = await this.fsOps.exists(from), targetExists = await this.fsOps.exists(to);
        if (sourceExists && !targetExists) {
            try { await this.fsOps.rename(from, to); }
            catch (error) {
                if (await this.fsOps.exists(from) && !(await this.fsOps.exists(to))) {
                    // No filesystem change: durably abandon the intent before reporting failure.
                    await db.setRecordField(RENAME_JOURNAL, `rename-result/${intent.id}`, { error: error instanceof Error ? error.message : String(error) });
                    await db.deleteRecordField(RENAME_JOURNAL, 'intent');
                    return;
                }
                throw error;
            }
        } else if (sourceExists || !targetExists) throw new Error('Rename recovery conflict: filesystem was modified outside VFS');
        await db.movePathData(intent.fromPath, intent.toPath);
        await db.setRecordField(RENAME_JOURNAL, `rename-result/${intent.id}`, { completed: true });
        await db.deleteRecordField(RENAME_JOURNAL, 'intent');
    }

    // ══ Content ══════════════════════════════════════════════════

    async read(path: string, options?: { offset?: number; length?: number }): Promise<Uint8Array> {
        const realPath = this.resolve(path);
        if (options?.length !== undefined && this.fsOps.readFileRange) {
            const data = await this.fsOps.readFileRange(realPath, options.offset ?? 0, options.length);
            if (!data) throw new Error(`ENOENT: ${path}`);
            return new Uint8Array(data);
        }
        const data = await this.fsOps.readFile(realPath);
        if (!data) throw new Error(`ENOENT: ${path}`);
        const bytes = new Uint8Array(data);
        if (options?.offset !== undefined || options?.length !== undefined) {
            const offset = options.offset ?? 0;
            return bytes.slice(offset, options.length !== undefined ? offset + options.length : undefined);
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
        await this.withDb(async db => {
            if (!(await this.fsOps.exists(this.resolve(path)))) return;
            const existing = await db.getMetaExt(path);
            const merged = existing?.metadata ? { ...JSON.parse(existing.metadata), ...metadata } : metadata;
            await this._upsertMeta(db, path, { metadata: JSON.stringify(merged) }, existing);
        });
    }

    async setTags(path: string, tags: string[]): Promise<void> {
        try {
            await this.withDb(async db => {
                await this._upsertMeta(db, path, { tags: JSON.stringify([...new Set(tags)]) });
                await db.syncTags(path, [...new Set(tags)]);
            });
        } catch (e) {
            console.error(`[LocalFS] setTags failed path=${path} tags=${JSON.stringify(tags)}`, e);
            throw e;
        }
    }

    async listTagEntries(): Promise<Array<{ path: string; tag: string }>> {
        return this.withDbRead(async db => {
            if (!db.listTagEntries) throw new Error('Sidecar does not support indexed tag queries');
            return db.listTagEntries();
        });
    }

    async getAllTags(): Promise<string[]> {
        return this.withDbRead(db => db.getAllDistinctTags());
    }

    private async _upsertMeta(
        db: ISidecarDb,
        path: string,
        partial: Partial<MetaExtRow>,
        existing?: MetaExtRow | null,
    ): Promise<void> {
        const prev = existing ?? await db.getMetaExt(path);
        const row: MetaExtRow = {
            path,
            icon: partial.icon !== undefined ? partial.icon : (prev?.icon ?? null),
            device_handler: partial.device_handler ?? prev?.device_handler ?? null,
            is_asset_dir: partial.is_asset_dir ?? prev?.is_asset_dir ?? 0,
            tags: partial.tags !== undefined ? partial.tags : (prev?.tags ?? null),
            metadata: partial.metadata !== undefined ? partial.metadata : (prev?.metadata ?? null),
            extra: partial.extra ?? prev?.extra ?? null,
        };
        await db.upsertMetaExt(row);
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
            || !(await this.fsOps.exists(this.sidecarDir))) {
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
        if (/[\\\0]/.test(p) || p.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid backend path');
        return joinPath(this.rootDir, p);
    }

    private requireDb(): ISidecarDb {
        if (!this.db) throw new Error('LocalFS sidecar database is not initialized');
        return this.db;
    }
}

const RENAME_JOURNAL = '/__vfs_namespace_journal__';

class SidecarRecordStore implements IRecordStore {
    private tail: Promise<void> = Promise.resolve();

    constructor(private readonly db: () => ISidecarDb,
        private readonly beforeTransaction?: (db: ISidecarDb) => Promise<void>,
        private readonly scoped = false) {}

    getRecordField(path: string, field: string): Promise<RecordValue | undefined> {
        if (!this.scoped) return this.withDbRead(db => db.getRecordField(path, field)) as Promise<RecordValue | undefined>;
        return this.db().getRecordField(path, field) as Promise<RecordValue | undefined>;
    }
    setRecordField(path: string, field: string, value: RecordValue): Promise<void> {
        if (!this.scoped) return this.withDb(db => db.setRecordField(path, field, value));
        return this.db().setRecordField(path, field, value);
    }
    deleteRecordField(path: string, field: string): Promise<void> {
        if (!this.scoped) return this.withDb(db => db.deleteRecordField(path, field));
        return this.db().deleteRecordField(path, field);
    }
    async setAllRecordFields(path: string, fields: Record<string, RecordValue>): Promise<void> {
        await this.runTransaction(async tx => {
            await tx.clearRecordFields(path);
            for (const [field, value] of Object.entries(fields)) await tx.setRecordField(path, field, value);
        });
    }
    clearRecordFields(path: string): Promise<void> {
        return this.scoped ? this.db().clearRecordFields(path) : this.withDb(db => db.clearRecordFields(path));
    }
    private rows(path: string, prefix?: string) {
        return this.scoped ? this.db().listRecordFields(path, prefix) : this.withDbRead(db => db.listRecordFields(path, prefix));
    }
    async createRecordIndex(): Promise<void> {}
    async deleteRecordIndex(): Promise<void> {}
    async queryRecordFields(
        path: string,
        query: RecordQuery,
        options?: RecordQueryOptions,
    ): Promise<RecordQueryResult[]> {
        const rows = await this.rows(path, query.field);
        const matched = rows.filter(row => row.field === query.field && recordMatches(row.value as RecordValue, query));
        const offset = options?.offset ?? 0;
        return matched.slice(offset, offset + (options?.limit ?? matched.length)) as RecordQueryResult[];
    }
    async walkRecordFields(
        path: string,
        callback: (field: string, value: RecordValue) => boolean | Promise<boolean>,
        options?: RecordWalkOptions,
    ): Promise<{ total: number; processed: number }> {
        const rows = await this.rows(path, options?.prefix);
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
        return this.runTransaction(operation);
    }
    private runTransaction<T>(operation: (tx: SidecarRecordStore) => Promise<T>): Promise<T> {
        if (this.scoped) return operation(this);
        return this.withDb(db => operation(new SidecarRecordStore(() => db, undefined, true)));
    }
    withDb<T>(operation: (db: ISidecarDb) => Promise<T>): Promise<T> {
        return this.serialize(db => this.runInTransaction(db, operation));
    }
    /**
     * Reads share the transaction/recovery boundary with writes: another process may
     * have moved files without migrating the durable records yet.
     */
    withDbRead<T>(operation: (db: ISidecarDb) => Promise<T>): Promise<T> {
        if (this.scoped) return operation(this.db());
        return this.withDb(operation);
    }
    /** Every operation on this store is serialized through one tail so reads and writes stay ordered. */
    private serialize<T>(operation: (db: ISidecarDb) => Promise<T>): Promise<T> {
        const run = async (): Promise<T> => operation(this.db());
        const result = this.tail.then(run, run);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
    private async runInTransaction<T>(db: ISidecarDb, operation: (db: ISidecarDb) => Promise<T>): Promise<T> {
        const execute = async (scopedDb: ISidecarDb): Promise<T> => {
            await this.beforeTransaction?.(scopedDb);
            return operation(scopedDb);
        };
        if (db.transaction) return db.transaction(execute);
        await db.begin();
        try {
            const result = await execute(db);
            await db.commit();
            return result;
        } catch (error) {
            try { await db.rollback(); } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], 'Sidecar transaction failed and rollback failed', { cause: error });
            }
            throw error;
        }
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

/** Unavailable probes and unknown results never authorize deleting durable data. */
async function confirmedCorruption(path: string): Promise<boolean> {
    try {
        const { default: Database } = await import('better-sqlite3');
        const probe = new Database(path, { readonly: true });
        try {
            const row = probe.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
            return typeof row?.integrity_check === 'string' && row.integrity_check.trim().length > 0 && row.integrity_check !== 'ok';
        } finally { probe.close(); }
    } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB';
    }
}

async function defaultCreateFs(): Promise<IFsOps> {
    const { NodeFsOps } = await import('./fs/node-fs-ops');
    return new NodeFsOps();
}

// ══ FSNode Factory ══════════════════════════════════════════════

function checkedNodeType(stat: StatResult | null): { type: 'file' | 'directory' } | null {
    if (!stat) return null;
    if (stat.isSymbolicLink || (!stat.isDirectory && stat.isFile === false)) {
        throw new FSError('EACCES', 'Links and device nodes require a separate capability');
    }
    return { type: stat.isDirectory ? 'directory' : 'file' };
}

function toFSNode(path: string, stat: StatResult, ext: MetaExtRow | null): FSNode {
    checkedNodeType(stat);
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
