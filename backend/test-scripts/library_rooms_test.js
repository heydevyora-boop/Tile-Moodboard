/**
 * The room types, and how an older picture finds its way into one.
 *
 * The library is a Theme -> Room hierarchy now. What is easy to get
 * silently wrong is the SECOND level: a room id that does not line up
 * with the generator's own rooms, an upload filed under a room nobody
 * can browse to, or -- worst -- a picture the studio uploaded before
 * rooms existed quietly disappearing from the gallery.
 *
 * Every secret here is a dummy.
 *
 * Run:  node test-scripts/library_rooms_test.js
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

Object.assign(process.env, {
  NODE_ENV: 'development',
  JWT_SECRET: 'test-only-jwt-secret-not-a-real-key',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key',
  ENCRYPTION_KEY: '0'.repeat(64),
  BCRYPT_SALT_ROUNDS: '10',
  LOG_LEVEL: 'error',
});

require('tsconfig-paths/register');
require('ts-node').register({ transpileOnly: true, project: path.join(ROOT, 'tsconfig.json') });

const rooms = require(path.join(ROOT, 'src/services/rooms.service'));
const starters = require(path.join(ROOT, 'src/services/libraryStarters'));

function main() {
  // ════════════════════════════════════════════════════════════════
  console.log('\n1. the five the studio asked for, and no sixth');
  {
    const ids = rooms.ROOM_LIST.map((r) => r.id);
    check('1a. exactly five room types', ids.length === 5, ids);
    check('1b. ...the ones asked for',
      ids.join(',') === 'bathroom,bedroom,drawing_room,powder_room,kitchen', ids);
    check('1c. each has a label a person reads',
      rooms.ROOM_LIST.every((r) => r.label && r.label[0] === r.label[0].toUpperCase()),
      rooms.ROOM_LIST.map((r) => r.label));
    check('1d. ...and a slug for its Drive folder and its starter file',
      rooms.ROOM_LIST.every((r) => /^[a-z-]+$/.test(r.slug)),
      rooms.ROOM_LIST.map((r) => r.slug));
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n2. they are the SYSTEM’s rooms, not a parallel list');
  {
    // This is the check that matters most. If these drifted from the
    // wizard and from Python, a client could choose a Kitchen reference
    // and have the generator draw a bathroom -- which is precisely what
    // a Theme -> Room hierarchy exists to make impossible.
    const WIZARD = ['Bathroom', 'Powder Room', 'Living Room', 'Bedroom', 'Kitchen & Dining'];
    const PYTHON = ['bath', 'powder', 'living', 'bedroom', 'kitchen'];

    check('2a. every room names a room the mood-board wizard offers',
      rooms.ROOM_LIST.every((r) => WIZARD.includes(r.wizard)),
      rooms.ROOM_LIST.map((r) => r.wizard));
    check('2b. ...and a space the Python generator knows',
      rooms.ROOM_LIST.every((r) => PYTHON.includes(r.space)),
      rooms.ROOM_LIST.map((r) => r.space));
    check('2c. no two rooms claim the same wizard room',
      new Set(rooms.ROOM_LIST.map((r) => r.wizard)).size === 5);
    check('2d. the wizard label is recoverable from a stored id',
      rooms.wizardRoomFor('kitchen') === 'Kitchen & Dining'
      && rooms.wizardRoomFor('drawing_room') === 'Living Room',
      [rooms.wizardRoomFor('kitchen'), rooms.wizardRoomFor('drawing_room')]);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n3. an older picture still finds its room');
  {
    // Rows written before the hierarchy carry free text, or nothing.
    check('3a. the label it was typed as', rooms.resolveRoomId('Bathroom') === 'bathroom');
    check('3b. ...in any case', rooms.resolveRoomId('BATHROOM') === 'bathroom');
    check('3c. ...with whitespace', rooms.resolveRoomId('  Powder Room \n') === 'powder_room');
    check('3d. the wizard’s own name', rooms.resolveRoomId('Living Room') === 'drawing_room');
    check('3e. ...and Kitchen & Dining, which is one room, not two',
      rooms.resolveRoomId('Kitchen & Dining') === 'kitchen');
    check('3f. a word the studio used', rooms.resolveRoomId('cloakroom') === 'powder_room');
    check('3g. ...or another', rooms.resolveRoomId('ensuite') === 'bathroom');
    check('3h. Python’s own key', rooms.resolveRoomId('bath') === 'bathroom');

    // THE ONE THAT MUST NEVER HAPPEN. A picture the studio uploaded
    // cannot become invisible because a category arrived after it.
    check('3i. null is unsorted, not nothing', rooms.resolveRoomId(null) === 'unsorted');
    check('3j. ...and so is a word nobody recognises',
      rooms.resolveRoomId('Garage') === 'unsorted');
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n4. but an UPLOAD may not invent a room');
  {
    // Lenient on the way out, strict on the way in: a picture filed
    // under a room that does not exist is browsable from nowhere.
    check('4a. a real room is stored by its id',
      rooms.storableRoomId('Bathroom') === 'bathroom');
    check('4b. ...from an alias too', rooms.storableRoomId('cloakroom') === 'powder_room');
    check('4c. an unknown room is refused', rooms.storableRoomId('Garage') === null);
    check('4d. ...and so is the unsorted bucket itself, which is not a choice',
      rooms.storableRoomId('unsorted') === null);
    check('4e. saying nothing is allowed, and means nothing',
      rooms.storableRoomId('') === null && rooms.storableRoomId(undefined) === null);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n5. every theme has every room, so no cell is empty');
  {
    const all = starters.STARTER_ROOMS;
    check('5a. nine themes times five rooms', all.length === 45, all.length);

    const byTheme = {};
    all.forEach((r) => {
      byTheme[r.themeId] = byTheme[r.themeId] || new Set();
      byTheme[r.themeId].add(r.roomId);
    });
    check('5b. ...every theme covering all five',
      Object.values(byTheme).every((set) => set.size === 5),
      Object.entries(byTheme).map(([t, s]) => t + ':' + s.size));

    check('5c. each one names a file that exists in the repo',
      all.every((r) => require('fs').existsSync(
        path.join(ROOT, '..', 'frontend', 'img', 'library', r.file),
      )),
      all.filter((r) => !require('fs').existsSync(
        path.join(ROOT, '..', 'frontend', 'img', 'library', r.file),
      )).map((r) => r.file));

    check('5d. ...a PNG, which is what Python’s Pillow can open',
      all.every((r) => r.file.endsWith('.png')));

    check('5e. their ids are unique', new Set(all.map((r) => r.id)).size === 45);
    check('5f. ...and say which room they are',
      all.every((r) => r.id.endsWith('-' + (rooms.ROOMS[r.roomId] || {}).slug)),
      all.slice(0, 3).map((r) => r.id));

    // The reading each one ships with has to say WHICH room, or a board
    // built on a kitchen reference reads as a bathroom brief.
    const kitchen = all.find((r) => r.themeId === 'moroccan' && r.roomId === 'kitchen');
    check('5g. the shipped reading names the room',
      /kitchen/i.test(kitchen.profile.summary), kitchen.profile.summary);
    check('5h. ...and the title does too', /Kitchen$/.test(kitchen.title), kitchen.title);
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n6. narrowing a theme to one room');
  {
    check('6a. a theme’s five', starters.startersForTheme('british').length === 5);
    check('6b. ...narrowed to one', starters.startersForTheme('british', 'kitchen').length === 1);
    check('6c. ...by an alias as readily as an id',
      starters.startersForTheme('british', 'Kitchen & Dining').length === 1);
    check('6d. a room that does not exist returns nothing, not everything',
      starters.startersForTheme('british', 'garage').length === 0);

    const counts = starters.starterRoomCounts('british');
    check('6e. one starter in each room', Object.keys(counts).length === 5
      && Object.values(counts).every((n) => n === 1), counts);
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (failures.length) console.log('failed:\n  ' + failures.join('\n  '));
  process.exit(fail ? 1 : 0);
}

main();
