import { config } from '@config/index';
import { logger } from '@utils/logger';
import { AppError } from '@utils/AppError';
import { retryWithBackoff } from '@utils/retry';
import { resolveActiveKeyValue } from './apiKey.service';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Distinguishes retryable failures (rate limits, transient server errors,
 * timeouts) from permanent ones (bad request, bad API key, model not
 * found) so the retry mechanism only retries what's actually worth
 * retrying — hammering a 401 four times wastes time and still fails.
 */
export class GeminiError extends AppError {
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;

  constructor(message: string, statusCode: number, retryable: boolean, retryAfterMs?: number) {
    super(message, statusCode);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface GenerateContentOptions {
  temperature?: number;
  maxOutputTokens?: number;
  /** 'application/json' asks Gemini to constrain output to valid JSON — used by generateJSON(). */
  responseMimeType?: 'text/plain' | 'application/json';
  systemInstruction?: string;
}

export interface GeminiUsage {
  promptTokens?: number;
  candidateTokens?: number;
  totalTokens?: number;
}

export interface GenerateContentResult {
  text: string;
  finishReason?: string;
  usage?: GeminiUsage;
  raw: unknown;
}

interface GeminiApiErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

/** Minimal fetch-compatible signature — lets tests inject a fake transport without touching the real network. */
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class GeminiClient {
  /**
   * apiKeyOverride lets tests exercise both the configured and
   * unconfigured paths in the same process without depending on ambient
   * .env state (which can't represent both "key set" and "key unset"
   * simultaneously). Production code should never pass this — it exists
   * for testability, not for per-request key rotation.
   */
  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly apiKeyOverride?: string | null) {}

  /**
   * Resolves the actual key to use: test override > an active DB-stored
   * key (Module 21 — lets an Owner rotate the key from the admin UI
   * without touching .env or restarting the process) > the env-config
   * fallback. The DB lookup happens on every call rather than being
   * cached, which is the right tradeoff for an internal tool making at
   * most a few dozen Gemini calls a day — correctness (a just-rotated
   * key takes effect immediately) matters more here than shaving off one
   * query per generation.
   */
  private async resolveApiKey(): Promise<string | undefined> {
    if (this.apiKeyOverride !== undefined) return this.apiKeyOverride ?? undefined;
    const stored = await resolveActiveKeyValue('GEMINI');
    return stored ?? config.gemini.apiKey;
  }

  async isConfigured(): Promise<boolean> {
    return !!(await this.resolveApiKey());
  }

  private buildUrl(): string {
    return `${GEMINI_API_BASE}/models/${config.gemini.model}:generateContent`;
  }

  /**
   * Maps an HTTP status + Gemini's error body into a GeminiError with the
   * correct retryable flag. This is the single place that decides "is
   * this worth retrying" — everything else just consults .retryable.
   */
  private classifyError(status: number, body: GeminiApiErrorBody, retryAfterHeader: string | null): GeminiError {
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
      return new GeminiError(`Gemini model not found ("${config.gemini.model}"): ${message}`, 404, false);
    }
    return new GeminiError(`Gemini request rejected: ${message}`, 400, false);
  }

  private async callOnce(prompt: string, options: GenerateContentOptions, apiKey: string): Promise<GenerateContentResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.gemini.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.buildUrl()}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: options.temperature ?? config.gemini.temperature,
            maxOutputTokens: options.maxOutputTokens ?? config.gemini.maxOutputTokens,
            responseMimeType: options.responseMimeType ?? 'text/plain',
          },
          ...(options.systemInstruction
            ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
            : {}),
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      throw new GeminiError(
        isAbort ? `Gemini request timed out after ${config.gemini.timeoutMs}ms` : `Gemini request failed: ${(err as Error).message}`,
        isAbort ? 504 : 502,
        true,
      );
    }
    clearTimeout(timer);

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw this.classifyError(res.status, body as GeminiApiErrorBody, res.headers.get('retry-after'));
    }

    const candidate = (body as { candidates?: Array<{ content?: { parts?: { text?: string }[] }; finishReason?: string }> }).candidates?.[0];
    if (!candidate) {
      throw new GeminiError('Gemini returned no candidates (likely blocked by safety filters)', 502, false);
    }

    const text = candidate.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const usageMetadata = (body as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }).usageMetadata;

    return {
      text,
      finishReason: candidate.finishReason,
      usage: usageMetadata
        ? { promptTokens: usageMetadata.promptTokenCount, candidateTokens: usageMetadata.candidatesTokenCount, totalTokens: usageMetadata.totalTokenCount }
        : undefined,
      raw: body,
    };
  }

  /**
   * Generates content from a single text prompt, retrying transient
   * failures with exponential backoff (honoring a Retry-After header
   * when Gemini sends one) and failing fast on permanent errors.
   */
  async generateContent(prompt: string, options: GenerateContentOptions = {}): Promise<GenerateContentResult> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      throw AppError.internal('Gemini API key is not configured (set GEMINI_API_KEY or add one in Admin > API Keys)');
    }

    return retryWithBackoff(() => this.callOnce(prompt, options, apiKey), {
      maxRetries: config.gemini.maxRetries,
      baseDelayMs: config.gemini.retryBaseDelayMs,
      isRetryable: (err) => err instanceof GeminiError && err.retryable,
      getRetryDelayOverrideMs: (err) => (err instanceof GeminiError ? err.retryAfterMs : undefined),
      onRetry: (attempt, err, delay) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Gemini request retry ${attempt}/${config.gemini.maxRetries} after ${delay}ms: ${message}`);
      },
    });
  }

  /** Convenience wrapper for structured output — parses the JSON Gemini was asked to return. */
  async generateJSON<T>(prompt: string, options: Omit<GenerateContentOptions, 'responseMimeType'> = {}): Promise<T> {
    const result = await this.generateContent(prompt, { ...options, responseMimeType: 'application/json' });
    try {
      return JSON.parse(result.text) as T;
    } catch {
      throw new GeminiError(`Gemini's response was not valid JSON: ${result.text.slice(0, 300)}`, 502, false);
    }
  }

  /** Lightweight live connectivity check — used by the admin integrations status endpoint. */
  async testConnection(): Promise<{ ok: boolean; model: string; latencyMs: number; message?: string }> {
    const start = Date.now();
    if (!(await this.isConfigured())) {
      return { ok: false, model: config.gemini.model, latencyMs: 0, message: 'GEMINI_API_KEY is not set' };
    }
    try {
      await this.generateContent('Reply with exactly one word: OK', { maxOutputTokens: 8 });
      return { ok: true, model: config.gemini.model, latencyMs: Date.now() - start };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, model: config.gemini.model, latencyMs: Date.now() - start, message };
    }
  }
}

export const geminiClient = new GeminiClient();
