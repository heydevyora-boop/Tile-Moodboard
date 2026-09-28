"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.geminiClient = exports.GeminiClient = exports.GeminiError = void 0;
const index_1 = require("@config/index");
const logger_1 = require("@utils/logger");
const AppError_1 = require("@utils/AppError");
const retry_1 = require("@utils/retry");
const apiKey_service_1 = require("./apiKey.service");
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
class GeminiError extends AppError_1.AppError {
    constructor(message, statusCode, retryable, retryAfterMs) {
        super(message, statusCode);
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
    }
}
exports.GeminiError = GeminiError;
class GeminiClient {
    constructor(fetchImpl = fetch, apiKeyOverride) {
        this.fetchImpl = fetchImpl;
        this.apiKeyOverride = apiKeyOverride;
    }
    async resolveApiKey() {
        if (this.apiKeyOverride !== undefined)
            return this.apiKeyOverride ?? undefined;
        const stored = await (0, apiKey_service_1.resolveActiveKeyValue)('GEMINI');
        return stored ?? index_1.config.gemini.apiKey;
    }
    async isConfigured() {
        return !!(await this.resolveApiKey());
    }
    buildUrl() {
        return `${GEMINI_API_BASE}/models/${index_1.config.gemini.model}:generateContent`;
    }
    classifyError(status, body, retryAfterHeader) {
        const message = body.error?.message || `Gemini API request failed with status ${status}`;
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
        if (status === 429) {
            return new GeminiError(`Gemini rate limit exceeded: ${message}`, 429, true, retryAfterMs);
        }
        if (status >= 500) {
            return new GeminiError(`Gemini server error: ${message}`, 502, true, retryAfterMs);
        }
        if (status === 401 || status === 403) {
            return new GeminiError(`Gemini authentication failed — check GEMINI_API_KEY: ${message}`, status, false);
        }
        if (status === 404) {
            return new GeminiError(`Gemini model not found ("${index_1.config.gemini.model}"): ${message}`, 404, false);
        }
        return new GeminiError(`Gemini request rejected: ${message}`, 400, false);
    }
    async callOnce(prompt, options, apiKey) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), index_1.config.gemini.timeoutMs);
        let res;
        try {
            res = await this.fetchImpl(`${this.buildUrl()}?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: options.temperature ?? index_1.config.gemini.temperature,
                        maxOutputTokens: options.maxOutputTokens ?? index_1.config.gemini.maxOutputTokens,
                        responseMimeType: options.responseMimeType ?? 'text/plain',
                    },
                    ...(options.systemInstruction
                        ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
                        : {}),
                }),
            });
        }
        catch (err) {
            clearTimeout(timer);
            const isAbort = err instanceof Error && err.name === 'AbortError';
            throw new GeminiError(isAbort ? `Gemini request timed out after ${index_1.config.gemini.timeoutMs}ms` : `Gemini request failed: ${err.message}`, isAbort ? 504 : 502, true);
        }
        clearTimeout(timer);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw this.classifyError(res.status, body, res.headers.get('retry-after'));
        }
        const candidate = body.candidates?.[0];
        if (!candidate) {
            throw new GeminiError('Gemini returned no candidates (likely blocked by safety filters)', 502, false);
        }
        const text = candidate.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        const usageMetadata = body.usageMetadata;
        return {
            text,
            finishReason: candidate.finishReason,
            usage: usageMetadata
                ? { promptTokens: usageMetadata.promptTokenCount, candidateTokens: usageMetadata.candidatesTokenCount, totalTokens: usageMetadata.totalTokenCount }
                : undefined,
            raw: body,
        };
    }
    async generateContent(prompt, options = {}) {
        const apiKey = await this.resolveApiKey();
        if (!apiKey) {
            throw AppError_1.AppError.internal('Gemini API key is not configured (set GEMINI_API_KEY or add one in Admin > API Keys)');
        }
        return (0, retry_1.retryWithBackoff)(() => this.callOnce(prompt, options, apiKey), {
            maxRetries: index_1.config.gemini.maxRetries,
            baseDelayMs: index_1.config.gemini.retryBaseDelayMs,
            isRetryable: (err) => err instanceof GeminiError && err.retryable,
            getRetryDelayOverrideMs: (err) => (err instanceof GeminiError ? err.retryAfterMs : undefined),
            onRetry: (attempt, err, delay) => {
                const message = err instanceof Error ? err.message : String(err);
                logger_1.logger.warn(`Gemini request retry ${attempt}/${index_1.config.gemini.maxRetries} after ${delay}ms: ${message}`);
            },
        });
    }
    async generateJSON(prompt, options = {}) {
        const result = await this.generateContent(prompt, { ...options, responseMimeType: 'application/json' });
        try {
            return JSON.parse(result.text);
        }
        catch {
            throw new GeminiError(`Gemini's response was not valid JSON: ${result.text.slice(0, 300)}`, 502, false);
        }
    }
    async testConnection() {
        const start = Date.now();
        if (!(await this.isConfigured())) {
            return { ok: false, model: index_1.config.gemini.model, latencyMs: 0, message: 'GEMINI_API_KEY is not set' };
        }
        try {
            await this.generateContent('Reply with exactly one word: OK', { maxOutputTokens: 8 });
            return { ok: true, model: index_1.config.gemini.model, latencyMs: Date.now() - start };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, model: index_1.config.gemini.model, latencyMs: Date.now() - start, message };
        }
    }
}
exports.GeminiClient = GeminiClient;
exports.geminiClient = new GeminiClient();
//# sourceMappingURL=gemini.service.js.map