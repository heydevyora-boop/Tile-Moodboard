/**
 * THE PRIVACY POLICY, FETCHED THE WAY ANYONE ELSE FETCHES IT.
 *
 * /privacy-policy is the one page of this application served to a
 * visitor with no session. It used to be a 404 -- the file did not
 * exist -- which is one of the things Google's OAuth branding review
 * refused the app for.
 *
 * So this suite is that anonymous visitor: it serves the repository the
 * way vercel.json routes it, fetches the policy with no cookie and no
 * token, and reads it.
 *
 * It also holds the policy to the code. The scope it names has to be
 * the scope the application actually asks Google for, and the token
 * store and the disconnect it describes have to exist -- otherwise the
 * page quietly becomes a lie about what the studio's data does.
 *
 * "/" is NOT a public page. It is a redirect to the sign-in, and that
 * is deliberate: the public front door that stood here was removed on
 * request. The redirect is asserted below so it cannot be undone by
 * accident, and so the reason is recorded next to it.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/public_pages_test.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');

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
  const home = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const policy = fs.readFileSync(path.join(REPO, 'privacy-policy.html'), 'utf8');
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));

  // The repository, served the way vercel.json routes it: the static
  // files at the repo root, frontend/ beneath it, and the one rewrite
  // that gives the policy its clean URL.
  const express = require('express');
  const app = express();
  app.get('/privacy-policy', (_req, res) =>
    res.sendFile(path.join(REPO, 'privacy-policy.html')));
  app.use(express.static(REPO, { index: 'index.html' }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;

  const browser = await chromium.launch();
  const pageErrors = [];

  try {
    // ══ 1. the routing is actually declared ════════════════════════
    step('1. the policy is served at the URL the consent screen was given');

    check('1a. the privacy policy is a file in the repository',
      fs.existsSync(path.join(REPO, 'privacy-policy.html')));

    check('1b. ...and vercel.json gives it the clean URL',
      (vercel.routes || []).some((r) => r.src === '/privacy-policy'
        && String(r.dest || '').includes('privacy-policy.html')),
      vercel.routes);

    check('1c. ...and builds it',
      (vercel.builds || []).some((b) => b.src === 'privacy-policy.html'),
      (vercel.builds || []).map((b) => b.src));

    check('1d. the rewrite comes before the filesystem handler, or it would never run',
      (vercel.routes || []).findIndex((r) => r.src === '/privacy-policy')
        < (vercel.routes || []).findIndex((r) => r.handle === 'filesystem'));

    // ══ 2. and "/" is the sign-in, on purpose ══════════════════════
    step('2. "/" sends you to the sign-in, which is what was asked for');

    check('2a. the root is a redirect to the sign-in, not a page of its own',
      /url=frontend\/login\.html/.test(home) && /location\.replace/.test(home),
      home.slice(0, 220));

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => location.pathname.indexOf('login.html') !== -1, null, { timeout: 20000 });
    check('2b. ...and it really lands there', page.url().includes('login.html'), page.url());

    // ══ 3. the policy itself ═══════════════════════════════════════
    step('3. the policy, fetched by a visitor with no session');

    const got = await page.goto(`${base}/privacy-policy`, { waitUntil: 'networkidle' });
    check('3a. it answers 200 rather than a 404', got.status() === 200, got.status());
    check('3b. ...and stays put: it is not behind the sign-in',
      page.url().endsWith('/privacy-policy'), page.url());

    const text = (await page.textContent('body')).replace(/\s+/g, ' ').trim();
    check('3c. ...with real content, not a stub', text.length > 2500, text.length);

    const says = (what, re) => check(`3. ...it says ${what}`, re.test(text),
      text.slice(0, 120));

    says('what data is collected', /what the application stores/i);
    says('what Google data is used', /Google account data/i);
    says('which Drive scope is asked for', /drive\.file/);
    says('that it cannot see the rest of the Drive', /rest of (that|the) Google Drive/i);
    says('where the refresh token lives, and that it is encrypted', /refresh token/i);
    says('that pictures go to Gemini for generation', /Gemini/);
    says('the Limited Use undertaking', /Limited Use/);
    says('that nothing is sold or used for advertising', /not sold/i);
    says('how long it is kept', /How long it is kept/i);
    says('how to revoke the connection', /myaccount\.google\.com\/permissions/);
    says('how to reach somebody about it', /Contact/i);
    says('when it was last updated', /Last updated/i);

    check('3d. the policy is readable on a phone too',
      await (async () => {
        await page.setViewportSize({ width: 393, height: 852 });
        await page.waitForTimeout(250);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1);
        await page.setViewportSize({ width: 1280, height: 900 });
        return !overflow;
      })());

    // ══ 4. the policy is held to the code ══════════════════════════
    step('4. the policy describes THIS application, not a hoped-for one');

    const env = fs.readFileSync(path.join(ROOT, 'src/config/env.ts'), 'utf8');
    const scope = (env.match(/GOOGLE_OAUTH_SCOPE[\s\S]{0,200}?'(https:\/\/[^']+)'/) || [])[1];
    check('4a. the scope the policy names is the scope the application asks for',
      !!scope && policy.includes(scope), { scope });

    check('4b. ...and no identity scope is requested, as the policy says',
      !!scope && !/userinfo|openid|profile|email/.test(scope), scope);

    const oauth = fs.readFileSync(path.join(ROOT, 'src/services/googleOAuth.service.ts'), 'utf8');
    check('4c. the refresh token really is encrypted before it is stored, as the policy says',
      /encryptSecret\(refreshToken/.test(oauth));

    check('4d. ...and there really is a way to disconnect, as the policy says',
      /export async function forgetRefreshToken/.test(oauth));

    check('Z. no page threw at any point', pageErrors.length === 0, pageErrors.slice(0, 3));
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('  failed:', failures.join(' | ')); process.exit(1); }
}

main().catch((error) => { console.error(error); process.exit(1); });
