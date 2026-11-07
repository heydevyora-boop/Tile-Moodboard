import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
  },

  datasource: {
    // DIRECT_URL FIRST, because this URL is only ever used by the CLI --
    // migrate, introspect, studio -- and never by the running server, which
    // builds its own client from process.env.DATABASE_URL in
    // src/db/connection.ts.
    //
    // On Supabase, DATABASE_URL is the TRANSACTION POOLER (port 6543) and the
    // migration engine cannot run through it: it needs session-level advisory
    // locks and prepared statements that pgbouncer's transaction mode does not
    // support. DEPLOYMENT.md and .env.production.example have said for months
    // that DIRECT_URL (port 5432) is what migrations use -- nothing actually
    // read it, so `prisma migrate deploy` was quietly pointed at the pooler.
    // Unset, as on the bundled Postgres where there is no pooler at all, this
    // is DATABASE_URL exactly as before.
    //
    // `env()` throws while the config file is being loaded when the variable is
    // missing, which breaks `prisma generate` during `npm install` on build
    // machines that only expose DATABASE_URL at runtime. Client generation does
    // not need a real URL; migrate/introspect still receive the resolved value
    // whenever one of the two is set.
    url: process.env.DIRECT_URL
      ? env("DIRECT_URL")
      : (process.env.DATABASE_URL ? env("DATABASE_URL") : ""),
  },
});