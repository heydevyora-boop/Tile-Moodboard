import { prisma } from '@db/connection';
import { logger } from '@utils/logger';

export type JobType = 'IMAGE_PROCESSING' | 'EXPORT';
export type JobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type JobProcessor = (payload: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;

interface RegisterOptions {
  concurrency?: number;
  pollIntervalMs?: number;
}

interface QueueRuntime {
  processor: JobProcessor;
  concurrency: number;
  running: Set<string>;
  pollTimer?: NodeJS.Timeout;
}

const queues = new Map<JobType, QueueRuntime>();

function computeBackoffMs(attempt: number): number {
  const base = 2000;
  const raw = base * 2 ** attempt;
  const jittered = raw * (0.5 + Math.random() * 0.5);
  return Math.min(60_000, Math.round(jittered));
}

/**
 * Registers the function that actually does the work for a job type, and
 * starts an in-process poller for it. No Redis/BullMQ — this is a
 * single-shop internal tool running one Node process, so a DB-backed
 * table plus an in-process worker loop is the right amount of
 * infrastructure (same philosophy as the Module 6 catalog extraction
 * queue, generalized and made durable/retryable/admin-visible).
 */
export function registerProcessor(type: JobType, processor: JobProcessor, opts: RegisterOptions = {}): void {
  const runtime: QueueRuntime = { processor, concurrency: opts.concurrency ?? 2, running: new Set() };
  queues.set(type, runtime);

  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  runtime.pollTimer = setInterval(() => {
    void tick(type);
  }, pollIntervalMs);
  runtime.pollTimer.unref?.();
}

export function stopPolling(type: JobType): void {
  const runtime = queues.get(type);
  if (runtime?.pollTimer) clearInterval(runtime.pollTimer);
}

export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown>,
  opts: { maxAttempts?: number; createdById?: string } = {},
): Promise<{ id: string; type: JobType; status: JobStatus }> {
  const job = await prisma.job.create({
    data: {
      type,
      status: 'PENDING',
      // See the identical cast + comment in errorLog.service.ts —
      // Prisma's Json input type is stricter than Record<string, unknown>.
      payload: payload as unknown as object,
      maxAttempts: opts.maxAttempts ?? 3,
      createdById: opts.createdById,
      nextAttemptAt: new Date(),
    },
  });
  void tick(type);
  return { id: job.id, type: job.type as JobType, status: job.status as JobStatus };
}

async function tick(type: JobType): Promise<void> {
  const runtime = queues.get(type);
  if (!runtime) return;

  while (runtime.running.size < runtime.concurrency) {
    const now = new Date();
    const due = await prisma.job.findFirst({
      where: { type, status: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
    });
    if (!due || !due.id) return;

    runtime.running.add(due.id);
    await prisma.job.update({ where: { id: due.id }, data: { status: 'PROCESSING' } });

    runProcessorFor(type, runtime, due.id, due.payload as Record<string, unknown>, due.attempts, due.maxAttempts)
      .finally(() => {
        runtime.running.delete(due.id);
        void tick(type);
      });
  }
}

async function runProcessorFor(
  type: JobType,
  runtime: QueueRuntime,
  jobId: string,
  payload: Record<string, unknown>,
  priorAttempts: number,
  maxAttempts: number,
): Promise<void> {
  const attempt = priorAttempts + 1;
  try {
    const result = await runtime.processor(payload);
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', result: (result ?? {}) as unknown as object, attempts: attempt, completedAt: new Date(), error: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt < maxAttempts) {
      const delayMs = computeBackoffMs(attempt - 1);
      logger.warn(`Job ${jobId} (${type}) failed on attempt ${attempt}/${maxAttempts}, retrying in ${delayMs}ms`, { error: message });
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'PENDING', attempts: attempt, error: message, nextAttemptAt: new Date(Date.now() + delayMs) },
      });
    } else {
      logger.error(`Job ${jobId} (${type}) failed permanently after ${attempt} attempts`, { error: message });
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'FAILED', attempts: attempt, error: message, completedAt: new Date() },
      });
    }
  }
}

export async function getJob(id: string) {
  return prisma.job.findUnique({ where: { id } });
}

export async function listJobs(params: { type?: JobType; status?: JobStatus; page: number; limit: number }) {
  const skip = (params.page - 1) * params.limit;
  const where = {
    ...(params.type ? { type: params.type } : {}),
    ...(params.status ? { status: params.status } : {}),
  };
  const [jobs, total] = await Promise.all([
    prisma.job.findMany({ where, skip, take: params.limit, orderBy: { createdAt: 'desc' } }),
    prisma.job.count({ where }),
  ]);
  return { jobs, total };
}

/** Manually retries a FAILED job — resets attempts so it gets the full retry budget again, matching "someone looked at it and wants to try again" rather than "the automatic backoff continuing." */
export async function retryJob(id: string): Promise<{ id: string; status: JobStatus } | null> {
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job || job.status !== 'FAILED') return null;
  const updated = await prisma.job.update({
    where: { id },
    data: { status: 'PENDING', attempts: 0, error: null, nextAttemptAt: new Date() },
  });
  void tick(job.type as JobType);
  return { id: updated.id, status: updated.status as JobStatus };
}

export async function getQueueStats(type: JobType): Promise<Record<JobStatus, number>> {
  const rows = await prisma.job.groupBy({ by: ['status'], where: { type }, _count: { status: true } });
  const counts = new Map(rows.map((r) => [r.status, r._count.status]));
  return {
    PENDING: counts.get('PENDING') ?? 0,
    PROCESSING: counts.get('PROCESSING') ?? 0,
    COMPLETED: counts.get('COMPLETED') ?? 0,
    FAILED: counts.get('FAILED') ?? 0,
  };
}