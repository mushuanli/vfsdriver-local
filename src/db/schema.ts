/**
 * @file vfsdriver-localfs/src/db/schema.ts
 *
 * Sidecar SQLite schema — stored in sidecarDir, never inside the user's rootDir.
 *
 * Purpose: maintain a stable ino ↔ relative-path mapping so VFS can reference
 * files by integer ino while reads/writes hit the real filesystem path.
 *
 * Design decisions:
 * - path_ino is the ONLY source of truth for ino→realpath translation.
 * - size / modifiedAt / version are derived from fs.stat() at runtime; not stored.
 * - meta_ext stores only the fields that cannot be derived from the filesystem.
 * - Staging table tracks temporary content files written before putInode is called
 *   (VFSEngine creates content before the inode record — see createFile ordering).
 */

export const SCHEMA_VERSION = 1;

/** DDL executed once at database creation / migration. */
export const DDL = `
PRAGMA journal_mode  = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;
PRAGMA cache_size    = -8000;
PRAGMA busy_timeout  = 5000;

-- Schema version guard
CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER PRIMARY KEY);

-- Ino counter (mirrors the convention of FsBackend — starts at 1 so first allocation = 2)
CREATE TABLE IF NOT EXISTS counters (
    name  TEXT    PRIMARY KEY,
    value INTEGER NOT NULL
);
INSERT OR IGNORE INTO counters (name, value) VALUES ('ino', 1);

-- ino ↔ relative-path index
-- rel = '' for root (rootDir itself), 'notes.md', 'sub/dir/file.txt', etc.
CREATE TABLE IF NOT EXISTS path_ino (
    ino        INTEGER PRIMARY KEY,
    rel        TEXT    NOT NULL UNIQUE,
    type       TEXT    NOT NULL CHECK(type IN ('file', 'directory')),
    created_at INTEGER NOT NULL
);
-- Root inode bootstrapped here; VFSEngine will also call putInode({ino:1,...})
-- but INSERT OR IGNORE keeps idempotency.
INSERT OR IGNORE INTO path_ino (ino, rel, type, created_at) VALUES (1, '', 'directory', 0);

-- Non-derivable metadata (everything not available from fs.stat())
CREATE TABLE IF NOT EXISTS meta_ext (
    ino             INTEGER PRIMARY KEY REFERENCES path_ino(ino) ON DELETE CASCADE,
    mime_type       TEXT,
    icon            TEXT,
    symlink_target  TEXT,
    device_handler  TEXT,
    asset_dir_ino   INTEGER,
    owner_file_ino  INTEGER,
    is_asset_dir    INTEGER NOT NULL DEFAULT 0,
    tags            TEXT,       -- JSON array,  e.g. ["work","urgent"]
    metadata        TEXT,       -- JSON object, e.g. {"priority":1}
    extra           TEXT        -- JSON object, plugin-reserved
);

-- Materialised tag index for O(log n) queryByTag
CREATE TABLE IF NOT EXISTS meta_tags (
    ino INTEGER NOT NULL REFERENCES path_ino(ino) ON DELETE CASCADE,
    tag TEXT    NOT NULL,
    PRIMARY KEY (ino, tag)
);
CREATE INDEX IF NOT EXISTS idx_meta_tags_tag ON meta_tags (tag);

-- Staging: temporary path for content written before putInode is called.
-- Key = String(ino), value = absolute path of the staged temp file.
-- Cleaned up on init (orphans from crashes).
CREATE TABLE IF NOT EXISTS staging (
    ref  TEXT PRIMARY KEY,
    path TEXT NOT NULL
);
`;
