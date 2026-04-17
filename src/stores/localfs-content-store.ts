/**
 * @file vfsdriver-localfs/src/stores/localfs-content-store.ts
 * IContentStore backed by real filesystem via IFsOps. No direct node:fs import.
 *
 * Content routing:
 *   - Regular files + files inside asset dirs (_name/) → rootDir/rel
 *   - Files inside internal dirs (__config/, ...)      → internalContentDir/rel
 */

import type { IContentStore } from '@itookit/common';
import type { ISidecarDb } from '../db/sidecar-interface';
import type { IFsOps } from '../fs/fs-ops';
import { joinPath, hasInternalSegment } from '../utils/fs-utils';

export class LocalFSContentStore implements IContentStore {
    constructor(
        private readonly rootDir: string,
        /** sidecarDir/vfs-internal — stores content for __ prefix paths */
        private readonly internalContentDir: string,
        private readonly stagingDir: string,
        private readonly db: ISidecarDb,
        private readonly fsOps: IFsOps,
    ) {}

    // ── Write ──────────────────────────────────────────────────────────────────

    async putData(ref: string, data: ArrayBuffer): Promise<void> {
        const realPath = await this.resolveRef(ref);
        if (realPath !== null) {
            await this.fsOps.writeFile(realPath, data);
        } else {
            // New file: stage until putInode is called (VFSEngine creates content before inode)
            await this.fsOps.mkdir(this.stagingDir);
            const stagePath = joinPath(this.stagingDir, ref);
            await this.fsOps.writeFile(stagePath, data);
            await this.db.setStage(ref, stagePath);
        }
    }

    async appendData(ref: string, data: ArrayBuffer): Promise<void> {
        const realPath = await this.resolveRef(ref);
        if (!realPath) throw new Error(`LocalFSContentStore: cannot append — ino ${ref} not yet tracked`);
        await this.fsOps.appendFile(realPath, data);
    }

    async deleteData(ref: string): Promise<void> {
        const realPath = await this.resolveRef(ref);
        if (realPath) await this.fsOps.unlink(realPath);

        const stagePath = await this.db.getStagePath(ref);
        if (stagePath) {
            await this.fsOps.unlink(stagePath);
            await this.db.clearStage(ref);
        }
    }

    // ── Read ───────────────────────────────────────────────────────────────────

    async getData(ref: string): Promise<ArrayBuffer | null> {
        const realPath = await this.resolveRef(ref);
        if (!realPath) return null;
        return this.fsOps.readFile(realPath);
    }

    async existsData(ref: string): Promise<boolean> {
        const realPath = await this.resolveRef(ref);
        if (!realPath) return false;
        return this.fsOps.exists(realPath);
    }

    async sizeData(ref: string): Promise<number> {
        const realPath = await this.resolveRef(ref);
        if (!realPath) return 0;
        const stat = await this.fsOps.stat(realPath);
        return stat?.size ?? 0;
    }

    async readRange(ref: string, offset: number, length: number): Promise<ArrayBuffer | null> {
        const data = await this.getData(ref);
        if (!data) return null;
        return data.slice(offset, offset + length);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private async resolveRef(ref: string): Promise<string | null> {
        const ino = parseInt(ref, 10);
        if (isNaN(ino)) return null;
        const rel = await this.db.getRelPath(ino);
        if (rel === null) return null;
        if (rel === '') return this.rootDir;
        // Internal paths (__config/, ...) are stored under internalContentDir.
        if (hasInternalSegment(rel)) return joinPath(this.internalContentDir, rel);
        return joinPath(this.rootDir, rel);
    }
}
