/**
 * @file vfsdriver-localfs/src/index.ts
 * Public API — browser-safe exports only. v4.1.
 */

// ── Backend ──
export { LocalFSBackend, openLocalFSBackend } from './localfs-backend';
export type { LocalFSBackendOptions }          from './localfs-backend';

// ── Interfaces ──
export type { ISidecarDb, MetaExtRow } from './db/sidecar-interface';
export type { IFsOps, StatResult, DirEntry } from './fs/fs-ops';

// ── Schema ──
export { DDL, SCHEMA_VERSION } from './db/schema';

// ── Utils ──
export {
    ensureDir, unlinkSafe, cleanOrphanedStaging,
    joinPath, basenamePath, dirnamePath,
} from './utils/fs-utils';
