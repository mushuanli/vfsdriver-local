# @itookit/vfsdriver-localfs

Node.js 本地文件系统存储后端 — 实现 path-based `IStorageBackend`。

**构建**: tsup → CJS + ESM + `.d.ts`

## 架构

```
IStorageBackend  ← LocalFSBackend
    ├── fs/                   原生文件系统操作(IFsOps → NodeFsOps):文件内容
    └── db/                   SQLite sidecar(<sidecarDir>/index.db):元数据/标签/SeqFile 记录
```

## 目录结构

```
src/
├── index.ts                 公共 API 导出
├── localfs-backend.ts       LocalFSBackend (IStorageBackend 实现)
├── db/
│   ├── schema.ts            DDL + SCHEMA_VERSION (meta_ext, meta_tags, records)
│   ├── sidecar-interface.ts ISidecarDb 接口 + MetaExtRow
│   ├── sidecar.ts           BetterSqliteSidecarDb (better-sqlite3 实现)
│   ├── sidecar-sync.ts      ISidecarDbSync 接口(同步事务控制)
│   └── path-data.ts         子树搬迁 SQL (Node / Tauri sidecar 共用)
├── fs/
│   ├── fs-ops.ts            IFsOps 接口 (readFile/writeFile/stat/readDir/...)
│   └── node-fs-ops.ts       NodeFsOps (基于 fs/promises, writeFile 临时文件+rename 原子写)
└── utils/
    └── fs-utils.ts          路径工具函数 (ensureDir, unlinkSafe, joinPath 等)
```

## 关键 API

```ts
// 创建/打开
import { openLocalFSBackend } from '@itookit/vfsdriver-localfs';
const backend = await openLocalFSBackend({ rootDir: '/path/to/vfs', sidecarDir: '/path/to/vfs/.meta' });

// 健康检查
const result = await backend.verify();   // { healthy, dirsExist, dbHealthy, orphanMetaExt, orphanMetaTags, ... }
await backend.repair(result);            // 清理孤儿 meta 行,返回 { fixedMetaExt, fixedMetaTags }
```

## 与其他后端的区别

| 后端 | 平台 | 元数据存储 | 内容存储 |
|---|---|---|---|
| `vfsdriver-indexeddb` | 浏览器 | IndexedDB | IndexedDB |
| `vfsdriver-localfs` | Node | SQLite sidecar | 原生文件系统 |
| `vfs-core MemoryBackend` | Node/Browser | 内存 | 内存 |

## 编码约定

- 实现 `IStorageBackend` 全部方法(path-based)。
- `write` 使用临时文件 + rename 保证原子性。
- 元数据(metadata, tags, icon)写入 SQLite sidecar,不与文件内容耦合。
- `init()` 在 sidecar 损坏(`PRAGMA integrity_check` 失败)时删除 `index.db` 并重建;健康但打开失败则抛错。
- 此包仅用于 Node/Electron 环境,依赖 `better-sqlite3` (原生模块)。

## 测试

```bash
pnpm --filter @itookit/vfsdriver-localfs test   # vitest run
```
