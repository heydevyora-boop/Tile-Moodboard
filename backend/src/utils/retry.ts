export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Decides whether a given error should trigger a retry at all. */
  isRetryable: (error: unknown) => boolean;
  /**
   * Lets a caught error override the computed backoff delay for the next
   * attempt (e.g. an API's Retry-After header) — returning undefined
   * falls back to the normal exponential-backoff-with-jitter calculation.
   */
  getRetryDelayOverrideMs?: (error: unknown) => number | undefined;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with +/-50% jitter, capped at maxDelayMs. */
function computeBackoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const raw = baseDelayMs * 2 ** attempt;
  const jittered = raw * (0.5 + Math.random() * 0.5);
  return Math.min(maxDelayMs, Math.round(jittered));
}

/**
 * Runs `fn`, retrying on failure per `options`. Attempt 0 is the first
 * real call — "maxRetries: 3" means up to 4 total attempts (1 initial +
 * 3 retries), which matches how most people mean "retry 3 times."
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isLastAttempt = attempt === options.maxRetries;
      if (isLastAttempt || !options.isRetryable(err)) {
        throw err;
      }

      const override = options.getRetryDelayOverrideMs?.(err);
      const delay = override ?? computeBackoffDelay(attempt, options.baseDelayMs, maxDelayMs);

      options.onRetry?.(attempt + 1, err, delay);
      await sleep(delay);
    }
  }

  // Unreachable — the loop always either returns or throws — but keeps TS happy.
  throw lastError;
}
