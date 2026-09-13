/**
 * Sidecar call counting (`LocalFSBackend.sidecarStats`). The desktop sidecar is a SQLite
 * IPC channel of its own; hosts combine this with VFS `ioStats` to quantify idle traffic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFSBackend } from '../src/localfs-backend';
import { SIDECAR_OPERATIONS } from '../src/db/sidecar-stats';
import type { ISidecarDb, MetaExtRow } from '../src/db/sidecar-interface';

describe('LocalFS sidecar call stats', () => {
    let root: string;
    let backend: LocalFSBackend;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'itookit-sidecar-stats-'));
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

    it('reports a full frozen counter set and resets on demand', () => {
        backend.resetSidecarStats();
        const stats = backend.sidecarStats;
        expect(Object.keys(stats).sort()).toEqual([...SIDECAR_OPERATIONS].sort());
        expect(Object.values(stats).every(count => count === 0)).toBe(true);
        expect(Object.isFrozen(stats)).toBe(true);
    });

    it('counts record reads and writes through their sidecar calls', async () => {
        backend.resetSidecarStats();
        await backend.records.setRecordField('/one.seq', 'state', 'ready');
        const afterWrite = backend.sidecarStats;
        await backend.records.getRecordField('/one.seq', 'state');
        const stats = backend.sidecarStats;
        expect(stats.setRecordField).toBe(1);
        // Reads also include the rename-journal recovery probe.
        expect(stats.getRecordField).toBeGreaterThanOrEqual(1);
        // Both operations check cross-process rename recovery inside their transaction.
        expect(afterWrite.transaction).toBe(1);
        expect(stats.transaction).toBe(2);
    });

    it('counts statements executed inside a transaction callback', async () => {
        backend.resetSidecarStats();
        await backend.records.transaction!(async tx => {
            await tx.setRecordField('/two.seq', 'a', 1);
            await tx.setRecordField('/two.seq', 'b', 2);
        });
        expect(backend.sidecarStats.setRecordField).toBe(2);
    });
});

class FakeSidecarDb implements ISidecarDb {
    private records = new Map<string, unknown>();
    async getMetaExt(): Promise<MetaExtRow | null> { return null; }
    async upsertMetaExt(): Promise<void> {}
    async deleteMetaExt(): Promise<void> {}
    async syncTags(): Promise<void> {}
    async getAllDistinctTags(): Promise<string[]> { return []; }
    async queryByTag(): Promise<string[]> { return []; }
    async healthCheck(): Promise<{ ok: boolean }> { return { ok: true }; }
    async close(): Promise<void> {}
    async getRecordField(path: string, field: string): Promise<unknown | undefined> { return this.records.get(`${path}\0${field}`); }
    async setRecordField(path: string, field: string, value: unknown): Promise<void> { this.records.set(`${path}\0${field}`, value); }
    async deleteRecordField(path: string, field: string): Promise<void> { this.records.delete(`${path}\0${field}`); }
    async listRecordFields(path: string, prefix = ''): Promise<Array<{ field: string; value: unknown }>> {
        const start = `${path}\0`;
        return [...this.records]
            .filter(([key]) => key.startsWith(start) && key.slice(start.length).startsWith(prefix))
            .map(([key, value]) => ({ field: key.slice(start.length), value }));
    }
    async clearRecordFields(path: string): Promise<void> {
        for (const key of this.records.keys()) if (key.startsWith(`${path}\0`)) this.records.delete(key);
    }
    async begin(): Promise<void> {}
    async commit(): Promise<void> {}
    async rollback(): Promise<void> {}
    async transaction<T>(operation: (db: ISidecarDb) => Promise<T>): Promise<T> { return operation(this); }
}
