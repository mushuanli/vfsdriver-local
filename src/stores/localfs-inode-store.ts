/**
 * @file vfsdriver-localfs/src/stores/localfs-inode-store.ts
 * IInodeStore backed by real filesystem via IFsOps + ISidecarDb.
 * No direct node:fs import — all FS operations go through IFsOps.
 */

import type { IInodeStore, InodeRecord, InodeWalkOptions } from '@itookit/common';
import type { ISidecarDb } from '../db/sidecar-interface';
import type { IFsOps } from '../fs/fs-ops';
import { joinPath, basenamePath, dirnamePath } from '../utils/fs-utils';

export const ROOT_INO = 1;

export class LocalFSInodeStore implements IInodeStore {
    constructor(
        private readonly rootDir: string,
        private readonly db: ISidecarDb,
        private readonly fsOps: IFsOps,
    ) {}

    // ── Allocation ─────────────────────────────────────────────────────────────

    async allocateIno(): Promise<number> {
        return this.db.allocateIno();
    }

    // ── Read ───────────────────────────────────────────────────────────────────

    async getInode(ino: number): Promise<InodeRecord | null> {
        const entry = await this.db.getEntry(ino);
        if (!entry) return null;
        // VFS-internal paths (asset dirs: _name, internal dirs: __name) are stored
        // only in the sidecar DB — they have no physical counterpart on disk.
        // Skip the filesystem stat for these; trust the DB record.
        const isVfsInternal = entry.rel.split('/').some(seg => seg.startsWith('_'));
        if (!isVfsInternal) {
            const stat = await this.fsOps.stat(this.toRealPath(entry.rel));
            if (!stat) return null;
        }
        return this.buildRecord(ino, entry.rel, entry.type as 'file' | 'directory');
    }

    // ── Patcher helper ──────────────────────────────────────────────────────────

    /**
     * Ensures the inode record for a directory at `rel` has a proper entry in
     * the sidecar DB so that `getInoForRel(rel)` returns a non-null value.
     * Called by buildRecord when a parent directory is not yet registered.
     */
    private async ensureParentIno(parentRel: string): Promise<number> {
        const existing = await this.db.getInoForRel(parentRel);
        if (existing !== null) return existing;
        // Parent directory exists on disk but was never explicitly registered.
        // Register it now so subsequent buildRecord calls resolve correctly.
        const stat = await this.fsOps.stat(this.toRealPath(parentRel));
        const createdAt = stat?.birthtimeMs ?? Date.now();
        return this.db.registerPath(parentRel, 'directory', createdAt);
    }

    async lookup(parentIno: number, name: string): Promise<InodeRecord | null> {
        const parentRel = await this.db.getRelPath(parentIno);
        if (parentRel === null) return null;

        const childRel = parentRel === '' ? name : `${parentRel}/${name}`;

        // VFS-internal names (_name, __name) live only in the sidecar DB.
        // Check the DB directly instead of stat-ing the filesystem.
        if (name.startsWith('_')) {
            const ino = await this.db.getInoForRel(childRel);
            if (ino === null) return null;
            const dbEntry = await this.db.getEntry(ino);
            if (!dbEntry) return null;
            return { ino, parentIno, name, type: dbEntry.type as 'file' | 'directory', createdAt: 0, nlink: 1 };
        }

        const stat = await this.fsOps.stat(this.toRealPath(childRel));
        if (!stat) return null;

        const type: 'file' | 'directory' = stat.isDirectory ? 'directory' : 'file';
        const ino = await this.db.registerPath(childRel, type, stat.birthtimeMs || Date.now());

        return { ino, parentIno, name, type, createdAt: stat.birthtimeMs || Date.now(), nlink: 1 };
    }

    private async _listChildrenInternal(parentIno: number): Promise<InodeRecord[]> {
        const parentRel = await this.db.getRelPath(parentIno);
        if (parentRel === null) return [];

        const realDir = this.toRealPath(parentRel);
        const entries = await this.fsOps.readDir(realDir);

        const results: InodeRecord[] = [];
        for (const entry of entries) {
            const childRel = parentRel === '' ? entry.name : `${parentRel}/${entry.name}`;
            const type: 'file' | 'directory' = entry.isDirectory ? 'directory' : 'file';

            const stat = await this.fsOps.stat(joinPath(realDir, entry.name));
            if (!stat) continue;

            const ino = await this.db.registerPath(childRel, type, stat.birthtimeMs || Date.now());
            results.push({ ino, parentIno, name: entry.name, type, createdAt: stat.birthtimeMs || Date.now(), nlink: 1 });
        }
        return results;
    }

    async forEachInode(
        inos: number[],
        callback: (inode: InodeRecord, index: number) => boolean | Promise<boolean>,
    ): Promise<void> {
        for (let i = 0; i < inos.length; i++) {
            const rec = await this.getInode(inos[i]);
            if (rec) {
                if (!(await callback(rec, i))) break;
            }
        }
    }

    // ── Write ──────────────────────────────────────────────────────────────────

