/**
 * @file vfsdriver-localfs/src/index.ts
 *
 * Public API — browser-safe exports only.
 *
 * Node.js-only implementations (BetterSqliteSidecarDb, NodeFsOps) are NOT
 * exported here to keep them out of the browser/Tauri WebView static bundle.
 * They are loaded lazily via dynamic import() inside localfs-backend.ts
 * (defaultCreateDb / defaultCreateFs), so they never appear in the static
 * import graph when a caller provides createDb / createFs in options.
 *
 * Electron / Node.js consumers that need the concrete classes can import
 * directly from the sub-paths:
 *   import { BetterSqliteSidecarDb } from '@itookit/vfsdriver-localfs/db/sidecar'
 *   import { NodeFsOps }             from '@itookit/vfsdriver-localfs/fs/node-fs-ops'
 */

// ── Backend (browser-safe: uses only dynamic imports for node:* internally) ──
export { LocalFSBackend, openLocalFSBackend } from './localfs-backend';
export type { LocalFSBackendOptions }          from './localfs-backend';

// ── Store classes (no node:* imports) ────────────────────────────────────────
export { LocalFSInodeStore, ROOT_INO } from './stores/localfs-inode-store';
export { LocalFSMetaStore }            from './stores/localfs-meta-store';
export { LocalFSContentStore }         from './stores/localfs-content-store';

// ── Interfaces — type-only, zero runtime code ─────────────────────────────────
export type { ISidecarDb, PathEntry, MetaExtRow } from './db/sidecar-interface';
export type { IFsOps, StatResult, DirEntry }      from './fs/fs-ops';

// ── Schema constants (pure strings, no imports) ───────────────────────────────
export { DDL, SCHEMA_VERSION } from './db/schema';

// ── Path / FS utilities (no node:* imports) ──────────────────────────────────
export {
    ensureDir, unlinkSafe, cleanOrphanedStaging,
    joinPath, basenamePath, dirnamePath,
} from './utils/fs-utils';
