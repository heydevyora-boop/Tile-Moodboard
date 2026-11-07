/**
 * The Drive folder De'vyora Library uploads into.
 *
 * The studio creates a folder -- "Reference Images" -- shares it with
 * the service account and puts its link in the environment. Every
 * library picture goes directly inside it.
 *
 * What this covers is the part that is easy to get silently wrong: the
 * setting being absent, mistyped, or naming something the credential
 * cannot open. Each of those used to end as a generic Drive failure on
 * every upload of a hundred, with nothing to say which setting was at
 * fault -- and the one outcome that must never happen is pictures
 * quietly landing in the Drive root instead.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/library_drive_folder_test.js
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, extra) {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else {
    console.log(`  FAIL  ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
    fail += 1; failures.push(label);
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

Object.assign(process.env, {
  NODE_ENV: 'development',
  JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
  ENCRYPTION_KEY: '0'.repeat(64),
  BCRYPT_SALT_ROUNDS: '10',
  LOG_LEVEL: 'error',
  GOOGLE_DRIVE_ROOT_FOLDER: 'TestDriveRoot',
});

require('tsconfig-paths/register');
require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

const { config } = require(path.join(ROOT, 'src/config/index'));
const library = require(path.join(ROOT, 'src/services/library.service'));
const drive = require(path.join(ROOT, 'src/services/googleDrive.service'));

async function main() {
  // ════════════════════════════════════════════════════════════════
  console.log('\n1. a link, an id, or neither');
  {
    const { driveFolderIdFrom } = library;
    const ID = '1AbCdEfGhIjKlMnOpQrStUv';

    check('1a. the link Google’s "Copy link" produces',
      driveFolderIdFrom(`https://drive.google.com/drive/folders/${ID}`) === ID);
    check('1b. ...with its sharing suffix',
      driveFolderIdFrom(`https://drive.google.com/drive/folders/${ID}?usp=sharing`) === ID);
    check('1c. ...and the one with an account in the path',
      driveFolderIdFrom(`https://drive.google.com/drive/u/0/folders/${ID}`) === ID);
    check('1d. an open?id= link', driveFolderIdFrom(`https://drive.google.com/open?id=${ID}`) === ID);
    check('1e. a bare id, pasted on its own', driveFolderIdFrom(ID) === ID);
    check('1f. ...with whitespace around it, as a paste often has',
      driveFolderIdFrom(`  ${ID}\n`) === ID);

    check('1g. a folder NAME is not an id', driveFolderIdFrom('Reference Images') === '');
    check('1h. ...nor is an empty setting', driveFolderIdFrom('') === '');
    check('1i. ...nor a path somebody typed by hand',
      driveFolderIdFrom('My Drive/Reference Images') === '');
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n2. nothing is uploaded until the folder is known');

  const client = drive.googleDriveClient;
  client.isConfigured = () => true;

  let uploads = 0;
  // Every folder found-or-created, with its parent -- so the test can
  // assert the SHAPE of the tree and not merely that something existed.
  const folders = [];
  client.uploadFile = async () => { uploads += 1; return { id: 'f1', name: 'x' }; };
  client.generatePublicLink = async () => 'ok';
  client.getOrCreateFolder = async (name, parent) => {
    folders.push({ name, parent });
    return { id: 'made-' + name, name };
  };
  // driveId marks it as living on a shared drive -- without one, a
  // service account could not store anything in it at all, which
  // section 6 covers on its own.
  client.getFolderById = async (id) =>
    (id === 'RealFolderId' ? { id, name: 'Reference Images', driveId: '0ASharedDriveId' } : null);

  const file = { originalname: 'room.png', mimetype: 'image/png', buffer: PNG };
  const attempt = async () => {
    library.clearLibraryFolderCache();
    folders.length = 0;
    try {
      await library.addReference(
        file, { themeId: 'british', room: 'bathroom', title: 'A room' }, 'user-1',
      );
      return null;
    } catch (error) {
      return error.message;
    }
  };

  {
    config.google.driveLibraryFolder = '';
    const message = await attempt();
    check('2a. an unset folder refuses the upload', Boolean(message));
    check('2b. ...naming the variable to set',
      /GOOGLE_DRIVE_LIBRARY_FOLDER/.test(message || ''), message);
    check('2c. ...and saying to share it with the service account',
      /share it with the service account/i.test(message || ''), message);
    check('2d. nothing was sent to Drive', uploads === 0, uploads);
    // THE WHOLE POINT. Falling back to the root would be exactly the
    // behaviour this setting exists to prevent.
    check('2e. and NO folder was created in the Drive root instead',
      folders.length === 0, folders);
  }

  {
    config.google.driveLibraryFolder = 'Reference Images';
    const message = await attempt();
    check('2f. a folder NAME is refused, not guessed at',
      /neither a Google Drive folder link nor a folder id/.test(message || ''), message);
    check('2g. ...quoting what was actually set, so it can be compared',
      /"Reference Images"/.test(message || ''), message);
    check('2h. still nothing uploaded', uploads === 0, uploads);
  }

  {
    config.google.driveLibraryFolder = 'https://drive.google.com/drive/folders/WrongFolderId';
    const message = await attempt();
    check('2i. a folder the credential cannot open is refused',
      /could not be opened/.test(message || ''), message);
    check('2j. ...naming the id it tried, not the whole link',
      /WrongFolderId/.test(message || ''), message);
    check('2k. ...and listing the three things it can be',
      /is wrong/.test(message || '') && /in the bin/.test(message || '')
      && /shared with/.test(message || ''), message);
    check('2l. still nothing uploaded', uploads === 0, uploads);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n2z. and the page can ask BEFORE anybody picks a file');
  {
    // WHAT THE STUDIO ACTUALLY HIT: four files chosen, four identical
    // failures, and the reason only readable afterwards. The server
    // knows all of this at page load, so it has to be askable then.
    config.google.driveLibraryFolder = '';
    library.clearLibraryFolderCache();
    let status = await library.describeLibraryFolder();
    check('2z1. an unset folder is reported, not thrown', status.ok === false);
    check('2z2. ...saying it is not configured at all', status.configured === false);
    check('2z3. ...naming the variable', /GOOGLE_DRIVE_LIBRARY_FOLDER/.test(status.reason));

    // THE HINT THAT MATTERS when somebody is certain they set it: on
    // Vercel the value belongs to one environment, and an existing
    // deployment keeps the old one until it is rebuilt. Both look
    // identical from the server: the variable is simply empty.
    check('2z4. ...and why a variable you DID set can still be missing',
      /Preview/.test(status.reason) && /redeployed/.test(status.reason), status.reason);

    config.google.driveLibraryFolder = 'Reference Images';
    library.clearLibraryFolderCache();
    status = await library.describeLibraryFolder();
    check('2z5. a folder name is reported as not a link or an id',
      status.ok === false && status.configured === true
      && /neither a Google Drive folder link nor a folder id/.test(status.reason),
      status.reason);

    config.google.driveLibraryFolder = 'https://drive.google.com/drive/folders/WrongFolderId';
    library.clearLibraryFolderCache();
    status = await library.describeLibraryFolder();
    check('2z6. an unreachable folder is reported with the id it tried',
      status.ok === false && /WrongFolderId/.test(status.reason), status.reason);

    config.google.driveLibraryFolder = 'https://drive.google.com/drive/folders/RealFolderId';
    library.clearLibraryFolderCache();
    status = await library.describeLibraryFolder();
    check('2z7. a working one reports ok, with the folder it opened',
      status.ok === true && status.folderId === 'RealFolderId'
      && status.name === 'Reference Images' && status.reason === '',
      status);

    // One definition of what is wrong: the thrown message and the
    // reported one are the same words, so the page and the upload
    // cannot tell the studio two different stories.
    config.google.driveLibraryFolder = '';
    library.clearLibraryFolderCache();
    const reported = (await library.describeLibraryFolder()).reason;
    library.clearLibraryFolderCache();
    let thrown = '';
    try {
      await library.addReference(file, { themeId: 'british', room: 'bathroom' }, 'user-1');
    } catch (error) { thrown = error.message; }
    // One definition, quoted verbatim: the per-file failure adds the
    // file's name in front and nothing else, so the page's warning and
    // the upload's refusal cannot tell two different stories.
    check('2z8. the thrown message quotes the reported reason verbatim',
      thrown.includes(reported), { reported: reported.slice(0, 60), thrown: thrown.slice(0, 90) });
    check('2z9. ...with the file it was for',
      thrown.startsWith('"room.png" could not be stored'), thrown.slice(0, 50));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n3. and with it set, into <folder>/<Theme>/<Room>');
  {
    config.google.driveLibraryFolder = 'https://drive.google.com/drive/folders/RealFolderId';
    library.clearLibraryFolderCache();
    folders.length = 0;

    let sentTo = null;
    client.uploadFile = async (input) => {
      sentTo = input.parentFolderId;
      return { id: 'drive-1', name: input.name };
    };

    // The database is not running here, so the upload is taken as far
    // as Drive and the row write is what fails. That is exactly the
    // boundary under test: WHERE the bytes went.
    const put = async (room) => {
      folders.length = 0;
      sentTo = null;
      try {
        await library.addReference(
          file, { themeId: 'british', room, title: 'A room' }, 'user-1',
        );
      } catch (error) { /* the row, not the upload */ }
    };

    await put('bathroom');
    check('3a. the theme folder is made under the configured one, not the Drive root',
      folders[0] && folders[0].name === 'British' && folders[0].parent === 'RealFolderId',
      folders[0]);
    check('3b. ...the room folder under the theme',
      folders[1] && folders[1].name === 'Bathroom' && folders[1].parent === 'made-British',
      folders[1]);
    check('3c. ...and the picture into THAT', sentTo === 'made-Bathroom', sentTo);
    check('3d. the folders are named as a person reads them, not as ids',
      folders.every((f) => !/^[a-z_]+$/.test(f.name)), folders.map((f) => f.name));

    // A second picture into the same place must not re-walk the tree:
    // a hundred-picture batch would otherwise pay two Drive lookups
    // each, two hundred round trips inside a sixty-second function.
    await put('bathroom');
    check('3e. a second picture into the same room re-walks nothing',
      folders.length === 0 && sentTo === 'made-Bathroom', folders);

    // ...but a different room is a different folder.
    await put('kitchen');
    check('3f. a different room gets its own folder under the same theme',
      sentTo === 'made-Kitchen'
      && folders.some((f) => f.name === 'Kitchen' && f.parent === 'made-British'),
      { sentTo, folders });

    // And a picture filed under no room still has somewhere to go.
    await put(undefined);
    check('3g. a picture with no room lands in Unsorted, not in the theme folder',
      sentTo === 'made-Unsorted', sentTo);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n4. a folder in My Drive cannot hold anything, and says so first');
  {
    // THE FAILURE THE STUDIO SPENT AN EVENING ON. The folder exists,
    // the service account is on it as an Editor, the id is right --
    // and Drive answers every upload with "Service Accounts do not
    // have storage quota". Sharing was never the missing piece: a
    // file has an owner, in a My Drive that owner is whoever created
    // it, and a service account may own nothing at all.
    let uploaded = 0;
    client.uploadFile = async () => { uploaded += 1; return { id: 'f1', name: 'x' }; };
    client.generatePublicLink = async () => 'ok';
    client.getOrCreateFolder = async (name) => ({ id: 'made-' + name, name });
    // No driveId: a plain folder in somebody's My Drive.
    client.getFolderById = async (id) => ({ id, name: 'Reference Images' });

    config.google.driveImpersonateUser = '';
    config.google.driveLibraryFolder = 'https://drive.google.com/drive/folders/MyDriveFolder';
    library.clearLibraryFolderCache();

    let status = await library.describeLibraryFolder();
    check('4a. a My Drive folder opens but is not usable', status.ok === false, status);
    check('4b. ...and it is not reported as missing or mistyped',
      status.configured === true && status.folderId === 'MyDriveFolder', status);
    check('4c. ...the reason says the folder is in a My Drive',
      /My Drive/.test(status.reason), status.reason);
    check('4d. ...that re-sharing it does not help',
      /even as an Editor/.test(status.reason), status.reason);
    check('4e. ...and names both configurations that do work',
      /SHARED DRIVE/.test(status.reason)
      && /GOOGLE_DRIVE_IMPERSONATE_USER/.test(status.reason), status.reason);
    check('4f. sharedDrive is reported as the fact it is', status.sharedDrive === false);

    // Said BEFORE the files are picked is only half of it: the upload
    // itself must refuse, rather than spending the bytes to be told by
    // Google in its own words.
    library.clearLibraryFolderCache();
    let thrown = '';
    try {
      await library.addReference(file, { themeId: 'british', room: 'bathroom' }, 'user-1');
    } catch (error) { thrown = error.message; }
    check('4g. the upload refuses rather than sending the file', uploaded === 0);
    check('4h. ...with the same words the page showed',
      thrown.includes(status.reason), { thrown: thrown.slice(0, 120) });

    // OAUTH DELEGATION -- Google's own second answer. With a user to
    // act as, the file is owned by that person and a My Drive folder
    // is exactly the right place for it.
    config.google.driveImpersonateUser = 'studio@example.com';
    library.clearLibraryFolderCache();
    status = await library.describeLibraryFolder();
    check('4i. with a delegated user the same folder is usable',
      status.ok === true && status.reason === '', status);

    library.clearLibraryFolderCache();
    try {
      await library.addReference(file, { themeId: 'british', room: 'bathroom' }, 'user-1');
    } catch { /* the database is not part of this test */ }
    check('4j. ...and the picture is actually sent', uploaded === 1);

    // A shared drive needs no delegation at all.
    config.google.driveImpersonateUser = '';
    client.getFolderById = async (id) => ({ id, name: 'Reference Images', driveId: '0AShared' });
    library.clearLibraryFolderCache();
    status = await library.describeLibraryFolder();
    check('4k. a folder on a shared drive is usable as it is',
      status.ok === true && status.sharedDrive === true, status);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n5. the requests Drive is actually sent');
  {
    // supportsAllDrives IS THE WHOLE FIX. A shared drive is the only
    // place a service account's upload can live, and without this flag
    // the API answers as though shared drives did not exist -- so the
    // file is treated as one the service account would own in a My
    // Drive, and refused for want of quota. The folder check carried
    // the flag already; the upload, the folder creation, the lookup
    // and the share did not.
    const seen = {};
    const fake = {
      files: {
        create: async (params) => {
          seen[params.media ? 'upload' : 'createFolder'] = params;
          return { data: { id: 'new-id', name: 'x', webViewLink: 'https://drive/x' } };
        },
        list: async (params) => { seen.list = params; return { data: { files: [] } }; },
        get: async (params) => { seen.get = params; return { data: { id: 'id', name: 'n', mimeType: 'application/vnd.google-apps.folder', driveId: '0AShared', webViewLink: 'https://drive/x' } }; },
        delete: async (params) => { seen.delete = params; return { data: {} }; },
      },
      permissions: { create: async (params) => { seen.permission = params; return { data: {} } } },
    };
    const real = new drive.GoogleDriveClient(fake);

    await real.uploadFile({ name: 'a.png', mimeType: 'image/png', content: PNG, parentFolderId: 'p' });
    check('5a. the upload says it understands shared drives',
      seen.upload && seen.upload.supportsAllDrives === true, seen.upload && Object.keys(seen.upload));

    await real.createFolder('British', 'p');
    check('5b. ...so does creating a folder inside one',
      seen.createFolder && seen.createFolder.supportsAllDrives === true);

    await real.findFolder('British', 'p');
    check('5c. ...and the search, which would otherwise find nothing there',
      seen.list && seen.list.supportsAllDrives === true
      && seen.list.includeItemsFromAllDrives === true, seen.list);

    await real.generatePublicLink('new-id');
    check('5d. ...and making the picture publicly readable',
      seen.permission && seen.permission.supportsAllDrives === true);

    await real.deleteFile('new-id');
    check('5e. ...and deleting it again',
      seen.delete && seen.delete.supportsAllDrives === true);

    const folder = await real.getFolderById('id');
    check('5f. the folder check reads which drive the folder is on',
      folder && folder.driveId === '0AShared', folder);

    // GOOGLE'S OWN WORDING, TRANSLATED. It arrives as a 403, which
    // would otherwise be reported as a permission error and send the
    // studio back to re-share a folder that was already shared right.
    const refusing = new drive.GoogleDriveClient({
      files: {
        create: async () => {
          const err = new Error('quota');
          err.response = { status: 403, data: { error: {
            errors: [{ reason: 'storageQuotaExceeded' }],
            message: 'Service Accounts do not have storage quota. Leverage shared drives ...',
          } } };
          throw err;
        },
        list: async () => ({ data: { files: [] } }),
        get: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      permissions: { create: async () => ({ data: {} }) },
    });
    let quotaError = null;
    try {
      await refusing.uploadFile({ name: 'a.png', mimeType: 'image/png', content: PNG, parentFolderId: 'p' });
    } catch (error) { quotaError = error; }
    check('5g. Google’s quota refusal is not reported as a permission problem',
      quotaError && !/authentication\/permission error/.test(quotaError.message),
      quotaError && quotaError.message);
    check('5h. ...it is explained, with both configurations that work',
      quotaError && /owns no Google Drive storage/.test(quotaError.message)
      && /SHARED DRIVE/.test(quotaError.message)
      && /GOOGLE_DRIVE_IMPERSONATE_USER/.test(quotaError.message),
      quotaError && quotaError.message.slice(0, 120));
    check('5i. ...and it is not retried, because no retry can fix it',
      quotaError && quotaError.retryable === false);
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
