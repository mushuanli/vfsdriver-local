// Executed in an independent OS process by 20-kernel-ipc.test.ts.
import { open, readFile } from 'node:fs/promises';
import { ManagedResourceStore } from '../../durable-kernel/src/infrastructure/seqfile/managed-resources';
import type { ManagedResourceAdapter, ResourceCleanup } from '../../durable-kernel/src/domain/resource-api';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { LocalFSBackend } from '../src/localfs-backend';
import { NodeFsOps } from '../src/fs/node-fs-ops';
import { Kernel } from '../../durable-kernel/src/application/kernel';
import { SeqFileKernelStore } from '../../durable-kernel/src/infrastructure/seqfile/store';
import { addEffect } from '../../durable-kernel/src/application/effect-utils';

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
        if (action.startsWith('message-')) {
            const target = { fs, rootPath: '/target' };
            if (action === 'message-setup') {
                const targetStore = new SeqFileKernelStore({ fs, rootPath: '/catalog' }, async () => target);
                await targetStore.createSession('target', { kind: 'local', locator: '/target' });
                const sender = await store.createTask(binding, 's', { ...spec, deferStart: true });
                const receiver = await store.createTask(target, 'target', spec);
                const init = (await store.claimReady(target, 'receiver', 10_000))!;
                await store.commitTask(target, init, { ...init.task, initialized: true, state: null, status: 'waiting',
                    currentAttempt: undefined, wait: { type: 'message', topic: 'work' } }, 'task.waiting');
                return store.sendTaskMessage(binding, sender.id, { idempotencyKey: 'once', targetSessionId: 'target',
                    targetTaskId: receiver.id, topic: 'work', payload: 'durable' });
            }
            if (action === 'message-consume-crash') {
                await store.deliverMessage(target, args);
                const claim = (await store.claimReady(target, 'receiver', 10_000))!;
                await store.commitTask(target, claim, { ...claim.task, pendingEvents: [], status: 'waiting',
                    currentAttempt: undefined, wait: { type: 'signal' } }, 'task.waiting');
                process.send!({ crashpoint: true }); await new Promise(() => {});
            }
            if (action === 'message-prune') return store.pruneMessages(args === 'target' ? target : binding, Date.now() + 1);
            if (action === 'message-redeliver') return store.deliverMessage(target, args);
            if (action === 'message-settle') {
                await store.markMessageDelivered(binding, args.id, await store.messageReceipt(target, args.id));
                const settled = (await store.outbox(binding))[0];
                await store.acknowledgeMessageSettlement(target, settled, 'inbox');
                await store.acknowledgeMessageSettlement(binding, settled, 'outbox');
                return (await store.readTask(target, args.targetTaskId)).pendingEvents;
            }
        }

        if (action === 'cancel-tree-setup') {
            const parent = await store.createTask(binding, 's', { ...spec, deferStart: true });
            const child = await store.createTask(binding, 's', { ...spec, parent: parent.id, deferStart: true });
            const leaf = await store.createTask(binding, 's', { ...spec, parent: child.id });
            const claim = (await store.claimReady(binding, 'worker', 30_000))!;
            const next = addEffect({ ...claim.task, state: null, initialized: true, status: 'waiting' as const,
                currentAttempt: undefined, wait: { type: 'effect' as const, id: 'e' } },
            { id: 'e', kind: 'external', version: '1', request: null, idempotencyKey: 'e', timeoutMs: 60_000 });
            await store.commitTask(binding, claim, next, 'task.waiting');
            const effect = (await store.claimEffect(binding, leaf.id, 'e', 'worker', 30_000))!;
            return { parent: parent.id, child: child.id, leaf: leaf.id, token: effect.effect.currentAttempt!.leaseToken };
        }
        if (action === 'cancel-tree-crash') {
            await store.cancelTask(binding, args);
            process.send!({ crashpoint: true });
            await new Promise(() => {});
        }
        if (action === 'late-effect') return store.completeEffect(binding, args.leaf, 'e', args.token, { result: 'late' });
        if (action === 'recover-effect-cleanup') {
            const kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' }, pollMs: 0, effectCleanupTimeoutMs: 20 });
            kernel.registerStorageResolver({ kind: 'local', async resolve() { return binding; } });
            let calls = 0;
            if (args.mode !== 'missing') kernel.registerEffect({
                kind: 'external', version: '1',
                async execute() { throw new Error('Cancelled effect must not execute'); },
                ...(args.mode === 'unsupported' ? {} : { async cancel() {
                    calls++;
                    if (args.mode === 'failed') throw new Error('External cleanup failed');
                    if (args.mode === 'hanging') await new Promise(() => {});
                } }),
            });
            await kernel.initialize();
            try {
                await kernel.recoverSession('s');
                return { calls, task: await store.readTask(binding, args.leaf) };
            } finally { kernel.dispose(); await kernel.waitIdle(); }
        }
        if (action === 'cache-setup') {
            const owner = await store.createTask(binding, 's', { ...spec, deferStart: true });
            const reader = await store.createTask(binding, 's', { ...spec, deferStart: true });
            const { handle } = await store.createCache(binding, owner.id, { name: 'once', scope: 'session', usage: 'single-use' });
            const shared = await store.grantResource(binding, 'reader-handle', handle.id, reader.id, ['read']);
            await store.publishCache(binding, owner.id, { operationId: 'put', handleId: handle.id,
                key: 'value', fingerprint: 'v1', value: 'durable-input', expectedGeneration: 1 });
            return { owner: owner.id, reader: reader.id, handle: handle.id, shared: shared.id };
        }
        if (action === 'cache-read' || action === 'cache-crash') {
            if (action === 'cache-crash' && args.stage === 'before-commit') {
                const original = backend.records.transaction!.bind(backend.records);
                backend.records.transaction = callback => original(async tx => {
                    const value = await callback(tx);
                    const raw = await tx.getRecordField(`${mounted ? '' : '/module/ipc'}/session/tasks/${args.taskId}/task.seq`, '__vfs_seq__:cache-operation/take');
                    if (raw) { process.send!({ crashpoint: true }); await new Promise(() => {}); }
                    return value;
                });
            }
            const receipt = await store.readCache(binding, args.taskId, { operationId: 'take',
                sources: [{ handleId: args.handleId, key: 'value', fingerprint: 'v1' }] });
            if (action === 'cache-crash') { process.send!({ crashpoint: true }); await new Promise(() => {}); }
            return receipt;
        }
        if (action === 'cache-invalidate') return store.invalidateCache(binding, args.owner, args.handle, 1);
        if (action === 'task-event-page') return store.taskEventPage(binding, args);
        if (action === 'task-list-page') return store.listTaskPage(binding);
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
            const taskId = typeof args === 'string' ? args : args.taskId;
            const kernel = new Kernel({ catalog: { fs, rootPath: '/catalog' } });
            kernel.registerStorageResolver({ kind: 'local', async resolve() { return binding; } });
            kernel.registerProgram({ manifest: spec.program,
                init() { return { state: null, next: { type: 'complete', output: 'recovered' } }; },
                reduce() { throw new Error('unexpected'); },
            });
            await kernel.initialize();
            try {
                const report = await kernel.recoverSession('s', { takeover: typeof args === 'string' || args.takeover !== false });
                const exit = await (await kernel.openTask(taskId)).wait({ timeoutMs: 5000 });
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
        if (action === 'create') return store.createTask(binding, 's', { ...spec, ...(args?.retry ? { retry: args.retry } : {}) });
        if (action === 'claim') return await store.claimReady(binding, String(process.pid), 30_000) ?? null;
        if (action === 'claim-short') return await store.claimReady(binding, String(process.pid), 2500) ?? null;
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
