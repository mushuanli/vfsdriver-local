# @itookit/vfsdriver-local

Local filesystem backend for `@itookit/vfs-core`. File content remains on disk;
SQLite sidecars hold metadata, tags and SeqFile records. Includes atomic file
replacement and recoverable namespace renames.

Runtime dependencies are `@itookit/vfs-core` and `better-sqlite3`.
Project organization, synchronization policy and execution belong to the host.

## Development

```sh
git clone --recurse-submodules git@github.com:mushuanli/vfsdriver-local.git
cd vfsdriver-local
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

CI uses Node.js 22. `better-sqlite3` is a native dependency; installation needs
a matching prebuilt binary or a native build toolchain. Its build is explicitly
allowed in pnpm-workspace.yaml.

`vendor/vfs-core` pins core for standalone development. Inside itookit, the outer
workspace resolves its top-level core instead. Packed releases reference core
as an npm dependency and exclude the development submodule.

## Usage

```ts
import { createVFS } from '@itookit/vfs-core';
import { LocalFSBackend } from '@itookit/vfsdriver-local';

const backend = new LocalFSBackend({
  rootDir: '/path/to/project',
  sidecarDir: '/path/to/project/.mindos/vfs',
});
const { manager } = await createVFS({ rootBackend: backend });
const fs = await manager.openFileSystem('/');
await fs.driver.createFile({ parentPath: '/', name: 'hello.txt', content: 'Hello' });
await manager.dispose();
```

`@itookit/vfsdriver-local/node` exports `NodeFsOps` and `BetterSqliteSidecarDb`
for Node hosts that inject these implementations. The root entry retains its
browser-safe interface for desktop hosts with their own filesystem bridge.

See [AGENTS.md](AGENTS.md) for transactions, recovery and performance invariants.
Driver tests are self-contained. Kernel IPC and CLI SQLite integration tests are
maintained by itookit under apps/cli/tests.

## itookit integration

```sh
git submodule update --init --recursive packages/vfs-core packages/vfsdriver-local
```
