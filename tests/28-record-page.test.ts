import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFSBackend } from '../src/localfs-backend';
import { BetterSqliteSidecarDb } from '../src/db/sidecar';
import { NodeSqliteSidecarDb } from '../../../apps/cli/src/sqlite-sidecar';
import type { ISidecarDb } from '../src/db/sidecar-interface';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each(['better', 'node'] as const)('bounds SQLite page payloads and retains totals and transaction visibility (%s)', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'record-page-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    let db!: ISidecarDb;
    const backend = new LocalFSBackend({ rootDir: root, sidecarDir: join(root, '.meta'),
        createDb: async path => db = kind === 'better' ? new BetterSqliteSidecarDb(path) : await NodeSqliteSidecarDb.open(path) });
    await backend.init(); cleanup.push(() => backend.close());
    await backend.records.transaction!(async tx => {
        for (let i = 0; i < 120; i++) await tx.setRecordField('/r', `a_%/${String(i).padStart(3, '0')}`, { i });
        await tx.setRecordField('/r', 'aXother', 'excluded');
    });
    const page = vi.spyOn(db, 'listRecordFieldsPage');
    const full = vi.spyOn(db, 'listRecordFields');
    const visit = vi.fn((_field: string) => true);
    expect(await backend.records.walkRecordFields('/r', visit, { prefix: 'a_%/', offset: 50, limit: 3 }))
        .toEqual({ total: 120, processed: 3 });
    expect(visit.mock.calls.map(call => call[0])).toEqual(['a_%/050', 'a_%/051', 'a_%/052']);
    expect((await page.mock.results[0].value).rows).toHaveLength(3);
    expect(full).not.toHaveBeenCalled();
    expect(await backend.records.walkRecordFields('/r', visit, { prefix: 'a_%/', offset: 200, limit: 3 }))
        .toEqual({ total: 120, processed: 0 });
    expect(await backend.records.walkRecordFields('/r', visit, { prefix: 'a_%/', limit: 0 }))
        .toEqual({ total: 120, processed: 0 });
    expect(await backend.records.walkRecordFields('/missing', visit, { limit: 3 })).toEqual({ total: 0, processed: 0 });
    expect(await backend.records.walkRecordFields('/r', () => false, { limit: 3 })).toEqual({ total: 121, processed: 0 });
    await expect(backend.records.transaction!(async tx => {
        await tx.setRecordField('/r', 'new', 1);
        expect(await tx.walkRecordFields('/r', () => true, { prefix: 'new', limit: 1 })).toEqual({ total: 1, processed: 1 });
        throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await backend.records.walkRecordFields('/r', () => true, { prefix: 'new', limit: 1 })).toEqual({ total: 0, processed: 0 });
    // A reader opened before the intent must recover it before serving a bounded page.
    await backend.mkdir('/old');
    await backend.records.setRecordField('/old/r', 'item', 1);
    await db.setRecordField('/__vfs_namespace_journal__', 'intent', { id: 1, fromPath: '/old', toPath: '/new' });
    if (db.movePathData) {
        expect(await backend.records.walkRecordFields('/new/r', () => true, { limit: 1 })).toEqual({ total: 1, processed: 1 });
        expect(await db.getRecordField('/__vfs_namespace_journal__', 'intent')).toBeUndefined();
    } else {
        await expect(backend.records.walkRecordFields('/new/r', () => true, { limit: 1 })).rejects.toThrow('recoverable rename support');
        expect(await db.getRecordField('/__vfs_namespace_journal__', 'intent')).toBeDefined();
    }
});
