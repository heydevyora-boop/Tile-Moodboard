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
  let createdFolders = 0;
  client.uploadFile = async () => { uploads += 1; return { id: 'f1', name: 'x' }; };
  client.generatePublicLink = async () => 'ok';
  client.getOrCreateFolder = async (name) => { createdFolders += 1; return { id: 'made-' + name, name }; };
  client.getFolderById = async (id) => (id === 'RealFolderId' ? { id, name: 'Reference Images' } : null);

  const file = { originalname: 'room.png', mimetype: 'image/png', buffer: PNG };
  const attempt = async () => {
    library.clearLibraryFolderCache();
    try {
      await library.addReference(file, { themeId: 'british', title: 'A room' }, 'user-1');
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
      createdFolders === 0, createdFolders);
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
  console.log('\n3. and with it set properly, straight into that folder');
  {
    config.google.driveLibraryFolder = 'https://drive.google.com/drive/folders/RealFolderId';
    library.clearLibraryFolderCache();

    let sentTo = null;
    client.uploadFile = async (input) => {
      sentTo = input.parentFolderId;
      return { id: 'drive-1', name: input.name };
    };

    // The database is not running in this test, so the upload is taken
    // as far as Drive and the row write is what fails. That is exactly
    // the boundary under test: WHERE the bytes went.
    try {
      await library.addReference(file, { themeId: 'british', title: 'A room' }, 'user-1');
    } catch (error) { /* the row, not the upload */ }

    check('3a. the picture went to the configured folder', sentTo === 'RealFolderId', sentTo);
    check('3b. ...and not to the Drive root', createdFolders === 0, createdFolders);
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
