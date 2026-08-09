import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFSBackend } from '../src/localfs-backend';
import type { ISidecarDb, MetaExtRow } from '../src/db/sidecar-interface';

describe('LocalFS transactional records', () => {
    let root: string;
    let backend: LocalFSBackend;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'itookit-records-'));
        backend = new LocalFSBackend({
            rootDir: join(root, 'files'),
            sidecarDir: join(root, 'sidecar'),
            createDb: async () => new FakeSidecarDb(),
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
