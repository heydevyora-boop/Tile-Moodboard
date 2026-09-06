"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerProcessor = registerProcessor;
exports.stopPolling = stopPolling;
exports.enqueueJob = enqueueJob;
exports.getJob = getJob;
exports.listJobs = listJobs;
exports.retryJob = retryJob;
exports.getQueueStats = getQueueStats;
const connection_1 = require("@db/connection");
const logger_1 = require("@utils/logger");
const queues = new Map();
function computeBackoffMs(attempt) {
    const base = 2000;
    const raw = base * 2 ** attempt;
    const jittered = raw * (0.5 + Math.random() * 0.5);
    return Math.min(60000, Math.round(jittered));
}
function registerProcessor(type, processor, opts = {}) {
    const runtime = { processor, concurrency: opts.concurrency ?? 2, running: new Set() };
    queues.set(type, runtime);
    const pollIntervalMs = opts.pollIntervalMs ?? 2000;
    runtime.pollTimer = setInterval(() => {
        void tick(type);
    }, pollIntervalMs);
    runtime.pollTimer.unref?.();
}
function stopPolling(type) {
    const runtime = queues.get(type);
    if (runtime?.pollTimer)
        clearInterval(runtime.pollTimer);
}
async function enqueueJob(type, payload, opts = {}) {
    const job = await connection_1.prisma.job.create({
        data: {
            type,
            status: 'PENDING',
            payload: payload,
            maxAttempts: opts.maxAttempts ?? 3,
            createdById: opts.createdById,
            nextAttemptAt: new Date(),
        },
    });
    void tick(type);
    return { id: job.id, type: job.type, status: job.status };
}
async function tick(type) {
    const runtime = queues.get(type);
    if (!runtime)
        return;
    while (runtime.running.size < runtime.concurrency) {
        const now = new Date();
        const due = await connection_1.prisma.job.findFirst({
            where: { type, status: 'PENDING', nextAttemptAt: { lte: now } },
            orderBy: { createdAt: 'asc' },
        });
        if (!due || !due.id)
            return;
        runtime.running.add(due.id);
        await connection_1.prisma.job.update({ where: { id: due.id }, data: { status: 'PROCESSING' } });
        runProcessorFor(type, runtime, due.id, due.payload, due.attempts, due.maxAttempts)
            .finally(() => {
            runtime.running.delete(due.id);
            void tick(type);
        });
    }
}
async function runProcessorFor(type, runtime, jobId, payload, priorAttempts, maxAttempts) {
    const attempt = priorAttempts + 1;
    try {
        const result = await runtime.processor(payload);
        await connection_1.prisma.job.update({
            where: { id: jobId },
            data: { status: 'COMPLETED', result: (result ?? {}), attempts: attempt, completedAt: new Date(), error: null },
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
            const delayMs = computeBackoffMs(attempt - 1);
            logger_1.logger.warn(`Job ${jobId} (${type}) failed on attempt ${attempt}/${maxAttempts}, retrying in ${delayMs}ms`, { error: message });
            await connection_1.prisma.job.update({
                where: { id: jobId },
                data: { status: 'PENDING', attempts: attempt, error: message, nextAttemptAt: new Date(Date.now() + delayMs) },
            });
        }
        else {
            logger_1.logger.error(`Job ${jobId} (${type}) failed permanently after ${attempt} attempts`, { error: message });
            await connection_1.prisma.job.update({
                where: { id: jobId },
                data: { status: 'FAILED', attempts: attempt, error: message, completedAt: new Date() },
            });
        }
    }
}
async function getJob(id) {
    return connection_1.prisma.job.findUnique({ where: { id } });
}
async function listJobs(params) {
    const skip = (params.page - 1) * params.limit;
    const where = {
        ...(params.type ? { type: params.type } : {}),
        ...(params.status ? { status: params.status } : {}),
    };
    const [jobs, total] = await Promise.all([
        connection_1.prisma.job.findMany({ where, skip, take: params.limit, orderBy: { createdAt: 'desc' } }),
        connection_1.prisma.job.count({ where }),
    ]);
    return { jobs, total };
}
async function retryJob(id) {
    const job = await connection_1.prisma.job.findUnique({ where: { id } });
    if (!job || job.status !== 'FAILED')
        return null;
    const updated = await connection_1.prisma.job.update({
        where: { id },
        data: { status: 'PENDING', attempts: 0, error: null, nextAttemptAt: new Date() },
    });
    void tick(job.type);
    return { id: updated.id, status: updated.status };
}
async function getQueueStats(type) {
    const rows = await connection_1.prisma.job.groupBy({ by: ['status'], where: { type }, _count: { status: true } });
    const counts = new Map(rows.map((r) => [r.status, r._count.status]));
    return {
        PENDING: counts.get('PENDING') ?? 0,
        PROCESSING: counts.get('PROCESSING') ?? 0,
        COMPLETED: counts.get('COMPLETED') ?? 0,
        FAILED: counts.get('FAILED') ?? 0,
    };
}
//# sourceMappingURL=jobQueue.service.js.map