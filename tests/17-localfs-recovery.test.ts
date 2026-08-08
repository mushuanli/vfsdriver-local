/**
 * LocalFSBackend recovery and health check tests.
 * Direct backend testing — no VFS integration needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalFSBackend, LocalFSBackend } from '@itookit/vfsdriver-localfs';
import type { LocalFSBackendOptions } from '@itookit/vfsdriver-localfs';

// ── Temp directory helpers ─────────────────────────────────────────────────

let _seq = 0;

interface TmpSetup {
    rootDir:    string;
    sidecarDir: string;
    cleanup:    () => Promise<void>;
}

async function makeTmp(): Promise<TmpSetup> {
    const id = `vfstest-localfs-rec-${Date.now()}-${++_seq}`;
    const base       = join(tmpdir(), id);
    const rootDir    = join(base, 'home');
    const sidecarDir = join(base, 'sidecar');
    await fsp.mkdir(rootDir,    { recursive: true });
    await fsp.mkdir(sidecarDir, { recursive: true });
    return {
        rootDir,
        sidecarDir,
        cleanup: () => fsp.rm(base, { recursive: true, force: true }),
    };
}

async function setupBackend(opts?: Partial<LocalFSBackendOptions>) {
    const tmp = await makeTmp();
    const backend = await openLocalFSBackend({
        rootDir:    opts?.rootDir ?? tmp.rootDir,
        sidecarDir: opts?.sidecarDir ?? tmp.sidecarDir,
        ...opts,
    });
    return { backend, tmp, dispose: async () => { await backend.close(); await tmp.cleanup(); } };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('LocalFSBackend — parent directory auto-creation', () => {
    let backend: Awaited<ReturnType<typeof openLocalFSBackend>>;
    let tmp: TmpSetup;
    beforeEach(async () => { const r = await setupBackend(); backend = r.backend; tmp = r.tmp; });
    afterEach(async () => { await backend.close(); await tmp.cleanup(); });

    it('write() creates nested parent directories', async () => {
        await backend.write('/deep/nested/file.txt', new TextEncoder().encode('hello'));
        expect(await backend.stat('/deep')).not.toBeNull();
        expect(await backend.stat('/deep/nested')).not.toBeNull();
        expect(await backend.stat('/deep/nested/file.txt')).not.toBeNull();
        // Verify on real disk
        const p = join(tmp.rootDir, 'deep', 'nested', 'file.txt');
        const st = await fsp.stat(p);
        expect(st.isFile()).toBe(true);
    });

    it('mkdir() creates nested parent directories', async () => {
        await backend.mkdir('/a/b/c');
        expect(await backend.stat('/a')).not.toBeNull();
        expect(await backend.stat('/a/b')).not.toBeNull();
        const c = await backend.stat('/a/b/c');
        expect(c).not.toBeNull();
        expect(c!.type).toBe('directory');
    });

    it('write() succeeds when parent already exists', async () => {
        await backend.mkdir('/existing');
        await expect(backend.write('/existing/file.txt', new TextEncoder().encode('ok'))).resolves.not.toThrow();
        const node = await backend.stat('/existing/file.txt');
        expect(node).not.toBeNull();
    });
});

describe('LocalFSBackend — auto-rebuild on init', () => {
    it('init() recovers from corrupted SQLite database', async () => {
        const tmp = await makeTmp();

        // Write garbage to index.db to simulate corruption
        const dbPath = join(tmp.sidecarDir, 'index.db');
        await fsp.writeFile(dbPath, 'this is not a valid sqlite database');

        // Create and init backend — should auto-rebuild
        const backend = new LocalFSBackend({
            rootDir:    tmp.rootDir,
            sidecarDir: tmp.sidecarDir,
        });
        await backend.init();

        // Verify the backend works after recovery
        await backend.mkdir('/test-dir');
        await backend.setTags('/test-dir', ['recovery-test']);
        const tags = await backend.getAllTags();
        expect(tags).toContain('recovery-test');

        await backend.close();
        await tmp.cleanup();
    });

    it('init() succeeds on a clean database', async () => {
        const tmp = await makeTmp();
        const backend = new LocalFSBackend({
            rootDir:    tmp.rootDir,
            sidecarDir: tmp.sidecarDir,
        });
        await backend.init();
        await backend.close();
        await tmp.cleanup();
    });
});

describe('LocalFSBackend — transaction', () => {
    let backend: Awaited<ReturnType<typeof openLocalFSBackend>>;
    let tmp: TmpSetup;
    beforeEach(async () => { const r = await setupBackend(); backend = r.backend; tmp = r.tmp; });
    afterEach(async () => { await backend.close(); await tmp.cleanup(); });

    it('transaction() passes through writes', async () => {
        await backend.transaction(async () => {
            await backend.mkdir('/tx-folder');
            await backend.write('/tx-folder/data.txt', new TextEncoder().encode('tx-data'));
        });
        expect(await backend.stat('/tx-folder')).not.toBeNull();
        expect(await backend.stat('/tx-folder/data.txt')).not.toBeNull();
    });

    it('transaction() returns result from callback', async () => {
        const result = await backend.transaction(async () => {
            await backend.mkdir('/result-folder');
            return 42;
        });
        expect(result).toBe(42);
    });
});

describe('LocalFSBackend — verify and repair', () => {
    let backend: Awaited<ReturnType<typeof openLocalFSBackend>>;
    let tmp: TmpSetup;
    beforeEach(async () => { const r = await setupBackend(); backend = r.backend; tmp = r.tmp; });
    afterEach(async () => { await backend.close(); await tmp.cleanup(); });

    it('verify() reports healthy for a clean backend', async () => {
        await backend.mkdir('/docs');
        await backend.write('/docs/readme.md', new TextEncoder().encode('# Hello'));
        const result = await backend.verify();
        expect(result.healthy).toBe(true);
        expect(result.dirsExist).toBe(true);
        expect(result.dbHealthy).toBe(true);
        expect(result.orphanMetaExt).toHaveLength(0);
        expect(result.orphanMetaTags).toHaveLength(0);
        expect(result.orphanMetaTags).toHaveLength(0);
    });

    it('verify() returns correct meta counts', async () => {
        await backend.mkdir('/tagged');
        await backend.setTags('/tagged', ['test-tag']);
        const result = await backend.verify();
        expect(result.totalMetaTags).toBeGreaterThanOrEqual(1);
    });

    it('verify() detects orphan meta_ext when file deleted directly from disk', async () => {
        await backend.write('/will-delete.txt', new TextEncoder().encode('bye'));
        await backend.setTags('/will-delete.txt', ['orphan-tag']);
        // Delete the file directly from disk — bypassing the backend
        await fsp.unlink(join(tmp.rootDir, 'will-delete.txt'));

        const result = await backend.verify();
        expect(result.orphanMetaExt).toContain('/will-delete.txt');
        expect(result.healthy).toBe(false);
    });

    it('repair() runs without error on healthy backend', async () => {
        const result = await backend.repair();
        expect(result.fixedMetaExt).toBe(0);
        expect(result.fixedMetaTags).toBe(0);
    });

    it('repair() cleans up orphan meta_ext entries', async () => {
        // Create file + metadata, then delete file directly from disk
        await backend.write('/will-delete-2.txt', new TextEncoder().encode('bye'));
        await backend.setTags('/will-delete-2.txt', ['orphan-tag-2']);
        await fsp.unlink(join(tmp.rootDir, 'will-delete-2.txt'));

        const issues = await backend.verify();
        expect(issues.orphanMetaExt.length).toBeGreaterThan(0);

        const fixResult = await backend.repair(issues);
        expect(fixResult.fixedMetaExt).toBe(issues.orphanMetaExt.length);

        // After repair, should be healthy
        const recheck = await backend.verify();
        expect(recheck.orphanMetaExt).toHaveLength(0);
        expect(recheck.healthy).toBe(true);
    });

    it('verify() reports counts in result', async () => {
        await backend.mkdir('/a');
        await backend.mkdir('/b');
        const result = await backend.verify();
        expect(result.totalMetaExt).toBeGreaterThanOrEqual(0);
        expect(result.totalMetaTags).toBeGreaterThanOrEqual(0);
    });
});
