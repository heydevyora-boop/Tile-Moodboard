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
  client.getFolderById = async (id) => (id === 'RealFolderId' ? { id, name: 'Reference Images' } : null);

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

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
