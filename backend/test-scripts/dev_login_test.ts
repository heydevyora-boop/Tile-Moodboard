/**
 * The temporary development login: what it allows, and what it cannot.
 *
 * A weak password is a reasonable convenience on a laptop and a real
 * danger on a public deployment, so the interesting assertions here are
 * the negative ones. The gate is NODE_ENV, read once in config, and
 * these drive the real config module in a fresh process for each
 * environment rather than reasoning about it.
 *
 * What is NOT changed, and is asserted: the password rules that protect
 * real accounts, and the fact that a password is still checked against
 * a stored bcrypt hash.
 *
 * Run:  npx ts-node -r tsconfig-paths/register test-scripts/dev_login_test.ts
 */

import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const results: Array<[string, boolean, string]> = [];

function check(label: string, ok: boolean, detail: unknown = '') {
  results.push([label, Boolean(ok), detail === '' ? '' : JSON.stringify(detail)]);
}

const ROOT = path.join(__dirname, '..');

/** Loads the real config in a separate process, under a given environment. */
function configUnder(vars: Record<string, string>): any {
  const script =
    "const { config } = require('./src/config');" +
    "process.stdout.write(JSON.stringify({ env: config.env, devLogin: config.devLogin }));";
  const out = execFileSync(
    'npx',
    ['ts-node', '-r', 'tsconfig-paths/register', '-e', script],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/db',
        JWT_SECRET: process.env.JWT_SECRET || 'test-jwt-secret-at-least-16',
        JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-16ch',
        ...vars,
      },
    },
  );
  return JSON.parse(out.slice(out.indexOf('{')));
}

