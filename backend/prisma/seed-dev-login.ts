/**
 * Creates the temporary development login.
 *
 * The username and password are a convenience for local work and for a
 * protected testing environment. They are NOT in the source: this reads
 * them from the environment, hashes the password with bcrypt exactly as
 * the normal seeder does, and stores only the hash. Nothing about the
 * login path changes -- the account is an ordinary user row, and the
 * password is checked against that hash like any other.
 *
 * It REFUSES TO RUN IN PRODUCTION. config.devLogin is null there, so
 * there is no configuration of a public deployment in which this
 * creates a weak account.
 *
 * Put the variables in the env file the server loads -- locally that
 * is backend/.env.development -- and then run `npm run seed:dev-login`.
 * Not on the command line: the RUNNING SERVER reads them too, and
 * without them in its environment the username is rejected at login
 * even though this created the account. (An inline prefix is also
 * bash-only, and does nothing in PowerShell.)
 */

import bcrypt from 'bcrypt';
import { prisma } from '../src/db/connection';
import { config } from '../src/config';

async function main(): Promise<void> {
  const dev = config.devLogin;

  if (!dev) {
    console.error(
      '✖ No development login is configured.\n' +
        '  In production this is refused outright, by design.\n' +
        '  Elsewhere, set DEV_LOGIN_USERNAME and DEV_LOGIN_PASSWORD and run this again.',
    );
    process.exitCode = 1;
    return;
  }

  if (!dev.password) {
    console.error('✖ DEV_LOGIN_PASSWORD is not set, so there is no password to store.');
    process.exitCode = 1;
    return;
  }

  const role = await prisma.role.findUnique({ where: { name: dev.role } });
  if (!role) {
    const available = (await prisma.role.findMany({ select: { name: true } })).map((r) => r.name);
    console.error(
      `✖ No role named "${dev.role}". Run the main seed first, or set DEV_LOGIN_ROLE to one of: ` +
        `${available.join(', ') || '(none seeded)'}`,
    );
    process.exitCode = 1;
    return;
  }

  // Hashed the same way, at the same cost, as every other account. The
  // password is weak; the way it is stored is not.
  const passwordHash = await bcrypt.hash(dev.password, 12);

  const user = await prisma.user.upsert({
    where: { email: dev.email },
    update: { passwordHash, roleId: role.id, isActive: true },
    create: {
      name: `Development — ${dev.username}`,
      email: dev.email,
      passwordHash,
      roleId: role.id,
      isActive: true,
    },
  });

  console.log(
    `✅ Development login ready in ${config.env}\n` +
      `   username : ${dev.username}\n` +
      `   account  : ${user.email}  (role ${role.name})\n` +
      `   password : the value of DEV_LOGIN_PASSWORD, stored as a bcrypt hash\n\n` +
      '   THE ACCOUNT IS NOT ENOUGH ON ITS OWN. The running server reads these\n' +
      '   variables as well, and rejects the username at login without them. If\n' +
      '   you passed them only to this command, put them in the env file the\n' +
      '   server loads (locally .env.development) and restart it.\n\n' +
      '   This login exists only where DEV_LOGIN_USERNAME is set and NODE_ENV is\n' +
      '   not production. Do not set these variables on a public deployment.',
  );
}

main()
  .catch((error) => {
    console.error('✖ Could not create the development login:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
