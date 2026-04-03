/**
 * @file vfsdriver-localfs/src/db/sidecar-sync.ts
 *
 * ISidecarDbSync — synchronous transaction control for better-sqlite3.
 *
 * This is NOT a replacement for ISidecarDb (which must remain async for
 * Tauri/browser backends). It is a small internal contract that exposes
 * better-sqlite3's native synchronous transaction primitives to
 * LocalFSBackend, without leaking them into the public ISidecarDb interface.
 *
 * LocalFSBackend detects this interface via isSyncDb() type guard. When
 * present, _execTx uses beginSync/commitSync/rollbackSync instead of the
 * async begin/commit/rollback no-ops on BetterSqliteSidecarDb.
 *
 * All data reads/writes still go through ISidecarDb (async interface).
 * For BetterSqliteSidecarDb these resolve synchronously, so there is no
 * actual I/O delay — and since txQueue serializes all _execTx calls,
 * no concurrent BEGIN IMMEDIATE can occur.
 */

export interface ISidecarDbSync {
    /** Issue BEGIN IMMEDIATE synchronously. */
    beginSync(): void;
    /** COMMIT synchronously. */
    commitSync(): void;
    /** ROLLBACK synchronously. */
    rollbackSync(): void;
    /** Close the database synchronously. */
    closeSync(): void;
}
