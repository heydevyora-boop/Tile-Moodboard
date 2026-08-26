import { logger } from '@utils/logger';

/**
 * A minimal in-process FIFO job queue for catalog extraction. No
 * Redis/BullMQ — this is a single-shop internal tool running one Node
 * process, so an in-memory queue is the right amount of infrastructure.
 * If this ever needs to survive a server restart or run across multiple
 * processes, that's the point to reach for a real job queue; until then
 * this is simpler to reason about and has nothing extra to deploy.
 */
class ExtractionQueue {
  private queue: string[] = [];
  private running = new Set<string>();
  private readonly maxConcurrent: number;
  private readonly processFn: (catalogId: string) => Promise<void>;

  constructor(maxConcurrent: number, processFn: (catalogId: string) => Promise<void>) {
    this.maxConcurrent = maxConcurrent;
    this.processFn = processFn;
  }

  enqueue(catalogId: string): void {
    this.queue.push(catalogId);
    logger.debug(`Catalog ${catalogId} enqueued for extraction (queue depth: ${this.queue.length})`);
    this.tick();
  }

  /** 1-based position in line, or 0 if already running, or -1 if not queued at all. */
  getPosition(catalogId: string): number {
    if (this.running.has(catalogId)) return 0;
    const idx = this.queue.indexOf(catalogId);
    return idx === -1 ? -1 : idx + 1;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  get runningCount(): number {
    return this.running.size;
  }

  private tick(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const catalogId = this.queue.shift();
      if (!catalogId) break;

      this.running.add(catalogId);
      this.processFn(catalogId)
        .catch((err: Error) => {
          logger.error(`Extraction queue: job for catalog ${catalogId} crashed`, { error: err.message });
        })
        .finally(() => {
          this.running.delete(catalogId);
          this.tick();
        });
    }
  }
}

let queueInstance: ExtractionQueue | null = null;

/**
 * Lazily constructed so the process function (which imports the Prisma
 * client etc.) is only wired up once something actually needs the queue,
 * avoiding import-order issues at module load time.
 */
export function getExtractionQueue(maxConcurrent: number, processFn: (catalogId: string) => Promise<void>): ExtractionQueue {
  if (!queueInstance) {
    queueInstance = new ExtractionQueue(maxConcurrent, processFn);
  }
  return queueInstance;
}
