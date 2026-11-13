/**
 * Physical Sample Placement & Barcode Tracking -- the backend.
 *
 * The real server and a real Postgres with the real migration applied.
 * No stubbed Prisma: the things most worth proving here are database
 * facts -- that two colours cannot share a barcode, that a relocation
 * leaves exactly one current placement, that a rejected request moves
 * nothing. A stubbed table proves none of it, because the constraints
 * and the transaction live in the database.
 *
 * Google Drive is replaced at its own boundary (this machine has no
 * credential for it), and is deliberately made to FAIL in one test, to
 * show that a sample is registered either way.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/physical_sample_test.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, '..', 'frontend');
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://postgres@localhost:54329/tm_samples?host=/var/tmp';
const LIBRARY_FOLDER = 'library-folder-id';

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
  GOOGLE_DRIVE_LIBRARY_FOLDER: LIBRARY_FOLDER,
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

const PASSWORD = 'dummy-password-samples';

async function main() {
  const admin = DB_URL.replace(/\/tm_samples\?/, '/postgres?');
  execFileSync('psql', [admin, '-c', 'drop database if exists tm_samples'], { stdio: 'ignore' });
  execFileSync('psql', [admin, '-c', 'create database tm_samples'], { stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, stdio: 'ignore', env: process.env });

  require('tsconfig-paths/register');
  require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

  const { prisma } = require(path.join(ROOT, 'src/db/connection'));
  const { createApp } = require(path.join(ROOT, 'src/app'));
  const { hashPassword } = require(path.join(ROOT, 'src/utils/password'));
  const drive = require(path.join(ROOT, 'src/services/googleDrive.service'));

  // ── a Drive that remembers, and can be made to refuse ────────────
  const calls = [];
  const folders = new Map();
  const driveFiles = new Map();
  let seq = 0;
  let driveDown = false;

  const client = drive.googleDriveClient;
  client.isConfigured = () => true;
  client.authMode = async () => 'oauth';
  client.getFolderById = async (id) => ({ id, name: 'Reference Images' });
  client.findFolder = async (name, parent) => {
    calls.push({ op: 'findFolder', name, parent });
    for (const f of folders.values()) if (f.name === name && f.parent === parent) return { id: f.id, name };
    return null;
  };
  client.createFolder = async (name, parent) => {
    calls.push({ op: 'createFolder', name, parent });
    const id = `folder-${++seq}`;
    folders.set(id, { id, name, parent });
    return { id, name };
  };
  client.uploadFile = async ({ name, parentFolderId }) => {
    calls.push({ op: 'uploadFile', name, parent: parentFolderId });
    if (driveDown) throw new Error('Google Drive is unavailable (503)');
    const id = `file-${++seq}`;
    driveFiles.set(id, { id, name, parent: parentFolderId });
    return { id, name };
  };
  client.generatePublicLink = async (id) => `https://drive.google.com/file/d/${id}/view`;
  client.deleteFile = async (fileId) => {
    calls.push({ op: 'deleteFile', fileId });
    throw new Error('the sample module must never delete anything on Drive');
  };

  // ── the studio, and a product with colours to hold ───────────────
  const ownerRole = await prisma.role.create({ data: { name: 'OWNER', description: 't', permissions: ['*'] } });
  const adminRole = await prisma.role.create({
    data: { name: 'ADMIN', description: 't', permissions: ['tiles:read', 'tiles:write', 'customers:read'] },
  });
  const staffRole = await prisma.role.create({
    data: { name: 'STAFF', description: 't', permissions: ['tiles:read', 'customers:read'] },
  });
  const owner = await prisma.user.create({
    data: { name: 'Priya Sharma', email: 'owner@example.test', passwordHash: await hashPassword(PASSWORD), roleId: ownerRole.id },
  });
  await prisma.user.create({
    data: { name: 'Shop Admin', email: 'admin@example.test', passwordHash: await hashPassword(PASSWORD), roleId: adminRole.id },
  });
  await prisma.user.create({
    data: { name: 'Floor Staff', email: 'staff@example.test', passwordHash: await hashPassword(PASSWORD), roleId: staffRole.id },
  });

  const brand = await prisma.brand.create({ data: { name: 'Kajaria', slug: 'kajaria' } });
  const product = await prisma.tile.create({
    data: { name: 'Carrara Statuario', brandId: brand.id, productCode: 'KAJ-CS-600', size: '600x1200' },
  });
  const other = await prisma.tile.create({
    data: { name: 'Travertine Classic', brandId: brand.id, productCode: 'KAJ-TC-800' },
  });

  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/api/v1`;
  const PHOTO = fs.readFileSync(path.join(FRONTEND, 'img/library/british-bathroom.png'));

  async function api(method, url, body, token) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
  }

  async function login(email) {
    const res = await api('POST', '/auth/login', { email, password: PASSWORD });
    return res.body?.data?.accessToken || res.body?.data?.tokens?.accessToken;
  }

  async function registerSample(colourId, cassetteNo, panelNo, token, withPhoto) {
    const form = new FormData();
    form.set('cassetteNo', cassetteNo);
    form.set('panelNo', panelNo);
    if (withPhoto) form.set('file', new Blob([PHOTO], { type: 'image/png' }), 'sample.png');
    const res = await fetch(`${base}/samples/colours/${colourId}/sample`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json };
  }

  try {
    const ownerJwt = await login('owner@example.test');
    const adminJwt = await login('admin@example.test');
    const staffJwt = await login('staff@example.test');
    check('0. the studio can log in', !!ownerJwt && !!adminJwt && !!staffJwt);

    // ══ 1. the four states ════════════════════════════════════════
    step('1. how the studio holds each colour');

    const options = await api('GET', '/samples/availability', undefined, staffJwt);
    check('1a. the four states are served, not hard-coded in a page',
      options.status === 200
      && options.body.data.availability.map((a) => a.id).join(',')
        === 'PHYSICAL_SAMPLE,CATALOGUE_ONLY,CUTOUT_ONLY,NOT_AVAILABLE',
      options.body?.data?.availability?.map((a) => a.id));

    const made = {};
    for (const [name, availability] of [
      ['Carrara White', 'PHYSICAL_SAMPLE'],
      ['Statuario Grey', 'PHYSICAL_SAMPLE'],
      ['Nero Marquina', 'CATALOGUE_ONLY'],
      ['Botticino Beige', 'CUTOUT_ONLY'],
      ['Verde Alpi', 'NOT_AVAILABLE'],
    ]) {
      const res = await api('POST', '/samples/colours',
        { productId: product.id, colourName: name, colourCode: name.slice(0, 3).toUpperCase(), availability },
        adminJwt);
      made[name] = res.body?.data?.colour;
    }
    check('1b. one product carries several colours, each in its own state',
      Object.keys(made).length === 5 && Object.values(made).every((c) => !!c)
      && made['Nero Marquina'].availability === 'CATALOGUE_ONLY'
      && made['Botticino Beige'].availability === 'CUTOUT_ONLY'
      && made['Verde Alpi'].availability === 'NOT_AVAILABLE',
      Object.fromEntries(Object.entries(made).map(([k, v]) => [k, v && v.availability])));

    const dupe = await api('POST', '/samples/colours',
      { productId: product.id, colourName: 'Carrara White', availability: 'PHYSICAL_SAMPLE' }, adminJwt);
    check('1c. the same colour twice is one colour, not two rows',
      dupe.status === 201
      && (await prisma.productColour.count({ where: { productId: product.id } })) === 5);

    const badState = await api('POST', '/samples/colours',
      { productId: product.id, colourName: 'Nonsense', availability: 'MAYBE' }, adminJwt);
    check('1d. an invented state is refused', badState.status === 400, badState.status);

    const noProduct = await api('POST', '/samples/colours',
      { productId: 'does-not-exist', colourName: 'Blue' }, adminJwt);
    check('1e. a colour cannot be hung on a product that is not in the catalogue',
      noProduct.status === 404, noProduct.status);

    // ══ 2. its own sample, its own barcode ════════════════════════
    step('2. each colour gets its own sample and its own barcode');

    const first = await registerSample(made['Carrara White'].id, '4', 'A-12', adminJwt, true);
    check('2a. a physical sample is registered, with its cassette and panel',
      first.status === 201 && first.body.data.placement.cassetteNo === '4'
      && first.body.data.placement.panelNo === 'A-12', first.body?.data?.placement);
    check('2b. ...with its own sample id and its own barcode',
      /^S-[A-Z2-9]{5}$/.test(first.body.data.sample.sampleId)
      && /^DVS-[A-Z2-9]{8}$/.test(first.body.data.sample.barcode), first.body?.data?.sample);
    check('2c. ...and its photograph in the studio’s own Drive folder',
      first.body.data.photoError === ''
      && !!first.body.data.sample.photoUrl
      && [...folders.values()].some((f) => f.name === 'Physical Samples' && f.parent === LIBRARY_FOLDER),
      { photoError: first.body?.data?.photoError });

    const second = await registerSample(made['Statuario Grey'].id, '4', 'A-13', adminJwt, true);
    check('2d. a second colour of the SAME product gets a different sample and barcode',
      second.body.data.sample.sampleId !== first.body.data.sample.sampleId
      && second.body.data.sample.barcode !== first.body.data.sample.barcode,
      { a: first.body.data.sample.barcode, b: second.body.data.sample.barcode });

    check('2e. registering the colour sets it to PHYSICAL_SAMPLE',
      (await prisma.productColour.findUnique({ where: { id: made['Carrara White'].id } })).availability
        === 'PHYSICAL_SAMPLE');

    const again = await registerSample(made['Carrara White'].id, '5', 'B-1', adminJwt, false);
    check('2f. a colour cannot be given a second sample',
      again.status === 400 && /already has a registered sample/i.test(again.body?.message || ''),
      again.body?.message);

    // The database, not the code, is what stops two samples sharing a
    // barcode -- so ask the database.
    const barcodeClash = await prisma.physicalSample.create({
      data: { colourId: made['Nero Marquina'].id, sampleId: 'S-UNIQUE', barcode: first.body.data.sample.barcode },
    }).then(() => 'accepted').catch((e) => e.code);
    check('2g. THE DATABASE refuses a duplicate barcode, not just the code',
      barcodeClash === 'P2002', barcodeClash);

    const sampleIdClash = await prisma.physicalSample.create({
      data: { colourId: made['Nero Marquina'].id, sampleId: first.body.data.sample.sampleId, barcode: 'DVS-UNIQUE00' },
    }).then(() => 'accepted').catch((e) => e.code);
    check('2h. ...and a duplicate sample id', sampleIdClash === 'P2002', sampleIdClash);

    const colourClash = await prisma.productColour.create({
      data: { productId: product.id, colourName: 'Carrara White' },
    }).then(() => 'accepted').catch((e) => e.code);
    check('2i. ...and the same colour name twice on one product', colourClash === 'P2002', colourClash);

    // ══ 3. the scan ══════════════════════════════════════════════
    step('3. one scan, one answer');

    const scan = await api('GET', `/samples/by-barcode/${first.body.data.sample.barcode}`, undefined, staffJwt);
    check('3a. a scan returns the colour, the product and where it sits',
      scan.status === 200
      && scan.body.data.sample.colour.colourName === 'Carrara White'
      && scan.body.data.sample.product.id === product.id
      && scan.body.data.sample.placement.cassetteNo === '4'
      && scan.body.data.sample.placement.panelNo === 'A-12', scan.body?.data?.sample);

    const lower = await api('GET',
      `/samples/by-barcode/${first.body.data.sample.barcode.toLowerCase()}`, undefined, staffJwt);
    check('3b. a barcode in lower case still scans', lower.status === 200);

    const unknown = await api('GET', '/samples/by-barcode/DVS-NOTREAL1', undefined, staffJwt);
    check('3c. one of ours that is not on record says so', unknown.status === 404
      && /no sample carries/i.test(unknown.body?.message || ''), unknown.body?.message);

    const foreign = await api('GET', '/samples/by-barcode/8901234567890', undefined, staffJwt);
    check('3d. ...and somebody else’s barcode is recognisably not ours',
      foreign.status === 404 && /not one of the studio/i.test(foreign.body?.message || ''),
      foreign.body?.message);

    const cassette = await api('GET', '/samples/contents?cassetteNo=4', undefined, staffJwt);
    check('3e. a cassette can be asked what it holds',
      cassette.status === 200 && cassette.body.data.samples.length === 2
      && cassette.body.data.samples.map((s) => s.panelNo).sort().join(',') === 'A-12,A-13',
      cassette.body?.data?.samples?.map((s) => s.panelNo));

    const onePanel = await api('GET', '/samples/contents?cassetteNo=4&panelNo=A-12', undefined, staffJwt);
    check('3f. ...and so can one panel of it', onePanel.body.data.samples.length === 1);

    // ══ 4. a colour that holds a piece cannot be demoted ═════════
    step('4. the shelf and the record cannot disagree');

    const demote = await api('POST', '/samples/colours',
      { productId: product.id, colourName: 'Carrara White', availability: 'CATALOGUE_ONLY' }, adminJwt);
    check('4a. a colour with a sample on a panel cannot be marked catalogue-only',
      demote.status === 400 && /still has a registered physical sample/i.test(demote.body?.message || ''),
      demote.body?.message);
    check('4b. ...and the colour is untouched by the attempt',
      (await prisma.productColour.findUnique({ where: { id: made['Carrara White'].id } })).availability
        === 'PHYSICAL_SAMPLE');

    // ══ 5. moving it needs the Admin ═════════════════════════════
    step('5. a move is asked for, then allowed');

    const sampleId = first.body.data.sample.id;

    const direct = await prisma.samplePlacement.count({ where: { physicalSampleId: sampleId } });
    check('5a. the first placement needed no approval', direct === 1
      && (await prisma.placementChangeRequest.count({ where: { physicalSampleId: sampleId } })) === 0);

    const asked = await api('POST', `/samples/${sampleId}/relocation-requests`,
      { cassetteNo: '7', panelNo: 'C-3', reason: 'Moved for the window display' }, staffJwt);
    check('5b. floor staff may ask for a move', asked.status === 201, asked.body?.message);

    const afterAsk = await prisma.samplePlacement.findFirst({
      where: { physicalSampleId: sampleId, isCurrent: true },
    });
    check('5c. ...and asking moves NOTHING',
      afterAsk.cassetteNo === '4' && afterAsk.panelNo === 'A-12'
      && (await prisma.samplePlacement.count({ where: { physicalSampleId: sampleId } })) === 1,
      { cassetteNo: afterAsk.cassetteNo, panelNo: afterAsk.panelNo });

    const staffApprove = await api('POST',
      `/samples/relocation-requests/${asked.body.data.request.id}/approve`, {}, staffJwt);
    check('5d. floor staff may NOT approve their own move', staffApprove.status === 403, staffApprove.status);

    const twice = await api('POST', `/samples/${sampleId}/relocation-requests`,
      { cassetteNo: '9', panelNo: 'D-1' }, staffJwt);
    check('5e. a second open request for one sample is refused',
      twice.status === 400 && /already waiting/i.test(twice.body?.message || ''), twice.body?.message);

    const queue = await api('GET', '/samples/relocation-requests', undefined, adminJwt);
    check('5f. the Admin sees the request waiting, with where it is going',
      queue.status === 200 && queue.body.data.total === 1
      && queue.body.data.requests[0].to.cassetteNo === '7'
      && queue.body.data.requests[0].from.cassetteNo === '4'
      && queue.body.data.requests[0].requestedBy.name === 'Floor Staff',
      queue.body?.data?.requests?.[0]);

    const approved = await api('POST',
      `/samples/relocation-requests/${asked.body.data.request.id}/approve`,
      { note: 'Agreed' }, adminJwt);
    check('5g. the Admin approves, and THAT is what moves it',
      approved.status === 200 && approved.body.data.placement.cassetteNo === '7'
      && approved.body.data.placement.panelNo === 'C-3', approved.body?.data?.placement);

    const placements = await prisma.samplePlacement.findMany({
      where: { physicalSampleId: sampleId }, orderBy: { placedAt: 'asc' },
    });
    check('5h. the move INSERTED a placement rather than editing one',
      placements.length === 2
      && placements[0].cassetteNo === '4' && placements[0].panelNo === 'A-12',
      placements.map((p) => `${p.cassetteNo}/${p.panelNo}`));
    check('5i. ...exactly one of them is current',
      placements.filter((p) => p.isCurrent).length === 1
      && placements.find((p) => p.isCurrent).cassetteNo === '7',
      placements.map((p) => ({ at: `${p.cassetteNo}/${p.panelNo}`, current: p.isCurrent })));
    check('5j. ...and the one it left is stamped with when it ended',
      !!placements[0].endedAt && placements[0].isCurrent === false, placements[0].endedAt);

    const decidedTwice = await api('POST',
      `/samples/relocation-requests/${asked.body.data.request.id}/approve`, {}, adminJwt);
    check('5k. approving the same request twice is refused',
      decidedTwice.status === 400 && /already approved/i.test(decidedTwice.body?.message || ''),
      decidedTwice.body?.message);

    // ── a refusal moves nothing, and is still recorded ───────────
    const toRefuse = await api('POST', `/samples/${sampleId}/relocation-requests`,
      { cassetteNo: '12', panelNo: 'Z-9', reason: 'Not sure about this one' }, staffJwt);
    const rejected = await api('POST',
      `/samples/relocation-requests/${toRefuse.body.data.request.id}/reject`,
      { note: 'Keep it in the window' }, adminJwt);
    const afterReject = await prisma.samplePlacement.findFirst({
      where: { physicalSampleId: sampleId, isCurrent: true },
    });
    check('5l. a rejected move leaves the sample exactly where it was',
      rejected.status === 200 && rejected.body.data.request.status === 'REJECTED'
      && afterReject.cassetteNo === '7' && afterReject.panelNo === 'C-3'
      && (await prisma.samplePlacement.count({ where: { physicalSampleId: sampleId } })) === 2,
      { at: `${afterReject.cassetteNo}/${afterReject.panelNo}` });
    check('5m. ...and the refusal is on the record, with who refused it and why',
      !!rejected.body.data.request.decidedById
      && !!rejected.body.data.request.decidedAt
      && rejected.body.data.request.decisionNote === 'Keep it in the window',
      {
        decidedById: rejected.body?.data?.request?.decidedById,
        note: rejected.body?.data?.request?.decisionNote,
      });

    // ══ 6. the history ═══════════════════════════════════════════
    step('6. everywhere it has been');

    // Two more approved moves, so the history is worth reading.
    for (const [c, p] of [['2', 'A-1'], ['15', 'B-4']]) {
      const r = await api('POST', `/samples/${sampleId}/relocation-requests`, { cassetteNo: c, panelNo: p }, staffJwt);
      await api('POST', `/samples/relocation-requests/${r.body.data.request.id}/approve`, {}, adminJwt);
    }

    const hist = await api('GET', `/samples/${sampleId}/history`, undefined, staffJwt);
    const trail = hist.body.data.placements.map((p) => `${p.cassetteNo}/${p.panelNo}`);
    check('6a. every placement it has ever had is kept, newest first',
      hist.status === 200 && trail.length === 4
      && trail[0] === '15/B-4' && trail[3] === '4/A-12', trail);
    check('6b. ...with exactly one current, and the rest ended',
      hist.body.data.placements.filter((p) => p.isCurrent).length === 1
      && hist.body.data.placements.filter((p) => p.endedAt).length === 3);
    check('6c. every request is kept too, approved and rejected alike',
      hist.body.data.requests.length === 4
      && hist.body.data.requests.filter((r) => r.status === 'APPROVED').length === 3
      && hist.body.data.requests.filter((r) => r.status === 'REJECTED').length === 1,
      hist.body.data.requests.map((r) => r.status));
    check('6d. ...naming who asked and who decided',
      hist.body.data.requests.every((r) => r.requestedBy && r.requestedBy.name === 'Floor Staff')
      && hist.body.data.requests.every((r) => r.decidedBy && r.decidedBy.name));

    // ══ 7. Drive is not allowed to cost a sample ═════════════════
    step('7. Drive failing costs the studio nothing');

    driveDown = true;
    const noPhoto = await registerSample(made['Verde Alpi'].id, '20', 'E-1', adminJwt, true);
    driveDown = false;

    check('7a. the sample is still registered when Drive refuses',
      noPhoto.status === 201 && !!noPhoto.body.data.sample.sampleId
      && !!noPhoto.body.data.sample.barcode, noPhoto.body?.message);
    check('7b. ...with the reason stated rather than swallowed',
      /drive/i.test(noPhoto.body.data.photoError) && /registered/i.test(noPhoto.body.data.photoError),
      noPhoto.body?.data?.photoError);
    const stored = await prisma.physicalSample.findUnique({
      where: { id: noPhoto.body.data.sample.id },
    });
    check('7c. ...and no half-written photograph',
      stored.photoDriveFileId === null && stored.photoUrl === null);
    check('7d. the sample is findable by its barcode regardless',
      (await api('GET', `/samples/by-barcode/${stored.barcode}`, undefined, staffJwt)).status === 200);

    // ══ 8. who may do what ═══════════════════════════════════════
    step('8. who may do what');

    check('8a. floor staff may scan', (await api('GET',
      `/samples/by-barcode/${first.body.data.sample.barcode}`, undefined, staffJwt)).status === 200);
    const staffColour = await api('POST', '/samples/colours',
      { productId: other.id, colourName: 'Staff Should Not', availability: 'CATALOGUE_ONLY' }, staffJwt);
    check('8b. ...but may not add a colour', staffColour.status === 403, staffColour.status);
    const staffSample = await registerSample(made['Nero Marquina'].id, '1', '1', staffJwt, false);
    check('8c. ...nor register a sample', staffSample.status === 403, staffSample.status);
    const staffQueue = await api('GET', '/samples/relocation-requests', undefined, staffJwt);
    check('8d. ...nor read the approval queue', staffQueue.status === 403, staffQueue.status);
    check('8e. nobody may do any of it without logging in',
      (await api('GET', '/samples/availability')).status === 401
      && (await api('GET', `/samples/by-barcode/${first.body.data.sample.barcode}`)).status === 401);
    check('8f. an admin may approve', (await api('GET',
      '/samples/relocation-requests?status=ALL', undefined, adminJwt)).status === 200);

    // ══ 9. nothing on Drive is ever destroyed ════════════════════
    step('9. the originals, and the rest of the application');

    check('9a. the module never deleted anything on Drive',
      !calls.some((c) => c.op === 'deleteFile'));
    const source = fs.readFileSync(path.join(ROOT, 'src/services/sample.service.ts'), 'utf8')
      + fs.readFileSync(path.join(ROOT, 'src/services/samplePlacement.service.ts'), 'utf8');
    check('9b. ...and has no way to: no deleteFile, no move, no re-parenting',
      !/deleteFile|\baddParents\b|\bremoveParents\b/.test(source));

    check('9c. the catalogue itself is untouched',
      (await prisma.tile.count()) === 2
      && (await prisma.tile.findUnique({ where: { id: product.id } })).name === 'Carrara Statuario');

    // Removing a sample frees the colour but keeps the trail.
    const removed = await api('DELETE', `/samples/${second.body.data.sample.id}`, undefined, adminJwt);
    check('9d. a sample can be taken off the panel',
      removed.status === 200
      && (await prisma.productColour.findUnique({ where: { id: made['Statuario Grey'].id } })).availability
        === 'NOT_AVAILABLE');
    check('9e. ...and the colour can then be re-stated as catalogue-only',
      (await api('POST', '/samples/colours',
        { productId: product.id, colourName: 'Statuario Grey', availability: 'CATALOGUE_ONLY' },
        adminJwt)).status === 201);

    // The activity log carries the whole story, for the audit trail the
    // rest of this application already relies on.
    const logged = await prisma.activityLog.findMany({
      where: { action: { startsWith: 'sample' } }, select: { action: true },
    });
    const actions = new Set(logged.map((l) => l.action));
    check('9f. every step is in the activity log',
      ['sample_colour.created', 'sample_placement.requested',
        'sample_placement.approved', 'sample_placement.rejected'].every((a) => actions.has(a)),
      [...actions]);
    check('9g. ...including registering and removing a sample',
      (await prisma.activityLog.count({ where: { action: 'physical_sample.registered' } })) === 3
      && (await prisma.activityLog.count({ where: { action: 'physical_sample.removed' } })) === 1);
  } finally {
    server.close();
    await prisma.$disconnect();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) { console.log('  failed:', failures.join(' | ')); process.exit(1); }
}

main().catch((error) => { console.error(error); process.exit(1); });
