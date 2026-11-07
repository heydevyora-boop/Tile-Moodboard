/**
 * CONNECTING THE STUDIO'S OWN GOOGLE ACCOUNT.
 *
 * The library's folder is in a personal My Drive. A service account
 * owns no Drive storage, so it cannot own the file it would create
 * there, however the folder is shared -- which is why every upload
 * came back "Service Accounts do not have storage quota". The way out
 * on a personal Gmail is the owner authorizing the application once
 * and the application acting as them afterwards.
 *
 * What is covered here is the part that must not be got wrong twice:
 * the signed state that stands in for a login on a callback Google
 * drives, the refresh token being encrypted at rest and never handed
 * back out, the Drive client actually preferring the connected account
 * while leaving the service account underneath it, and a revoked
 * authorization being reported as something a person can act on
 * instead of as a permission error.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/google_oauth_test.js
 */

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_oauth?host=/var/tmp';

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: DB_URL,
  JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
  ENCRYPTION_KEY: '0'.repeat(64),
  BCRYPT_SALT_ROUNDS: '10',
  LOG_LEVEL: 'error',
  BACKEND_PUBLIC_URL: 'https://studio.example.test',
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-only-client-secret-not-a-real-key',
  GOOGLE_DRIVE_LIBRARY_FOLDER: 'https://drive.google.com/drive/folders/1RefImagesFolderId',
});

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else {
    console.log(`  FAIL  ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
    fail += 1; failures.push(label);
  }
}

async function main() {
  execFileSync('psql', [DB_URL.replace(/\/tm_oauth\?/, '/postgres?'), '-c', 'drop database if exists tm_oauth'], { stdio: 'ignore' });
  execFileSync('psql', [DB_URL.replace(/\/tm_oauth\?/, '/postgres?'), '-c', 'create database tm_oauth'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { config } = require(path.join(ROOT, 'src/config/index'));
  const oauth = require(path.join(ROOT, 'src/services/googleOAuth.service'));
  const drive = require(path.join(ROOT, 'src/services/googleDrive.service'));
  const library = require(path.join(ROOT, 'src/services/library.service'));

  // ════════════════════════════════════════════════════════════════
  console.log('\n1. the callback Google drives, and the login it cannot carry');
  {
    // Google's redirect is a top-level navigation: no Authorization
    // header, so the route cannot sit behind authenticate(). The
    // owner's identity is signed into `state` on the way out and
    // checked on the way back, which is what replaces the guard.
    const state = oauth.signState('user-42');
    check('1a. a state this server issued verifies',
      oauth.verifyState(state).userId === 'user-42');

    const [payload, mac] = state.split('.');
    let rejected = false;
    try { oauth.verifyState(`${payload}x.${mac}`); } catch { rejected = true; }
    check('1b. a tampered payload does not', rejected);

    rejected = false;
    try { oauth.verifyState(`${payload}.${mac.slice(0, -2)}ab`); } catch { rejected = true; }
    check('1c. ...nor a forged signature', rejected);

    rejected = false;
    try { oauth.verifyState(''); } catch { rejected = true; }
    check('1d. ...nor nothing at all', rejected);

    // Sixteen minutes later.
    rejected = false;
    try { oauth.verifyState(state, Date.now() + 16 * 60 * 1000); } catch { rejected = true; }
    check('1e. ...nor one that has gone stale', rejected);

    check('1f. two states are never the same string',
      oauth.signState('user-42') !== oauth.signState('user-42'));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n2. the URL Google is asked for, and the one it comes back to');
  {
    check('2a. the callback is derived from the deployment’s own address',
      oauth.oauthRedirectUri() === 'https://studio.example.test/api/v1/integrations/google/callback',
      oauth.oauthRedirectUri());

    config.google.oauthRedirectUri = 'https://tunnel.example.test/api/v1/integrations/google/callback';
    check('2b. ...and an explicit override wins, for a preview or a tunnel',
      oauth.oauthRedirectUri() === 'https://tunnel.example.test/api/v1/integrations/google/callback');
    config.google.oauthRedirectUri = '';

    const url = new URL(oauth.buildAuthUrl('user-42'));
    const q = url.searchParams;
    check('2c. it is Google’s consent endpoint', url.host === 'accounts.google.com', url.host);
    // offline + consent together are what actually yields a refresh
    // token: Google returns one only on a first authorization, so a
    // re-connection without prompt=consent would hand back an access
    // token and nothing to store.
    check('2d. offline access is asked for', q.get('access_type') === 'offline');
    check('2e. ...and consent is forced, so a refresh token comes back',
      q.get('prompt') === 'consent');
    check('2f. the scope is the one configured',
      q.get('scope') === 'https://www.googleapis.com/auth/drive.file', q.get('scope'));
    check('2g. the redirect is the registered callback',
      q.get('redirect_uri') === 'https://studio.example.test/api/v1/integrations/google/callback');
    check('2h. the client id is sent, the secret is not',
      q.get('client_id') === 'test-client-id.apps.googleusercontent.com'
      && !url.href.includes('test-only-client-secret'), url.href.slice(0, 120));
    check('2i. and the state verifies when it comes back',
      oauth.verifyState(q.get('state')).userId === 'user-42');
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n3. the refresh token, which must never be readable or returned');
  {
    check('3a. nothing is authorized before the owner connects',
      (await oauth.isOAuthAuthorized()) === false);

    await oauth.storeRefreshToken('1//dummy-refresh-token-not-real', null);

    const row = await prisma.apiKey.findFirst({ where: { service: oauth.OAUTH_SERVICE } });
    check('3b. it is stored in the existing api_keys table, not a new one', !!row);
    check('3c. ...encrypted at rest, not as itself',
      !!row && !row.encryptedValue.includes('1//dummy-refresh-token-not-real'),
      row && row.encryptedValue.slice(0, 40));
    check('3d. ...and it reads back intact',
      (await oauth.readRefreshToken()) === '1//dummy-refresh-token-not-real');
    check('3e. the account now counts as connected',
      (await oauth.isOAuthAuthorized()) === true);

    // Re-connecting rotates the one row rather than piling up grants
    // nobody can tell apart.
    await oauth.storeRefreshToken('1//second-dummy-refresh-token', null);
    const rows = await prisma.apiKey.findMany({ where: { service: oauth.OAUTH_SERVICE } });
    check('3f. re-connecting replaces it instead of adding a second',
      rows.length === 1, rows.length);
    check('3g. ...and the new one is what is read',
      (await oauth.readRefreshToken()) === '1//second-dummy-refresh-token');
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n4. which credential the Drive client then uses');
  {
    // The service account stays configured underneath. Nothing that
    // worked before OAuth existed stops working because of it.
    config.google.serviceAccountJson = JSON.stringify({
      client_email: 'robot@example.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----\\n',
    });

    const client = new drive.GoogleDriveClient();
    check('4a. with the account connected, the library uploads as the person',
      (await client.authMode()) === 'oauth', await client.authMode());

    await oauth.forgetRefreshToken();
    check('4b. disconnecting falls back to the service account, not to nothing',
      (await client.authMode()) === 'service-account', await client.authMode());
    check('4c. ...and Drive is still reported as configured',
      client.isConfigured() === true);

    config.google.driveImpersonateUser = 'studio@example.test';
    check('4d. a Workspace deployment’s delegation is reported as its own thing',
      (await client.authMode()) === 'delegated');
    config.google.driveImpersonateUser = '';

    const saved = config.google.serviceAccountJson;
    config.google.serviceAccountJson = undefined;
    check('4e. with neither, nothing is claimed',
      (await client.authMode()) === 'none');
    config.google.serviceAccountJson = saved;
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n5. the My Drive folder the whole exercise is about');
  {
    const client = drive.googleDriveClient;
    client.isConfigured = () => true;
    // No driveId: an ordinary folder in a personal My Drive, which is
    // exactly what the studio has.
    client.getFolderById = async (id) => ({ id, name: 'Reference Images' });

    await oauth.forgetRefreshToken();
    library.clearLibraryFolderCache();
    let status = await library.describeLibraryFolder();
    check('5a. unconnected, the library refuses it and says why',
      status.ok === false && /My Drive/.test(status.reason), status.reason);
    check('5b. ...naming connecting the studio’s own account as the answer',
      /connect the studio’s own Google account/.test(status.reason), status.reason);

    await oauth.storeRefreshToken('1//dummy-refresh-token-not-real', null);
    drive.googleDriveClient.resetAuth();
    library.clearLibraryFolderCache();
    status = await library.describeLibraryFolder();
    check('5c. connected, the same folder is usable',
      status.ok === true && status.reason === '', status);
    check('5d. ...and it is still reported as a My Drive folder, not pretended otherwise',
      status.sharedDrive === false);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n6. when the authorization dies');
  {
    // google-auth-library refreshes the access token underneath every
    // Drive call, so a revoked grant arrives as a token-endpoint
    // error in the middle of an upload. Reported as a permission
    // problem it would send the owner back to re-share a folder that
    // was never the trouble.
    const refusing = new drive.GoogleDriveClient({
      files: {
        create: async () => {
          const err = new Error('invalid_grant');
          err.response = { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
          throw err;
        },
        list: async () => ({ data: { files: [] } }),
        get: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      permissions: { create: async () => ({ data: {} }) },
    });

    let thrown = null;
    try {
      await refusing.uploadFile({
        name: 'a.png',
        mimeType: 'image/png',
        content: Buffer.from('x'),
        parentFolderId: 'p',
      });
    } catch (err) { thrown = err; }

    check('6a. it is reported as an authentication failure', !!thrown && thrown.statusCode === 401,
      thrown && thrown.statusCode);
    check('6b. ...not as a Drive permission problem',
      !!thrown && !/permission error/.test(thrown.message), thrown && thrown.message);
    check('6c. ...it says the stored authorization is the thing that died',
      !!thrown && /invalid_grant/.test(thrown.message), thrown && thrown.message);
    check('6d. ...and that a Testing app expires one after seven days',
      !!thrown && /seven days/.test(thrown.message), thrown && thrown.message);
    check('6e. it is not retried, because no retry can fix it',
      !!thrown && thrown.retryable === false);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n7. nothing secret comes back out');
  {
    const controller = require(path.join(ROOT, 'src/controllers/integrations.controller'));
    await oauth.storeRefreshToken('1//dummy-refresh-token-not-real', null);

    // catchAsync hands errors to next() rather than returning a
    // promise, so the answer is waited for rather than awaited.
    const body = await new Promise((resolve, reject) => {
      const res = {
        status() { return this; },
        json(payload) { resolve(payload); return this; },
      };
      controller.getGoogleOAuthStatus({ user: { id: 'user-42', role: 'OWNER' } }, res, reject);
      setTimeout(() => reject(new Error('the status endpoint never answered')), 10000);
    });

    const text = JSON.stringify(body);
    check('7a. the status says the account is connected',
      body && body.data && body.data.authorized === true, body && body.data);
    check('7b. ...without the refresh token in it',
      !text.includes('dummy-refresh-token'), text.slice(0, 200));
    check('7c. ...and without the client secret',
      !text.includes('test-only-client-secret'));
    check('7d. it states the callback to register, which is the one setting people get wrong',
      body.data.redirectUri === 'https://studio.example.test/api/v1/integrations/google/callback',
      body.data.redirectUri);
    check('7e. ...and whether the folder still has to be handed over with the Picker',
      body.data.needsPicker === true);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n8. the routes, through the real application');
  {
    const http = require('http');
    const { createApp } = require(path.join(ROOT, 'src/app'));
    const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));

    const ownerRole = await prisma.role.create({
      data: { name: 'OWNER', description: 'test', permissions: ['*'] },
    });
    const staffRole = await prisma.role.create({
      data: { name: 'STAFF', description: 'test', permissions: ['reference_images:read'] },
    });
    const PASSWORD = 'dummy-password-oauth-test';
    await prisma.user.create({
      data: { name: 'Store Owner', email: 'owner@example.test', passwordHash: await hashPassword(PASSWORD), roleId: ownerRole.id },
    });
    await prisma.user.create({
      data: { name: 'Priya', email: 'staff@example.test', passwordHash: await hashPassword(PASSWORD), roleId: staffRole.id },
    });

    const server = http.createServer(createApp());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;

    const call = async (method, route, token, body) => {
      const res = await fetch(base + route, {
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          token ? { Authorization: `Bearer ${token}` } : {},
        ),
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* the callback answers HTML */ }
      return { status: res.status, text, json };
    };

    const signIn = async (email) => {
      const res = await call('POST', '/auth/login', null, { email, password: PASSWORD });
      return (res.json && (res.json.data?.accessToken || res.json.accessToken)) || '';
    };

    // THE ROUTE GOOGLE DRIVES. It is a top-level browser navigation
    // with no Authorization header: behind authenticate() it could
    // never succeed, and the connection would fail at the last step
    // every time. So it has to answer unauthenticated -- and refuse
    // anything it did not itself issue.
    const bare = await call('GET', '/integrations/google/callback');
    check('8a. the callback answers without a login', bare.status !== 401 && bare.status !== 403,
      bare.status);
    check('8b. ...with a page, not JSON', /<!doctype html>/i.test(bare.text), bare.text.slice(0, 60));

    const forged = await call('GET', '/integrations/google/callback?code=x&state=forged.signature');
    check('8c. a forged state is refused', forged.status === 400 && /could not be verified/i.test(forged.text),
      forged.text.slice(0, 120));

    const noState = await call('GET', `/integrations/google/callback?code=x`);
    check('8d. ...and so is a missing one', noState.status === 400);

    const denied = await call('GET', '/integrations/google/callback?error=access_denied');
    check('8e. Google’s own refusal is shown as itself',
      denied.status === 400 && /access_denied/.test(denied.text), denied.text.slice(0, 120));

    // Everything else is the owner's alone.
    const anon = await call('GET', '/integrations/google/status');
    check('8f. the status needs a login', anon.status === 401, anon.status);

    const staffToken = await signIn('staff@example.test');
    const staffTry = await call('POST', '/integrations/google/connect', staffToken);
    check('8g. ...and staff cannot connect the studio’s Google account', staffTry.status === 403,
      staffTry.status);

    const ownerToken = await signIn('owner@example.test');
    const status = await call('GET', '/integrations/google/status', ownerToken);
    check('8h. the owner is told the state of it',
      status.status === 200 && status.json.data.configured === true, status.json && status.json.data);
    check('8i. ...and still no secret comes back',
      !status.text.includes('dummy-refresh-token') && !status.text.includes('test-only-client-secret'));

    const start = await call('POST', '/integrations/google/connect', ownerToken);
    check('8j. the owner can start the flow',
      start.status === 200 && /accounts\.google\.com/.test(start.json.data.url), start.json && start.json.data);

    // A state the real endpoint issued completes the round trip --
    // the exchange itself is Google's and cannot run from here, so
    // what is proved is that the callback accepts its own state and
    // fails on the code rather than on the login.
    const issued = new URL(start.json.data.url).searchParams.get('state');
    const replay = await call('GET', `/integrations/google/callback?code=not-a-real-code&state=${encodeURIComponent(issued)}`);
    check('8k. ...and the callback accepts the state it issued, failing only on Google’s code',
      replay.status === 400 && !/could not be verified/i.test(replay.text)
      && /could not be completed/i.test(replay.text), replay.text.slice(0, 200));

    // THE SELF-TEST, end to end through the real route: folder, the
    // Theme/Room tree, an upload, a public link, and the clean-up --
    // against a Drive that records what it was asked to do.
    const driveClient = drive.googleDriveClient;
    const made = [];
    const uploaded = [];
    const publicised = [];
    const deleted = [];
    driveClient.isConfigured = () => true;
    driveClient.getFolderById = async (id) => ({ id, name: 'Reference Images' });
    driveClient.getOrCreateFolder = async (name, parent) => {
      made.push({ name, parent });
      return { id: 'folder-' + name, name };
    };
    driveClient.uploadFile = async (input) => {
      uploaded.push(input);
      return { id: 'uploaded-1', name: input.name };
    };
    driveClient.generatePublicLink = async (id) => { publicised.push(id); return 'https://drive/' + id; };
    driveClient.deleteFile = async (id) => { deleted.push(id); };

    await oauth.storeRefreshToken('1//dummy-refresh-token-not-real', null);
    driveClient.resetAuth();
    library.clearLibraryFolderCache();

    const test = await call('POST', '/integrations/drive/self-test', ownerToken);
    check('8l. the self-test runs and passes',
      test.status === 200 && test.json.data.ok === true,
      test.json && test.json.data && test.json.data.steps);
    check('8m. ...it built <folder>/British/Bathroom, in that order',
      made.length === 2
      && made[0].name === 'British' && made[0].parent === '1RefImagesFolderId'
      && made[1].name === 'Bathroom' && made[1].parent === 'folder-British', made);
    check('8n. ...uploaded one real PNG into the room folder',
      uploaded.length === 1
      && uploaded[0].parentFolderId === 'folder-Bathroom'
      && uploaded[0].mimeType === 'image/png'
      && uploaded[0].content.slice(1, 4).toString() === 'PNG', uploaded.length);
    check('8o. ...made it readable by link', publicised.length === 1 && publicised[0] === 'uploaded-1');
    check('8p. ...and removed its own test picture again',
      deleted.length === 1 && deleted[0] === 'uploaded-1', deleted);
    check('8q. every step is reported, so a failure names itself',
      (test.json.data.steps || []).length === 6
      && test.json.data.steps.every((s) => s.step && s.detail), test.json.data.steps);

    // And it reports a failure rather than claiming success.
    driveClient.uploadFile = async () => { throw new Error('Service Accounts do not have storage quota.'); };
    const failed = await call('POST', '/integrations/drive/self-test', ownerToken);
    check('8r. a refused upload is reported as a failure, with Google’s words',
      failed.json.data.ok === false
      && failed.json.data.steps.some((s) => !s.ok && /storage quota/.test(s.detail)),
      failed.json.data.steps);

    await new Promise((r) => server.close(r));
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
