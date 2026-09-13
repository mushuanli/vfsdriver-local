import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFSBackend } from '../src/localfs-backend';

const probe = vi.hoisted(() => ({ mode: '' }));
vi.mock('better-sqlite3', () => ({ default: class {
    constructor() { if (probe.mode === 'unavailable') throw new Error('Probe unavailable'); }
    prepare() { return { get: () => probe.mode === 'unknown-result' ? undefined : { integrity_check: probe.mode === 'empty-result' ? '' : 'ok' } }; }
    close() { if (probe.mode === 'close-failure') throw new Error('Probe close failed'); }
} }));
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'localfs-open-failure-')); await mkdir(join(root, 'db')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each(['unavailable', 'unknown-result', 'empty-result', 'close-failure'])('preserves the database when integrity probing gives %s', async mode => {
    probe.mode = mode;
    const path = join(root, 'db', 'index.db'), original = 'existing database bytes';
    await writeFile(path, original);
    const failure = new Error('Schema or host initialization failed');
    const createDb = vi.fn(async () => { throw failure; });
    const backend = new LocalFSBackend({ rootDir: join(root, 'files'), sidecarDir: join(root, 'db'), createDb });
    await expect(backend.init()).rejects.toBe(failure);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(createDb).toHaveBeenCalledTimes(1);
});
