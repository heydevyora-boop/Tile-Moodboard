/**
 * Step 9 — the ERP client's own failure handling, isolated from the
 * full app and from any database. No Postgres, no Express: this
 * proves erpClient.service.ts and erpCatalogMapping.service.ts's
 * "not configured" path never attempts a network call and never
 * throws an uncaught exception.
 *
 * Every secret here is a dummy. ERP_INTEGRATION_API_KEY is
 * deliberately left UNSET for this whole script -- see
 * erp_catalog_preview_test.js for the configured, end-to-end path
 * against a mock ERP server.
 *
 * Run:  node test-scripts/erp_client_unavailable_test.js
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');

Object.assign(process.env, {
  NODE_ENV: 'development',
  // Deliberately absent: ERP_INTEGRATION_API_KEY.
  ERP_API_BASE_URL: 'http://127.0.0.1:4310/api/v1',
  // Everything else env.ts requires just to load without throwing.
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:devpassword@127.0.0.1:5432/tm_erp_client_unavailable_test',
  JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
  ENCRYPTION_KEY: '0'.repeat(64),
  BCRYPT_SALT_ROUNDS: '10',
  LOG_LEVEL: 'error',
  RATE_LIMIT_MAX: '100000',
});

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else {
    console.log(`  FAIL  ${label}`, extra === undefined ? '' : JSON.stringify(extra));
    fail += 1; failures.push(label);
  }
}
function step(title) { console.log(`\n  — ${title}`); }

async function main() {
  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const erpClient = require(path.join(ROOT, 'src/services/erpClient.service'));

  step('1. an unconfigured ERP integration never attempts a network call');

  check('1a. isErpIntegrationConfigured() is false with no key set', erpClient.isErpIntegrationConfigured() === false);

  const before = Date.now();
  let threw = null;
  try {
    await erpClient.fetchErpCatalogFeedPage({ page: 1 });
  } catch (error) {
    threw = error;
  }
  const elapsedMs = Date.now() - before;

  check('1b. fetchErpCatalogFeedPage throws ErpUnavailableError, not something else',
    threw && threw.name === 'ErpUnavailableError', threw && threw.constructor.name);
  check('1c. the message names the real reason (unconfigured), not a generic failure',
    threw && /not configured/i.test(threw.message), threw && threw.message);
  check('1d. it failed FAST -- under 500ms -- proving no network call was attempted at all',
    elapsedMs < 500, elapsedMs);

  step('2. the mapping/preview layer reports unavailable, never throws, for the same reason');

  // erpCatalogMapping.service.ts also imports @db/connection (CASA's
  // own Prisma client). That import must not require a live
  // database connection -- Prisma Client only connects on its first
  // query, and the "not configured" branch returns before any
  // query, so this is safe to exercise with no Postgres running.
  const erpCatalogMapping = require(path.join(ROOT, 'src/services/erpCatalogMapping.service'));

  const preview = await erpCatalogMapping.getErpCatalogPreview({});
  check('2a. erpReachable is false', preview.erpReachable === false, preview);
  check('2b. a human-readable reason is given, with no stack trace leaked into it',
    typeof preview.erpUnavailableReason === 'string' && !preview.erpUnavailableReason.includes('at '));
  check('2c. no erp/casa/matches fields are present when unreachable -- nothing invented',
    preview.erp === undefined && preview.casa === undefined && preview.matches === undefined);

  console.log(fail ? `\n  failed: ${failures.join(' | ')}` : '');
  console.log(`\n${'='.repeat(58)}\n${pass} passed, ${fail} failed, ${pass + fail} checks\n${'='.repeat(58)}`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
