# @itookit/vfsdriver-localfs

Node.js 本地文件系统存储后端 — 实现 v4.1 path-based `IStorageBackend`。

**构建**: tsup → CJS + ESM + `.d.ts`

## 架构

```
IStorageBackend  ← LocalFSBackend
    ├── fs/                   原生文件系统操作（IFsOps → NodeFsOps）
    └── db/                   SQLite sidecar（元数据/标签）
```

文件层 → 原生 FS（`fs/promises`）读写内容；元数据（icon, tags, metadata）→ SQLite sidecar。

## 目录结构

```
src/
├── index.ts                 公共 API 导出
├── localfs-backend.ts       LocalFSBackend (441行, IStorageBackend 实现)
├── db/
│   ├── schema.ts            DDL (SCHEMA_VERSION=2: meta_ext, meta_tags)
│   ├── sidecar-interface.ts ISidecarDb 接口 + MetaExtRow
│   ├── sidecar.ts           BetterSqliteSidecarDb (better-sqlite3 实现)
│   └── sidecar-sync.ts      ISidecarDbSync 接口
├── fs/
│   ├── fs-ops.ts            IFsOps 接口 (readFile/writeFile/stat/readDir/...)
│   └── node-fs-ops.ts       NodeFsOps (基于 fs/promises, writeFile 临时文件+rename 原子写)
└── utils/
    └── fs-utils.ts           路径工具函数 (ensureDir, unlinkSafe, joinPath 等)
```

## 关键 API

```ts
// 创建/打开
import { openLocalFSBackend } from '@itookit/vfsdriver-localfs';
const backend = await openLocalFSBackend({ rootDir: '/path/to/vfs' });

// 健康检查
const result = await backend.verify();   // 返回 { ok, errors, warnings }
await backend.repair(result);            // 修复元数据不一致
```

## 与其他后端的区别

| 后端 | 平台 | 元数据存储 | 内容存储 |
|---|---|---|---|
| `vfsdriver-indexeddb` | 浏览器 | IndexedDB | IndexedDB |
| `vfsdriver-localfs` | Node | SQLite sidecar | 原生文件系统 |
| `vfs-core MemoryBackend` | Node/Browser | 内存 | 内存 |

## 编码约定

- 实现 `IStorageBackend` 全部方法（path-based, v4.1）
- `writeFile` 使用临时文件 + rename 保证原子性
- 元数据（metadata, tags, icon）写入 SQLite sidecar，不与文件内容耦合
- `verify()` / `repair()` 用于健康检查和修复（sidecar 与 FS 一致性）
- 此包仅用于 Node/Electron 环境，依赖 `better-sqlite3` (原生模块)
