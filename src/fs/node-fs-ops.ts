/**
 * @file vfsdriver-localfs/src/fs/node-fs-ops.ts
 * IFsOps implementation backed by node:fs (Node.js / Electron).
 */

import { promises as fs } from 'node:fs';
import nodePath from 'node:path';
import type { IFsOps, StatResult, DirEntry } from './fs-ops';

export class NodeFsOps implements IFsOps {
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
        // Atomic: write to temp file, then rename (POSIX rename is atomic)
        const tmp = `${p}.${process.pid}.tmp`;
        try {
            await fs.writeFile(tmp, Buffer.from(data));
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
        const s = await fs.stat(p).catch(() => null);
        if (!s) return null;
        return {
            size:        s.size,
            mtimeMs:     s.mtimeMs,
            birthtimeMs: s.birthtimeMs || 0,
            isDirectory: s.isDirectory(),
        };
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