    async putInode(inode: InodeRecord): Promise<void> {
        if (inode.ino === ROOT_INO) {
            await this.db.insertPath(ROOT_INO, '', 'directory', inode.createdAt);
            return;
        }

        const existingRel = await this.db.getRelPath(inode.ino);
        if (existingRel !== null) return; // already tracked (re-mount or upsert)

        const parentRel = (await this.db.getRelPath(inode.parentIno)) ?? '';
        const rel       = parentRel === '' ? inode.name : `${parentRel}/${inode.name}`;
        const realPath  = this.toRealPath(rel);
        const sidecarType: 'file' | 'directory' = inode.type === 'directory' ? 'directory' : 'file';

        if (inode.type === 'directory') {
            // Asset dirs (_filename/) and internal dirs (__config/) are VFS-internal
            // metadata. For LocalFS the rootDir is the user's real filesystem, so we
            // must NOT create these on disk — register only in the sidecar DB.
            const isVfsInternal = inode.name.startsWith('_');
            if (!isVfsInternal) {
                await this.fsOps.mkdir(realPath);
            }
        } else {
            const stagePath = await this.db.getStagePath(String(inode.ino));
            await this.fsOps.mkdir(dirnamePath(realPath));
            if (stagePath) {
                await this.fsOps.rename(stagePath, realPath);
                await this.db.clearStage(String(inode.ino));
            } else {
                const already = await this.fsOps.exists(realPath);
                if (!already) await this.fsOps.writeFile(realPath, new ArrayBuffer(0));
            }
        }

        await this.db.insertPath(inode.ino, rel, sidecarType, inode.createdAt);
    }

    async updateInode(
        ino: number,
        updates: Partial<Pick<InodeRecord, 'parentIno' | 'name' | 'nlink'>>,
    ): Promise<void> {
        if (updates.name === undefined && updates.parentIno === undefined) return;

        const currentEntry = await this.db.getEntry(ino);
        if (!currentEntry) return;
        const oldRel = currentEntry.rel;

        let newParentRel: string;
        let newName: string;

        if (updates.parentIno !== undefined && updates.name !== undefined) {
            newParentRel = (await this.db.getRelPath(updates.parentIno)) ?? '';
            newName      = updates.name;
        } else if (updates.parentIno !== undefined) {
            newParentRel = (await this.db.getRelPath(updates.parentIno)) ?? '';
            newName      = basenamePath(oldRel);
        } else {
            newParentRel = dirnamePath(oldRel) === '/' ? '' : dirnamePath(oldRel);
            newName      = updates.name!;
        }

        const newRel = newParentRel === '' ? newName : `${newParentRel}/${newName}`;
        if (newRel === oldRel) return;

        await this.fsOps.mkdir(dirnamePath(this.toRealPath(newRel)));
        await this.fsOps.rename(this.toRealPath(oldRel), this.toRealPath(newRel));
        await this.db.updateRel(ino, newRel);
    }

    async deleteInode(ino: number): Promise<void> {
        const entry = await this.db.getEntry(ino);
        if (!entry) return;
        const realPath = this.toRealPath(entry.rel);
        if (entry.type === 'directory') {
            await this.fsOps.rmdir(realPath);
        } else {
            await this.fsOps.unlink(realPath);
        }
        await this.db.deletePath(ino);
    }

    async walkTree(
        parentIno: number,
        callback: (inode: InodeRecord, depth: number) => boolean | 'skip' | Promise<boolean | 'skip'>,
        options?: InodeWalkOptions,
    ): Promise<void> {
        if (options?.order === 'breadth-first') {
            await this._walkBFS(parentIno, callback, options?.maxDepth ?? -1);
        } else {
            await this._walkDFS(parentIno, callback, 0, options?.maxDepth ?? -1);
        }
    }

    private async _walkDFS(
        parentIno: number,
        callback: (inode: InodeRecord, depth: number) => boolean | 'skip' | Promise<boolean | 'skip'>,
        depth: number,
        maxDepth: number,
    ): Promise<boolean> {
        const children = await this._listChildrenInternal(parentIno);
        for (const child of children) {
            const result = await callback(child, depth);
            if (result === false) return false;
            if (result !== 'skip' && child.type === 'directory' && (maxDepth < 0 || depth < maxDepth)) {
                if (!(await this._walkDFS(child.ino, callback, depth + 1, maxDepth))) return false;
            }
        }
        return true;
    }

    private async _walkBFS(
        parentIno: number,
        callback: (inode: InodeRecord, depth: number) => boolean | 'skip' | Promise<boolean | 'skip'>,
        maxDepth: number,
    ): Promise<void> {
        const queue: Array<{ ino: number; depth: number }> = [{ ino: parentIno, depth: -1 }];
        while (queue.length > 0) {
            const { ino, depth } = queue.shift()!;
            const nextDepth = depth + 1;
            if (maxDepth >= 0 && nextDepth > maxDepth) continue;
            const children = await this._listChildrenInternal(ino);
            for (const child of children) {
                const result = await callback(child, nextDepth);
                if (result === false) return;
                if (result !== 'skip' && child.type === 'directory') {
                    queue.push({ ino: child.ino, depth: nextDepth });
                }
            }
        }
    }

    async hasChildren(parentIno: number): Promise<boolean> {
        const parentRel = await this.db.getRelPath(parentIno);
        if (parentRel === null) return false;
        const entries = await this.fsOps.readDir(this.toRealPath(parentRel));
        return entries.length > 0;
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    toRealPath(rel: string): string {
        return rel === '' ? this.rootDir : joinPath(this.rootDir, rel);
    }

    private async buildRecord(ino: number, rel: string, type: 'file' | 'directory'): Promise<InodeRecord> {
        const name = rel === '' ? '' : basenamePath(rel);
        // Compute the true parentIno from the rel path instead of hardcoding ROOT_INO.
        // Without this, _buildAbsPath in ModuleFS walks up only one level (the file
        // itself) and produces wrong paths like '/guide.md' instead of '/docs/guide.md'.
        const slashIdx = rel.lastIndexOf('/');
        let parentIno = ROOT_INO;
        if (slashIdx > 0) {
            const parentRel = rel.slice(0, slashIdx);
            parentIno = await this.ensureParentIno(parentRel);
        }
        return { ino, parentIno, name, type, createdAt: 0, nlink: 1 };
    }
}
