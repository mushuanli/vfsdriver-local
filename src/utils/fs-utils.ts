/**
 * @file vfsdriver-localfs/src/utils/fs-utils.ts
 * Filesystem helpers that operate through IFsOps (no direct node:fs import).
 */

import type { IFsOps } from '../fs/fs-ops';

export async function ensureDir(fsOps: IFsOps, dirPath: string): Promise<void> {
    await fsOps.mkdir(dirPath);
}

export async function unlinkSafe(fsOps: IFsOps, filePath: string): Promise<void> {
    await fsOps.unlink(filePath);
}

/**
 * Remove orphaned staging files older than maxAgeMs.
 * Called on backend init for crash recovery.
 */
export async function cleanOrphanedStaging(
    fsOps: IFsOps,
    stagingDir: string,
    maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<void> {
    const entries = await fsOps.readDir(stagingDir);
    const now = Date.now();
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        // Construct child path — join with '/' (cross-platform safe for VFS paths)
        const filePath = joinPath(stagingDir, entry.name);
        const stat = await fsOps.stat(filePath);
        if (stat && now - stat.mtimeMs > maxAgeMs) {
            await fsOps.unlink(filePath).catch(() => {});
        }
    }
}

/** Minimal path join that works in both Node.js and browser contexts. */
export function joinPath(...parts: string[]): string {
    return parts
        .map((p, i) => (i === 0 ? p : p.replace(/^\/+/, '')))
        .join('/')
        .replace(/\/+/g, '/');
}

export function basenamePath(p: string): string {
    return p.split('/').filter(Boolean).pop() ?? p;
}

export function dirnamePath(p: string): string {
    const parts = p.split('/');
    parts.pop();
    return parts.join('/') || '/';
}
