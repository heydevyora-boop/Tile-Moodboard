/* eslint-disable no-console */
import { PrismaClient, RuleSection } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

// Prisma 7's generated client requires an explicit driver adapter — same
// one the real app uses in src/db/connection.ts. A bare `new PrismaClient()`
// throws "instantiated without any options" at runtime.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not defined in the environment.');
}
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

// Default password for all seeded users. Change on first login in a real
// deployment — this is only for local/dev bootstrapping.
const SEED_PASSWORD = 'ChangeMe123!';

async function seedRoles() {
  const roles = [
    {
      name: 'OWNER',
      description: 'Store owner. Full access, including design rules and settings.',
      permissions: ['*'],
    },
    {
      name: 'ADMIN',
      description: 'Manages catalog, users, and day-to-day admin tasks.',
      permissions: [
        'tiles:read', 'tiles:write',
        'catalogs:read', 'catalogs:write',
        'design_rules:read', 'design_rules:write',
        'reference_images:read', 'reference_images:write',
        'mood_boards:read', 'mood_boards:write',
        'print_boards:read', 'print_boards:write',
        'customers:read', 'customers:write',
        'users:read', 'users:write',
        'logs:read', 'analytics:read',
      ],
    },
    {
      name: 'STAFF',
      description: 'Store floor staff. Generates mood boards and print boards for customers.',
      permissions: [
        'tiles:read',
        // Scene & Angles (a Staff-facing tool) needs to list bathroom
        // reference photos to generate visualizations -- without read
        // access here, that lookup 403s and silently looks like zero
        // reference images exist, even when Admin has uploaded some.
        'reference_images:read',
        'mood_boards:read', 'mood_boards:write',
        'print_boards:read', 'print_boards:write',
        'customers:read', 'customers:write',
      ],
    },
  ];

  const created: Record<string, string> = {};
  for (const role of roles) {
    const r = await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description, permissions: role.permissions },
      create: role,
    });
    created[role.name] = r.id;
  }
  console.log(`✅ Roles seeded (${roles.length})`);
  return created;
}

async function seedUsers(roleIds: Record<string, string>) {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);

  const users = [
    { name: 'Store Owner', email: 'owner@casadeaurum.com', roleId: roleIds.OWNER },
    { name: 'Shop Admin', email: 'admin@casadeaurum.com', roleId: roleIds.ADMIN },
    { name: 'Staff — Priya', email: 'priya@casadeaurum.com', roleId: roleIds.STAFF },
    { name: 'Staff — Rahul', email: 'rahul@casadeaurum.com', roleId: roleIds.STAFF },
  ];

  const created: Record<string, string> = {};
  for (const u of users) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, roleId: u.roleId },
      create: { ...u, passwordHash },
    });
    created[u.email] = user.id;
  }
  console.log(`✅ Users seeded (${users.length}) — default password: "${SEED_PASSWORD}"`);
  return created;
}

