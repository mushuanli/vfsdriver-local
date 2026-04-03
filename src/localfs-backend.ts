/**
 * @file vfsdriver-localfs/src/localfs-backend.ts
 *
 * LocalFSBackend — IStorageBackend that makes a local directory transparent to VFS.
 *
 * ## Transaction architecture
 *
 * Two injection points for environment-specific implementations:
 *   createDb? — defaults to BetterSqliteSidecarDb (node:better-sqlite3)
 *               override with TauriSqlSidecarDb for Tauri WebView
 *   createFs? — defaults to NodeFsOps (node:fs)
 *               override with TauriFsOps for Tauri WebView
 *
 * ## SQLITE_BUSY prevention
 *
 * The root cause of SQLITE_BUSY in the Tauri path was holding BEGIN IMMEDIATE
 * across async boundaries while using a sqlx connection pool:
 *
 *   1. _execTx calls await db.begin() → connection A issues BEGIN IMMEDIATE
 *   2. _execTx awaits fn(scope) — yields the event loop
 *   3. Inside fn, stores call await this.db.xxx() → pool checks out connection B
 *   4. Connection B has no busy_timeout and cannot write while A holds the lock
 *   5. SQLITE_BUSY
 *
 * Fix: _execTx holds NO explicit transaction. txQueue provides operation-level
 * serialization (one fn at a time). Multi-statement atomicity is handled inside
 * each DB method that needs it (see BetterSqliteSidecarDb.syncTags,
 * registerPath — db.transaction() wrappers; TauriSqlSidecarDb.syncTags —
 * BEGIN/COMMIT scoped within the method, never spanning async FS I/O).
 */

import type {
    IStorageBackend,
    ITransactionScope,
    IInodeStore,
    IMetaStore,
    IContentStore,
} from '@itookit/common';
import type { ISidecarDb } from './db/sidecar-interface';
import type { IFsOps } from './fs/fs-ops';
import { LocalFSInodeStore } from './stores/localfs-inode-store';
import { LocalFSMetaStore }  from './stores/localfs-meta-store';
import { LocalFSContentStore } from './stores/localfs-content-store';
import { ensureDir, cleanOrphanedStaging, joinPath } from './utils/fs-utils';

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalFSBackendOptions {
    /**
     * The real local directory to expose through VFS.
     * Reads and writes go directly to files inside this directory.
     */
    rootDir: string;

    /**
     * Private directory for sidecar SQLite + staging files.
     * Must be OUTSIDE rootDir to avoid polluting the user's directory.
     */
    sidecarDir: string;

    /**
     * Factory for the sidecar DB.
     * Default: BetterSqliteSidecarDb (requires Node.js / Electron).
     * Override: TauriSqlSidecarDb (Tauri WebView, no native addon).
     */
    createDb?: (dbPath: string) => Promise<ISidecarDb>;

    /**
     * Factory for filesystem operations.
     * Default: NodeFsOps (requires node:fs — Node.js / Electron only).
     * Override: TauriFsOps (@tauri-apps/plugin-fs, runs in Tauri WebView).
     */
    createFs?: () => IFsOps | Promise<IFsOps>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend
// ─────────────────────────────────────────────────────────────────────────────

export class LocalFSBackend implements IStorageBackend {
    readonly name = 'localfs';

    inodes!:  IInodeStore;
    meta!:    IMetaStore;
    content!: IContentStore;

    private sidecarDb: ISidecarDb | null = null;

    /**
     * Serialization queue: ensures at most one runInTransaction callback runs
     * at a time. This is the SOLE concurrency guard — no explicit SQLite
     * transaction is held across the async fn boundary.
     */
    private txQueue: Promise<unknown> = Promise.resolve();

    private readonly rootDir:    string;
    private readonly sidecarDir: string;
    private readonly stagingDir: string;
    private readonly createDb:   (dbPath: string) => Promise<ISidecarDb>;
    private readonly createFs:   () => IFsOps | Promise<IFsOps>;

    constructor(options: LocalFSBackendOptions) {
        this.rootDir    = options.rootDir;
        this.sidecarDir = options.sidecarDir;
        this.stagingDir = joinPath(this.sidecarDir, 'staging');
        this.createDb   = options.createDb ?? defaultCreateDb;
        this.createFs   = options.createFs ?? defaultCreateFs;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    async init(): Promise<void> {
        if (this.sidecarDb) return;

        const fsOps = await this.createFs();
        await ensureDir(fsOps, this.rootDir);
        await ensureDir(fsOps, this.sidecarDir);
        await ensureDir(fsOps, this.stagingDir);

        const dbPath = joinPath(this.sidecarDir, 'index.db');
        this.sidecarDb = await this.createDb(dbPath);

        await cleanOrphanedStaging(fsOps, this.stagingDir);

        for (const entry of await this.sidecarDb.allStaged()) {
            const exists = await fsOps.exists(entry.path);
            if (!exists) await this.sidecarDb.clearStage(entry.ref);
        }

        this.inodes  = new LocalFSInodeStore(this.rootDir, this.sidecarDb, fsOps);
        this.meta    = new LocalFSMetaStore(this.rootDir, this.sidecarDb, fsOps);
        this.content = new LocalFSContentStore(this.rootDir, this.stagingDir, this.sidecarDb, fsOps);
    }

    async close(): Promise<void> {
        if (!this.sidecarDb) return;
        await this.sidecarDb.close();
        this.sidecarDb = null;
    }

    // ── Transactions ───────────────────────────────────────────────────────────

    async runInTransaction<T>(
        _mode: 'readonly' | 'readwrite',
        fn: (scope: ITransactionScope) => Promise<T>,
    ): Promise<T> {
        const result = this.txQueue.then(() => this._execTx(fn));
        // Swallow rejections on the queue tail so a failed tx doesn't poison
        // subsequent ones.
        this.txQueue = result.catch(() => undefined);
        return result;
    }

    get dbFilePath(): string { return joinPath(this.sidecarDir, 'index.db'); }

    // ── Private ────────────────────────────────────────────────────────────────

    private async _execTx<T>(fn: (scope: ITransactionScope) => Promise<T>): Promise<T> {
        // txQueue guarantees only one _execTx runs at a time.
        // No explicit BEGIN/COMMIT is held here — doing so across async
        // boundaries causes SQLITE_BUSY on connection-pooled backends (Tauri).
        // Each DB method that needs multi-statement atomicity wraps itself
        // internally (BetterSqliteSidecarDb: db.transaction(); Tauri: per-method
        // BEGIN/COMMIT scoped within the method, not spanning FS I/O).
        return fn({ inodes: this.inodes, meta: this.meta, content: this.content });
    }


}

// Default factories — dynamic imports keep node:fs / better-sqlite3 out of
// the static bundle. These are only ever loaded in Node.js / Electron contexts.
async function defaultCreateDb(dbPath: string): Promise<ISidecarDb> {
    const { BetterSqliteSidecarDb } = await import('./db/sidecar');
    return new BetterSqliteSidecarDb(dbPath);
}
async function defaultCreateFs(): Promise<IFsOps> {
    const { NodeFsOps } = await import('./fs/node-fs-ops');
    return new NodeFsOps();
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory shorthand
// ─────────────────────────────────────────────────────────────────────────────

export async function openLocalFSBackend(options: LocalFSBackendOptions): Promise<LocalFSBackend> {
    const backend = new LocalFSBackend(options);
    await backend.init();
    return backend;
}
