import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
  },

  datasource: {
    // `env()` throws while the config file is being loaded when the variable is
    // missing, which breaks `prisma generate` during `npm install` on build
    // machines that only expose DATABASE_URL at runtime. Client generation does
    // not need a real URL; migrate/introspect still receive the resolved value
    // whenever DATABASE_URL is set.
    url: process.env.DATABASE_URL ? env("DATABASE_URL") : "",
  },
});