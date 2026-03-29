/**
 * @file vfsdriver-localfs/src/localfs-backend.ts
 *
 * LocalFSBackend — IStorageBackend that makes a local directory transparent to VFS.
 *
 * Storage layout:
 *   rootDir/         ← real files, readable by any external tool
 *   sidecarDir/
 *   ├── index.db     ← ISidecarDb (ino↔path mapping, meta_ext, staging)
 *   └── staging/     ← temp content written before putInode (see putData docs)
 *
 * Two injection points for environment-specific implementations:
 *   createDb? — defaults to BetterSqliteSidecarDb (node:better-sqlite3)
 *               override with TauriSqlSidecarDb for Tauri WebView
 *   createFs? — defaults to NodeFsOps (node:fs)
 *               override with TauriFsOps for Tauri WebView
 *
 * With both injected, the package has zero node:fs / node:better-sqlite3
 * runtime dependency in the Tauri WebView bundle.
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
// BetterSqliteSidecarDb and NodeFsOps are loaded via dynamic import in the
// default factories below, so they are NEVER statically bundled into the
// Tauri WebView. The Tauri app always supplies createDb / createFs, so
// the dynamic chunks are never fetched.
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
    private txQueue:   Promise<unknown>  = Promise.resolve();

    private readonly rootDir:    string;
    private readonly sidecarDir: string;
    private readonly stagingDir: string;
    private readonly createDb:   (dbPath: string) => Promise<ISidecarDb>;
    private readonly createFs:   () => IFsOps | Promise<IFsOps>;

    constructor(options: LocalFSBackendOptions) {
        // Callers must pass absolute paths. Tauri provides them from invoke(),
        // Node.js callers should use path.resolve() before passing in.
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
        const result = this.txQueue.then(() => this.execTx(fn));
        this.txQueue = result.catch(() => undefined);
        return result;
    }

    get dbFilePath(): string { return joinPath(this.sidecarDir, 'index.db'); }

    // ── Private ────────────────────────────────────────────────────────────────

    private async execTx<T>(fn: (scope: ITransactionScope) => Promise<T>): Promise<T> {
        const db = this.assertOpen();
        await db.begin();
        try {
            const result = await fn({ inodes: this.inodes, meta: this.meta, content: this.content });
            await db.commit();
            return result;
        } catch (e) {
            try { await db.rollback(); } catch { /* ignore */ }
            throw e;
        }
    }

    private assertOpen(): ISidecarDb {
        if (!this.sidecarDb) throw new Error('LocalFSBackend is not open — call init() first');
        return this.sidecarDb;
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
