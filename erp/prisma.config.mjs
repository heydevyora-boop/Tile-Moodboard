import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/* ============================================================
   PRISMA CLI CONFIGURATION — ERP ONLY
   ============================================================

   THE VARIABLE IS ERP_DATABASE_URL, not DATABASE_URL, and that is
   the whole safety story of this file.

   DATABASE_URL on a developer's machine points at the Casa De
   Aurum website's database. If the ERP read that name too, then
   running `prisma migrate dev` in the wrong terminal tab -- or
   with the website's .env already exported -- would try to migrate
   the WEBSITE's database with the ERP's schema. That is not a
   mistake you recover from on a production Supabase instance.

   Under a different name it cannot happen by accident: with only
   the website's environment loaded, the ERP CLI finds nothing and
   refuses to run, which is the correct outcome.
   ============================================================ */

export default defineConfig({
  schema: 'prisma/schema.prisma',

  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.mjs',
  },

  datasource: {
    /* ERP_DIRECT_URL first, where one is set.
       This URL is used ONLY by the CLI -- migrate, studio,
       introspect -- never by a running application. A pooled
       connection (pgbouncer in transaction mode) cannot run
       migrations: the migration engine needs session-level
       advisory locks and prepared statements that transaction
       pooling does not provide. Where there is no pooler, the two
       are the same URL and this changes nothing.

       Resolved with a plain ternary rather than env() alone
       because env() throws while the config is being LOADED if
       the variable is missing -- which would break
       `prisma generate` during npm install on a build machine
       that has no database URL at all. Generating a client does
       not need a real connection; migrating still gets the real
       value whenever one is set. */
    url: process.env.ERP_DIRECT_URL
      ? env('ERP_DIRECT_URL')
      : (process.env.ERP_DATABASE_URL ? env('ERP_DATABASE_URL') : ''),
  },
});
