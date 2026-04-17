/**
 * @file vfsdriver-localfs/src/stores/localfs-inode-store.ts
 *
 * IInodeStore backed by real filesystem via IFsOps + ISidecarDb.
 *
 * ## Path classification
 *
 * Paths are split into three categories:
 *   - Regular paths ("note.md", "docs/")  → rootDir, full disk I/O
 *   - Asset dirs   ("_note.md/", ...)     → rootDir, real dirs on disk
 *   - Internal     ("__config/", ...)     → DB-only dir; content at internalContentDir
 *
 * The distinction is made by hasInternalSegment(): only `__` prefix segments
 * are "internal".  Single-`_` segments (asset dirs) are treated exactly like
 * regular paths — real directories created under rootDir.
 *
 * ## Concurrency
 *
 * lookup() only writes to the DB when a file exists on disk but has no DB
 * entry yet (registerPath is idempotent). This is safe because:
 * - LocalFSBackend.txQueue ensures no two operations run concurrently.
 * - registerPath uses INSERT OR IGNORE, so duplicate calls are harmless.
 */

import type { IInodeStore, InodeRecord, InodeWalkOptions } from '@itookit/common';
import type { ISidecarDb } from '../db/sidecar-interface';
import type { IFsOps } from '../fs/fs-ops';
import {
    joinPath, basenamePath, dirnamePath,
    hasInternalSegment, isInternalSeg,
} from '../utils/fs-utils';

export const ROOT_INO = 1;

export class LocalFSInodeStore implements IInodeStore {
    constructor(
        private readonly rootDir: string,
        /** sidecarDir/vfs-internal — where __ prefix content files live */
        private readonly internalContentDir: string,
        private readonly db: ISidecarDb,
        private readonly fsOps: IFsOps,
    ) { }

    // ── Allocation ─────────────────────────────────────────────────────────────

    async allocateIno(): Promise<number> {
        return this.db.allocateIno();
    }

    // ── Read ───────────────────────────────────────────────────────────────────

    async getInode(ino: number): Promise<InodeRecord | null> {
        if (ino < 0) return null; // virtual ino — not yet registered

        const entry = await this.db.getEntry(ino);
        if (!entry) return null;

        // Internal paths (__config/, ...) exist only in the sidecar DB.
        // Asset dirs (_note.md/) and regular paths exist on disk — stat them.
        if (!hasInternalSegment(entry.rel)) {
            const stat = await this.fsOps.stat(this.toRealPath(entry.rel));
            if (!stat) {
                // File disappeared from disk outside VFS — lazily clean up orphan.
                await this.db.deletePath(ino);
                return null;
            }
        }
        return this.buildRecord(ino, entry.rel, entry.type as 'file' | 'directory');
    }

    // ── Patcher helper ──────────────────────────────────────────────────────────

    private async ensureParentIno(parentRel: string): Promise<number> {
        const existing = await this.db.getInoForRel(parentRel);
        if (existing !== null) return existing;
        const stat = await this.fsOps.stat(this.toRealPath(parentRel));
        const createdAt = stat?.birthtimeMs ?? Date.now();
        return this.db.registerPath(parentRel, 'directory', createdAt);
    }

    async lookup(parentIno: number, name: string): Promise<InodeRecord | null> {
        const parentRel = await this.db.getRelPath(parentIno);
        if (parentRel === null) return null;

        const childRel = parentRel === '' ? name : `${parentRel}/${name}`;

        // If the child path contains a __ segment (e.g. parent is __config/ or
        // child name itself is __config), resolve from DB only — no disk I/O.
        if (hasInternalSegment(childRel)) {
            const ino = await this.db.getInoForRel(childRel);
            if (ino === null) return null;
            const dbEntry = await this.db.getEntry(ino);
            if (!dbEntry) return null;
            return {
                ino, parentIno, name,
                type: dbEntry.type as 'file' | 'directory',
                createdAt: 0, nlink: 1,
            };
        }

        // Regular paths and asset dirs (_name/) → check the real filesystem.
        const stat = await this.fsOps.stat(this.toRealPath(childRel));
        if (!stat) return null;

        const type: 'file' | 'directory' = stat.isDirectory ? 'directory' : 'file';

        const existingIno = await this.db.getInoForRel(childRel);
        if (existingIno !== null) {
            return { ino: existingIno, parentIno, name, type, createdAt: stat.birthtimeMs || Date.now(), nlink: 1 };
        }

        const ino = await this.db.registerPath(childRel, type, stat.birthtimeMs || Date.now());
        return { ino, parentIno, name, type, createdAt: stat.birthtimeMs || Date.now(), nlink: 1 };
    }

