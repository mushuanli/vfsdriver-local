/**
 * @file vfsdriver-localfs/src/db/sidecar-stats.ts
 *
 * Sidecar (SQLite) logical operation counting, including transaction callbacks.
 * One method may issue several host IPC requests; these counts are not transport totals.
 * VFS ioStats measures engine operations, so this exposes the separate storage layer.
 */

import type { ISidecarDb } from './sidecar-interface';

/** Logical `ISidecarDb` operations, in a fixed order for stable stats. */
export const SIDECAR_OPERATIONS = [
    'getMetaExt', 'getMetaExtMany', 'upsertMetaExt', 'deleteMetaExt',
    'movePathData', 'assertPathDataVacant',
    'syncTags', 'getAllDistinctTags', 'queryByTag', 'listTagEntries',
    'getRecordField', 'getRecordFields', 'setRecordField', 'deleteRecordField', 'listRecordFields', 'clearRecordFields',
    'transaction', 'begin', 'commit', 'rollback', 'healthCheck', 'close',
] as const;

export type SidecarOperation = typeof SIDECAR_OPERATIONS[number];

/**
 * Wrap an `ISidecarDb` so every invoked operation is reported to `bump`.
 *
 * A `transaction` callback receives a wrapped handle as well, so statements executed inside a
 * transaction are counted instead of bypassing the instrumented object.
 */
export function countSidecarOperations(db: ISidecarDb, bump: (operation: string) => void): ISidecarDb {
    const proxies = new WeakMap<object, ISidecarDb>();
    const wrap = (target: ISidecarDb): ISidecarDb => {
        const cached = proxies.get(target as object);
        if (cached) return cached;
        const proxy = new Proxy(target, {
            get(object, property) {
                const value = Reflect.get(object, property, object);
                if (typeof value !== 'function') return value;
                const name = String(property);
                if (name === 'transaction') {
                    return (operation: (inner: ISidecarDb) => Promise<unknown>) => {
                        bump(name);
                        return (value as (callback: (inner: ISidecarDb) => Promise<unknown>) => Promise<unknown>)
                            .call(object, (inner: ISidecarDb) => operation(wrap(inner)));
                    };
                }
                return (...args: unknown[]) => {
                    bump(name);
                    return (value as (...rest: unknown[]) => unknown).apply(object, args);
                };
            },
        });
        proxies.set(target as object, proxy);
        return proxy;
    };
    return wrap(db);
}
