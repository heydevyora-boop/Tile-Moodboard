import 'tsconfig-paths/register';
import { GeminiClient, GeminiError } from '../src/services/gemini.service';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`OK   ${label}`);
    pass++;
  } else {
    console.log(`FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '');
    fail++;
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function geminiSuccessBody(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
}

async function main() {
  {
    let fetchCalls = 0;
    const client = new GeminiClient(async () => {
      fetchCalls++;
      return jsonResponse(200, geminiSuccessBody('should not get here'));
    }, 'fake-key-for-tests');
    check('1. isConfigured() is true when an API key is provided', await client.isConfigured());
    void fetchCalls;
  }

  {
    let calls = 0;
    const client = new GeminiClient(async () => {
      calls++;
      return jsonResponse(200, geminiSuccessBody('Hello from Gemini'));
    }, 'fake-key-for-tests');
    const result = await client.generateContent('test prompt');
    check('2a. Successful call returns the generated text', result.text === 'Hello from Gemini', result);
    check('2b. Only called fetch once (no unnecessary retries)', calls === 1, calls);
    check('2c. Usage metadata parsed correctly', result.usage?.totalTokens === 15, result.usage);
  }

  {
    let calls = 0;
    const client = new GeminiClient(async () => {
      calls++;
      if (calls < 3) return jsonResponse(503, { error: { message: 'Service temporarily unavailable' } });
      return jsonResponse(200, geminiSuccessBody('Succeeded on 3rd try'));
    }, 'fake-key-for-tests');
    const result = await client.generateContent('test prompt');
    check('3a. Eventually succeeds after retries', result.text === 'Succeeded on 3rd try', result);
    check('3b. Took exactly 3 attempts', calls === 3, calls);
  }

  {
    let calls = 0;
    const client = new GeminiClient(async () => {
      calls++;
      return jsonResponse(400, { error: { message: 'Invalid request format' } });
    }, 'fake-key-for-tests');
    let threw: unknown = null;
    try {
      await client.generateContent('test prompt');
    } catch (err) {
      threw = err;
    }
    check('4a. Throws a GeminiError', threw instanceof GeminiError);
    check('4b. Error is marked non-retryable', threw instanceof GeminiError && threw.retryable === false, threw);
    check('4c. Only called fetch ONCE — no retries wasted on a permanent error', calls === 1, calls);
  }

  {
    let calls = 0;
    const client = new GeminiClient(async () => {
      calls++;
      return jsonResponse(401, { error: { message: 'API key invalid' } });
    }, 'fake-key-for-tests');
    let threw: unknown = null;
    try {
      await client.generateContent('test prompt');
    } catch (err) {
      threw = err;
    }
    check('5a. 401 throws non-retryable GeminiError', threw instanceof GeminiError && !threw.retryable, threw);
    check('5b. Only one attempt made', calls === 1, calls);
  }

  {
    let calls = 0;
    const client = new GeminiClient(async () => {
      calls++;
      return jsonResponse(503, { error: { message: 'Always fails' } });
    }, 'fake-key-for-tests');
    let threw: unknown = null;
    try {
      await client.generateContent('test prompt');
    } catch (err) {
      threw = err;
    }
    check('6a. Eventually throws after exhausting retries', threw instanceof GeminiError, threw);
    check('6b. Made exactly maxRetries+1 attempts', calls === 4, calls);
  }

  {
    let calls = 0;
    const timestamps: number[] = [];
    const client = new GeminiClient(async () => {
      calls++;
      timestamps.push(Date.now());
      if (calls === 1) return jsonResponse(429, { error: { message: 'Rate limited' } }, { 'retry-after': '1' });
      return jsonResponse(200, geminiSuccessBody('Recovered after rate limit'));
    }, 'fake-key-for-tests');
    const result = await client.generateContent('test prompt');
    check('7a. Recovers after a 429', result.text === 'Recovered after rate limit', result);
    check('7b. Two attempts made', calls === 2, calls);
    const gapMs = timestamps[1] - timestamps[0];
    check('7c. Honored the Retry-After header (~1000ms gap, not the default backoff)', gapMs >= 950 && gapMs <= 1400, gapMs);
  }

  {
    const client = new GeminiClient(async () => jsonResponse(200, geminiSuccessBody('{"board_name":"Luxury Bath","tiles":["a","b"]}')), 'fake-key-for-tests');
    const parsed = await client.generateJSON<{ board_name: string; tiles: string[] }>('generate a mood board');
    check('8. generateJSON() parses structured output correctly', parsed.board_name === 'Luxury Bath' && parsed.tiles.length === 2, parsed);
  }

  {
    const client = new GeminiClient(async () => jsonResponse(200, geminiSuccessBody('this is not json{{{')), 'fake-key-for-tests');
    let threw: unknown = null;
    try {
      await client.generateJSON('generate a mood board');
    } catch (err) {
      threw = err;
    }
    check('9. generateJSON() throws GeminiError on malformed JSON', threw instanceof GeminiError, threw);
  }

  {
    let calls = 0;
    const client = new GeminiClient(async () => {
      calls++;
      return jsonResponse(200, { candidates: [] });
    }, 'fake-key-for-tests');
    let threw: unknown = null;
    try {
      await client.generateContent('test prompt');
    } catch (err) {
      threw = err;
    }
    check('10a. Empty candidates throws GeminiError', threw instanceof GeminiError, threw);
    check('10b. Not retried (permanent)', calls === 1, calls);
  }

  {
    let calls = 0;
    const client = new GeminiClient(async () => {
      calls++;
      if (calls < 2) throw new Error('ECONNRESET');
      return jsonResponse(200, geminiSuccessBody('Recovered from network error'));
    }, 'fake-key-for-tests');
    const result = await client.generateContent('test prompt');
    check('11. Recovers from a raw network error via retry', result.text === 'Recovered from network error', result);
  }

  {
    const okClient = new GeminiClient(async () => jsonResponse(200, geminiSuccessBody('OK')), 'fake-key-for-tests');
    const okResult = await okClient.testConnection();
    check('12a. testConnection() reports ok:true on success', okResult.ok === true && typeof okResult.latencyMs === 'number', okResult);

    const failClient = new GeminiClient(async () => jsonResponse(400, { error: { message: 'bad key' } }), 'fake-key-for-tests');
    const failResult = await failClient.testConnection();
    check('12b. testConnection() reports ok:false on failure, with a message', failResult.ok === false && !!failResult.message, failResult);
  }

  // ---- 13. Not configured (no API key): fails immediately, zero fetch calls ----
  {
    let fetchCalls = 0;
    // Passing `null` explicitly overrides to "no key," independent of whatever GEMINI_API_KEY happens to be in .env —
    // this is what makes it safe to run this check in the same process/run as the "configured" tests above.
    const client = new GeminiClient(async () => {
      fetchCalls++;
      throw new Error('should never be called');
    }, null);

    let threw: unknown = null;
    try {
      await client.generateContent('test prompt');
    } catch (err) {
      threw = err;
    }

    check('13a. isConfigured() is false with no key', !(await client.isConfigured()));
    check('13b. Fails fast with a clear "not configured" message', threw instanceof Error && /not configured/i.test(threw.message), threw);
    check('13c. Zero fetch calls attempted', fetchCalls === 0, fetchCalls);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
