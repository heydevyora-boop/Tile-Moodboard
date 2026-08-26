const path = require('path');
process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'tsconfig.json');
require('tsconfig-paths/register');
require('ts-node/register');

async function main() {
  let pass = 0, fail = 0;
  function check(label, cond, extra) { if (cond) { console.log(`OK   ${label}`); pass++; } else { console.log(`FAIL ${label}`, JSON.stringify(extra)); fail++; } }

  const { openApiDocument } = require('../src/docs/openapi');
  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

  console.log('--- Spec structure ---');

  check('1a. openapi version is 3.0.x', openApiDocument.openapi.startsWith('3.0'), openApiDocument.openapi);
  check('1b. Has a title and description', !!openApiDocument.info.title && openApiDocument.info.description.length > 100, { title: openApiDocument.info.title, descLen: openApiDocument.info.description.length });
  check('1c. Documents an authentication flow in the description (getting a token, refreshing it)', openApiDocument.info.description.includes('/auth/login') && openApiDocument.info.description.includes('/auth/refresh'), 'auth flow text missing');
  check('1d. Defines a bearerAuth security scheme', openApiDocument.components.securitySchemes?.bearerAuth?.scheme === 'bearer', openApiDocument.components.securitySchemes);

  let totalOps = 0;
  for (const methodsObj of Object.values(openApiDocument.paths)) {
    for (const m of METHODS) if (methodsObj[m]) totalOps++;
  }
  check('2. At least 95 real operations are documented (covers essentially the whole route surface, not a handful of samples)', totalOps >= 95, totalOps);

  console.log('\n--- Every documented operation is genuinely complete, not a stub ---');

  const missing = [];
  for (const [p, methodsObj] of Object.entries(openApiDocument.paths)) {
    for (const m of METHODS) {
      const op = methodsObj[m];
      if (!op) continue;
      if (!op.tags?.length) missing.push(`${p} ${m}: missing tags`);
      if (!op.summary) missing.push(`${p} ${m}: missing summary`);
      if (!op.responses || !Object.keys(op.responses).length) missing.push(`${p} ${m}: missing responses`);
      if (op.security === undefined) missing.push(`${p} ${m}: missing explicit security`);
    }
  }
  check('3. Every single operation has tags, a summary, at least one response, and explicit security (no silently-incomplete entries)', missing.length === 0, missing.slice(0, 10));

  console.log('\n--- No broken $ref pointers ---');

  const refs = new Set();
  function walk(obj) {
    if (obj && typeof obj === 'object') {
      if (obj.$ref) refs.add(obj.$ref);
      for (const v of Object.values(obj)) walk(v);
    }
  }
  walk(openApiDocument.paths);
  walk(openApiDocument.components.schemas);

  const broken = [...refs].filter((ref) => {
    const m = ref.match(/^#\/components\/schemas\/(.+)$/);
    return !m || !openApiDocument.components.schemas[m[1]];
  });
  check('4. Every $ref used across the spec resolves to a real schema component', broken.length === 0, broken);
  check('5. A meaningful number of shared schemas are actually referenced (not defined and unused)', refs.size >= 15, refs.size);

  console.log('\n--- Error documentation ---');

  const authLogin = openApiDocument.paths['/auth/login'].post;
  check('6a. Login documents its 401 (bad credentials) case', !!authLogin.responses[401], authLogin.responses);
  check('6b. Login documents its 429 (rate limit) case', !!authLogin.responses[429], authLogin.responses);

  const generate = openApiDocument.paths['/mood-boards/generate'].post;
  check('7. Mood board generation documents the 429 it can genuinely return (Module 24 rate limiter)', !!generate.responses[429], generate.responses);

  console.log('\n--- Docs endpoints actually work at runtime ---');

  const { createApp } = require('../src/app');
  const http = require('http');
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(4816, resolve));

  let res = await fetch('http://localhost:4816/api-docs.json');
  const spec = await res.json();
  check('8a. GET /api-docs.json returns 200 with the real spec', res.status === 200 && spec.info?.title === openApiDocument.info.title, res.status);
  check('8b. The served spec has the same operation count as the source document', (() => {
    let n = 0;
    for (const methodsObj of Object.values(spec.paths)) for (const m of METHODS) if (methodsObj[m]) n++;
    return n === totalOps;
  })());

  res = await fetch('http://localhost:4816/api-docs/');
  const html = await res.text();
  check('9a. GET /api-docs/ returns 200 and renders the real Swagger UI', res.status === 200 && html.includes('swagger-ui'), res.status);

  res = await fetch('http://localhost:4816/api-docs.json');
  check('10. The docs endpoints are reachable without an Authorization header (this IS the discovery entry point)', res.status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