async function seedDesignRules(ownerId: string) {
  // Content matches design_rules.txt from the build guide exactly, split
  // into individually editable rows (one per section+key) so Admin Design
  // Rules can edit each block on its own.
  const rules: { section: RuleSection; key: string | null; title: string; content: string; sortOrder: number }[] = [
    {
      section: RuleSection.GENERAL,
      key: null,
      title: 'General Rules',
      content:
        '- Every combination must have: 1 base tile + 1 highlighter + 1 border or accent\n' +
        '- Never use more than 2 strong colors in one combination\n' +
        '- Always recommend a grout color\n' +
        '- Prefer warmer tones for Indian homes unless client specifies otherwise',
      sortOrder: 0,
    },
    {
      section: RuleSection.STYLE,
      key: 'LUXURY',
      title: 'Style: Luxury',
      content:
        '- Base: Large format (600x600 or bigger), marble-look or stone-look\n' +
        '- Highlight: Metallic finish (gold, bronze, silver), slim listello format\n' +
        '- Grout: Matching tone, epoxy type recommended',
      sortOrder: 1,
    },
    {
      section: RuleSection.STYLE,
      key: 'SUBTLE',
      title: 'Style: Subtle',
      content:
        '- Base: Neutral tones, matte finish only\n' +
        '- Highlight: Same tone family, different texture, very slim border\n' +
        '- Grout: White or matching — nearly invisible',
      sortOrder: 2,
    },
    {
      section: RuleSection.STYLE,
      key: 'BOLD',
      title: 'Style: Bold',
      content:
        '- Base: Solid neutral so the highlight stands out\n' +
        '- Highlight: Strong color — navy, emerald, terracotta\n' +
        '- Grout: Dark, contrasting',
      sortOrder: 3,
    },
    {
      section: RuleSection.ROOM,
      key: 'BATHROOM',
      title: 'Room: Bathroom',
      content:
        '- Floor: Anti-slip finish, 300x300 or 300x600 preferred\n' +
        '- Wall: Vertical stack pattern looks premium\n' +
        '- Highlight: Wall niche or waist-height border strip',
      sortOrder: 4,
    },
    {
      section: RuleSection.ROOM,
      key: 'KITCHEN',
      title: 'Room: Kitchen',
      content:
        '- Floor: Matte or sugar finish, 600x600\n' +
        '- Highlight: Above counter as decorative strip or full backsplash',
      sortOrder: 5,
    },
    {
      section: RuleSection.ROOM,
      key: 'LIVING_ROOM',
      title: 'Room: Living Room',
      content:
        '- Floor only: Large format (800x800 or 600x1200)\n' +
        '- Feature wall: Stone-look or wood-look panel tiles if client wants',
      sortOrder: 6,
    },
    {
      section: RuleSection.CLIENT,
      key: 'FEMININE',
      title: 'Client: Feminine / Female',
      content:
        '- Prefer: Soft pinks, dusty rose, warm whites, soft terracotta\n' +
        '- Highlight: Rose gold or champagne metallic\n' +
        '- Avoid: Cold greys, dark heavy tones',
      sortOrder: 7,
    },
    {
      section: RuleSection.CLIENT,
      key: 'TRADITIONAL',
      title: 'Client: Traditional',
      content:
        '- Prefer: Cream, ivory, warm beige base with decorative border\n' +
        '- Pattern tiles acceptable for pooja room or entrance',
      sortOrder: 8,
    },
  ];

  for (const r of rules) {
    if (r.key === null) {
      // Prisma's generated where-unique input for a compound index
      // (section_key) requires a concrete, non-null key — NULL doesn't
      // behave as a normal value in a unique-constraint lookup, so
      // upsert() can't target it that way. This only ever applies to
      // the single GENERAL-section rule above, which has no key by
      // design (schema comment: "null for GENERAL").
      const existing = await prisma.designRule.findFirst({ where: { section: r.section, key: null } });
      if (existing) {
        await prisma.designRule.update({
          where: { id: existing.id },
          data: { title: r.title, content: r.content, sortOrder: r.sortOrder, updatedById: ownerId },
        });
      } else {
        await prisma.designRule.create({ data: { ...r, updatedById: ownerId } });
      }
      continue;
    }

    await prisma.designRule.upsert({
      where: { section_key: { section: r.section, key: r.key } },
      update: { title: r.title, content: r.content, sortOrder: r.sortOrder, updatedById: ownerId },
      create: { ...r, key: r.key, updatedById: ownerId },
    });
  }

  // Full-document snapshot for version 1, matching design_rules.txt
  const fullContent = [
    '# CASA DE AURUM — INTERNAL DESIGN RULES',
    '# Written by store owner. Loaded into AI system prompt automatically.',
    '# Edit this file any time to update how mood boards are generated.',
    '',
    ...rules.flatMap((r) => [`## ${r.title.toUpperCase()}`, r.content, '']),
  ].join('\n');

  // Structured snapshot of every rule row at publish time — what
  // "Restore" replays back into the draft table. fullContent alone is
  // just the compiled text and would be lossy to parse back into
  // individual section/key/title/content/sortOrder rows.
  const rulesSnapshot = rules.map((r) => ({
    section: r.section,
    key: r.key,
    title: r.title,
    content: r.content,
    sortOrder: r.sortOrder,
    isActive: true,
  }));

  await prisma.ruleVersion.upsert({
    where: { versionNumber: 1 },
    update: {},
    create: {
      versionNumber: 1,
      fullContent,
      rulesSnapshot,
      changeSummary: 'Initial import from design_rules.txt',
      createdById: ownerId,
    },
  });

  console.log(`✅ Design rules seeded (${rules.length} entries) + version 1 snapshot`);
}

async function seedActivityLogs(userId: string) {
  const actions = [
    { action: 'user.login', entityType: 'User', entityId: userId },
    { action: 'catalog.extraction_completed', entityType: 'Catalog', entityId: null, metadata: { tiles: 6 } },
    { action: 'design_rules.updated', entityType: 'DesignRule', entityId: null },
    { action: 'mood_board.generated', entityType: 'MoodBoard', entityId: null },
    { action: 'print_board.exported', entityType: 'PrintBoard', entityId: null, metadata: { format: 'PDF', dpi: 300 } },
  ];

  for (const a of actions) {
    await prisma.activityLog.create({
      data: { userId, action: a.action, entityType: a.entityType, entityId: a.entityId ?? undefined, metadata: a.metadata },
    });
  }
  console.log(`✅ Activity logs seeded (${actions.length})`);
}

async function seedSettings(ownerId: string) {
  const settings = [
    { key: 'google.sheet_name', value: 'CasaDeAurum Tiles', category: 'google', description: 'Name of the Google Sheet used as the tile database' },
    { key: 'google.drive_root_folder', value: 'CasaDeAurum', category: 'google', description: 'Root Drive folder for uploaded tile images' },
    { key: 'gemini.model', value: 'gemini-2.5-flash', category: 'gemini', description: 'Model used for mood board generation' },
    { key: 'print.default_dpi', value: 300, category: 'print', description: 'Default export DPI for print boards' },
    { key: 'general.combinations_per_request', value: 4, category: 'general', description: 'Number of mood board combinations returned per generation' },
  ];

  for (const s of settings) {
    await prisma.setting.upsert({
      where: { key: s.key },
      update: { value: s.value, updatedById: ownerId },
      create: { ...s, updatedById: ownerId },
    });
  }
  console.log(`✅ Settings seeded (${settings.length})`);
}

async function main() {
  console.log('🌱 Seeding Casa de Aurum database...\n');

  const roleIds = await seedRoles();
  const userIds = await seedUsers(roleIds);
  await seedDesignRules(userIds['owner@casadeaurum.com']);
  await seedActivityLogs(userIds['owner@casadeaurum.com']);
  await seedSettings(userIds['owner@casadeaurum.com']);

  console.log('\n✅ Seed complete.');
  console.log(`   Login with any seeded email above and password "${SEED_PASSWORD}"`);
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });