import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: ['@itookit/vfs-core', 'better-sqlite3'],
    splitting: false,
    treeshake: true,
    platform: 'node',
    target: 'es2022',
});
