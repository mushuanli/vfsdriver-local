/** Read optimizations must preserve cross-process rename recovery and capability checks. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFSBackend } from '../src/localfs-backend';
import type { ISidecarDb, MetaExtRow } from '../src/db/sidecar-interface';

const JOURNAL = '/__vfs_namespace_journal__';

class RecordingSidecar implements ISidecarDb {
    journalProbes = 0;
    transactions = 0;
    metaExtCalls = 0;
    private records = new Map<string, unknown>();
    async getMetaExt(): Promise<MetaExtRow | null> { this.metaExtCalls += 1; return null; }
    async upsertMetaExt(): Promise<void> {}
    async deleteMetaExt(): Promise<void> {}
    async syncTags(): Promise<void> {}
    async getAllDistinctTags(): Promise<string[]> { return []; }
    async queryByTag(): Promise<string[]> { return []; }
    async healthCheck(): Promise<{ ok: boolean }> { return { ok: true }; }
    async close(): Promise<void> {}
    async getRecordField(path: string, field: string): Promise<unknown | undefined> {
        if (path === JOURNAL && field === 'intent') this.journalProbes += 1;
        return this.records.get(`${path}\0${field}`);
    }
    async setRecordField(path: string, field: string, value: unknown): Promise<void> { this.records.set(`${path}\0${field}`, value); }
    async deleteRecordField(path: string, field: string): Promise<void> { this.records.delete(`${path}\0${field}`); }
    async listRecordFields(path: string, prefix = ''): Promise<Array<{ field: string; value: unknown }>> {
        const start = `${path}\0`;
        return [...this.records].filter(([key]) => key.startsWith(start) && key.slice(start.length).startsWith(prefix))
            .map(([key, value]) => ({ field: key.slice(start.length), value }));
    }
    async clearRecordFields(path: string): Promise<void> {
        for (const key of this.records.keys()) if (key.startsWith(`${path}\0`)) this.records.delete(key);
    }
    async movePathData(from: string, to: string): Promise<void> {
        for (const [key, value] of [...this.records]) {
            const path = key.split('\0')[0];
            if (path !== from && !path.startsWith(`${from}/`)) continue;
            this.records.set(`${to}${path.slice(from.length)}\0${key.split('\0')[1]}`, value);
            this.records.delete(key);
        }
    }
    async assertPathDataVacant(path: string): Promise<void> {
        if ([...this.records.keys()].some(key => key.split('\0')[0].startsWith(path))) throw new Error('Destination path data exists');
    }
    async begin(): Promise<void> {}
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
    async transaction<T>(operation: (db: ISidecarDb) => Promise<T>): Promise<T> { this.transactions += 1; return operation(this); }
}

describe('rename journal probing', () => {
    let root: string, backend: LocalFSBackend, sidecar: RecordingSidecar;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'itookit-journal-'));
        sidecar = new RecordingSidecar();
        backend = new LocalFSBackend({ rootDir: join(root, 'files'), sidecarDir: join(root, 'db'),
            createDb: async () => sidecar });
        await backend.init();
    });
    afterEach(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });

    it('checks the journal once per outer transaction, including reads', async () => {
        expect(sidecar.journalProbes).toBe(1);
        for (let index = 0; index < 5; index += 1) await backend.records.setRecordField(`/f${index}`, 'state', index);
        for (let index = 0; index < 5; index += 1) await backend.records.getRecordField(`/f${index}`, 'state');
        expect(sidecar.journalProbes).toBe(11);
    });

    it('re-reads the journal after writing an intent and still migrates records on rename', async () => {
        await backend.write('/old/data.bin', new Uint8Array());
        await backend.records.setRecordField('/old/data.bin', 'state', 'durable');
        await backend.rename('/old', '/new');
        // One probe for the intent, then one clean probe from the receipt transaction.
        expect(sidecar.journalProbes).toBeGreaterThan(1);
        expect(await backend.records.getRecordField('/new/data.bin', 'state')).toBe('durable');
        expect(await backend.records.getRecordField('/old/data.bin', 'state')).toBeUndefined();
        const settled = sidecar.journalProbes;
        await backend.records.getRecordField('/new/data.bin', 'state');
        expect(sidecar.journalProbes).toBe(settled + 1);
    });

    it('keeps read recovery and the read in one transaction', async () => {
        const afterInit = sidecar.transactions;
        await backend.stat('/missing');
        await backend.stat('/another');
        await backend.records.getRecordField('/x', 'state');
        await backend.records.walkRecordFields('/x', () => true);
        await backend.getAllTags();
        expect(sidecar.transactions).toBe(afterInit + 5);
        await backend.records.setRecordField('/x', 'state', 1);
        expect(sidecar.transactions).toBe(afterInit + 6);
    });

    it('checks path prefixes without fetching sidecar metadata', async () => {
        for (const dir of ['/deep', '/deep/a', '/deep/b']) await backend.mkdir(dir);
        await backend.write('/deep/a/b/file.md', new Uint8Array());
        const { createVFS, MemoryBackend } = await import('@itookit/vfs-core');
        const { manager } = await createVFS({ rootBackend: new MemoryBackend(),
            additionalMounts: [{ path: '/ws', backend }] });
        try {
            const fs = await manager.openFileSystem('/ws');
            sidecar.metaExtCalls = 0;
            await fs.driver.readContent('/deep/a/b/file.md', { encoding: 'utf-8' });
            // Four prefix segments are capability-checked via statType; only the target needs meta.
            expect(sidecar.metaExtCalls).toBeLessThanOrEqual(2);
        } finally { await manager.dispose(); }
    });

    it('keeps a nested view prefix walk metadata-free', async () => {
        for (const dir of ['/nv', '/nv/a', '/nv/b']) await backend.mkdir(dir);
        await backend.write('/nv/a/b/file.md', new Uint8Array());
        const { createVFS, createFileSystemView, MemoryBackend } = await import('@itookit/vfs-core');
        const { manager } = await createVFS({ rootBackend: new MemoryBackend(),
            additionalMounts: [{ path: '/ws', backend }] });
        try {
            const inner = await manager.openFileSystem('/ws');
            const outer = createFileSystemView({ viewId: 'nested',
                mounts: [{ mountId: 'inner', at: '/', fs: inner, access: 'ro' }] });
            sidecar.metaExtCalls = 0;
            await outer.driver.readContent('/nv/a/b/file.md', { encoding: 'utf-8' });
            // A view driver exposes getNodeType, so the outer prefix walk stays metadata-free too.
            expect(sidecar.metaExtCalls).toBeLessThanOrEqual(2);
            await outer.dispose();
        } finally { await manager.dispose(); }
    });

    it('coalesces a path-prefix walk into one batched stat call', async () => {
        for (const dir of ['/cb', '/cb/a', '/cb/b']) await backend.mkdir(dir);
        await backend.write('/cb/a/b/file.md', new Uint8Array());
        const fsOps = (backend as unknown as { fsOps: { statMany: (paths: string[]) => Promise<unknown> } }).fsOps;
        const batched: string[][] = [];
        const original = fsOps.statMany.bind(fsOps);
        fsOps.statMany = async paths => { batched.push(paths); return original(paths); };
        const { createVFS, MemoryBackend } = await import('@itookit/vfs-core');
        const { manager } = await createVFS({ rootBackend: new MemoryBackend(),
            additionalMounts: [{ path: '/ws', backend }] });
        try {
            const fs = await manager.openFileSystem('/ws');
            batched.length = 0;
            await fs.driver.readContent('/cb/a/b/file.md', { encoding: 'utf-8' });
            // Concurrent prefix checks arrive as one batched host call (>=2 paths), not one each.
            expect(Math.max(0, ...batched.map(list => list.length))).toBeGreaterThanOrEqual(2);
        } finally { await manager.dispose(); }
    });

    it('rejects reading outside a mounted root through a filesystem symlink', async () => {
        const outside = join(root, 'outside');
        await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'must-not-read');
        await symlink(outside, join(root, 'files', 'escape'), 'dir');
        const { createVFS, createFileSystemView, MemoryBackend } = await import('@itookit/vfs-core');
        const { manager } = await createVFS({ rootBackend: new MemoryBackend(), additionalMounts: [{ path: '/ws', backend }] });
        try {
            const inner = await manager.openFileSystem('/ws');
            const view = createFileSystemView({ viewId: 'link-test', mounts: [{ mountId: 'workspace', at: '/', fs: inner, access: 'ro' }] });
            try { await expect(view.driver.readContent('/escape/secret.txt', { encoding: 'utf-8' })).rejects.toThrow(); }
            finally { await view.dispose(); }
        } finally { await manager.dispose(); }
    });

    it('does not fail a safe sibling stat when another path is a symlink', async () => {
        await backend.mkdir('/safe');
        await symlink(join(root, 'files', 'safe'), join(root, 'files', 'link'), 'dir');
        const [safe, link] = await Promise.allSettled([backend.statType('/safe'), backend.statType('/link')]);
        expect(safe).toEqual({ status: 'fulfilled', value: { type: 'directory' } });
        expect(link).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ code: 'EACCES' }) });
    });

    it.each([0, 3])('rejects all waiters when the host returns %s rows for two paths', async count => {
        const port = (backend as unknown as { fsOps: { statMany: (paths: string[]) => Promise<unknown[]> } }).fsOps;
        port.statMany = async () => Array(count).fill(null);
        const replies = await Promise.allSettled([backend.statType('/a'), backend.statType('/b')]);
        for (const reply of replies) expect(reply).toMatchObject({ status: 'rejected',
            reason: expect.objectContaining({ message: 'Invalid batched stat response length' }) });
    });


});
