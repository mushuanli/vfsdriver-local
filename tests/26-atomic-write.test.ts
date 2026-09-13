import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFsOps } from '../src/fs/node-fs-ops';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'localfs-atomic-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it('publishes one complete value when independent instances write the same path', async () => {
    const path = join(root, 'same.bin');
    await Promise.all(Array.from({ length: 24 }, (_, index) => new NodeFsOps().writeFile(path, new Uint8Array(8192).fill(index).buffer)));
    const data = await fs.readFile(path);
    expect(data.length).toBe(8192);
    expect(data.every(byte => byte === data[0])).toBe(true);
    expect(await fs.readdir(root)).toEqual(['same.bin']);
});

it('preserves the existing destination and cleans up when publication fails', async () => {
    const path = join(root, 'same.bin');
    await fs.writeFile(path, 'original');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('publication failed'));
    await expect(new NodeFsOps().writeFile(path, new Uint8Array([1]).buffer)).rejects.toThrow('publication failed');
    expect(await fs.readFile(path, 'utf8')).toBe('original');
    expect(await fs.readdir(root)).toEqual(['same.bin']);
});

it('does not overwrite or remove a temporary path created by another writer', async () => {
    const originalOpen = fs.open.bind(fs);
    let temporary = '';
    vi.spyOn(fs, 'open').mockImplementationOnce(async (path, flags, mode) => {
        temporary = String(path);
        await fs.writeFile(temporary, 'other writer');
        return originalOpen(path, flags, mode);
    });
    await expect(new NodeFsOps().writeFile(join(root, 'target'), new Uint8Array([1]).buffer)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(temporary, 'utf8')).toBe('other writer');
    expect(await fs.readdir(root)).toEqual([temporary.slice(root.length + 1)]);
});

it('retries editor content through the real atomic writer after publication failure', async () => {
    const { SaveManager } = await import('../../mdx/src/editor/save-manager');
    const path = join(root, 'document.md');
    await fs.writeFile(path, 'original');
    const writer = new NodeFsOps();
    const manager = new SaveManager(content => writer.writeFile(path, new TextEncoder().encode(content).buffer));
    const onError = vi.fn(), onSuccess = vi.fn();
    manager.setDirty(true);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('publication failed'));
    await manager.save(() => 'edited', onSuccess, onError);
    expect(manager.isDirty()).toBe(true);
    expect(await fs.readFile(path, 'utf8')).toBe('original');
    manager.setDirty(true);
    await manager.save(() => 'newer edit', onSuccess, onError);
    expect(manager.isDirty()).toBe(false);
    expect(await fs.readFile(path, 'utf8')).toBe('newer edit');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual(['document.md']);
});
