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

/** A Prisma-shaped failure with the given code. */
function describeTokenStoreFailureFor(code) {
  const err = new Error('prisma');
  err.code = code;
  // eslint-disable-next-line no-undef
  return oauthRef.describeTokenStoreFailure(err);
}

let oauthRef = null;

async function main() {
  execFileSync('psql', [DB_URL.replace(/\/tm_oauth\?/, '/postgres?'), '-c', 'drop database if exists tm_oauth'], { stdio: 'ignore' });
  execFileSync('psql', [DB_URL.replace(/\/tm_oauth\?/, '/postgres?'), '-c', 'create database tm_oauth'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { config } = require(path.join(ROOT, 'src/config/index'));
  const oauth = require(path.join(ROOT, 'src/services/googleOAuth.service'));
  oauthRef = oauth;
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

    // A SERVERLESS INSTANCE THAT ASKED TOO EARLY. Each one holds its
    // own copy of this, so an instance that answered a request before
    // the owner connected must not go on insisting the account is
    // unconnected -- which is precisely the minute afterwards, when
    // the owner uploads. The absence of a token is never remembered.
    await oauth.forgetRefreshToken();
    check('3e2. an unconnected read is not cached',
      (await oauth.isOAuthAuthorized()) === false);
    await prisma.apiKey.create({
      data: {
        service: oauth.OAUTH_SERVICE,
        label: 'written by another instance',
        encryptedValue: require(path.join(ROOT, 'src/utils/crypto'))
          .encryptSecret('1//written-elsewhere', require(path.join(ROOT, 'src/utils/crypto'))
            .deriveEncryptionKey(config.auth.encryptionKey)),
      },
    });
    check('3e3. ...so a token another instance wrote is picked up at once',
      (await oauth.readRefreshToken()) === '1//written-elsewhere');

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
  console.log('\n3z. and when there is nowhere to keep it');
  {
    // THE WORST MOMENT FOR A VAGUE ERROR. Google has already said yes,
    // and it will not issue a second refresh token until the owner
    // removes the app from their account -- so "could not be
    // completed" sends somebody back to Google, which is not where
    // the problem is. An un-migrated database is exactly this case:
    // the token is kept in api_keys.
    const missingTable = describeTokenStoreFailureFor('P2021');
    check('3z1. an un-migrated database is named as the reason',
      /no api_keys table/.test(missingTable), missingTable);
    check('3z2. ...with the command that fixes it',
      /prisma migrate deploy/.test(missingTable), missingTable);
    check('3z3. ...and the warning that Google will not issue a second one',
      /myaccount\.google\.com\/permissions/.test(missingTable)
      && /only on a first authorization|only on a first|refresh token only/.test(missingTable),
      missingTable);
    check('3z4. a missing column is the same answer',
      /no api_keys table/.test(describeTokenStoreFailureFor('P2022')));

    const other = oauth.describeTokenStoreFailure(new Error('connection refused'));
    check('3z5. anything else is passed through as itself',
      /connection refused/.test(other) && !/api_keys/.test(other), other);
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
    // CONFIGURED IS NOT CONNECTED. Setting the client id and secret
    // feels like finishing, and it is not: nothing is authorized until
    // somebody presses Connect once. That state was being answered
    // with the whole shared-drive-and-delegation essay -- true, and
    // useless, when the answer is one button on a linked page.
    check('5b. ...and that a sign-in is set up but unused, which is the state it is in',
      /has a Google sign-in set up/.test(status.reason)
      && /press\s+Connect/.test(status.reason), status.reason);
    check('5b2. ...not the shared-drive essay, which nothing here can act on',
      !/SHARED DRIVE/.test(status.reason), status.reason);

    // With no OAuth client configured at all there is nothing to
    // press, so the full answer is still the right one.
    const savedClientId = config.google.oauthClientId;
    config.google.oauthClientId = '';
    library.clearLibraryFolderCache();
    const bare = await library.describeLibraryFolder();
    check('5b3. with no OAuth client configured, both real configurations are named',
      /SHARED DRIVE/.test(bare.reason)
      && /GOOGLE_DRIVE_IMPERSONATE_USER/.test(bare.reason), bare.reason);
    config.google.oauthClientId = savedClientId;

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
    check('6f. ...and the client built on the dead authorization is dropped',
      !!thrown && thrown.authExpired === true);

    // ...and the client that holds the dead token is actually thrown
    // away, or every later call in this process replays it.
    let dropped = 0;
    const dropping = new drive.GoogleDriveClient({
      files: {
        create: async () => {
          const err = new Error('invalid_grant');
          err.response = { status: 400, data: { error: 'invalid_grant' } };
          throw err;
        },
        list: async () => ({ data: { files: [] } }),
        get: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      permissions: { create: async () => ({ data: {} }) },
    });
    dropping.resetAuth = () => { dropped += 1; };
    try {
      await dropping.uploadFile({
        name: 'a.png', mimeType: 'image/png', content: Buffer.from('x'), parentFolderId: 'p',
      });
    } catch { /* expected */ }
    check('6g. ...and the client holding it is dropped, once', dropped === 1, dropped);

    // A plain Drive failure must NOT throw the credential away.
    let keptDrops = 0;
    const notFound = new drive.GoogleDriveClient({
      files: {
        create: async () => {
          const err = new Error('nope');
          err.response = { status: 404, data: { error: { message: 'File not found' } } };
          throw err;
        },
        list: async () => ({ data: { files: [] } }),
        get: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      permissions: { create: async () => ({ data: {} }) },
    });
    notFound.resetAuth = () => { keptDrops += 1; };
    try {
      await notFound.uploadFile({
        name: 'a.png', mimeType: 'image/png', content: Buffer.from('x'), parentFolderId: 'p',
      });
    } catch { /* expected */ }
    check('6h. ...while an ordinary Drive error leaves the credential alone', keptDrops === 0);
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
    // Drive asked again, independently of the upload's own answer.
    driveClient.describeFile = async (id) => (deleted.includes(id)
      ? null
      : { id, name: 'devyora-connection-test.png', parents: ['folder-Bathroom'] });

    // The anonymous fetch of the public link goes to drive.google.com,
    // which is not reachable from a test. Only that host is answered
    // here; everything else -- this suite's own HTTP calls to the app
    // -- goes to the real fetch.
    const realFetch = global.fetch;
    let anonymousFetches = 0;
    let anonymousStatus = 200;
    global.fetch = async (url, init) => {
      if (String(url).includes('drive.google.com')) {
        anonymousFetches += 1;
        return {
          ok: anonymousStatus < 400,
          status: anonymousStatus,
          headers: { get: () => 'image/png' },
        };
      }
      return realFetch(url, init);
    };

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
      (test.json.data.steps || []).length === 9
      && test.json.data.steps.every((s) => s.step && s.detail), test.json.data.steps);

    // A 200 ON THE UPLOAD IS NOT EVIDENCE THE PICTURE IS THERE.
    const stepNamed = (fragment) =>
      (test.json.data.steps || []).find((s) => s.step.includes(fragment));
    check('8q2. ...and the file is looked up again, in the folder it should be in',
      !!stepNamed('Finding it again') && stepNamed('Finding it again').ok
      && /folder-Bathroom/.test(stepNamed('Finding it again').detail),
      stepNamed('Finding it again'));
    check('8q3. ...the link is fetched with no credentials, as the generator will',
      anonymousFetches === 1 && stepNamed('no credentials').ok, anonymousFetches);
    check('8q4. ...and the test picture is confirmed gone, not merely deleted',
      !!stepNamed('Confirming it is gone') && stepNamed('Confirming it is gone').ok);

    // Each failure is a different failure, and says which.
    anonymousStatus = 403;
    const blocked = await call('POST', '/integrations/drive/self-test', ownerToken);
    const shareStep = (blocked.json.data.steps || []).find((s) => s.step.includes('no credentials'));
    check('8q5. a file that uploads but cannot be read anonymously is named as a sharing restriction',
      blocked.json.data.ok === false && !!shareStep && !shareStep.ok
      && /sharing restriction/.test(shareStep.detail)
      && /rather than[\s\S]*an upload failure/.test(shareStep.detail), shareStep);
    anonymousStatus = 200;

    // ...and a file that lands in the wrong place is not a pass.
    driveClient.describeFile = async (id) => ({ id, name: 'x.png', parents: ['somewhere-else'] });
    const misplaced = await call('POST', '/integrations/drive/self-test', ownerToken);
    const findStep = (misplaced.json.data.steps || []).find((s) => s.step.includes('Finding it again'));
    check('8q6. a picture that lands in the wrong folder fails, naming both folders',
      misplaced.json.data.ok === false && !!findStep && !findStep.ok
      && /somewhere-else/.test(findStep.detail) && /folder-Bathroom/.test(findStep.detail),
      findStep);
    driveClient.describeFile = async (id) => (deleted.includes(id)
      ? null
      : { id, name: 'devyora-connection-test.png', parents: ['folder-Bathroom'] });
    global.fetch = realFetch;

    // And it reports a failure rather than claiming success.
    driveClient.uploadFile = async () => { throw new Error('Service Accounts do not have storage quota.'); };
    const failed = await call('POST', '/integrations/drive/self-test', ownerToken);
    check('8r. a refused upload is reported as a failure, with Google’s words',
      failed.json.data.ok === false
      && failed.json.data.steps.some((s) => !s.ok && /storage quota/.test(s.detail)),
      failed.json.data.steps);

    await new Promise((r) => server.close(r));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n9. the fallback must not outlive the thing it falls back from');
  {
    // THE INVISIBLE HALF-CONNECTED STATE. Every serverless instance
    // builds its own Drive client and keeps it. An instance that
    // served one request before the owner pressed Connect would hold
    // a service-account client for as long as it stayed warm -- and
    // the instance that stores the token is rarely the instance that
    // handles the next upload. The studio would see some uploads work
    // and others fail with "Service Accounts do not have storage
    // quota", for no visible reason.
    config.google.serviceAccountJson = JSON.stringify({
      client_email: 'robot@example.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
    });

    const makeStaleClient = () => {
      let used = 0;
      const client = new drive.GoogleDriveClient();
      // Exactly the state a warm instance is in: a client already
      // built, for the service account.
      client.cachedDrive = {
        files: {
          list: async () => { used += 1; return { data: { files: [] } }; },
          create: async () => ({ data: { id: 'x' } }),
          get: async () => ({ data: {} }),
          delete: async () => ({ data: {} }),
        },
        permissions: { create: async () => ({ data: {} }) },
      };
      client.cachedDriveMode = 'service-account';
      return { client, usedCount: () => used };
    };

    // Control: nothing better exists, so the cached client is reused.
    await oauth.forgetRefreshToken();
    const cold = makeStaleClient();
    await cold.client.findFolder('British', 'root').catch(() => {});
    check('9a. with no account connected, the service-account client is reused',
      cold.usedCount() === 1, cold.usedCount());

    // Now the owner connects, on some other instance.
    await oauth.storeRefreshToken('1//dummy-refresh-token-not-real', null);
    const warm = makeStaleClient();
    await warm.client.findFolder('British', 'root').catch(() => {});
    check('9b. once an account IS connected, the stale service-account client is not used',
      warm.usedCount() === 0, warm.usedCount());

    // ...and it is not rebuilt from scratch on every single call once
    // it is the owner's account: a hundred-picture batch would pay for
    // that a hundred times.
    const settled = new drive.GoogleDriveClient();
    settled.cachedDrive = { files: { list: async () => ({ data: { files: [] } }) } };
    settled.cachedDriveMode = 'oauth';
    let rebuilt = false;
    const spyAuthorized = oauth.isOAuthAuthorized;
    oauth.isOAuthAuthorized = async () => { rebuilt = true; return true; };
    await settled.findFolder('British', 'root').catch(() => {});
    oauth.isOAuthAuthorized = spyAuthorized;
    check('9c. an OAuth client already built is reused as it is', rebuilt === false);

    // resetAuth forgets the mode too, or the next call would decide
    // from a mode that no longer describes anything.
    const reset = makeStaleClient();
    reset.client.resetAuth();
    check('9d. resetAuth clears the remembered mode, not just the client',
      reset.client.cachedDrive === null && reset.client.cachedDriveMode === null);

    await oauth.forgetRefreshToken();
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
