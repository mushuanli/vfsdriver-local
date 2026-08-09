/**
 * @file vfsdriver-localfs/src/db/schema.ts
 *
 * v4.1 Sidecar SQLite schema — path-based, no ino/counters/path_ino tables.
 *
 * Only non-derivable metadata is stored. Size/mtime/type come from the filesystem.
 */
export const SCHEMA_VERSION = 3;

export const DDL = `
PRAGMA journal_mode  = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;
PRAGMA cache_size    = -8000;
PRAGMA busy_timeout  = 5000;

CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO _schema_version (version) VALUES (3);

-- Non-derivable metadata keyed by relative path
CREATE TABLE IF NOT EXISTS meta_ext (
    path            TEXT PRIMARY KEY,
    icon            TEXT,
    device_handler  TEXT,
    is_asset_dir    INTEGER NOT NULL DEFAULT 0,
    tags            TEXT,       -- JSON array
    metadata        TEXT,       -- JSON object
    extra           TEXT        -- plugin-reserved
);

-- Materialised tag index
CREATE TABLE IF NOT EXISTS meta_tags (
    path TEXT NOT NULL REFERENCES meta_ext(path) ON DELETE CASCADE,
    tag  TEXT NOT NULL,
    PRIMARY KEY (path, tag)
);
CREATE INDEX IF NOT EXISTS idx_meta_tags_tag ON meta_tags(tag);

CREATE TABLE IF NOT EXISTS records (
    path  TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (path, field)
);
CREATE INDEX IF NOT EXISTS idx_records_path ON records(path, field);
`;
