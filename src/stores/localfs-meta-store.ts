/**
 * @file vfsdriver-localfs/src/stores/localfs-meta-store.ts
 * IMetaStore backed by IFsOps.stat() + ISidecarDb. No direct node:fs import.
 */

import type { IMetaStore, MetaRecord, MetaWalkOptions } from '@itookit/common';
import type { ISidecarDb, MetaExtRow } from '../db/sidecar-interface';
import type { IFsOps } from '../fs/fs-ops';
import { joinPath } from '../utils/fs-utils';

export class LocalFSMetaStore implements IMetaStore {
    constructor(
        private readonly rootDir: string,
        private readonly db: ISidecarDb,
        private readonly fsOps: IFsOps,
    ) {}

    // ── Core CRUD ──────────────────────────────────────────────────────────────

    async getMeta(ino: number): Promise<MetaRecord | null> {
        const rel = await this.db.getRelPath(ino);
        if (rel === null) return null;

        const realPath = rel === '' ? this.rootDir : joinPath(this.rootDir, rel);
        const stat = await this.fsOps.stat(realPath);
        if (!stat) return null;

        const ext = await this.db.getMetaExt(ino);

        return {
            ino,
            // Directories have no content; only files carry a contentRef.
            // Leaving contentRef set for directories would cause deleteWalk to
            // call content.deleteData → fsOps.unlink(directoryPath) → EPERM.
            contentRef:      stat.isDirectory ? undefined : String(ino),
            modifiedAt:      stat.mtimeMs,
            size:            stat.isDirectory ? 0 : stat.size,
            version:         Math.floor(stat.mtimeMs),
            mimeType:        ext?.mime_type       ?? undefined,
            icon:            ext?.icon            ?? undefined,
            symlinkTarget:   ext?.symlink_target  ?? undefined,
            deviceHandlerId: ext?.device_handler  ?? undefined,
            assetDirIno:     ext?.asset_dir_ino   ?? undefined,
            ownerFileIno:    ext?.owner_file_ino  ?? undefined,
            isAssetDir:      ext ? Boolean(ext.is_asset_dir) : undefined,
            tags:     ext?.tags     ? (JSON.parse(ext.tags)     as string[])                : undefined,
            metadata: ext?.metadata ? (JSON.parse(ext.metadata) as Record<string, unknown>) : undefined,
            extra:    ext?.extra    ? (JSON.parse(ext.extra)    as Record<string, unknown>) : undefined,
        };
    }

    async putMeta(meta: MetaRecord): Promise<void> {
        await this.db.upsertMetaExt(this.toExtRow(meta));
        await this.db.syncTags(meta.ino, meta.tags);
    }

    async deleteMeta(ino: number): Promise<void> {
        await this.db.deleteMetaExt(ino);
    }

    async patchMeta(ino: number, partial: Partial<Omit<MetaRecord, 'ino'>>): Promise<void> {
        const hasStorable = [
            partial.mimeType, partial.icon, partial.symlinkTarget, partial.deviceHandlerId,
            partial.assetDirIno, partial.ownerFileIno, partial.isAssetDir,
            partial.tags, partial.metadata, partial.extra,
        ].some(v => v !== undefined);
        if (!hasStorable) return;

        const existing = await this.db.getMetaExt(ino);
        const row: MetaExtRow = {
            ino,
            mime_type:      partial.mimeType       !== undefined ? (partial.mimeType      ?? null) : (existing?.mime_type      ?? null),
            icon:           partial.icon           !== undefined ? (partial.icon          ?? null) : (existing?.icon           ?? null),
            symlink_target: partial.symlinkTarget  !== undefined ? (partial.symlinkTarget ?? null) : (existing?.symlink_target ?? null),
            device_handler: partial.deviceHandlerId !== undefined ? (partial.deviceHandlerId ?? null) : (existing?.device_handler ?? null),
            asset_dir_ino:  partial.assetDirIno    !== undefined ? (partial.assetDirIno   ?? null) : (existing?.asset_dir_ino  ?? null),
            owner_file_ino: partial.ownerFileIno   !== undefined ? (partial.ownerFileIno  ?? null) : (existing?.owner_file_ino ?? null),
            is_asset_dir:   partial.isAssetDir !== undefined ? (partial.isAssetDir ? 1 : 0) : (existing?.is_asset_dir ?? 0),
            tags:     partial.tags     !== undefined ? JSON.stringify(partial.tags)     : (existing?.tags     ?? null),
            metadata: partial.metadata !== undefined ? JSON.stringify(partial.metadata) : (existing?.metadata ?? null),
            extra:    partial.extra    !== undefined ? JSON.stringify(partial.extra)    : (existing?.extra    ?? null),
        };
        await this.db.upsertMetaExt(row);
        if (partial.tags !== undefined) await this.db.syncTags(ino, partial.tags);
    }

    async forEachMeta(
        inos: number[],
        callback: (meta: MetaRecord, index: number) => boolean | Promise<boolean>,
    ): Promise<void> {
        for (let i = 0; i < inos.length; i++) {
            const rec = await this.getMeta(inos[i]);
            if (rec) {
                if (!(await callback(rec, i))) break;
            }
        }
    }

    async walkByTag(
        tag: string,
        callback: (ino: number) => boolean | Promise<boolean>,
        options?: MetaWalkOptions,
    ): Promise<{ total: number; processed: number }> {
        const inos = await this.db.queryByTag(tag);
        const total = inos.length;
        let processed = 0;
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? Infinity;
        for (let i = offset; i < inos.length && processed < limit; i++) {
            if (!(await callback(inos[i]))) break;
            processed++;
        }
        return { total, processed };
    }

    async walkByMetadata(
        field: string,
        value: unknown,
        callback: (ino: number) => boolean | Promise<boolean>,
        options?: MetaWalkOptions,
    ): Promise<{ total: number; processed: number }> {
        const inos = await this.db.queryByMetadata(`$.${field}`, typeof value === 'string' ? value : JSON.stringify(value));
        const total = inos.length;
        let processed = 0;
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? Infinity;
        for (let i = offset; i < inos.length && processed < limit; i++) {
            if (!(await callback(inos[i]))) break;
            processed++;
        }
        return { total, processed };
    }

    private toExtRow(meta: MetaRecord): MetaExtRow {
        return {
            ino:            meta.ino,
            mime_type:      meta.mimeType       ?? null,
            icon:           meta.icon           ?? null,
            symlink_target: meta.symlinkTarget  ?? null,
            device_handler: meta.deviceHandlerId ?? null,
            asset_dir_ino:  meta.assetDirIno    ?? null,
            owner_file_ino: meta.ownerFileIno   ?? null,
            is_asset_dir:   meta.isAssetDir ? 1 : 0,
            tags:     meta.tags     ? JSON.stringify(meta.tags)     : null,
            metadata: meta.metadata ? JSON.stringify(meta.metadata) : null,
            extra:    meta.extra    ? JSON.stringify(meta.extra)    : null,
        };
    }
}
