import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { config } from "@config/index";
import { logger } from "@utils/logger";

// Prevent multiple PrismaClient instances during ts-node-dev/nodemon
// hot reloads in development.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// ------------------------------------------------------------
// DATABASE URL
// ------------------------------------------------------------

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not defined in the environment.");
}

// ------------------------------------------------------------
// PRISMA POSTGRES ADAPTER
// ------------------------------------------------------------

/*
 * HOW MANY POSTGRES CONNECTIONS ONE INSTANCE MAY HOLD.
 *
 * node-postgres defaults to 10 per pool, and this deployment runs on
 * serverless functions: every warm instance keeps its own pool, so ten
 * apiece exhausts a pooler that allows fifteen in total. That is the
 * "(EMAXCONNSESSION) max clients reached in session mode" the library
 * page was reporting -- the database was not down, the connections to
 * it had simply all been taken and held.
 *
 * Three is deliberate rather than tuned: enough for a request that
 * fans out a few queries at once (settings reads several categories in
 * parallel), small enough that several warm instances still fit. A
 * request that wants a fourth waits for one of the three instead of
 * opening another, which is the behaviour that was missing.
 *
 * idleTimeoutMillis matters as much as max on a serverless host: an
 * instance between requests holds nothing, so a frozen one stops
 * occupying a slot it is not using. connectionTimeoutMillis is
 * generous on purpose -- queueing behind a busy pool is normal and
 * should wait, not fail.
 */
const adapter = new PrismaPg({
  connectionString,
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
  allowExitOnIdle: true,
});

// ------------------------------------------------------------
// PRISMA CLIENT
// ------------------------------------------------------------

const logConfig = config.isDev
  ? [
      { emit: "event" as const, level: "query" as const },
      { emit: "event" as const, level: "warn" as const },
      { emit: "event" as const, level: "error" as const },
    ]
  : [{ emit: "event" as const, level: "error" as const }];

export const prisma =
  global.__prisma ??
  new PrismaClient({
    adapter,
    log: logConfig,
  });

// ------------------------------------------------------------
// DEVELOPMENT QUERY LOGGING
// ------------------------------------------------------------

/*
 * ONE CLIENT PER PROCESS, in production too.
 *
 * This cache was only ever populated in development, so anything that
 * evaluated this module a second time in production built a second
 * client -- and a second pool, with its own connections, on top of a
 * pooler that was already full.
 */
global.__prisma = prisma;

if (config.isDev) {
  prisma.$on("query" as never, (e: any) => {
    logger.debug(
      `prisma query (${e.duration}ms): ${e.query}`
    );
  });

  prisma.$on("warn" as never, (e: any) => {
    logger.warn(`Prisma warning: ${e.message}`);
  });
}

// ------------------------------------------------------------
// PRISMA ERROR LOGGING
// ------------------------------------------------------------

prisma.$on("error" as never, (e: any) => {
  logger.error(`Prisma error: ${e.message}`);
});

// ------------------------------------------------------------
// DATABASE CONNECTION STATE
// ------------------------------------------------------------

let isConnected = false;

// ------------------------------------------------------------
// CONNECT DATABASE
// ------------------------------------------------------------

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();

    // Sanity-check the database connection.
    await prisma.$queryRaw`SELECT 1`;

    isConnected = true;

    logger.info("✅ Database connected");
  } catch (err) {
    isConnected = false;

    logger.error("❌ Database connection failed", {
      error: err instanceof Error ? err.message : String(err),
    });

    throw err;
  }
}

// ------------------------------------------------------------
// DISCONNECT DATABASE
// ------------------------------------------------------------

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();

    isConnected = false;

    logger.info("Database disconnected");
  } catch (err) {
    logger.error("❌ Database disconnect failed", {
      error: err instanceof Error ? err.message : String(err),
    });

    throw err;
  }
}

// ------------------------------------------------------------
// DATABASE STATUS
// ------------------------------------------------------------

export function isDatabaseConnected(): boolean {
  return isConnected;
}