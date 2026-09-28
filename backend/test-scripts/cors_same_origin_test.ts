/**
 * Regression: a same-origin request must never be blocked by CORS.
 *
 * THE FAILURE THIS COVERS
 * -----------------------
 * vercel.json serves the static frontend AND routes /api/v1/* to this
 * backend from the SAME Vercel deployment domain. A frontend page on
 * that domain calling its own API is therefore always same-origin --
 * its Origin header's host equals the request's own Host.
 *
 * The CORS middleware only allowed origins listed in CORS_ORIGINS,
 * which has to be set by hand per deployment. Vercel preview
 * deployments get a fresh random subdomain every time
 * (casa-de-aurum-<hash>-devyora.vercel.app), so the allowlist can never
 * stay in sync -- every preview's own login page got rejected with
 * "Origin ... is not allowed by CORS" (403), even though the request
 * never left that deployment's own domain.
 *
 * WHAT THIS TEST ACTUALLY CHECKS
 * ------------------------------
 * The real createApp(), listening on a real port, hit with real HTTP
 * requests carrying an explicit Origin header -- this is a browser-level
 * concern, so a unit test calling the middleware function directly
 * would not prove the header comparison happens against the actual
 * request the server receives.
 *
 * Run:  npx ts-node -r tsconfig-paths/register \
 *         test-scripts/cors_same_origin_test.ts
 */

import http from 'http';
import { createApp } from '../src/app';

const results: Array<[string, boolean, string]> = [];

function check(label: string, ok: boolean, detail = '') {
  results.push([label, Boolean(ok), detail]);
}

function request(port: number, origin: string | null, host: string): Promise<{ status: number; allowOrigin?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/health',
        method: 'GET',
        headers: {
          host,
          ...(origin ? { origin } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            allowOrigin: res.headers['access-control-allow-origin'] as string | undefined,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  // A preview deployment's own random subdomain, calling its own API --
  // same-origin, and NOT in CORS_ORIGINS (which defaults to
  // http://localhost:3000 and can't predict a random hash).
  const previewHost = 'casa-de-aurum-f1kb0gm09-devyora.vercel.app';
  const sameOrigin = await request(port, `https://${previewHost}`, previewHost);
  check(
    'a same-origin request from an unlisted preview domain is allowed (not 403)',
    sameOrigin.status !== 403,
    `status=${sameOrigin.status}`,
  );
  check(
    'the response reflects that origin back',
    sameOrigin.allowOrigin === `https://${previewHost}`,
    `Access-Control-Allow-Origin=${sameOrigin.allowOrigin}`,
  );

  // A genuinely different origin, not in the allowlist, must still be
  // rejected -- the fix must not have turned CORS off entirely.
  const crossOrigin = await request(port, 'https://evil.example.com', previewHost);
  check(
    'a cross-origin request from an unrelated domain is still rejected',
    crossOrigin.status === 403,
    `status=${crossOrigin.status}`,
  );

  // No Origin header at all (curl, server-to-server, same-tab navigation)
  // must still be allowed, as before.
  const noOrigin = await request(port, null, previewHost);
  check(
    'a request with no Origin header is still allowed',
    noOrigin.status !== 403,
    `status=${noOrigin.status}`,
  );

  server.close();

  let failures = 0;
  for (const [label, ok, detail] of results) {
    if (ok) {
      console.log(`  PASS  ${label}`);
    } else {
      failures += 1;
      console.log(`  FAIL  ${label}${detail ? `  [${detail}]` : ''}`);
    }
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
