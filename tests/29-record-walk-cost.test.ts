/**
 * Record walks must cost one statement and one recovered transaction per node, never one
 * operation per row: that pattern is what made large SeqFile scans dominate application boot.
 */
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFSBackend } from '../src/localfs-backend';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const FIELDS = 500;
const NODES = 40;
const PER_NODE = 40;

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'record-walk-cost-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const backend = new LocalFSBackend({ rootDir: root, sidecarDir: join(root, '.meta') });
    await backend.init();
    cleanup.push(() => backend.close());
    await backend.records.transaction!(async tx => {
        for (let index = 0; index < FIELDS; index++) await tx.setRecordField('/big', `f/${String(index).padStart(3, '0')}`, index);
        for (let node = 0; node < NODES; node++) {
            for (let field = 0; field < PER_NODE; field++) await tx.setRecordField(`/n${node}`, `f/${field}`, field);
        }
    });
    return backend;
}

/** `transaction` is used by the IPC sidecar, `begin`/`commit` by the in-process one. */
const transactions = (stats: Record<string, number>) => (stats.transaction ?? 0) + (stats.begin ?? 0);

it('reads every field of a large node in one statement and one recovered transaction', async () => {
    const backend = await fixture();
    backend.resetSidecarStats();
    const seen: string[] = [];
    expect(await backend.records.walkRecordFields('/big', field => { seen.push(field); return true; }))
        .toEqual({ total: FIELDS, processed: FIELDS });
    expect(seen).toHaveLength(FIELDS);
    const stats = { ...backend.sidecarStats } as unknown as Record<string, number>;
    expect(stats.listRecordFields).toBe(1);
    expect(stats.listRecordFieldsPage).toBe(0);
    expect(stats.getRecordField).toBe(1);          // the rename-journal probe
    expect(stats.setRecordField).toBe(0);
    expect(transactions(stats)).toBe(1);
});

it('scans many nodes with one statement and one transaction each', async () => {
    const backend = await fixture();
    backend.resetSidecarStats();
    for (let node = 0; node < NODES; node++) {
        expect(await backend.records.walkRecordFields(`/n${node}`, () => true)).toEqual({ total: PER_NODE, processed: PER_NODE });
    }
    const stats = { ...backend.sidecarStats } as unknown as Record<string, number>;
    expect(stats.listRecordFields).toBe(NODES);
    expect(stats.getRecordField).toBe(NODES);
    expect(transactions(stats)).toBe(NODES);
    // No per-field operations: reads and callbacks stay inside the single statement.
    expect(stats.getRecordFields).toBe(0);
    expect(stats.getRecordFieldsMany).toBe(0);
    expect(stats.setRecordField).toBe(0);
});
