import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFSBackend } from '../src/localfs-backend';
it('maps __tests__ literally and rejects parent traversal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-literal-'));
    const backend = new LocalFSBackend({ rootDir: join(directory, 'data'), sidecarDir: join(directory, 'meta') });
    try {
        await backend.init();
        await backend.write('/__tests__/example.ts', new TextEncoder().encode('test'));
        expect(await readFile(join(directory, 'data/__tests__/example.ts'), 'utf8')).toBe('test');
        expect((await backend.list('/__tests__'))[0].path).toBe('/__tests__/example.ts');
        expect(new TextDecoder().decode(await backend.read('/__tests__/example.ts'))).toBe('test');
        await expect(backend.read('/../meta/index.db')).rejects.toThrow('Invalid backend path');
    } finally { await backend.close(); await rm(directory, { recursive: true, force: true }); }
});
