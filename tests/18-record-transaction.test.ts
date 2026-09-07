import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFSBackend } from '../src/localfs-backend';
import type { ISidecarDb, MetaExtRow } from '../src/db/sidecar-interface';

describe('LocalFS transactional records', () => {
    let root: string;
    let backend: LocalFSBackend;
    let sidecar: ISidecarDb;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'itookit-records-'));
        sidecar = new FakeSidecarDb();
        backend = new LocalFSBackend({
            rootDir: join(root, 'files'),
            sidecarDir: join(root, 'sidecar'),
            createDb: async () => sidecar,
        });
        await backend.init();
    });

    afterEach(async () => {
        await backend.close();
        await rm(root, { recursive: true, force: true });
    });

    it('commits fields across paths', async () => {
        await backend.records.transaction!(async tx => {
            await tx.setRecordField('/one.seq', 'state', 'ready');
            await tx.setRecordField('/two.seq', 'state', 'waiting');
        });
        expect(await backend.records.getRecordField('/one.seq', 'state')).toBe('ready');
        expect(await backend.records.getRecordField('/two.seq', 'state')).toBe('waiting');
    });

    it('rolls back all record writes', async () => {
        await expect(backend.records.transaction!(async tx => {
            await tx.setRecordField('/one.seq', 'version', 1);
            throw new Error('rollback');
        })).rejects.toThrow('rollback');
        expect(await backend.records.getRecordField('/one.seq', 'version')).toBeUndefined();
    });

    it('uses the supplied connection for reads, writes and replacing all fields', async () => {
        const scoped = new FakeSidecarDb();
        sidecar.transaction = async operation => operation(scoped);
        await sidecar.setRecordField('/one.seq', 'outside', 'untouched');
        await scoped.setRecordField('/one.seq', 'old', 'remove');
        await backend.records.transaction!(async tx => {
            expect(await tx.getRecordField('/one.seq', 'old')).toBe('remove');
            await tx.setRecordField('/one.seq', 'new', 'ready');
        });
        expect(await scoped.getRecordField('/one.seq', 'new')).toBe('ready');
        await backend.records.setAllRecordFields('/one.seq', { replacement: 'done' });
        expect(await scoped.listRecordFields('/one.seq')).toEqual([{ field: 'replacement', value: 'done' }]);
        expect(await sidecar.listRecordFields('/one.seq')).toEqual([{ field: 'outside', value: 'untouched' }]);
    });

    it('preserves both errors and permits another transaction after rollback fails', async () => {
        const original = new Error('commit failed');
        const rollback = new Error('rollback failed');
        vi.spyOn(sidecar, 'commit').mockRejectedValueOnce(original);
        vi.spyOn(sidecar, 'rollback').mockRejectedValueOnce(rollback);
        await expect(backend.records.transaction!(async () => undefined)).rejects.toMatchObject({
            cause: original, errors: [original, rollback],
        });
        await backend.records.transaction!(async tx => { await tx.setRecordField('/one.seq', 'next', true); });
        expect(await sidecar.getRecordField('/one.seq', 'next')).toBe(true);
    });
});

class FakeSidecarDb implements ISidecarDb {
    private records = new Map<string, unknown>();
    private snapshot?: Map<string, unknown>;
    async getMetaExt(): Promise<MetaExtRow | null> { return null; }
    async upsertMetaExt(): Promise<void> {}
    async deleteMetaExt(): Promise<void> {}
    async syncTags(): Promise<void> {}
    async getAllDistinctTags(): Promise<string[]> { return []; }
    async queryByTag(): Promise<string[]> { return []; }
    async healthCheck(): Promise<{ ok: boolean }> { return { ok: true }; }
    async close(): Promise<void> {}
    async getRecordField(path: string, field: string): Promise<unknown | undefined> {
        return this.records.get(`${path}\0${field}`);
    }
    async setRecordField(path: string, field: string, value: unknown): Promise<void> {
        this.records.set(`${path}\0${field}`, value);
    }
    async deleteRecordField(path: string, field: string): Promise<void> {
        this.records.delete(`${path}\0${field}`);
    }
    async listRecordFields(path: string, prefix = ''): Promise<Array<{ field: string; value: unknown }>> {
        const start = `${path}\0`;
        return [...this.records]
            .filter(([key]) => key.startsWith(start) && key.slice(start.length).startsWith(prefix))
            .map(([key, value]) => ({ field: key.slice(start.length), value }))
            .sort((left, right) => left.field.localeCompare(right.field));
    }
    async clearRecordFields(path: string): Promise<void> {
        for (const key of this.records.keys()) if (key.startsWith(`${path}\0`)) this.records.delete(key);
    }
    async begin(): Promise<void> { this.snapshot = new Map(this.records); }
    async commit(): Promise<void> { this.snapshot = undefined; }
    async rollback(): Promise<void> {
        if (this.snapshot) this.records = this.snapshot;
        this.snapshot = undefined;
    }
}
