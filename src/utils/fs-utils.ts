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

/**
 * Returns true when a path segment is "internal" — i.e. it begins with double
 * underscore (`__`).  These paths (e.g. `__config/`) live only in the sidecar
 * directory and must NOT be created inside the user's rootDir.
 *
 * Single-underscore segments (`_note.md/`) are *asset directories* — real
 * directories that belong to the user and ARE created on disk inside rootDir.
 */
export function isInternalSeg(seg: string): boolean {
    return seg.length >= 2 && seg.startsWith('__');
}

/**
 * Returns true if any segment of a relative path is internal (`__` prefix).
 * Used to decide whether content/directory operations should target rootDir
 * (false) or sidecarDir/vfs-internal/ (true).
 */
export function hasInternalSegment(rel: string): boolean {
    if (!rel) return false;
    return rel.split('/').some(isInternalSeg);
}
