const path = require('path');
process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'tsconfig.json');
require('tsconfig-paths/register');
require('ts-node/register');
const bcrypt = require('bcryptjs');
const fs = require('fs');

async function main() {
  const roles = new Map();
  roles.set('role-owner', { id: 'role-owner', name: 'OWNER', permissions: ['*'] });
  roles.set('role-staff', { id: 'role-staff', name: 'STAFF', permissions: ['print_boards:write'] });
  const users = new Map();
  let uid = 0;
  async function addUser(name, email, plainPassword, roleId) {
    const id = `user-${++uid}`;
    const row = { id, name, email, passwordHash: await bcrypt.hash(plainPassword, 12), roleId, isActive: true, lastLoginAt: null, createdAt: new Date(), updatedAt: new Date() };
    users.set(id, row);
    return row;
  }
  function withRole(row) { return row ? { ...row, role: roles.get(row.roleId) } : null; }
  await addUser('Store Owner', 'owner@test.com', 'OwnerPass123', 'role-owner');
  await addUser('Staff One', 'staff@test.com', 'StaffPass123', 'role-staff');

  const jobs = new Map();
  let jobIdCounter = 0;

  const { prisma } = require('../src/db/connection');
  prisma.user.findUnique = async ({ where, include }) => {
    let row = null;
    if (where.email) row = [...users.values()].find((u) => u.email === where.email);
    if (where.id) row = users.get(where.id);
    if (!row) return null;
    return include?.role ? withRole(row) : row;
  };
  prisma.user.update = async ({ where, data }) => { const row = users.get(where.id); Object.assign(row, data); return row; };

  prisma.job.create = async ({ data }) => {
    const id = `job-${++jobIdCounter}`;
    const row = { id, attempts: 0, result: null, error: null, completedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
    jobs.set(id, row);
    return row;
  };
  prisma.job.findUnique = async ({ where }) => jobs.get(where.id) || null;
  prisma.job.findFirst = async ({ where }) => {
    let list = [...jobs.values()].filter((j) => j.type === where.type && j.status === where.status);
    if (where.nextAttemptAt?.lte) list = list.filter((j) => j.nextAttemptAt <= where.nextAttemptAt.lte);
    list.sort((a, b) => a.createdAt - b.createdAt);
    return list[0] || null;
  };
  prisma.job.update = async ({ where, data }) => { const row = jobs.get(where.id); Object.assign(row, data, { updatedAt: new Date() }); return row; };
  prisma.job.findMany = async ({ where = {}, skip = 0, take = 50 } = {}) => {
    let list = [...jobs.values()];
    if (where.type) list = list.filter((j) => j.type === where.type);
    if (where.status) list = list.filter((j) => j.status === where.status);
    return list.sort((a, b) => b.createdAt - a.createdAt).slice(skip, skip + take);
  };
  prisma.job.count = async ({ where = {} } = {}) => {
    let list = [...jobs.values()];
    if (where.type) list = list.filter((j) => j.type === where.type);
    if (where.status) list = list.filter((j) => j.status === where.status);
    return list.length;
  };
  prisma.job.groupBy = async ({ where = {} } = {}) => {
    let list = [...jobs.values()];
    if (where.type) list = list.filter((j) => j.type === where.type);
    const counts = new Map();
    for (const j of list) counts.set(j.status, (counts.get(j.status) || 0) + 1);
    return [...counts.entries()].map(([status, count]) => ({ status, _count: { status: count } }));
  };

  prisma.catalog.count = async ({ where }) => (where.status === 'PENDING' ? 1 : 0);

  let refImgId = 0;
  const referenceImages = new Map();
  prisma.referenceImage.create = async ({ data }) => { const id = `ri-${++refImgId}`; const row = { id, thumbnailUrl: null, createdAt: new Date(), ...data }; referenceImages.set(id, row); return row; };
  prisma.referenceImage.update = async ({ where, data }) => { const row = referenceImages.get(where.id); Object.assign(row, data); return row; };
  prisma.referenceImage.findUnique = async ({ where }) => referenceImages.get(where.id) || null;

  const moodBoards = new Map();
  moodBoards.set('mb-1', {
    id: 'mb-1',
    clientBrief: 'Test brief',
    selectedIndex: null,
    combinations: [
      { board_name: 'Test Combo', tiles: [{ tileId: 't-1', name: 'Test Tile', role: 'base', imageUrl: '/x.png', pricePerSqft: 50 }], grout_recommendation: '', rooms_suitable: [], reason_for_selection: '' },
    ],
  });
  prisma.moodBoard.findUnique = async ({ where }) => moodBoards.get(where.id) || null;

  let pbId = 0;
  const printBoards = new Map();
  prisma.printBoard.create = async ({ data }) => { const id = `pb-${++pbId}`; const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data }; printBoards.set(id, row); return row; };
  prisma.printBoard.findUnique = async ({ where }) => printBoards.get(where.id) || null;

  let rtId = 0;
  const refreshTokens = new Map();
  prisma.refreshToken.create = async ({ data }) => { const row = { id: String(++rtId), ...data, revokedAt: null }; refreshTokens.set(data.tokenHash, row); return row; };
  prisma.refreshToken.findUnique = async ({ where }) => refreshTokens.get(where.tokenHash) || null;
  prisma.refreshToken.update = async ({ where, data }) => { const row = [...refreshTokens.values()].find((r) => r.id === where.id); Object.assign(row, data); return row; };
  prisma.refreshToken.updateMany = async () => ({ count: 0 });

  const activityLogs = [];
  prisma.activityLog.create = async ({ data }) => { const row = { id: `log-${activityLogs.length + 1}`, createdAt: new Date(), ...data }; activityLogs.push(row); return row; };

  let pass = 0, fail = 0;
  function check(label, cond, extra) { if (cond) { console.log(`OK   ${label}`); pass++; } else { console.log(`FAIL ${label}`, JSON.stringify(extra)); fail++; } }

  console.log('--- Generic Job Queue mechanics ---');

  const jobQueue = require('../src/services/jobQueue.service');

  jobQueue.registerProcessor('IMAGE_PROCESSING', async (payload) => ({ echoed: payload.value }), { concurrency: 2, pollIntervalMs: 50 });
  const successJob = await jobQueue.enqueueJob('IMAGE_PROCESSING', { value: 'hello' });
  await new Promise((r) => setTimeout(r, 150));
  const successJobRow = await jobQueue.getJob(successJob.id);
  check('1a. A job with a succeeding processor ends up COMPLETED', successJobRow.status === 'COMPLETED', successJobRow);
  check('1b. Its result reflects what the processor actually returned', successJobRow.result?.echoed === 'hello', successJobRow.result);

  let callCount = 0;
  jobQueue.registerProcessor('EXPORT', async () => {
    callCount++;
    if (callCount < 3) throw new Error(`Simulated transient failure #${callCount}`);
    return { madeItOnAttempt: callCount };
  }, { concurrency: 2, pollIntervalMs: 30 });
  const retryJob1 = await jobQueue.enqueueJob('EXPORT', {}, { maxAttempts: 3 });
  let retryJobRow;
  for (let i = 0; i < 60; i++) {
    retryJobRow = await jobQueue.getJob(retryJob1.id);
    if (retryJobRow.status === 'COMPLETED' || retryJobRow.status === 'FAILED') break;
    if (retryJobRow.status === 'PENDING' && retryJobRow.nextAttemptAt > new Date()) {
      await prisma.job.update({ where: { id: retryJob1.id }, data: { nextAttemptAt: new Date() } });
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  check('2a. A processor that fails twice then succeeds eventually reaches COMPLETED (genuine retry, not first-try luck)', retryJobRow.status === 'COMPLETED', retryJobRow);
  check('2b. It took exactly 3 real attempts, not 1', callCount === 3, callCount);
  check('2c. attempts on the row matches the real attempt count', retryJobRow.attempts === 3, retryJobRow.attempts);

  jobQueue.registerProcessor('IMAGE_PROCESSING', async () => { throw new Error('always fails'); }, { concurrency: 1, pollIntervalMs: 30 });
  const failJob = await jobQueue.enqueueJob('IMAGE_PROCESSING', {}, { maxAttempts: 2 });
  let failJobRow;
  for (let i = 0; i < 60; i++) {
    failJobRow = await jobQueue.getJob(failJob.id);
    if (failJobRow.status === 'FAILED') break;
    if (failJobRow.status === 'PENDING' && failJobRow.nextAttemptAt > new Date()) {
      await prisma.job.update({ where: { id: failJob.id }, data: { nextAttemptAt: new Date() } });
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  check('3a. A processor that always fails ends up FAILED, not stuck retrying forever', failJobRow.status === 'FAILED', failJobRow);
  check('3b. Stopped exactly at maxAttempts (2), not fewer or more', failJobRow.attempts === 2, failJobRow.attempts);
  check('3c. The real error message is preserved on the row', failJobRow.error === 'always fails', failJobRow.error);

  const manualRetryResult = await jobQueue.retryJob(failJob.id);
  check('4a. retryJob() on a FAILED job succeeds and returns PENDING', manualRetryResult?.status === 'PENDING', manualRetryResult);
  let afterManualRetry;
  for (let i = 0; i < 60; i++) {
    afterManualRetry = await jobQueue.getJob(failJob.id);
    if (afterManualRetry.status === 'FAILED') break;
    if (afterManualRetry.status === 'PENDING' && afterManualRetry.nextAttemptAt > new Date()) {
      await prisma.job.update({ where: { id: failJob.id }, data: { nextAttemptAt: new Date() } });
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  check('4b. It was genuinely reprocessed (still fails since the processor always throws) and is FAILED again with attempts reset+recounted', afterManualRetry.status === 'FAILED' && afterManualRetry.attempts === 2, afterManualRetry);

  const notFailedRetry = await jobQueue.retryJob(successJob.id);
  check('4c. retryJob() on a non-FAILED job (COMPLETED) is rejected, not silently reprocessed', notFailedRetry === null, notFailedRetry);

  console.log('\n--- Image Processing Queue: real thumbnail generation ---');

  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const uploadsDir = require('../src/config/index').config.referenceImages.uploadsDir;
  fs.mkdirSync(uploadsDir, { recursive: true });
  const testCanvas = createCanvas(800, 600);
  const ctx = testCanvas.getContext('2d');
  ctx.fillStyle = 'rgb(120, 80, 40)';
  ctx.fillRect(0, 0, 800, 600);
  const testImageBuffer = await testCanvas.encode('png');
  const testFilename = 'test-source-image.png';
  fs.writeFileSync(path.join(uploadsDir, testFilename), testImageBuffer);

  const refImage = await prisma.referenceImage.create({ data: { styleTag: 'test_style', imageUrl: `/static/reference-images/${testFilename}`, uploadedById: 'user-1' } });
  check('5a. Reference image starts with no thumbnail', refImage.thumbnailUrl === null);

  require('../src/services/imageProcessingQueue.service').registerImageProcessingQueue();
  const thumbJob = await jobQueue.enqueueJob('IMAGE_PROCESSING', { referenceImageId: refImage.id, sourceFilename: testFilename });
  let thumbJobRow;
  for (let i = 0; i < 60; i++) {
    thumbJobRow = await jobQueue.getJob(thumbJob.id);
    if (thumbJobRow.status === 'COMPLETED' || thumbJobRow.status === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  check('5b. The real thumbnail job completes successfully', thumbJobRow.status === 'COMPLETED', thumbJobRow);
  const updatedRefImage = await prisma.referenceImage.findUnique({ where: { id: refImage.id } });
  check('5c. reference_images.thumbnailUrl was genuinely updated', !!updatedRefImage.thumbnailUrl, updatedRefImage);
  const thumbFilename = updatedRefImage.thumbnailUrl?.replace('/static/reference-images/', '');
  const thumbPath = path.join(uploadsDir, thumbFilename || '');
  check('5d. A real thumbnail file was actually written to disk', !!thumbFilename && fs.existsSync(thumbPath), thumbPath);
  if (thumbFilename && fs.existsSync(thumbPath)) {
    const loaded = await loadImage(thumbPath);
    check('5e. The thumbnail was actually resized down (max dimension <= 320), not just a copy of the 800x600 original', Math.max(loaded.width, loaded.height) <= 320, { width: loaded.width, height: loaded.height });
    check('5f. Aspect ratio was preserved (800x600 -> 4:3)', Math.abs(loaded.width / loaded.height - 800 / 600) < 0.02, { width: loaded.width, height: loaded.height });
  } else {
    fail += 2;
  }

  console.log('\n--- Export Queue + HTTP wiring ---');

  require('../src/services/exportQueue.service').registerExportQueue();

  const { createApp } = require('../src/app');
  const http = require('http');
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(4813, resolve));

  const BASE = 'http://localhost:4813/api/v1';
  async function login(email, password) {
    const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const body = await res.json();
    return body.data.accessToken;
  }
  const ownerToken = await login('owner@test.com', 'OwnerPass123');
  const ownerAuthed = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' };

  let res = await fetch(`${BASE}/print-boards/generate-async`, {
    method: 'POST',
    headers: ownerAuthed,
    body: JSON.stringify({
      moodBoardId: 'mb-1', combinationIndex: 0,
      format: 'CASSETTE_PANEL', layout: 'TILE_GRID', widthValue: 4, heightValue: 6, unit: 'FT', dpi: 150, fileFormat: 'PNG',
    }),
  });
  let body = await res.json();
  check('6a. POST /print-boards/generate-async returns 202 with a job id immediately, not a finished board', res.status === 202 && !!body.data?.job?.id, body);
  check('6b. The job status starts PENDING', body.data?.job?.status === 'PENDING', body.data?.job);
  const exportJobId = body.data.job.id;

  let exportJobRow;
  for (let i = 0; i < 60; i++) {
    res = await fetch(`${BASE}/jobs/${exportJobId}`, { headers: ownerAuthed });
    body = await res.json();
    exportJobRow = body.data.job;
    if (exportJobRow.status === 'COMPLETED' || exportJobRow.status === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  check('7a. Polling GET /jobs/:id eventually shows COMPLETED for a real print board export', exportJobRow.status === 'COMPLETED', exportJobRow);
  check('7b. The completed job result references a real created PrintBoard id', !!exportJobRow.result?.printBoardId && printBoards.has(exportJobRow.result.printBoardId), exportJobRow.result);

  res = await fetch(`${BASE}/jobs/nonexistent-id`, { headers: ownerAuthed });
  check('8. Polling a nonexistent job id returns 404, not a crash', res.status === 404);

  console.log('\n--- Admin queue observability ---');

  res = await fetch(`${BASE}/admin/queues`, { headers: ownerAuthed });
  body = await res.json();
  check('9a. Admin queue stats endpoint succeeds', res.status === 200, body);
  check('9b. Catalog queue stats include real DB-backed status counts', body.data.catalog.counts.PENDING === 1, body.data.catalog);
  check('9c. Image Processing queue stats reflect the real completed thumbnail job', body.data.imageProcessing.COMPLETED >= 1, body.data.imageProcessing);
  check('9d. Export queue stats reflect the real completed export job', body.data.export.COMPLETED >= 1, body.data.export);

  res = await fetch(`${BASE}/admin/queues/jobs?type=EXPORT`, { headers: ownerAuthed });
  body = await res.json();
  check('10. Admin job list, filtered by type, returns only EXPORT jobs', body.data.jobs.length > 0 && body.data.jobs.every((j) => j.type === 'EXPORT'), body.data.jobs.map((j) => j.type));

  const staffToken = await login('staff@test.com', 'StaffPass123');
  res = await fetch(`${BASE}/admin/queues`, { headers: { Authorization: `Bearer ${staffToken}` } });
  check('11. STAFF is blocked from admin queue stats (403)', res.status === 403);

  res = await fetch(`${BASE}/admin/queues/jobs/${exportJobId}/retry`, { method: 'POST', headers: ownerAuthed });
  check('12. Retrying a job that is COMPLETED (not FAILED) is rejected with 404', res.status === 404, await res.json());

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
