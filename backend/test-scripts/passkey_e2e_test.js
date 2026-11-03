/**
 * Face ID / fingerprint sign-in, driven in a real browser.
 *
 * This runs the REAL server -- createApp() from src/, the one both
 * server.ts and api/index.ts wire up -- against a real Postgres, with
 * the real frontend served from the same origin, and drives it with
 * Chromium's WebAuthn virtual authenticator over CDP.
 *
 * Nothing here is mocked except the authenticator itself, which is the
 * one thing a test machine has no hardware for.
 *
 * Every secret in this file is a dummy. Nothing reads a real key.
 *
 * Run:  node test-scripts/passkey_e2e_test.js
 *       (expects a Postgres reachable at TEST_DATABASE_URL)
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');

// ── dummy environment, assembled before anything under src/ is loaded ──
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_passkey?host=/var/tmp';

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: DB_URL,
  JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
  ENCRYPTION_KEY: '0'.repeat(64),
  BCRYPT_SALT_ROUNDS: '10',
  LOG_LEVEL: 'error',
  RATE_LIMIT_MAX: '100000',
  CORS_ORIGINS: '*',
});

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else {
    console.log(`  FAIL  ${label}`, detail === undefined ? '' : JSON.stringify(detail));
    fail += 1;
    failures.push(label);
  }
}

// ── user agents, as the real browsers send them ──
const UA = {
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
  androidEdge: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0',
  androidOpera: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 OPR/80.0.0.0',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15',
  iphoneEdge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/140.0.0.0 Mobile/15E148 Safari/605.1.15',
  webview: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36',
  facebook: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 [FBAN/EMA;FBAV/400.0]',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0',
};

async function main() {
  // ── database ──
  execFileSync('psql', [DB_URL.replace(/\/tm_passkey\?/, '/postgres?'), '-c', 'drop database if exists tm_passkey'], { stdio: 'ignore' });
  execFileSync('psql', [DB_URL.replace(/\/tm_passkey\?/, '/postgres?'), '-c', 'create database tm_passkey'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

  const role = await prisma.role.create({
    data: { name: 'OWNER', description: 'test', permissions: ['visualizations:write'] },
  });
  const PASSWORD = 'dummy-password-one';
  const SECOND_PASSWORD = 'dummy-password-two';
  const primary = await prisma.user.create({
    data: {
      name: 'Priya Sharma', email: 'priya@example.test',
      passwordHash: await hashPassword(PASSWORD), roleId: role.id,
    },
  });
  const second = await prisma.user.create({
    data: {
      name: 'Arun Mehta', email: 'arun@example.test',
      passwordHash: await hashPassword(SECOND_PASSWORD), roleId: role.id,
    },
  });

  // ── the real app, plus the real frontend on the SAME origin ──
  const express = require('express');
  const host = express();
  // Static FIRST: createApp() ends in a 404 handler, so anything mounted
  // after it is never reached.
  host.use(express.static(FRONTEND));
  host.use(createApp());
  const server = http.createServer(host);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;

  const browser = await chromium.launch();

  // ── helpers ──
  async function newPage(opts) {
    const settings = opts || {};
    const context = await browser.newContext(
      settings.ua ? { userAgent: settings.ua } : {}
    );
    const page = await context.newPage();
    let authenticatorId = null;
    let cdp = null;

    if (settings.authenticator !== false) {
      cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      const res = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: settings.userVerified !== false,
          automaticPresenceSimulation: true,
        },
      });
      authenticatorId = res.authenticatorId;
    }

    // The virtual authenticator answers conditional (autofill) requests
    // by itself, which would sign a visitor in before the test can touch
    // the password form. Tests that need the form turn autofill off.
    if (settings.autofill === false) {
      await page.addInitScript(() => {
        window.__noAutofill = true;
      });
      await page.addInitScript(() => {
        const wait = setInterval(() => {
          if (window.SimpleWebAuthnBrowser) {
            clearInterval(wait);
            window.SimpleWebAuthnBrowser.browserSupportsWebAuthnAutofill = () => false;
          }
        }, 5);
      });
    }

    if (settings.noWebAuthn) {
      await page.addInitScript(() => {
        delete window.PublicKeyCredential;
      });
    }

    if (settings.isUVPAAFalse) {
      await page.addInitScript(() => {
        const wait = setInterval(() => {
          if (window.PublicKeyCredential) {
            clearInterval(wait);
            window.PublicKeyCredential
              .isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
            delete window.PublicKeyCredential.getClientCapabilities;
          }
        }, 5);
      });
    }

    if (settings.noPlatformAuthenticator) {
      await page.addInitScript(() => {
        const wait = setInterval(() => {
          if (window.PublicKeyCredential) {
            clearInterval(wait);
            window.PublicKeyCredential
              .isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
            window.PublicKeyCredential.getClientCapabilities = async () => ({
              userVerifyingPlatformAuthenticator: false,
              passkeyPlatformAuthenticator: false,
            });
          }
        }, 5);
      });
    }

    return { context, page, cdp, authenticatorId };
  }

  const openLogin = async (page) => {
    await page.goto(`${base}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.getElementById('checkingState').style.display === 'none',
      { timeout: 15000 },
    );
  };

  const signInWithPassword = async (page, email, password) => {
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click('#submitBtn');
  };

  const credentialCount = (userId) => prisma.webAuthnCredential.count({ where: { userId } });

  // ════════════════════════════════════════════════════════════════
  console.log('\n1. a device with no biometrics');
  {
    const { context, page } = await newPage({
      ua: UA.desktop, authenticator: false, noPlatformAuthenticator: true, autofill: false,
    });
    await openLogin(page);
    check('1a. no Face ID button is shown',
      !(await page.locator('#bioLead').isVisible()));
    check('1b. the password form is shown',
      await page.locator('#loginForm').isVisible());

    await signInWithPassword(page, 'priya@example.test', PASSWORD);
    await page.waitForURL('**/dashboard.html', { timeout: 15000 }).catch(() => {});
    check('1c. the password still signs in', page.url().includes('dashboard.html'), page.url());
    check('1d. no enable offer was made', await credentialCount(primary.id) === 0);
    await context.close();
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n2. a phone with no passkey for this site');
  {
    const { context, page } = await newPage({ ua: UA.androidChrome, autofill: false });
    await openLogin(page);
    check('2a. the form and the Face ID button are both shown',
      await page.locator('#loginForm').isVisible()
      && await page.locator('#bioLead').isVisible());

    await page.click('#bioBtn');
    await page.waitForFunction(
      () => document.getElementById('bioAlert').style.display === 'flex',
      { timeout: 15000 },
    ).catch(() => {});
    const message = await page.locator('#bioAlert').textContent();
    check('2b. tapping it says Face ID is not set up on this phone yet',
      /not set up on this phone yet/.test(message || ''), message);
    await context.close();
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n3. password sign-in, the offer, and enabling it');
  let enrolledState = null;
  {
    const { context, page } = await newPage({ ua: UA.androidChrome, autofill: false });
    await openLogin(page);
    await signInWithPassword(page, 'priya@example.test', PASSWORD);

    await page.waitForSelector('#bioAsk', { timeout: 15000 });
    check('3a. the offer is shown, and the redirect waits for an answer',
      page.url().includes('login.html'), page.url());
    check('3b. it asks the right question',
      /Sign in faster next time/.test(await page.locator('#bioAsk').textContent()));

    await page.click('#bioEnable');
    await page.waitForURL('**/dashboard.html', { timeout: 20000 });
    check('3c. enabling it signs the visitor through to the dashboard', true);
    check('3d. exactly one key was created', await credentialCount(primary.id) === 1,
      await credentialCount(primary.id));

    enrolledState = await context.storageState();
    await context.close();
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n4. reopening the site while signed in');
  {
    const { context, page } = await newPage({ ua: UA.androidChrome, autofill: false });
    await context.addCookies(enrolledState.cookies);
    await page.goto(`${base}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/dashboard.html', { timeout: 15000 }).catch(() => {});
    check('4a. it goes straight in, with no login page',
      page.url().includes('dashboard.html'), page.url());

    const cookie = enrolledState.cookies.find((c) => c.name.includes('refresh'));
    const days = cookie ? (cookie.expires * 1000 - Date.now()) / 86400000 : 0;
    check('4b. the session cookie lasts 30 days', days > 29.5 && days <= 30.5,
      { name: cookie && cookie.name, days: Number(days.toFixed(2)) });
    check('4c. ...and the browser cannot read it', cookie ? cookie.httpOnly : false);
    await context.close();
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n5-7. sign out, sign in by Face ID, and a face that is not recognised');
  {
    // The authenticator is per-context, so the enrolled key is recreated
    // by signing in with the password once in this fresh context.
    const { context, page, cdp, authenticatorId } = await newPage({
      ua: UA.androidChrome, autofill: false,
    });
    await openLogin(page);
    await signInWithPassword(page, 'priya@example.test', PASSWORD);
    await page.waitForSelector('#bioAsk', { timeout: 15000 });
    await page.click('#bioEnable');
    await page.waitForURL('**/dashboard.html', { timeout: 20000 });

    // 5. sign out
    await page.click('#logoutBtn');
    await page.waitForURL('**/login.html**', { timeout: 15000 });
    await page.waitForFunction(
      () => document.getElementById('checkingState').style.display === 'none',
      { timeout: 15000 },
    );
    check('5a. the Face ID screen is shown after signing out',
      await page.locator('#bioLead').isVisible());
    check('5b. ...naming the account it is for',
      /as Priya Sharma/.test(await page.locator('#bioAs').textContent() || ''));
    await page.waitForTimeout(1200);
    check('5c. ...and no prompt starts by itself', page.url().includes('login.html'), page.url());

    await page.click('#bioBtn');
    await page.waitForURL('**/dashboard.html', { timeout: 20000 });
    check('5d. one tap signs in', page.url().includes('dashboard.html'));
    const whoami = await page.evaluate(async () => {
      const u = await window.CasaApi.me.get();
      return u && u.email;
    });
    check('5e. ...with a session that actually works', whoami === 'priya@example.test', whoami);

    // 6. opening the login page later: the prompt starts by itself
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${base}/login.html?redirect=dashboard.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.removeItem('casa_access_token'); });
    await page.goto(`${base}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/dashboard.html', { timeout: 20000 }).catch(() => {});
    check('6a. the prompt starts by itself and signs in',
      page.url().includes('dashboard.html'), page.url());

    // 7. a face that is not recognised
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
    // A genuinely signed-out browser: the refresh cookie has to go too,
    // or the login page recognises the session and leaves at once.
    await context.clearCookies();
    await page.evaluate(() => {
      localStorage.removeItem('casa_access_token');
      localStorage.removeItem('casa_user');
      sessionStorage.setItem('casa_signed_out', '1');
    });
    await openLogin(page);
    await page.click('#bioBtn');
    await page.waitForFunction(
      () => document.getElementById('bioAlert').style.display === 'flex',
      { timeout: 20000 },
    ).catch(() => {});
    check('7a. it does not sign in', page.url().includes('login.html'), page.url());
    const refusal = await page.locator('#bioAlert').textContent();
    check('7b. ...and says so clearly', !!(refusal || '').trim(), refusal);

    await page.click('#bioAlt');
    await signInWithPassword(page, 'priya@example.test', PASSWORD);
    await page.waitForURL('**/dashboard.html', { timeout: 20000 }).catch(() => {});
    check('7c. the password still works', page.url().includes('dashboard.html'), page.url());
    await context.close();
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n8. a replay, and what a challenge is not');
  {
    const { context, page } = await newPage({ ua: UA.androidChrome, autofill: false });
    await openLogin(page);
    await signInWithPassword(page, 'priya@example.test', PASSWORD);
    await page.waitForSelector('#bioAsk', { timeout: 15000 });
    await page.click('#bioEnable');
    await page.waitForURL('**/dashboard.html', { timeout: 20000 });

    // Capture a real, successful sign-in off the wire.
    let captured = null;
    page.on('request', (req) => {
      if (req.url().endsWith('/auth/passkey/login') && req.method() === 'POST') {
        captured = req.postData();
      }
    });
    await page.click('#logoutBtn');
    await page.waitForURL('**/login.html**', { timeout: 15000 });
    await page.waitForFunction(
      () => document.getElementById('checkingState').style.display === 'none',
      { timeout: 15000 },
    );
    await page.click('#bioBtn');
    await page.waitForURL('**/dashboard.html', { timeout: 20000 });
    check('8a. a sign-in was captured, as an attacker would', !!captured);

    const replay = await page.evaluate(async (body) => {
      const r = await fetch('/api/v1/auth/passkey/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, captured);
    check('8b. replaying it is refused', replay.status === 401, replay);

    // Enrolment needs a session, and a challenge is not one.
    const noSession = await page.evaluate(async () => {
      const r = await fetch('/api/v1/auth/passkey/register-options', { method: 'POST' });
      return r.status;
    });
    check('8c. register-options without a session is refused', noSession === 401, noSession);

    const noSessionRegister = await page.evaluate(async () => {
      const r = await fetch('/api/v1/auth/passkey/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } }),
      });
      return r.status;
    });
    check('8d. register without a session is refused too', noSessionRegister === 401,
      noSessionRegister);

    // A login challenge is obtainable by anyone -- that is its job -- and
    // buys nothing: it is not a token and no endpoint accepts it as one.
    const challengeOnly = await page.evaluate(async () => {
      const opts = await fetch('/api/v1/auth/passkey/login-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'priya@example.test' }),
      }).then((r) => r.json());
      const used = await fetch('/api/v1/auth/passkey/register-options', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + opts.data.options.challenge },
      });
      return { gotChallenge: !!opts.data.options.challenge, status: used.status };
    });
    check('8e. a challenge is not a session and cannot be traded for one',
      challengeOnly.gotChallenge && challengeOnly.status === 401, challengeOnly);
    await context.close();
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n9. the password changed, and the account deleted');
  {
    // Earlier scenarios each enrolled this account on their own virtual
    // authenticator, so the count is cleared to make this one about the
    // password change and nothing else.
    await prisma.webAuthnCredential.deleteMany({ where: { userId: primary.id } });
    const { context, page } = await newPage({ ua: UA.androidChrome, autofill: false });
    await openLogin(page);
    await signInWithPassword(page, 'priya@example.test', PASSWORD);
    await page.waitForSelector('#bioAsk', { timeout: 15000 });
    await page.click('#bioEnable');
    await page.waitForURL('**/dashboard.html', { timeout: 20000 });

    // The password changes, as it would after a reset.
    await prisma.user.update({
      where: { id: primary.id },
      data: { passwordHash: await hashPassword('dummy-password-changed') },
    });

    await page.click('#logoutBtn');
    await page.waitForURL('**/login.html**', { timeout: 15000 });
    await page.waitForFunction(
      () => document.getElementById('checkingState').style.display === 'none',
      { timeout: 15000 },
    );
    await page.click('#bioBtn');
    await page.waitForFunction(
      () => document.getElementById('bioAlert').style.display === 'flex',
      { timeout: 20000 },
    ).catch(() => {});
    const stale = (await page.locator('#bioAlert').textContent()) || '';
    check('9a. the old passkey is refused after a password change',
      page.url().includes('login.html'), page.url());
    check('9b. ...and says to set it up again with the password',
      /password has changed/i.test(stale) && /set it up again/i.test(stale), stale);
    check('9c. ...and the dead key is cleared, so the offer comes back',
      await credentialCount(primary.id) === 0, await credentialCount(primary.id));
    check('9d. ...and the form is shown, not a dead end',
      await page.locator('#loginForm').isVisible());

    await signInWithPassword(page, 'priya@example.test', 'dummy-password-changed');
    const offeredAgain = await page.waitForSelector('#bioAsk', { timeout: 15000 })
      .then(() => true).catch(() => false);
    check('9e. signing in with the new password offers enrolment again', offeredAgain);
    await page.click('#bioEnable');
    await page.waitForURL('**/dashboard.html', { timeout: 20000 });

    // And a deleted account takes its keys with it.
    const doomed = await prisma.user.create({
      data: {
        name: 'Temp Staff', email: 'temp@example.test',
        passwordHash: await hashPassword('dummy-password-temp'), roleId: role.id,
      },
    });
    await prisma.webAuthnCredential.create({
      data: {
        userId: doomed.id, credentialId: 'deleted-account-key', publicKey: 'x',
        rpId: 'localhost', passwordTag: 'x',
      },
    });
    await prisma.user.delete({ where: { id: doomed.id } });
    check('9f. deleting an account deletes its passkeys with it',
      await prisma.webAuthnCredential.count({ where: { credentialId: 'deleted-account-key' } }) === 0);
    await context.close();
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n10. a second account on a device that is already enrolled');
  {
    const { context, page } = await newPage({ ua: UA.androidChrome, autofill: false });
    await openLogin(page);
    await signInWithPassword(page, 'priya@example.test', 'dummy-password-changed');
    const first = await page.waitForSelector('#bioAsk', { timeout: 15000 })
      .then(() => true).catch(() => false);
    if (first) {
      await page.click('#bioEnable');
      await page.waitForURL('**/dashboard.html', { timeout: 20000 });
    }
    check('10a. the first account enrols on this device',
      await credentialCount(primary.id) >= 1, await credentialCount(primary.id));

    await page.click('#logoutBtn');
    await page.waitForURL('**/login.html**', { timeout: 15000 });
    await page.waitForFunction(
      () => document.getElementById('checkingState').style.display === 'none',
      { timeout: 15000 },
    );
    check('10b. the device leads with Face ID for the account it knows',
      /as Priya Sharma/.test(await page.locator('#bioAs').textContent() || ''));

    // The second person uses the same phone.
    await page.click('#bioAlt');
    await signInWithPassword(page, 'arun@example.test', SECOND_PASSWORD);
    const offered = await page.waitForSelector('#bioAsk', { timeout: 15000 })
      .then(() => true).catch(() => false);
    check('10c. a different account on an enrolled device is offered it too', offered);

    await page.click('#bioEnable');
    await page.waitForURL('**/dashboard.html', { timeout: 20000 });
    check('10d. ...and gets its own key', await credentialCount(second.id) === 1,
      await credentialCount(second.id));
    check('10e. ...without disturbing the first account’s',
      await credentialCount(primary.id) >= 1, await credentialCount(primary.id));

    const remembered = await page.evaluate(
      () => JSON.parse(localStorage.getItem('casa_passkey_accounts') || '[]')
    );
    check('10f. the device remembers both accounts',
      remembered.length === 2
      && remembered.some((a) => a.email === 'priya@example.test')
      && remembered.some((a) => a.email === 'arun@example.test'), remembered);
    await context.close();
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n11-13. phones, an unhelpful isUVPAA, and in-app browsers');
  for (const [name, ua] of [
    ['Chrome (Android)', UA.androidChrome], ['Samsung Internet', UA.samsung],
    ['Firefox (Android)', UA.androidFirefox], ['Edge (Android)', UA.androidEdge],
    ['Opera (Android)', UA.androidOpera], ['Safari (iPhone)', UA.iphoneSafari],
    ['Chrome (iPhone)', UA.iphoneChrome], ['Firefox (iPhone)', UA.iphoneFirefox],
    ['Edge (iPhone)', UA.iphoneEdge],
  ]) {
    const { context, page } = await newPage({ ua, autofill: false });
    await openLogin(page);
    const shown = await page.locator('#bioLead').isVisible();
    await signInWithPassword(page, 'arun@example.test', SECOND_PASSWORD);
    const offered = await page.waitForSelector('#bioAsk', { timeout: 15000 })
      .then(() => true).catch(() => false);
    let enabled = false;
    if (offered) {
      await page.click('#bioEnable');
      enabled = await page.waitForURL('**/dashboard.html', { timeout: 20000 })
        .then(() => true).catch(() => false);
    }
    let signedIn = false;
    if (enabled) {
      await page.click('#logoutBtn');
      await page.waitForURL('**/login.html**', { timeout: 15000 });
      await page.waitForFunction(
        () => document.getElementById('checkingState').style.display === 'none',
        { timeout: 15000 },
      );
      await page.click('#bioBtn');
      signedIn = await page.waitForURL('**/dashboard.html', { timeout: 20000 })
        .then(() => true).catch(() => false);
    }
    check(`11. ${name}: button, offer, enable and Face ID sign-in`,
      shown && offered && enabled && signedIn,
      { shown, offered, enabled, signedIn });
    await prisma.webAuthnCredential.deleteMany({ where: { userId: second.id } });
    await context.close();
  }

  {
    const { context, page } = await newPage({
      ua: UA.androidChrome, autofill: false, isUVPAAFalse: true,
    });
    await openLogin(page);
    const shown = await page.locator('#bioLead').isVisible();
    await signInWithPassword(page, 'arun@example.test', SECOND_PASSWORD);
    const offered = await page.waitForSelector('#bioAsk', { timeout: 15000 })
      .then(() => true).catch(() => false);
    check('12. an Android phone that answers isUVPAA false still gets both',
      shown && offered, { shown, offered });
    await prisma.webAuthnCredential.deleteMany({ where: { userId: second.id } });
    await context.close();
  }

  for (const [name, ua, isApple] of [
    ['Android WebView', UA.webview, false],
    ['Facebook', UA.facebook, false],
    ['Instagram (iPhone)', UA.instagram, true],
  ]) {
    const { context, page } = await newPage({ ua, autofill: false });
    await openLogin(page);
    const note = (await page.locator('#bioNote').textContent()) || '';
    const noteShown = await page.locator('#bioNote').isVisible();
    const link = await page.locator('#bioOpenBrowser').count()
      ? await page.locator('#bioOpenBrowser').getAttribute('href') : '';
    check(`13. ${name}: the note is shown instead of nothing`,
      noteShown && /Open (this page|in your browser)/i.test(note), note.slice(0, 80));
    if (!isApple) {
      check(`13. ${name}: ...with an intent link to the default browser`,
        /^intent:\/\/localhost:\d+\/login\.html#Intent;scheme=https;end$/.test(link || ''), link);
    }
    check(`13. ${name}: no enable offer is made there`,
      !(await page.locator('#bioLead').isVisible()));
    await signInWithPassword(page, 'arun@example.test', SECOND_PASSWORD);
    const through = await page.waitForURL('**/dashboard.html', { timeout: 15000 })
      .then(() => true).catch(() => false);
    check(`13. ${name}: the password still works`, through);
    await context.close();
  }

  {
    const { context, page } = await newPage({ ua: UA.androidChrome, noWebAuthn: true, authenticator: false });
    await openLogin(page);
    check('13. a browser with no WebAuthn at all: the note is shown',
      await page.locator('#bioNote').isVisible());
    check('13. ...and no Face ID button',
      !(await page.locator('#bioLead').isVisible()));
    await context.close();
  }

  await browser.close();
  server.close();
  await prisma.$disconnect();

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
