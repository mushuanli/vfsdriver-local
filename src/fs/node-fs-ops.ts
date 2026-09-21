/**
 * @file vfsdriver-localfs/src/fs/node-fs-ops.ts
 * IFsOps implementation backed by node:fs (Node.js / Electron).
 */

import { promises as fs } from 'node:fs';
import nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IFsOps, StatResult, DirEntry } from './fs-ops';

export class NodeFsOps implements IFsOps {
    async readFileRange(path: string, offset: number, length: number): Promise<ArrayBuffer | null> {
        const file = await fs.open(path, 'r').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (!file) return null;
        try {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await file.read(buffer, 0, length, offset);
            return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) as ArrayBuffer;
        } finally { await file.close(); }
    }

    async readFile(p: string): Promise<ArrayBuffer | null> {
        try {
            const buf = await fs.readFile(p);
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw e;
        }
    }

    async writeFile(p: string, data: ArrayBuffer): Promise<void> {
        await fs.mkdir(nodePath.dirname(p), { recursive: true });
        const tmp = `${p}.${randomUUID()}.tmp`;
        // Exclusive creation prevents overwriting a stale or pre-existing temporary path.
        const file = await fs.open(tmp, 'wx');
        try {
            try { await file.writeFile(Buffer.from(data)); } finally { await file.close(); }
            await fs.rename(tmp, p);
        } catch (err) {
            await fs.unlink(tmp).catch(() => {});
            throw err;
        }
    }

    async appendFile(p: string, data: ArrayBuffer): Promise<void> {
        await fs.appendFile(p, Buffer.from(data));
    }

    async stat(p: string): Promise<StatResult | null> {
        const s = await fs.lstat(p).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
            throw error;
        });
        if (!s) return null;
        return {
            size:        s.size,
            mtimeMs:     s.mtimeMs,
            birthtimeMs: s.birthtimeMs || 0,
            isDirectory: s.isDirectory(),
            isSymbolicLink: s.isSymbolicLink(),
            isFile: s.isFile(),
        };
    }

    /** Local stats are one syscall each; the batch form only saves per-call overhead. */
    async statMany(paths: string[]): Promise<Array<StatResult | null>> {
        return Promise.all(paths.map(path => this.stat(path)));
    }

    async readDir(p: string): Promise<DirEntry[]> {
        let entries: { name: string; isDirectory(): boolean }[];
        try {
            entries = (await fs.readdir(p, { withFileTypes: true, encoding: 'utf8' })) as unknown as { name: string; isDirectory(): boolean }[];
        } catch {
            return [];
        }
        return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
    }

    async mkdir(p: string): Promise<void> {
        await fs.mkdir(p, { recursive: true });
    }

    async rename(from: string, to: string): Promise<void> {
        await fs.rename(from, to);
    }

    async unlink(p: string): Promise<void> {
        await fs.unlink(p).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'ENOENT') throw e;
        });
    }

    async rmdir(p: string): Promise<void> {
        await fs.rmdir(p).catch(() => {});
    }

    async exists(p: string): Promise<boolean> {
        return fs.access(p).then(() => true).catch(() => false);
    }
}
