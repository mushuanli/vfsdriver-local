import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));
let bundle: string, root: string;
const children: ChildProcess[] = [];
const diagnostics = new WeakMap<ChildProcess, string>();
let serial = 0;
let mountMode = 'root';

function receive(child: ChildProcess, matches: (message: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
        const message = (value: any) => { if (matches(value)) { cleanup(); value.error ? reject(new Error(value.error)) : resolve(value); } };
        const exit = (code: number | null, signal: string | null) => { cleanup(); reject(new Error(`Worker exited before reply (${code ?? signal}): ${diagnostics.get(child) ?? ''}`)); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Worker reply timed out')); }, 10_000);
        child.on('message', message); child.on('exit', exit);
    });
}
async function worker() {
    const child = fork(join(bundle, 'ipc-worker.cjs'), [root, mountMode], {
        env: { ...process.env, NODE_PATH: join(here, '../node_modules') },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stderr?.on('data', data => diagnostics.set(child, ((diagnostics.get(child) ?? '') + String(data)).slice(-8000)));
    await receive(child, message => message.ready || message.error);
    return child;
}
async function call(child: ChildProcess, action: string, args?: unknown) {
    const id = ++serial;
    const reply = receive(child, message => message.id === id);
    child.send({ id, action, args });
    return (await reply).result;
}
async function kill(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
}
async function crash(child: ChildProcess, action: string, args?: unknown) {
    const point = receive(child, message => message.crashpoint || message.error);
    child.send({ id: ++serial, action, args });
    await point; await kill(child);
}

beforeAll(async () => {
    bundle = await mkdtemp(join(tmpdir(), 'kernel-worker-build-'));
    await build({ config: false, entry: [join(here, 'ipc-worker.ts')], outDir: bundle, format: ['cjs'],
        outExtension: () => ({ js: '.cjs' }), noExternal: ['@itookit/vfs-core'],
        external: ['better-sqlite3'], splitting: false, silent: true, dts: false });
}, 30_000);
afterAll(async () => { if (bundle) await rm(bundle, { recursive: true, force: true }); });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'kernel-ipc-')); });
afterEach(async () => { await Promise.all(children.splice(0).map(kill)); await rm(root, { recursive: true, force: true }); });

describe.each(['root', 'module'])('kernel over shared LocalFS/SQLite (%s mount) in independent OS processes', mode => {
    beforeEach(() => { mountMode = mode; });
    it('advances another process\'s waiter and dependant without event delivery or sweep', async () => {
        const a = await worker();
        const ids = await call(a, 'setup');
        const b = await worker();
        await call(b, 'complete', ids.target);
        const records = await call(a, 'snapshot', [ids.waiter, ids.dependent]);
        expect(records.map((r: any) => r.status)).toEqual(['ready', 'ready']);
        expect(records[0].pendingEvents.filter((e: any) => e.type === 'task-exited')).toHaveLength(1);
    });
    it('does not lose a wakeup when registration races completion', async () => {
        const a = await worker(), b = await worker();
        const target = await call(a, 'create-target');
        const [waiter] = await Promise.all([call(a, 'register', target.id), call(b, 'complete', target.id)]);
        const [record] = await call(a, 'snapshot', [waiter.id]);
        expect(record.status).toBe('ready');
        expect(record.pendingEvents.filter((e: any) => e.type === 'task-exited')).toHaveLength(1);
    });
    it('rolls back a killed multi-file transaction and resumes durable waiting after restart', async () => {
        const a = await worker();
        const ids = await call(a, 'setup');
        await crash(a, 'crash-tx', ids.target);
        const b = await worker();
        await call(b, 'recover');
        expect((await call(b, 'snapshot', [ids.target]))[0].status).toBe('created');
        await call(b, 'complete', ids.target);
        expect((await call(b, 'snapshot', [ids.waiter, ids.dependent])).map((r: any) => r.status)).toEqual(['ready', 'ready']);
    });
    it('grants a ready task to only one competing process', async () => {
        const a = await worker(), b = await worker();
        const task = await call(a, 'create');
        const claims = await Promise.all([call(a, 'claim'), call(b, 'claim')]);
        expect(claims.filter(Boolean).map(c => c.task.id)).toEqual([task.id]);
    });
    it('resumes an unexpired task through Kernel after SIGKILL without periodic polling', async () => {
        const a = await worker();
        const task = await call(a, 'create');
        const claim = await call(a, 'claim');
        expect(claim.task.id).toBe(task.id);
        await kill(a);
        const b = await worker();
        const result = await call(b, 'resume-kernel', task.id);
        expect(result.report.recoveredTasks).toBe(1);
        expect(result.exit).toMatchObject({ status: 'succeeded', output: 'recovered' });
    });
    it.each(['adapter', 'receipt'])('recovers physical cleanup after SIGKILL at %s without overallocating', async stage => {
        const a = await worker();
        const setup = await call(a, 'resource-setup');
        await crash(a, 'cleanup-crash', { ...setup, stage });
        const b = await worker();
        const before = await call(b, 'resource-status', setup);
        expect(before.stat).toMatchObject({ held: 1, waiting: 1 });
        expect(before.cleanup[0].status).not.toBe('succeeded');
        const recovered = await call(b, 'cleanup-recover', setup);
        expect(recovered.release).toMatchObject({ status: 'succeeded', result: { released: true } });
        expect(recovered.waiting).toMatchObject({ status: 'succeeded', result: { released: false } });
        expect(recovered.stat).toMatchObject({ held: 1, waiting: 0 });
        const replay = await call(b, 'cleanup-recover', setup);
        expect(replay.waiting.result.id).toBe(recovered.waiting.result.id);
    });
    it('recovers records after SIGKILL between filesystem rename and sidecar migration', async () => {
        const a = await worker();
        await crash(a, 'rename-crash');
        const b = await worker();
        expect(await call(b, 'read-renamed')).toEqual({ value: 'durable' });
    });
});
