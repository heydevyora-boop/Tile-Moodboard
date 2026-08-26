const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`OK   ${label}`); pass++; }
  else { console.log(`FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : ''); fail++; }
}

const backendDir = path.join(__dirname, '..');
const rootDir = path.join(backendDir, '..');

console.log('--- Prisma schema ---');

const schema = fs.readFileSync(path.join(backendDir, 'prisma', 'schema.prisma'), 'utf8');
check('1a. schema.prisma declares directUrl on the datasource block', /directUrl\s*=\s*env\("DIRECT_URL"\)/.test(schema), 'directUrl line missing');
check('1b. DATABASE_URL is still the primary url', /url\s*=\s*env\("DATABASE_URL"\)/.test(schema));
check('1c. No Postgres extensions or native-db-specific features that a hosted provider might not have enabled', !/@db\.|extensions\s*=/.test(schema));

console.log('\n--- Env templates ---');

const envExample = fs.readFileSync(path.join(backendDir, '.env.example'), 'utf8');
check('2a. .env.example sets DIRECT_URL (Prisma requires it to be present, even for plain local Postgres)', /^DIRECT_URL=/m.test(envExample));

const envProdExample = fs.readFileSync(path.join(backendDir, '.env.production.example'), 'utf8');
check('3a. .env.production.example documents the pooled DATABASE_URL for Supabase', /pooler\.supabase\.com:6543/.test(envProdExample));
check('3b. .env.production.example documents the direct DIRECT_URL for Supabase', /pooler\.supabase\.com:5432|db\.<project-ref>\.supabase\.co/.test(envProdExample));
check('3c. Both Supabase examples require sslmode=require', (envProdExample.match(/supabase\.com[^\n]*sslmode=require/g) || []).length >= 1);
check('3d. The pooled connection string disables prepared statements (pgbouncer=true) — required for pgbouncer transaction mode', /pgbouncer=true/.test(envProdExample));

console.log('\n--- Docker entrypoint ---');

const entrypoint = fs.readFileSync(path.join(backendDir, 'docker-entrypoint.sh'), 'utf8');
check('4. docker-entrypoint.sh falls back DIRECT_URL to DATABASE_URL when unset, before running migrations', /DIRECT_URL="\$\{DIRECT_URL:-\$DATABASE_URL\}"/.test(entrypoint) && entrypoint.indexOf('DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"') < entrypoint.indexOf('migrate deploy'));

console.log('\n--- Docker Compose ---');

const compose = fs.readFileSync(path.join(rootDir, 'docker-compose.yml'), 'utf8');
check('5a. The base compose file does not hardcode DATABASE_URL/DIRECT_URL to the local postgres service (that would silently break Supabase usage)', !/DATABASE_URL:\s*postgresql/.test(compose));
check('5b. The backend service reads its config via env_file (backend/.env) so whatever is configured there is respected', /env_file:\s*\n\s*-\s*\.\/backend\/\.env/.test(compose));

const supabaseOverride = fs.readFileSync(path.join(rootDir, 'docker-compose.supabase.yml'), 'utf8');
check('6a. docker-compose.supabase.yml exists with the expected structure', supabaseOverride.includes('services:') && supabaseOverride.includes('backend:'));
check('6b. It removes the backend->postgres dependency so the local container is never started when using Supabase', /depends_on:\s*\{\}/.test(supabaseOverride));

console.log('\n--- DEPLOYMENT.md ---');

const deploymentDoc = fs.readFileSync(path.join(rootDir, 'DEPLOYMENT.md'), 'utf8');
check('7a. DEPLOYMENT.md has a real Using Supabase section, not just a passing mention', /## Using Supabase/.test(deploymentDoc));
check('7b. It documents the docker-compose.supabase.yml override command', /docker-compose\.supabase\.yml/.test(deploymentDoc));
check('7c. It explains why DATABASE_URL and DIRECT_URL differ for Supabase (pooler vs direct)', /pooler/i.test(deploymentDoc) && /direct/i.test(deploymentDoc));
check("7d. It correctly notes that Row Level Security is not relevant to this app's Prisma-based access pattern", /Row Level Security/i.test(deploymentDoc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
