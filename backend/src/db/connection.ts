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

const adapter = new PrismaPg({
  connectionString,
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

if (config.isDev) {
  global.__prisma = prisma;

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