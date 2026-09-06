"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retryWithBackoff = retryWithBackoff;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function computeBackoffDelay(attempt, baseDelayMs, maxDelayMs) {
    const raw = baseDelayMs * 2 ** attempt;
    const jittered = raw * (0.5 + Math.random() * 0.5);
    return Math.min(maxDelayMs, Math.round(jittered));
}
async function retryWithBackoff(fn, options) {
    const maxDelayMs = options.maxDelayMs ?? 30000;
    let lastError;
    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
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
    throw lastError;
}
//# sourceMappingURL=retry.js.map