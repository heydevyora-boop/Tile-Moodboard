import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ============================================================
   AN ISOLATED DATABASE FOR THE TESTS
   ============================================================
   The suite creates products, renames brands and archives rows.
   Run against the development database it leaves fixtures behind
   — which it did once: a twenty-rupee "Retired, nothing left"
   turned up in the Product Master looking like a real product.

   So the tests get their own database, built from the same
   migrations and the same seed. Nothing they do can reach the
   development data, and the name is checked before anything runs.
   ============================================================ */

const here = path.dirname(fileURLToPath(import.meta.url));
export const ERP_ROOT = path.resolve(here, '..', '..');

function readEnvFile(file) {
  try {
    const out = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Point this process at a test database, creating it if needed.
 *
 * MUST be called before anything imports db/client.mjs: that
 * module reads the URL once, at import time.
 */
export function useTestDatabase(name = 'devyora_erp_test') {
  // A belt-and-braces guard. The cost of this suite running
  // against the development or (worse) a real database is high
  // enough that the name is checked rather than assumed.
  if (!/test/i.test(name)) {
    throw new Error('Refusing to run tests against "' + name + '": the name must contain "test".');
  }

  // Derived from whatever already works on this machine — host,
  // port and credentials are reused, only the database differs.
  const base = process.env.ERP_DATABASE_URL
    ?? readEnvFile(path.join(ERP_ROOT, '.env')).ERP_DATABASE_URL;
  if (!base) {
    throw new Error('ERP_DATABASE_URL is not set, so a test database cannot be derived from it.');
  }

  const url = new URL(base);
  url.pathname = '/' + name;

  const admin = new URL(base);
  admin.pathname = '/postgres';

  try {
    const exists = execSync(
      'psql "' + admin.toString() + '" -tAc "SELECT 1 FROM pg_database WHERE datname=\'' + name + '\'"',
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    if (exists !== '1') {
      execSync('psql "' + admin.toString() + '" -qc "CREATE DATABASE ' + name + '"', { stdio: 'pipe' });
    }
  } catch {
    // psql may not be on PATH. migrate deploy will then fail with
    // a clearer message than anything invented here.
  }

  process.env.ERP_DATABASE_URL = url.toString();
  return url.toString();
}

/** Bring the test database up to the current migrations. */
export function migrate() {
  execSync('npx prisma migrate deploy', { cwd: ERP_ROOT, stdio: 'pipe', env: { ...process.env } });
}

/** Seed it with the project's own seed, so the two cannot drift. */
export function seed() {
  execSync('node prisma/seed.mjs', { cwd: ERP_ROOT, stdio: 'pipe', env: { ...process.env } });
}
