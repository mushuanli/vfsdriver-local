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
    it('retains Effect cleanup across missing, unsupported and failed adapters after SIGKILL', async () => {
        const a = await worker(), ids = await call(a, 'cancel-tree-setup');
        await crash(a, 'cancel-tree-crash', ids.parent);
        const b = await worker();
        for (const mode of ['missing', 'unsupported', 'failed', 'hanging']) {
            const result = await call(b, 'recover-effect-cleanup', { leaf: ids.leaf, mode });
            expect(result.task.status).toBe('cancelled');
            expect(result.task.effects.e.cleanupPending).toBe(true);
            expect(result.calls).toBe(mode === 'failed' || mode === 'hanging' ? 1 : 0);
        }
        await kill(b);
        const c = await worker();
        const result = await call(c, 'recover-effect-cleanup', { leaf: ids.leaf, mode: 'success' });
        expect(result.calls).toBe(1);
        expect(result.task.status).toBe('cancelled');
        expect(result.task.effects.e.cleanupPending).toBe(false);
        await kill(c);
        const d = await worker();
        const repeated = await call(d, 'recover-effect-cleanup', { leaf: ids.leaf, mode: 'success' });
        expect(repeated.calls).toBe(0);
        expect(repeated.task).toEqual(result.task);
    });
    it('recovers a cancelled tree after SIGKILL between parent commit and descendant cleanup', async () => {
        const a = await worker(), ids = await call(a, 'cancel-tree-setup');
        await crash(a, 'cancel-tree-crash', ids.parent);
        const b = await worker();
        const before = await call(b, 'snapshot', [ids.parent, ids.child, ids.leaf]);
        expect(before.map((task: any) => task.status)).toEqual(['cancelled', 'created', 'waiting']);
        expect(before[2].effects.e.status).toBe('leased');
        expect(before[2].effects.e.currentAttempt.leaseUntil).toBeGreaterThan(Date.now());
        await expect(call(b, 'late-effect', ids)).rejects.toThrow('Stale effect claim');
        expect(await call(b, 'snapshot', [ids.parent, ids.child, ids.leaf])).toEqual(before);
        await call(b, 'recover');
        const after = await call(b, 'snapshot', [ids.parent, ids.child, ids.leaf]);
        expect(after.map((task: any) => task.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
        expect(after[2].effects.e).toMatchObject({ status: 'cancelled', cleanupPending: true });
        expect(after[2].effects.e.currentAttempt).toBeUndefined();
        const page = await call(b, 'task-event-page', ids.leaf);
        expect(page.items.filter((event: any) => event.type === 'task.cancelled')).toHaveLength(1);
        await kill(b);
        const c = await worker();
        await call(c, 'recover');
        expect(await call(c, 'snapshot', [ids.parent, ids.child, ids.leaf])).toEqual(after);
        expect(await call(c, 'task-event-page', ids.leaf)).toEqual(page);
    });
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
    it('retains consumed message receipts across SIGKILL and concurrent local Session GC', async () => {
        const a = await worker(), sent = await call(a, 'message-setup');
        await crash(a, 'message-consume-crash', sent);
        const b = await worker(), c = await worker();
        expect(await Promise.all([call(b, 'message-prune', 'source'), call(c, 'message-prune', 'target')]))
            .toEqual([{ outbox: 0, inbox: 0 }, { outbox: 0, inbox: 0 }]);
        expect(await call(c, 'message-redeliver', sent)).toBe(false);
        expect(await call(b, 'message-settle', sent)).toEqual([]);
        expect(await Promise.all([call(b, 'message-prune', 'source'), call(c, 'message-prune', 'target')]))
            .toEqual([{ outbox: 1, inbox: 0 }, { outbox: 0, inbox: 1 }]);
        await kill(b); await kill(c);
        const reopened = await worker();
        expect(await call(reopened, 'message-prune', 'source')).toEqual({ outbox: 0, inbox: 0 });
        expect(await call(reopened, 'message-prune', 'target')).toEqual({ outbox: 0, inbox: 0 });
    });

    it('grants a ready task to only one competing process', async () => {
        const a = await worker(), b = await worker();
        const task = await call(a, 'create');
        const claims = await Promise.all([call(a, 'claim'), call(b, 'claim')]);
        expect(claims.filter(Boolean).map(c => c.task.id)).toEqual([task.id]);
    });
    it('delivers a single-use cache to only one competing process', async () => {
        const a = await worker(), setup = await call(a, 'cache-setup'), b = await worker();
        const owner = { taskId: setup.owner, handleId: setup.handle }, reader = { taskId: setup.reader, handleId: setup.shared };
        const results = await Promise.all([call(a, 'cache-read', owner), call(b, 'cache-read', reader)]);
        expect(results.map(result => result.status).sort()).toEqual(['hit', 'miss']);
        expect(await call(a, 'cache-read', owner)).toEqual(results[0]);
        expect(await call(b, 'cache-read', reader)).toEqual(results[1]);
    });
    it.each(['before-commit', 'after-commit'])('preserves single-use receipt atomicity across SIGKILL %s', async stage => {
        const a = await worker(), setup = await call(a, 'cache-setup');
        const owner = { taskId: setup.owner, handleId: setup.handle }, reader = { taskId: setup.reader, handleId: setup.shared };
        await crash(a, 'cache-crash', { ...owner, stage });
        const b = await worker();
        const other = await call(b, 'cache-read', reader);
        const recovered = await call(b, 'cache-read', owner);
        expect(other.status).toBe(stage === 'before-commit' ? 'hit' : 'miss');
        expect(recovered.status).toBe(stage === 'before-commit' ? 'miss' : 'hit');
        if (stage === 'after-commit') expect(recovered.value).toBe('durable-input');
        await call(b, 'cache-invalidate', setup);
        expect(await call(b, 'cache-read', owner)).toEqual(recovered);
        const page = await call(b, 'task-event-page', setup.owner);
        expect(page.items.filter((event: any) => event.type === 'cache.read')).toHaveLength(1);
        expect((await call(b, 'task-list-page')).items.map((task: any) => task.id).sort()).toEqual([setup.owner, setup.reader].sort());
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
    it('waits for the dead worker lease deadline and resumes without forced takeover', async () => {
        const a = await worker();
        const task = await call(a, 'create', { retry: { maxAttempts: 2 } });
        await call(a, 'claim-short');
        await kill(a);
        const b = await worker();
        const result = await call(b, 'resume-kernel', { taskId: task.id, takeover: false });
        expect(result.report.recoveredTasks).toBe(0);
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
    it.each([false, true])('recovers a SIGKILL rename with reader already open: %s', async alreadyOpen => {
        const a = await worker();
        const existing = alreadyOpen ? await worker() : undefined;
        await crash(a, 'rename-crash');
        const b = existing ?? await worker();
        expect(await call(b, 'read-renamed')).toEqual({ value: 'durable' });
    });
});
