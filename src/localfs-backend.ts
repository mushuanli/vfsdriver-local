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
    FSErrorCode,
} from '@itookit/common';
import type { ISidecarDb, MetaExtRow } from './db/sidecar-interface';
import type { IFsOps, StatResult } from './fs/fs-ops';
import { ensureDir, cleanOrphanedStaging, joinPath, hasInternalSegment } from './utils/fs-utils';

export interface LocalFSBackendOptions {
    rootDir: string;
    sidecarDir: string;
    createDb?: (dbPath: string) => Promise<ISidecarDb>;
    createFs?: () => IFsOps | Promise<IFsOps>;
}

export class LocalFSBackend implements IStorageBackend {
    readonly name = 'localfs';

    private db: ISidecarDb | null = null;
    private fsOps!: IFsOps;
    private readonly rootDir: string;
    private readonly sidecarDir: string;
    private readonly stagingDir: string;
    private readonly internalDir: string;
    private readonly _createDb: (dbPath: string) => Promise<ISidecarDb>;
    private readonly _createFs: () => IFsOps | Promise<IFsOps>;
    private txQueue: Promise<unknown> = Promise.resolve();

    constructor(options: LocalFSBackendOptions) {
        this.rootDir = options.rootDir;
        this.sidecarDir = options.sidecarDir;
        this.stagingDir = joinPath(this.sidecarDir, 'staging');
        this.internalDir = joinPath(this.sidecarDir, 'vfs-internal');
        this._createDb = options.createDb ?? defaultCreateDb;
        this._createFs = options.createFs ?? defaultCreateFs;
    }

    get dbFilePath(): string { return joinPath(this.sidecarDir, 'index.db'); }

    // ══ Lifecycle ═════════════════════════════════════════════════

    async init(): Promise<void> {
        if (this.db) return;
        this.fsOps = await this._createFs();
        await ensureDir(this.fsOps, this.rootDir);
        await ensureDir(this.fsOps, this.sidecarDir);
        await ensureDir(this.fsOps, this.stagingDir);
        await ensureDir(this.fsOps, this.internalDir);
        await cleanOrphanedStaging(this.fsOps, this.stagingDir);

        const dbPath = joinPath(this.sidecarDir, 'index.db');
        this.db = await this._createDb(dbPath);

        // Clean up orphaned staged files from crashes
        for (const entry of await this.db.allStaged()) {
            if (!(await this.fsOps.exists(entry.path))) {
                await this.db.clearStage(entry.ref);
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
            const ext = await this.db.getMetaExt(fromPath);
            if (ext) {
                await this.db.deleteMetaExt(fromPath);
                await this.db.upsertMetaExt({ ...ext, path: toPath });
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
        const isInternal = hasInternalSegment(path);

        // For new files without a real path yet, stage first
        if (!isInternal && !(await this.fsOps.exists(realPath))) {
            await this.fsOps.mkdir(this.stagingDir);
            const stagePath = joinPath(this.stagingDir, Array.from(new TextEncoder().encode(path), b => b.toString(16).padStart(2, '0')).join(''));
            await this.fsOps.writeFile(stagePath, content.buffer as ArrayBuffer);
            if (this.db) await this.db.setStage(path, stagePath);
            await this.fsOps.mkdir(joinPath(realPath, '..'));
            await this.fsOps.rename(stagePath, realPath);
            if (this.db) await this.db.clearStage(path);
        } else if (isInternal) {
            await this.fsOps.mkdir(joinPath(realPath, '..'));
            await this.fsOps.writeFile(realPath, content.buffer as ArrayBuffer);
        } else {
            await this.fsOps.writeFile(realPath, content.buffer as ArrayBuffer);
        }

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
        await this._upsertMeta(path, { tags: JSON.stringify(tags) });
        if (this.db) await this.db.syncTags(path, tags);
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

    // ══ Helpers ══════════════════════════════════════════════════

    /** Resolve a relative VFS path to an absolute filesystem path. */
    private resolve(rel: string): string {
        const p = rel.startsWith('/') ? rel.slice(1) : rel;
        if (!p) return this.rootDir;
        return hasInternalSegment(p)
            ? joinPath(this.internalDir, p)
            : joinPath(this.rootDir, p);
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
        id: path,
        parentId: parentPath,
        name,
        path,
        createdAt: stat.birthtimeMs,
        modifiedAt,
        version: Math.floor(modifiedAt),
        nlink: 1,
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
        assetDirId: undefined,
    } as FSFileNode;
}
