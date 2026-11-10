/**
 * De'vyora Client Wishlist -- the backend foundation.
 *
 * The real server and a real Postgres with the real migration applied.
 * No stubbed Prisma: the whole point of this chunk is the database --
 * that one client cannot reach another's choices, that the same room
 * cannot be hearted twice, that a submitted round stops changing, and
 * that deleting a library picture does not rewrite what a client chose.
 * A stubbed table proves none of that, because the constraints live in
 * the migration.
 *
 * Google Drive is replaced at its own boundary (this machine has no
 * credential for it). Every secret here is a dummy.
 *
 * Run:  node test-scripts/client_wishlist_test.js
 */

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_wishlist?host=/var/tmp';

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: DB_URL,
  JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
  ENCRYPTION_KEY: '0'.repeat(64),
  BCRYPT_SALT_ROUNDS: '10',
  LOG_LEVEL: 'error',
  RATE_LIMIT_MAX: '100000',
  GOOGLE_DRIVE_ROOT_FOLDER: 'TestDriveRoot',
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

async function main() {
  const admin = DB_URL.replace(/\/tm_wishlist\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_wishlist'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_wishlist'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));
  const drive = require(path.join(ROOT, 'src/services/googleDrive.service'));
  drive.googleDriveClient.isConfigured = () => true;
  drive.googleDriveClient.deleteFile = async () => {};

  // ── the studio, and two uploaded library pictures ────────────────
  const ownerRole = await prisma.role.create({
    // ["*"], exactly as prisma/seed.ts seeds the Owner.
    data: { name: 'OWNER', description: 'test', permissions: ['*'] },
  });
  const PASSWORD = 'dummy-password-wishlist';
  const owner = await prisma.user.create({
    data: {
      name: 'Priya Sharma',
      email: 'priya@example.test',
      passwordHash: await hashPassword(PASSWORD),
      roleId: ownerRole.id,
    },
  });

  const picture = await prisma.libraryReference.create({
    data: {
      themeId: 'british',
      title: 'Heritage Green Cloakroom',
      imageUrl: 'https://drive.google.com/uc?export=download&id=file-british-1',
      driveFileId: 'file-british-1',
      room: 'Bathroom',
      uploadedById: owner.id,
    },
  });
  const doomed = await prisma.libraryReference.create({
    data: {
      themeId: 'moroccan',
      title: 'Zellige Courtyard',
      imageUrl: 'https://drive.google.com/uc?export=download&id=file-moroccan-1',
      driveFileId: 'file-moroccan-1',
      uploadedById: owner.id,
    },
  });

  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/api/v1`;

  async function call(method, url, body, token) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  }

  const W = '/client-wishlists';

  try {
    // ── 1. registration ──────────────────────────────────────────
    const noName = await call('POST', `${W}/register`, { phone: '9876543210' });
    check('1. a registration with no name is refused', noName.status === 400, noName);

    const blankName = await call('POST', `${W}/register`, { name: '   ' });
    check('2. a name of only spaces is refused', blankName.status === 400, blankName);

    const a = await call('POST', `${W}/register`, { name: 'Aarti Mehta', phone: '9876543210' });
    check('3. a name and a number start a wishlist', a.status === 201 && !!a.body?.data?.token, a.body);
    check('4. the client gets an id, a code and a status',
      !!a.body?.data?.clientId && /^DV-[A-Z2-9]{5}$/.test(a.body?.data?.code || '')
      && a.body?.data?.status === 'DRAFT',
      a.body?.data);
    check('5. registration is timestamped', !!a.body?.data?.registeredAt, a.body?.data?.registeredAt);

    // A client who will not leave a number still gets a wishlist.
    const b = await call('POST', `${W}/register`, { name: 'Rohit Nair' });
    check('6. the mobile number is optional',
      b.status === 201 && !!b.body?.data?.token && b.body?.data?.phone === null, b.body?.data);

    const tokenA = a.body.data.token;
    const tokenB = b.body.data.token;
    check('7. two clients get different tokens and different codes',
      tokenA !== tokenB && a.body.data.code !== b.body.data.code);
    check('8. two clients with their own rows, not one shared customer',
      a.body.data.clientId !== b.body.data.clientId);

    // Same name twice is two clients, not a reused one.
    const bAgain = await call('POST', `${W}/register`, { name: 'Aarti Mehta' });
    check('9. the same name again is a second client, not the first one reopened',
      bAgain.body?.data?.clientId !== a.body.data.clientId);

    // ── 2. the token is the only key ─────────────────────────────
    const stranger = await call('GET', `${W}/not-a-real-token`);
    check('10. an invented token opens nothing', stranger.status === 404, stranger.status);

    // ── 3. nothing the browser says about a picture is believed ──
    const lied = await call('POST', `${W}/${tokenA}/items`, {
      imageId: picture.id,
      themeId: 'floral',
      title: 'Whatever The Client Typed',
      imageUrl: 'https://evil.test/not-ours.png',
      driveFileId: 'some-other-file',
    });
    check('11. hearting a library room is accepted', lied.status === 201, lied.body);

    const storedRow = await prisma.wishlistItem.findFirst({ where: { imageId: picture.id } });
    check('12. the theme is read from the library, not from the request',
      storedRow?.themeId === 'british', storedRow?.themeId);
    check('13. the title is read from the library, not from the request',
      storedRow?.title === 'Heritage Green Cloakroom', storedRow?.title);
    check('14. the image url is the library picture, not a url the client sent',
      /file-british-1/.test(storedRow?.imageUrl || '')
      && !/evil\.test/.test(storedRow?.imageUrl || ''), storedRow?.imageUrl);
    check('15. the Drive file id is the library one',
      storedRow?.driveFileId === 'file-british-1', storedRow?.driveFileId);
    check('16. the original library picture is referenced by id',
      storedRow?.libraryReferenceId === picture.id, storedRow?.libraryReferenceId);
    check('17. the room survives', storedRow?.room === 'Bathroom', storedRow?.room);
    check('18. the selection is timestamped', !!storedRow?.createdAt, storedRow?.createdAt);

    const madeUp = await call('POST', `${W}/${tokenA}/items`, { imageId: 'does-not-exist' });
    check('19. a picture that is not in the library cannot be hearted',
      madeUp.status === 404, madeUp.status);
    check('20. and nothing was written for it',
      (await prisma.wishlistItem.count({ where: { imageId: 'does-not-exist' } })) === 0);

    // ── 4. the same room twice is still one choice ───────────────
    const twice = await call('POST', `${W}/${tokenA}/items`, { imageId: picture.id });
    check('21. hearting the same room twice is not an error', twice.status === 200, twice.body);
    check('22. ...and did not add it twice', twice.body?.data?.added === false, twice.body?.data);
    check('23. one row, not two',
      (await prisma.wishlistItem.count({ where: { imageId: picture.id } })) === 1);

    // ── 5. the starters a client can also choose ─────────────────
    const starter = await call('POST', `${W}/${tokenA}/items`, { imageId: 'starter:british-bathroom' });
    check('24. a starter room can be hearted too', starter.status === 201, starter.body);
    const starterRow = await prisma.wishlistItem.findFirst({ where: { imageId: 'starter:british-bathroom' } });
    check('25. its theme comes from the shipped file',
      starterRow?.themeId === 'british', starterRow?.themeId);
    check('26. a starter has no Drive file and no library row to point at',
      starterRow?.driveFileId === null && starterRow?.libraryReferenceId === null, starterRow);
    const starterTwice = await call('POST', `${W}/${tokenA}/items`, { imageId: 'starter:british-bathroom' });
    check('27. a starter cannot be hearted twice either',
      starterTwice.body?.data?.added === false
      && (await prisma.wishlistItem.count({ where: { imageId: 'starter:british-bathroom' } })) === 1);

    const fakeStarter = await call('POST', `${W}/${tokenA}/items`, { imageId: 'starter:not-a-room' });
    check('28. an invented starter id is refused', fakeStarter.status === 404, fakeStarter.status);

    // ── 6. ONE CLIENT CANNOT REACH ANOTHER'S WISHLIST ────────────
    await call('POST', `${W}/${tokenB}/items`, { imageId: doomed.id });

    const mineA = await call('GET', `${W}/${tokenA}`);
    const mineB = await call('GET', `${W}/${tokenB}`);
    const idsA = (mineA.body?.data?.items || []).map((i) => i.imageId);
    const idsB = (mineB.body?.data?.items || []).map((i) => i.imageId);
    check('29. each client sees their own choices',
      idsA.includes(picture.id) && idsA.includes('starter:british-bathroom')
      && idsB.includes(doomed.id), { idsA, idsB });
    check('30. and none of the other client’s',
      !idsA.includes(doomed.id) && !idsB.includes(picture.id), { idsA, idsB });
    check('31. a wishlist never carries another client’s name',
      mineA.body?.data?.name === 'Aarti Mehta' && mineB.body?.data?.name === 'Rohit Nair');

    // The credential is shown once, at registration, and never again.
    check('32. reading a wishlist does not echo its token',
      !JSON.stringify(mineA.body).includes(tokenA), 'the token came back in the response');

    // B cannot remove A's item even by naming it exactly.
    const crossRemove = await call('DELETE', `${W}/${tokenB}/items/${picture.id}`);
    check('33. one client cannot unheart another’s room',
      crossRemove.status === 200
      && (await prisma.wishlistItem.count({ where: { imageId: picture.id } })) === 1,
      crossRemove.body);

    // ── 7. unhearting ────────────────────────────────────────────
    const gone = await call('DELETE', `${W}/${tokenA}/items/${picture.id}`);
    check('34. a client can unheart a room',
      gone.status === 200 && gone.body?.data?.removed === true
      && (await prisma.wishlistItem.count({ where: { imageId: picture.id } })) === 0, gone.body);
    const goneTwice = await call('DELETE', `${W}/${tokenA}/items/${picture.id}`);
    check('35. unhearting it again is not an error',
      goneTwice.status === 200 && goneTwice.body?.data?.removed === false, goneTwice.body);

    // ── 8. submitting ────────────────────────────────────────────
    const empty = await call('POST', `${W}/register`, { name: 'Nobody Chose Anything' });
    const emptySubmit = await call('POST', `${W}/${empty.body.data.token}/submit`);
    check('36. an empty wishlist cannot be submitted', emptySubmit.status === 400, emptySubmit.status);

    const submitted = await call('POST', `${W}/${tokenA}/submit`);
    check('37. a wishlist can be submitted',
      submitted.status === 200 && submitted.body?.data?.status === 'SUBMITTED'
      && !!submitted.body?.data?.submittedAt, submitted.body?.data);

    const firstSubmittedAt = submitted.body.data.submittedAt;
    const again = await call('POST', `${W}/${tokenA}/submit`);
    check('38. submitting again is safe and keeps the first time',
      again.status === 200 && again.body?.data?.alreadySubmitted === true
      && again.body?.data?.submittedAt === firstSubmittedAt, again.body?.data);

    const afterAdd = await call('POST', `${W}/${tokenA}/items`, { imageId: doomed.id });
    check('39. a submitted wishlist stops changing', afterAdd.status === 400, afterAdd.status);
    const afterRemove = await call('DELETE', `${W}/${tokenA}/items/starter:british-bathroom`);
    check('40. ...for removals too', afterRemove.status === 400, afterRemove.status);

    // ── 9. the themes a client chooses from ──────────────────────
    const themes = await call('GET', `${W}/browse/themes`);
    const list = themes.body?.data?.themes || [];
    const others = list.find((t) => t.id === 'others');
    check('41. the nine themes are offered, plus Others',
      list.length === 10 && !!others && list.filter((t) => t.id !== 'others').length === 9,
      list.map((t) => t.id));
    check('42. Others is every room in all of them, not a tenth theme',
      others?.count === list.filter((t) => t.id !== 'others').reduce((s, t) => s + t.count, 0),
      { others: others?.count });
    check('43. the themes are the studio’s own nine',
      ['british', 'moroccan'].every((id) => list.some((t) => t.id === id)), list.map((t) => t.id));

    // ── 10. the pictures in a theme, and in Others ───────────────
    const british = await call('GET', `${W}/browse/images?themeId=british`);
    const bImages = british.body?.data?.images || [];
    check('44. a theme shows its starters and the studio’s own uploads',
      bImages.some((i) => i.imageId === picture.id) && bImages.some((i) => i.isStarter),
      bImages.map((i) => i.imageId));
    check('45. every picture in a theme belongs to it',
      bImages.every((i) => i.themeId === 'british'), bImages.map((i) => i.themeId));
    check('46. a Drive picture is given in a form a browser can draw',
      /thumbnail\?id=/.test(bImages.find((i) => i.imageId === picture.id)?.imageUrl || ''),
      bImages.find((i) => i.imageId === picture.id)?.imageUrl);

    const everything = await call('GET', `${W}/browse/images?themeId=others`);
    const all = everything.body?.data?.images || [];
    check('47. Others shows every theme’s rooms, uploads and starters alike',
      all.some((i) => i.themeId === 'british') && all.some((i) => i.themeId === 'moroccan')
      && all.filter((i) => i.isStarter).length > 9 && all.length > bImages.length,
      { all: all.length, british: bImages.length, starters: all.filter((i) => i.isStarter).length });

    const nonsense = await call('GET', `${W}/browse/images?themeId=klingon`);
    check('48. a theme that does not exist is refused', nonsense.status === 400, nonsense.status);

    // ── 11. what the studio sees ─────────────────────────────────
    const locked = await call('GET', `${W}/studio/all`);
    check('49. the studio’s own view needs a login', locked.status === 401, locked.status);

    const login = await call('POST', '/auth/login', { email: 'priya@example.test', password: PASSWORD });
    const jwt = login.body?.data?.accessToken || login.body?.data?.tokens?.accessToken;
    check('50. the studio can log in', !!jwt, login.body);

    const studio = await call('GET', `${W}/studio/all`, undefined, jwt);
    const sent = studio.body?.data?.wishlists || [];
    check('51. the studio sees what clients have sent',
      studio.status === 200 && sent.length === 1 && sent[0].status === 'SUBMITTED',
      sent.map((w) => w.status));
    check('52. with the client’s name, their code and how many rooms',
      sent[0]?.client?.name === 'Aarti Mehta' && /^DV-/.test(sent[0]?.code || '')
      && sent[0]?.itemCount === 1, sent[0]);
    check('53. a client’s token is never in the studio’s view',
      !JSON.stringify(studio.body).includes(tokenA)
      && !JSON.stringify(studio.body).includes(tokenB));

    const drafts = await call('GET', `${W}/studio/all?status=ALL`, undefined, jwt);
    check('54. drafts are there when asked for, and not before',
      (drafts.body?.data?.wishlists || []).length > 1,
      (drafts.body?.data?.wishlists || []).length);

    const one = await call('GET', `${W}/studio/${sent[0].id}`, undefined, jwt);
    check('55. one wishlist can be opened in full',
      one.status === 200 && (one.body?.data?.items || []).length === 1
      && !!one.body?.data?.items?.[0]?.selectedAt, one.body?.data);

    // ── 12. the library may change; a client's choice may not ────
    await prisma.libraryReference.delete({ where: { id: doomed.id } });
    const survivor = await prisma.wishlistItem.findFirst({ where: { imageId: doomed.id } });
    check('56. deleting a library picture does not delete what a client chose',
      !!survivor, survivor);
    check('57. ...and does not rewrite it either',
      survivor?.title === 'Zellige Courtyard' && survivor?.themeId === 'moroccan'
      && survivor?.libraryReferenceId === null, survivor);

    // ── 13. a client removed is a client removed ─────────────────
    const customerB = b.body.data.clientId;
    const wishlistB = await prisma.clientWishlist.findFirst({ where: { customerId: customerB } });
    await prisma.customer.delete({ where: { id: customerB } });
    check('58. deleting a client takes their wishlist with it',
      (await prisma.clientWishlist.count({ where: { id: wishlistB.id } })) === 0);
    check('59. ...and leaves no orphaned selections',
      (await prisma.wishlistItem.count({ where: { wishlistId: wishlistB.id } })) === 0);
  } finally {
    server.close();
    await prisma.$disconnect();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('  failed:', failures.join(' | ')); process.exit(1); }
}

main().catch((error) => { console.error(error); process.exit(1); });
