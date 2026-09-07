/** SQL shared by Node and Tauri sidecars. Prefix checks are literal, not LIKE patterns. */
export const PATH_SUBTREE = "(path = ? OR substr(path, 1, length(?) + 1) = ? || '/')";

export function movePathStatements(from: string, to: string): Array<{ sql: string; values: string[] }> {
    const select = [to, from, from, from, from];
    const source = [from, from, from];
    return [
        { sql: `INSERT INTO meta_ext SELECT ? || substr(path, length(?) + 1), icon, device_handler, is_asset_dir, tags, metadata, extra FROM meta_ext WHERE ${PATH_SUBTREE}`, values: select },
        { sql: `INSERT INTO meta_tags SELECT ? || substr(path, length(?) + 1), tag FROM meta_tags WHERE ${PATH_SUBTREE}`, values: select },
        { sql: `INSERT INTO records SELECT ? || substr(path, length(?) + 1), field, value FROM records WHERE ${PATH_SUBTREE}`, values: select },
        { sql: `DELETE FROM meta_tags WHERE ${PATH_SUBTREE}`, values: source },
        { sql: `DELETE FROM meta_ext WHERE ${PATH_SUBTREE}`, values: source },
        { sql: `DELETE FROM records WHERE ${PATH_SUBTREE}`, values: source },
    ];
}

export const PATH_DATA_EXISTS = `SELECT path FROM meta_ext WHERE ${PATH_SUBTREE} UNION ALL SELECT path FROM records WHERE ${PATH_SUBTREE} LIMIT 1`;

export function migrateRecordStatements(prefix: string) {
    const local = "CASE WHEN source.path = ? THEN '/' ELSE substr(source.path, length(?) + 1) END";
    const source = "(source.path = ? OR substr(source.path, 1, length(?) + 1) = ? || '/')";
    return {
        conflict: `SELECT source.path FROM records source JOIN records dest ON dest.path = ${local} WHERE ${source} LIMIT 1`,
        values: [prefix, prefix, prefix, prefix, prefix],
        update: `UPDATE records SET path = CASE WHEN path = ? THEN '/' ELSE substr(path, length(?) + 1) END WHERE ${PATH_SUBTREE}`,
    };
}
