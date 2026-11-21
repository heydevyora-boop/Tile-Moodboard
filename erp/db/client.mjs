import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';

/* The .env is found RELATIVE TO THIS FILE, not to wherever the
   process happened to be started. `dotenv/config` resolves against
   the working directory, so a script run from erp/db or from the
   repository root would silently find nothing and the connection
   would fail for a reason that has nothing to do with the
   database. */
dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  quiet: true,
});

import { PrismaClient } from '../node_modules/.prisma/erp-client/client.js';

/* ============================================================
   THE ERP'S OWN DATABASE CONNECTION
   ============================================================

   Reads ERP_DATABASE_URL and nothing else. Not DATABASE_URL --
   that is the Casa De Aurum website's database, and this process
   must never open it, not even read-only. Refusing to start
   without the ERP's own variable is the point: a missing variable
   is a loud failure, and silently falling back to another
   system's connection string is the quiet one.
   ============================================================ */

const url = process.env.ERP_DATABASE_URL;

if (!url) {
  throw new Error(
    'ERP_DATABASE_URL is not set. The ERP has its own database and its own '
    + 'variable; it deliberately does not fall back to DATABASE_URL, which '
    + 'points at the Casa De Aurum website. Copy erp/.env.example to erp/.env.',
  );
}

// A guard against the one mistake that would be expensive. Someone
// copying a connection string in a hurry is not hypothetical, and
// the ERP opening the website's database -- even to read -- is the
// thing this whole separation exists to prevent.
if (/casa|aurum|tile[-_]?moodboard/i.test(url) && !/erp/i.test(url)) {
  throw new Error(
    'ERP_DATABASE_URL appears to point at a Casa De Aurum database: '
    + url.replace(/:[^:@/]*@/, ':***@')
    + '\nThe ERP must use its own database. Refusing to connect.',
  );
}

const adapter = new PrismaPg({ connectionString: url });

export const prisma = new PrismaClient({ adapter });

export async function disconnect() {
  await prisma.$disconnect();
}