    private async _listChildrenInternal(parentIno: number): Promise<InodeRecord[]> {
        const parentRel = await this.db.getRelPath(parentIno);
        if (parentRel === null) return [];

        // Internal parent (e.g. __config/): no disk directory — list from DB only.
        if (hasInternalSegment(parentRel)) {
            const dbChildren = await this.db.listDirectChildren(parentRel);
            return dbChildren.map(child => ({
                ino: child.ino, parentIno, name: child.name,
                type: child.type as 'file' | 'directory',
                createdAt: child.createdAt, nlink: 1,
            }));
        }

        // Regular / asset-dir parent: read from disk.
        const realDir = this.toRealPath(parentRel);
        const entries = await this.fsOps.readDir(realDir);

        const realNames = new Set<string>();
        const results: InodeRecord[] = [];

        for (const entry of entries) {
            realNames.add(entry.name);
            const childRel = parentRel === '' ? entry.name : `${parentRel}/${entry.name}`;
            const type: 'file' | 'directory' = entry.isDirectory ? 'directory' : 'file';

            const stat = await this.fsOps.stat(joinPath(realDir, entry.name));
            if (!stat) continue;

            let ino = await this.db.getInoForRel(childRel);
            if (ino === null) {
                ino = await this.db.registerPath(childRel, type, stat.birthtimeMs || Date.now());
            }
            results.push({ ino, parentIno, name: entry.name, type, createdAt: stat.birthtimeMs || Date.now(), nlink: 1 });
        }

        // Merge DB-only children: only __ prefix dirs (internal config).
        // Single _ prefix (asset dirs) now live on disk and appear via readDir above.
        const dbChildren = await this.db.listDirectChildren(parentRel);
        for (const child of dbChildren) {
            if (!realNames.has(child.name) && isInternalSeg(child.name)) {
                results.push({
                    ino: child.ino, parentIno, name: child.name,
                    type: child.type as 'file' | 'directory',
                    createdAt: child.createdAt, nlink: 1,
                });
            }
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
        if (existingRel !== null) return; // already tracked

        const parentRel = (await this.db.getRelPath(inode.parentIno)) ?? '';
        const rel = parentRel === '' ? inode.name : `${parentRel}/${inode.name}`;
        const sidecarType: 'file' | 'directory' = inode.type === 'directory' ? 'directory' : 'file';
        const isInternal = hasInternalSegment(rel);

        if (inode.type === 'directory') {
            if (!isInternal) {
                // Regular dirs + asset dirs (_name/) → create real directory on disk.
                await this.fsOps.mkdir(this.toRealPath(rel));
            }
            // __ prefix dirs: DB-only, no disk creation needed.
        } else {
            if (!isInternal) {
                // Regular files + files inside asset dirs → real files under rootDir.
                const realPath = this.toRealPath(rel);
                const stagePath = await this.db.getStagePath(String(inode.ino));
                await this.fsOps.mkdir(dirnamePath(realPath));
                if (stagePath) {
                    await this.fsOps.rename(stagePath, realPath);
                    await this.db.clearStage(String(inode.ino));
                } else {
                    const already = await this.fsOps.exists(realPath);
                    if (!already) await this.fsOps.writeFile(realPath, new ArrayBuffer(0));
                }
            } else {
                // Internal files (e.g. __config/history.yaml) → content goes to
                // internalContentDir; move staging there if present.
                const targetPath = joinPath(this.internalContentDir, rel);
                const stagePath = await this.db.getStagePath(String(inode.ino));
                await this.fsOps.mkdir(dirnamePath(targetPath));
                if (stagePath) {
                    await this.fsOps.rename(stagePath, targetPath);
                    await this.db.clearStage(String(inode.ino));
                } else {
                    const already = await this.fsOps.exists(targetPath);
                    if (!already) await this.fsOps.writeFile(targetPath, new ArrayBuffer(0));
                }
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
            newName = updates.name;
        } else if (updates.parentIno !== undefined) {
            newParentRel = (await this.db.getRelPath(updates.parentIno)) ?? '';
            newName = basenamePath(oldRel);
        } else {
            newParentRel = dirnamePath(oldRel) === '/' ? '' : dirnamePath(oldRel);
            newName = updates.name!;
        }

        const newRel = newParentRel === '' ? newName : `${newParentRel}/${newName}`;
        if (newRel === oldRel) return;

        const isInternal = hasInternalSegment(oldRel);
        const oldPath = isInternal ? joinPath(this.internalContentDir, oldRel) : this.toRealPath(oldRel);
        const newPath = isInternal ? joinPath(this.internalContentDir, newRel) : this.toRealPath(newRel);

        await this.fsOps.mkdir(dirnamePath(newPath));
        await this.fsOps.rename(oldPath, newPath);
        await this.db.updateRel(ino, newRel);
    }

    async deleteInode(ino: number): Promise<void> {
        const entry = await this.db.getEntry(ino);
        if (!entry) return;

        const isInternal = hasInternalSegment(entry.rel);
        const path = isInternal
            ? joinPath(this.internalContentDir, entry.rel)
            : this.toRealPath(entry.rel);

        if (entry.type === 'directory') {
            await this.fsOps.rmdir(path);
        } else {
            await this.fsOps.unlink(path);
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
                if (result !== 'skip' && child.type === 'directory' && (maxDepth < 0 || nextDepth < maxDepth)) {
                    queue.push({ ino: child.ino, depth: nextDepth });
                }
            }
        }
    }

    async hasChildren(parentIno: number): Promise<boolean> {
        const parentRel = await this.db.getRelPath(parentIno);
        if (parentRel === null) return false;

        if (hasInternalSegment(parentRel)) {
            // Internal dir: no disk presence — check DB only.
            const dbChildren = await this.db.listDirectChildren(parentRel);
            return dbChildren.length > 0;
        }

        const entries = await this.fsOps.readDir(this.toRealPath(parentRel));
        if (entries.length > 0) return true;

        // Also check for __ prefix DB-only children (e.g. __config/ with no
        // disk-visible siblings yet).
        const dbChildren = await this.db.listDirectChildren(parentRel);
        return dbChildren.some(c => isInternalSeg(c.name));
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    toRealPath(rel: string): string {
        return rel === '' ? this.rootDir : joinPath(this.rootDir, rel);
    }

    private async buildRecord(ino: number, rel: string, type: 'file' | 'directory'): Promise<InodeRecord> {
        const name = rel === '' ? '' : basenamePath(rel);
        const slashIdx = rel.lastIndexOf('/');
        let parentIno = ROOT_INO;
        if (slashIdx > 0) {
            const parentRel = rel.slice(0, slashIdx);
            parentIno = await this.ensureParentIno(parentRel);
        }
        return { ino, parentIno, name, type, createdAt: 0, nlink: 1 };
    }
}