function main(): number {
  // ----------------------------------------------------------------
  // IN PRODUCTION IT DOES NOT EXIST -- whatever is set.
  // ----------------------------------------------------------------
  const prod = configUnder({
    NODE_ENV: 'production',
    DEV_LOGIN_USERNAME: 'devyora',
    DEV_LOGIN_PASSWORD: '123',
  });
  check('1. production ignores the development login entirely',
    prod.devLogin === null, prod);
  check('2. ...even though both variables were set',
    prod.env === 'production' && prod.devLogin === null, prod.env);

  // ----------------------------------------------------------------
  // IN DEVELOPMENT it exists, but only when asked for.
  // ----------------------------------------------------------------
  const off = configUnder({ NODE_ENV: 'development' });
  check('3. a development machine that asked for nothing has no such login',
    off.devLogin === null, off);

  const dev = configUnder({
    NODE_ENV: 'development',
    DEV_LOGIN_USERNAME: 'devyora',
    DEV_LOGIN_PASSWORD: '123',
  });
  check('4. the configured username is accepted, lower-cased',
    dev.devLogin && dev.devLogin.username === 'devyora', dev.devLogin);
  check('5. ...and maps to an account address of its own',
    dev.devLogin.email === 'devyora@devyora.local', dev.devLogin.email);
  check('6. ...with a role the account is created under',
    dev.devLogin.role === 'OWNER', dev.devLogin.role);

  const named = configUnder({
    NODE_ENV: 'development',
    DEV_LOGIN_USERNAME: 'DeVyOrA',
    DEV_LOGIN_PASSWORD: '123',
    DEV_LOGIN_EMAIL: 'Dev@Example.com',
  });
  check('7. a username is matched case-insensitively',
    named.devLogin.username === 'devyora', named.devLogin.username);
  check('8. ...and an explicit account address is honoured',
    named.devLogin.email === 'dev@example.com', named.devLogin.email);

  const test = configUnder({
    NODE_ENV: 'test',
    DEV_LOGIN_USERNAME: 'devyora',
    DEV_LOGIN_PASSWORD: '123',
  });
  check('9. a protected test environment may have one too',
    test.devLogin !== null && test.devLogin.username === 'devyora', test.devLogin);

  // ----------------------------------------------------------------
  // WHAT THE SOURCE MUST NOT CONTAIN.
  // ----------------------------------------------------------------
  const source = [
    'src/config/index.ts', 'src/config/env.ts',
    'src/validators/auth.validators.ts', 'src/services/auth.service.ts',
    'prisma/seed-dev-login.ts',
  ].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

  check('10. no username is hard-coded anywhere in the backend',
    !/['"`]devyora['"`]/i.test(source));
  check('11. no password is hard-coded anywhere in the backend',
    !/DEV_LOGIN_PASSWORD\s*(\?\?|\|\|)\s*['"`]/.test(source)
    && !/password\s*[:=]\s*['"`]123['"`]/i.test(source));

  // The page is served to anyone who visits, so it must carry no
  // credential. "devyora" appears in it as the studio's own name and in
  // the logo filename, which is not one -- so this looks at the script
  // and at the fields, where a credential would actually have to live
  // to be usable.
  const loginPage = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'login.html'), 'utf8');
  const pageScript = loginPage.slice(loginPage.lastIndexOf('<script>'));
  check('12. no credential is written into the login page\'s script',
    !/devyora/i.test(pageScript) && !/['"`]123['"`]/.test(pageScript));
  check('13. ...and neither field arrives pre-filled',
    !/<input[^>]*id="(email|password)"[^>]*\svalue=/.test(loginPage));
  check('14. the password field imposes no length of its own',
    !/<input[^>]*id="password"[^>]*minlength=/.test(loginPage));

  // ----------------------------------------------------------------
  // WHAT WAS NOT WEAKENED.
  // ----------------------------------------------------------------
  const validators = fs.readFileSync(path.join(ROOT, 'src/validators/auth.validators.ts'), 'utf8');
  check('15. setting a password still demands 8 characters',
    validators.includes("min(8, 'Password must be at least 8 characters')"));
  check('16. ...and upper case, lower case and a number',
    validators.includes('must contain at least one uppercase letter')
    && validators.includes('must contain at least one lowercase letter')
    && validators.includes('must contain at least one number'));
  check('17. the reset flow still uses those rules',
    /resetPasswordSchema[\s\S]{0,120}newPassword:\s*passwordSchema/.test(validators));

  const service = fs.readFileSync(path.join(ROOT, 'src/services/auth.service.ts'), 'utf8');
  check('18. the password is still compared against the stored hash',
    service.includes('await comparePassword(password, user.passwordHash)'));
  check('19. a wrong password is still rejected',
    /if\s*\(!passwordOk\)[\s\S]{0,400}throw invalidCredentials\(\)/.test(service));
  check('20. an unknown identifier is still rejected',
    /if\s*\(!user\)[\s\S]{0,300}throw invalidCredentials\(\)/.test(service));
  check('21. a deactivated account is still refused',
    service.includes('This account has been deactivated'));
  check('22. the session is still issued the same way',
    service.includes('await issueTokenPair(user, req)'));
  check('23. the identifier maps to an account -- it does not skip the lookup',
    /accountEmail\(email\)/.test(service)
    && /prisma\.user\.findUnique/.test(service));
  check('24. ...and resolves nothing when no development login is configured',
    /const dev = config\.devLogin;[\s\S]{0,160}return dev && typed === dev\.username \? dev\.email : typed;/
      .test(service));

  const seeder = fs.readFileSync(path.join(ROOT, 'prisma/seed-dev-login.ts'), 'utf8');
  check('25. the seeder stores a bcrypt hash, never the password',
    seeder.includes('bcrypt.hash(dev.password, 12)')
    && !/passwordHash:\s*dev\.password/.test(seeder));
  check('26. ...and refuses to run without a configured login',
    /if \(!dev\)[\s\S]{0,400}process\.exitCode = 1/.test(seeder));

  let failures = 0;
  for (const [label, ok, detail] of results) {
    if (ok) console.log(`  PASS  ${label}`);
    else { failures += 1; console.log(`  FAIL  ${label}${detail ? '  [' + detail + ']' : ''}`); }
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  return failures ? 1 : 0;
}

process.exit(main());
