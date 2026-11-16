/**
 * THE TWO PAGES AN ANONYMOUS VISITOR HAS TO BE ABLE TO READ.
 *
 * Google's OAuth branding review fetches "/" and the privacy policy as
 * a visitor with no session, and refuses the app when:
 *
 *   - the homepage is behind a login page;
 *   - the homepage carries no link to the privacy policy;
 *   - the privacy policy URL does not answer;
 *   - the privacy policy has too little content to tell what the app
 *     collects and why.
 *
 * All four were true of this deployment: "/" was two lines that
 * redirected to frontend/login.html, and /privacy-policy was a 404.
 *
 * So this suite is that reviewer. It serves the repository the way
 * vercel.json routes it, visits both pages with no cookie and no token,
 * and reads them.
 *
 * It also holds the privacy policy to the code: the scope it names has
 * to be the scope the application actually asks Google for.
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
    step('1. the deployment serves them at the URLs Google was given');

    check('1a. "/" is a page of its own, not a redirect to the sign-in',
      !/http-equiv="refresh"/i.test(home) && !/location\.replace/.test(home),
      home.slice(0, 200));

    check('1b. the privacy policy is a file in the repository',
      fs.existsSync(path.join(REPO, 'privacy-policy.html')));

    check('1c. ...and vercel.json gives it the clean URL Google was given',
      (vercel.routes || []).some((r) => r.src === '/privacy-policy'
        && String(r.dest || '').includes('privacy-policy.html')),
      vercel.routes);

    check('1d. ...and builds it',
      (vercel.builds || []).some((b) => b.src === 'privacy-policy.html'),
      (vercel.builds || []).map((b) => b.src));

    check('1e. the rewrite comes before the filesystem handler, or it would never run',
      (vercel.routes || []).findIndex((r) => r.src === '/privacy-policy')
        < (vercel.routes || []).findIndex((r) => r.handle === 'filesystem'));

    // ══ 2. an anonymous visitor ════════════════════════════════════
    step('2. a visitor with no session, which is what the reviewer is');

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    const landed = await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    check('2a. "/" answers 200', landed.status() === 200, landed.status());
    check('2b. ...and STAYS on "/" -- it is not a login page',
      new URL(page.url()).pathname === '/' && !page.url().includes('login'),
      page.url());

    const visible = (await page.textContent('body')).replace(/\s+/g, ' ').trim();
    check('2c. ...with enough on it to tell what the application is',
      visible.length > 600, visible.length);
    check('2d. ...naming the studio and what the application does',
      /De’vyora/.test(visible) && /mood board/i.test(visible)
      && /catalogue|catalog/i.test(visible), visible.slice(0, 160));

    check('2e. there is no form asking an anonymous visitor for anything',
      (await page.$$('input[type="password"]')).length === 0
      && (await page.$$('form')).length === 0);

    // ══ 3. the link Google looks for ═══════════════════════════════
    step('3. the homepage links to the privacy policy');

    const policyLinks = await page.$$eval('a[href]',
      (els) => els.map((e) => e.getAttribute('href'))
        .filter((h) => /privacy/i.test(h)));
    check('3a. at least one link to the policy', policyLinks.length >= 1, policyLinks);
    check('3b. ...pointing at the exact URL on the consent screen',
      policyLinks.includes('/privacy-policy'), policyLinks);

    check('3c. the way in for staff is a link, not an automatic redirect',
      (await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href'))))
        .some((h) => /login\.html$/.test(h)));

    // ══ 4. the policy itself ═══════════════════════════════════════
    step('4. the privacy policy, fetched the way Google fetches it');

    const got = await page.goto(`${base}/privacy-policy`, { waitUntil: 'networkidle' });
    check('4a. it answers 200 rather than a 404', got.status() === 200, got.status());

    const text = (await page.textContent('body')).replace(/\s+/g, ' ').trim();
    check('4b. ...with real content, not a stub',
      text.length > 2500, text.length);

    const says = (what, re) => check(`4. ...it says ${what}`, re.test(text),
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

    check('4c. the policy is readable on a phone too',
      await (async () => {
        await page.setViewportSize({ width: 393, height: 852 });
        await page.waitForTimeout(250);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1);
        await page.setViewportSize({ width: 1280, height: 900 });
        return !overflow;
      })());

    // ══ 5. the policy is held to the code ══════════════════════════
    step('5. the policy describes THIS application, not a hoped-for one');

    const env = fs.readFileSync(path.join(ROOT, 'src/config/env.ts'), 'utf8');
    const scope = (env.match(/GOOGLE_OAUTH_SCOPE[\s\S]{0,200}?'(https:\/\/[^']+)'/) || [])[1];
    check('5a. the scope the policy names is the scope the application asks for',
      !!scope && policy.includes(scope), { scope });

    check('5b. ...and no identity scope is requested, as the policy says',
      !!scope && !/userinfo|openid|profile|email/.test(scope), scope);

    const oauth = fs.readFileSync(path.join(ROOT, 'src/services/googleOAuth.service.ts'), 'utf8');
    check('5c. the refresh token really is encrypted before it is stored, as the policy says',
      /encryptSecret\(refreshToken/.test(oauth));

    check('5d. ...and there really is a way to disconnect, as the policy says',
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
