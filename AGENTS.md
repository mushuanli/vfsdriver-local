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
│   ├── sidecar-stats.ts     SIDECAR_OPERATIONS + countSidecarOperations（IPC 计量代理）
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

// Sidecar 逻辑调用计量:`ioStats` 不包含此通道；一次方法可能发出多条 SQL IPC，不能直接当作 IPC 总数
backend.sidecarStats;      // Readonly<Record<SidecarOperation, number>>（全量键,冻结快照）
backend.resetSidecarStats();
// SIDECAR_OPERATIONS / countSidecarOperations 由包入口导出;transaction 回调内的语句也被计数
```

## 与其他后端的区别

| 后端 | 平台 | 元数据存储 | 内容存储 |
|---|---|---|---|
| `vfsdriver-indexeddb` | 浏览器 | IndexedDB | IndexedDB |
| `vfsdriver-localfs` | Node | SQLite sidecar | 原生文件系统 |
| `vfs-core MemoryBackend` | Node/Browser | 内存 | 内存 |

## 编码约定

- 实现 `IStorageBackend` 全部方法(path-based)。
- `write` 使用临时文件 + rename 保证原子性;临时名必须**每次写唯一**（Node 使用 UUID 并以 wx 独占创建；Rust 使用序号候选并以 create_new 独占创建）——否则同一路径的并发写会共用临时文件、第二个 rename 报 `ENOENT`(桌面 Rust `fs_write_file` 同样要唯一,且不能改真实扩展名)。回归:`25-journal-probe.test.ts`「survives concurrent writes to the same path」。
- 元数据(metadata, tags, icon)写入 SQLite sidecar,不与文件内容耦合。
- `init()` 仅在完整性检查明确报告损坏，或原生 SQLite 返回 SQLITE_CORRUPT/SQLITE_NOTADB 时重建；探针不可用、未知/空结果和普通关闭错误不能授权删除数据库，须保留原文件并抛出原初始化错误。
- **rename journal 每个外层事务核对**：另一进程可在当前连接打开后提交 intent 并崩溃；实例内「曾经干净」不能证明 journal 仍为空。恢复与记录/元数据读写必须在同一事务内执行。`20-kernel-ipc.test.ts` 覆盖先打开读者、写者在文件 rename 后 SIGKILL、原读者恢复 sidecar 的 root/module 两条路径。
- **只读恢复边界**：`withDbRead` 复用事务路径，在执行读取前核对并恢复 rename journal。事务内已绑定的 scoped 记录句柄直接使用同一连接。后续减少 IPC 应通过原子批量操作，不能省略跨进程恢复检查。
- **`statType` 供能力检查用**:VFS 的 `noLinks` 会对每个路径前缀做类型检查,`LocalFSBackend.statType` 复用同一个 `fsOps.stat` 但**不读 sidecar 元数据**——否则每个前缀都是一次 `getMetaExt` IPC。实测单次发送的 VFS stat 由 653 降到 114。语义与 `stat` 的类型同源,不要在其中加元数据。`25-journal-probe.test.ts` 守「深路径只对目标取一次元数据」。详见 [验收记录 §14](../../doc/minimal-system-acceptance.md)。
- **`statType` 微批处理**:`noLinks` 并发发起各前缀检查,`LocalFSBackend` 把同一事件循环 tick 的 `statType` 合并为一次 `IFsOps.statMany`(桌面 = 一次 `fs_stat_many` IPC)。**不要改成逐个 await 或逐个 `fsOps.stat`**,那会把一次发送的前缀走查从批量打回 ~900 次 IPC。回归:`25-journal-probe.test.ts`「coalesces a path-prefix walk into one batched stat call」。详见 [验收记录 §16](../../doc/minimal-system-acceptance.md)。
- 此包仅用于 Node/Electron 环境,依赖 `better-sqlite3` (原生模块)。

## 测试

```bash
pnpm --filter @itookit/vfsdriver-localfs test   # vitest run
```
