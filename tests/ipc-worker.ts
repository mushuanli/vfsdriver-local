// Executed in an independent OS process by 20-kernel-ipc.test.ts.
import { open, readFile } from 'node:fs/promises';
import { ManagedResourceStore } from '../../durable-kernel/src/infrastructure/seqfile/managed-resources';
import type { ManagedResourceAdapter, ResourceCleanup } from '../../durable-kernel/src/domain/resource-api';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { LocalFSBackend } from '../src/localfs-backend';
import { NodeFsOps } from '../src/fs/node-fs-ops';
import { Kernel } from '../../durable-kernel/src/application/kernel';
import { SeqFileKernelStore } from '../../durable-kernel/src/infrastructure/seqfile/store';

let crashOnRename = false;
class CrashFs extends NodeFsOps {
    override async rename(from: string, to: string) {
        await super.rename(from, to);
        if (crashOnRename) {
            process.send!({ crashpoint: true });
            await new Promise(() => {});
        }
    }
}

async function main() {
    const root = process.argv[2];
    const backend = new LocalFSBackend({ rootDir: `${root}/files`, sidecarDir: `${root}/db`, createFs: () => new CrashFs() });
    const mounted = process.argv[3] === 'module';
    const { manager } = await createVFS({ rootBackend: mounted ? new MemoryBackend() : backend,
        additionalMounts: mounted ? [{ path: '/module/ipc', backend }] : [],});
    const fs = await manager.openFileSystem('/module/ipc');
    const binding = { fs, rootPath: '/session' };
    const store = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => binding);
    await store.initialize();
    await store.createSession('s', { kind: 'local', locator: null });
    const resources = new ManagedResourceStore({ fs, rootPath: '/catalog' }, async () => binding);
    await resources.initialize();
    const spec = { program: { kind: 'test', version: '1' }, input: null };
    process.on('message', async (request: { id: number; action: string; args: any }) => {
        try {
            const result = await execute(request.action, request.args);
            process.send!({ id: request.id, result });
        } catch (error) { process.send!({ id: request.id, error: String(error) }); }
    });
    async function execute(action: string, args: any) {
        if (action === 'resource-setup') {
            const resource = (await resources.execute({}, { type: 'create', requestId: 'pool', kind: 'pool', name: 'device', capacity: 1,
                physical: { kind: 'device', version: '1', externalId: 'device' } })).result as any;
            await resources.execute({}, { type: 'share', requestId: 'share', ref: resource.ref, toSessionId: 's', rights: ['execute'] });
            const t1 = await store.createTask(binding, 's', { ...spec, deferStart: true });
            const t2 = await store.createTask(binding, 's', { ...spec, deferStart: true });
            const a = { sessionId: 's', taskId: t1.id }, b = { sessionId: 's', taskId: t2.id };
            const h1 = (await resources.execute(a, { type: 'open', requestId: 'open', ref: resource.ref, name: 'device', rights: ['execute'] })).result as any;
            const h2 = (await resources.execute(b, { type: 'open', requestId: 'open', ref: resource.ref, name: 'device', rights: ['execute'] })).result as any;
            const claim = (await resources.execute(a, { type: 'acquire', requestId: 'hold', handle: h1, quantity: 1 })).result as any;
            await resources.execute(b, { type: 'acquire', requestId: 'wait', handle: h2, quantity: 1 });
            await resources.execute(a, { type: 'release', requestId: 'release', claim });
            const [operation] = (await resources.query({}, { kind: 'cleanups', scope: 'kernel' })).items as ResourceCleanup[];
            return { ref: resource.ref, a, b, claim, operation };
        }
        if (action === 'resource-status') return {
            stat: await resources.stat({}, args.ref),
            cleanup: (await resources.query({}, { kind: 'cleanups', scope: 'kernel' })).items,
            claims: (await resources.query({}, { kind: 'claims', scope: 'kernel' })).items,
        };
        if (action === 'cleanup-crash' || action === 'cleanup-recover') {
            const adapter: ManagedResourceAdapter = {
                kind: 'device', version: '1', timeoutMs: 60_000,
                async cleanup(c) {
                    const marker = `${root}/device-stopped`;
                    if (action === 'cleanup-crash') {
                        const file = await open(marker, 'w');
                        try { await file.writeFile(c.operationId); await file.sync(); } finally { await file.close(); }
                        if (args.stage === 'adapter') {
                            process.send!({ crashpoint: true });
                            await new Promise(() => {});
                        }
                    } else if (await readFile(marker, 'utf8') !== c.operationId) throw new Error('Cleanup identity changed after crash');
                    return { operationId: c.operationId, epoch: c.epoch, status: 'stopped' };
                },
                async destroy(c) { return { operationId: c.operationId, epoch: c.epoch, status: 'stopped' }; },
            };
            resources.registerAdapter(adapter);
            if (action === 'cleanup-crash' && args.stage === 'receipt') {
                const original = backend.records.transaction!.bind(backend.records);
                backend.records.transaction = callback => original(async tx => {
                    const value = await callback(tx);
                    const raw = await tx.getRecordField(`${mounted ? '' : '/module/ipc'}/catalog/resources.seq`, `__vfs_seq__:managed/cleanup/${encodeURIComponent(args.operation.id)}`);
                    if (raw && JSON.parse(String(raw)).status === 'succeeded') {
                        process.send!({ crashpoint: true });
                        await new Promise(() => {});
                    }
                    return value;
                });
            }
            await resources.recover('kernel', action === 'cleanup-recover');
            await resources.sweep('kernel');
            return {
                release: await resources.poll(args.a, 'kernel', 'release'),
                waiting: await resources.poll(args.b, 'kernel', 'wait'),
                stat: await resources.stat({}, args.ref),
            };
        }
        if (action === 'resume-kernel') {
            const kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' } });
            kernel.registerStorageResolver({ kind: 'local', async resolve() { return binding; } });
            kernel.registerProgram({ manifest: spec.program,
                init() { return { state: null, next: { type: 'complete', output: 'recovered' } }; },
                reduce() { throw new Error('unexpected'); },
            });
            await kernel.initialize();
            try {
                const report = await kernel.recoverSession('s', { takeover: true });
                const exit = await (await kernel.openTask(args)).wait({ timeoutMs: 2000 });
                return { report, exit };
            } finally { kernel.dispose(); await kernel.waitIdle(); }
        }
        if (action === 'setup') {
            const target = await store.createTask(binding, 's', { ...spec, deferStart: true });
            const dependent = await store.createTask(binding, 's', { ...spec, dependsOn: [{ task: target.id, condition: 'terminal' }] });
            const waiter = await store.createTask(binding, 's', spec);
            const claim = (await store.claimReady(binding, 'worker', 30_000))!;
            await store.commitTask(binding, claim, { ...claim.task, status: 'waiting', currentAttempt: undefined, wait: { type: 'task', id: target.id } }, 'task.waiting');
            return { target: target.id, dependent: dependent.id, waiter: waiter.id };
        }
        if (action === 'create-target') return store.createTask(binding, 's', { ...spec, deferStart: true });
        if (action === 'register') {
            const waiter = await store.createTask(binding, 's', spec);
            const claim = (await store.claimReady(binding, 'worker', 30_000))!;
            if (claim.task.id !== waiter.id) throw new Error('Unexpected claim');
            return store.commitTask(binding, claim, { ...claim.task, status: 'waiting', currentAttempt: undefined,
                wait: { type: 'task', id: args } }, 'task.waiting');
        }
        if (action === 'complete') return store.cancelTask(binding, args);
        if (action === 'snapshot') return Promise.all(args.map((id: string) => store.readTask(binding, id)));
        if (action === 'recover') return store.recover(binding);
        if (action === 'create') return store.createTask(binding, 's', spec);
        if (action === 'claim') return await store.claimReady(binding, String(process.pid), 30_000) ?? null;
        if (action === 'crash-tx') return fs.meta.seq!.transaction!(async tx => {
            await tx.setEntry(`/session/tasks/${args}/task.seq`, 'record', '{"broken":true}');
            await tx.setEntry('/session/graph.seq', 'uncommitted', 'bad');
            process.send!({ crashpoint: true });
            await new Promise(() => {});
        });
        if (action === 'rename-crash') {
            await backend.write('/old/data.seq', new Uint8Array());
            await backend.records.setRecordField('/old/data.seq', 'value', 'durable');
            crashOnRename = true;
            await backend.rename('/old', '/new');
        }
        if (action === 'read-renamed') return {
            value: await backend.records.getRecordField('/new/data.seq', 'value'),
            old: await backend.records.getRecordField('/old/data.seq', 'value'),
            journal: await backend.records.getRecordField('/__vfs_namespace_journal__', 'intent'),
        };
        throw new Error(`Unknown action: ${action}`);
    }
    process.send!({ ready: true });
}
main().catch(error => { process.send?.({ error: String(error) }); process.exitCode = 1; });
