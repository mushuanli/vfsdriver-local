import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { LocalFSBackend } from '../src/localfs-backend';
import { NodeFsOps } from '../src/fs/node-fs-ops';
import { BetterSqliteSidecarDb } from '../src/db/sidecar';

let root: string, backend: LocalFSBackend, db: BetterSqliteSidecarDb;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'localfs-rename-'));
    backend = new LocalFSBackend({ rootDir: join(root, 'files'), sidecarDir: join(root, 'db'),
        createDb: async path => (db = new BetterSqliteSidecarDb(path)) });
    await backend.init();
});
afterEach(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });

describe('recoverable filesystem rename', () => {
    it('removes subtree tag associations without affecting prefix siblings', async () => {
        await backend.write('/folder/file.md', new Uint8Array());
        await backend.write('/folder-other/keep.md', new Uint8Array());
        await backend.setTags('/folder/file.md', ['work']);
        await backend.setTags('/folder-other/keep.md', ['keep']);
        await backend.rename('/folder', '/moved');
        expect(await backend.listTagEntries()).toContainEqual({ path: '/moved/file.md', tag: 'work' });
        await backend.delete('/moved', { recursive: true });
        expect(await backend.listTagEntries()).toEqual([{ path: '/folder-other/keep.md', tag: 'keep' }]);
    });
    it('keeps backend-local records accessible through a mount after rename', async () => {
        await backend.write('/old/data.seq', new Uint8Array());
        await db.setRecordField('/old/data.seq', '__vfs_seq__:state', 'original');
        const { manager } = await createVFS({ rootBackend: new MemoryBackend(),
            additionalMounts: [{ path: '/workspace', backend }],});
        try {
            const fs = await manager.openFileSystem('/workspace');
            expect(await fs.meta.seq!.getEntry('/old/data.seq', 'state')).toBe('original');
            await fs.meta.seq!.transaction!(tx => tx.setEntry('/old/data.seq', 'next', 'new'));
            await fs.driver.rename('/old', 'new');
            expect(await fs.meta.seq!.getEntry('/new/data.seq', 'state')).toBe('original');
            expect(await fs.meta.seq!.getEntry('/new/data.seq', 'next')).toBe('new');
            expect(await db.getRecordField('/new/data.seq', '__vfs_seq__:next')).toBe('new');
            await fs.driver.createFile({ name: 'other.seq', parentPath: null, type: 'seqfile' });
            await fs.meta.seq!.setEntry('/other.seq', 'value', 'other');
            await fs.driver.move(['/other.seq'], '/new');
            expect(await fs.meta.seq!.getEntry('/new/other.seq', 'value')).toBe('other');
        } finally { await manager.dispose(); }
    });
    it('moves every descendant record, metadata and tag while preserving prefix siblings', async () => {
        await backend.write('/a_%/deep/data.seq', new Uint8Array());
        await backend.write('/a_%other/data.seq', new Uint8Array());
        await backend.setTags('/a_%/deep/data.seq', ['durable']);
        await backend.updateMetadata('/a_%/deep/data.seq', { custom: 'kept' });
        await backend.records.setRecordField('/a_%/deep/data.seq', 'state', 'ready');
        await backend.records.setRecordField('/a_%other/data.seq', 'state', 'sibling');
        await backend.rename('/a_%', '/renamed');
        expect(await backend.records.getRecordField('/renamed/deep/data.seq', 'state')).toBe('ready');
        expect(await backend.records.getRecordField('/a_%/deep/data.seq', 'state')).toBeUndefined();
        expect(await backend.records.getRecordField('/a_%other/data.seq', 'state')).toBe('sibling');
        expect((await backend.stat('/renamed/deep/data.seq'))?.metadata.custom).toBe('kept');
        expect(await db.queryByTag('durable')).toEqual(['/renamed/deep/data.seq']);
    });
    it('retains a failed migration intent and completes it before the next record access', async () => {
        await backend.write('/old.seq', new Uint8Array());
        await backend.records.setRecordField('/old.seq', 'state', 'ready');
        vi.spyOn(db, 'movePathData').mockRejectedValueOnce(new Error('injected SQL failure'));
        await expect(backend.rename('/old.seq', '/new.seq')).rejects.toThrow('injected SQL failure');
        expect(await backend.records.getRecordField('/new.seq', 'state')).toBe('ready');
        expect(await backend.records.getRecordField('/old.seq', 'state')).toBeUndefined();
        expect(await db.getRecordField('/__vfs_namespace_journal__', 'intent')).toBeUndefined();
    });
    it('keeps concurrent rename outcomes separate when one filesystem operation fails', async () => {
        await backend.write('/one.seq', new Uint8Array());
        await backend.write('/two.seq', new Uint8Array());
        const original = NodeFsOps.prototype.rename;
        const spy = vi.spyOn(NodeFsOps.prototype, 'rename').mockImplementation(async function (from, to) {
            if (from.endsWith('/two.seq')) throw new Error('second rename denied');
            return original.call(this, from, to);
        });
        try {
            const results = await Promise.allSettled([backend.rename('/one.seq', '/one-new.seq'), backend.rename('/two.seq', '/two-new.seq')]);
            expect(results[0].status).toBe('fulfilled');
            expect(results[1]).toMatchObject({ status: 'rejected', reason: { message: 'second rename denied' } });
            expect(await backend.stat('/one-new.seq')).not.toBeNull();
            expect(await backend.stat('/two.seq')).not.toBeNull();
        } finally { spy.mockRestore(); }
    });
    it('abandons a rename that fails without changing the filesystem', async () => {
        await backend.write('/source.seq', new Uint8Array());
        const spy = vi.spyOn(NodeFsOps.prototype, 'rename').mockRejectedValueOnce(new Error('filesystem denied rename'));
        try {
            await expect(backend.rename('/source.seq', '/destination.seq')).rejects.toThrow('filesystem denied rename');
            expect(await backend.stat('/source.seq')).not.toBeNull();
            expect(await db.getRecordField('/__vfs_namespace_journal__', 'intent')).toBeUndefined();
            await backend.records.setRecordField('/source.seq', 'value', 'still writable');
            expect(await backend.records.getRecordField('/source.seq', 'value')).toBe('still writable');
        } finally { spy.mockRestore(); }
    });
    it('refuses to overwrite destination data before moving the file', async () => {
        await backend.write('/source.seq', new Uint8Array());
        await backend.records.setRecordField('/destination.seq', 'state', 'must survive');
        await expect(backend.rename('/source.seq', '/destination.seq')).rejects.toThrow('Destination has durable data');
        expect(await backend.stat('/source.seq')).not.toBeNull();
        expect(await backend.records.getRecordField('/destination.seq', 'state')).toBe('must survive');
    });
    it('does not let a standalone record write join a failing transaction', async () => {
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const failing = backend.records.transaction!(async tx => {
            await tx.setRecordField('/tx.seq', 'value', 'rollback');
            entered(); await gate; throw new Error('abort');
        });
        const rejected = expect(failing).rejects.toThrow('abort');
        await started;
        const standalone = backend.records.setRecordField('/outside.seq', 'value', 'keep');
        release(); await rejected; await standalone;
        expect(await backend.records.getRecordField('/outside.seq', 'value')).toBe('keep');
        expect(await backend.records.getRecordField('/tx.seq', 'value')).toBeUndefined();
    });
});
