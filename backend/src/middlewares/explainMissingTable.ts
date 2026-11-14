/**
 * A MISSING TABLE, EXPLAINED RATHER THAN NUMBERED.
 *
 * Prisma's P2021 means "that table does not exist in the current
 * database". The global error handler turns any code it does not
 * recognise into a 400 carrying the code itself, so a feature whose
 * migration has not run reaches the screen as
 * "Database request error (P2021)" -- a number that names neither the
 * cause nor the cure, on every screen of that feature at once.
 *
 * THERE ARE TWO WAYS TO GET HERE, and the message has to cover both,
 * because the second one looks exactly like the first and wastes far
 * more time:
 *
 *   1. The migration has never been run. vercel.json's buildCommand is
 *      `prisma generate` alone, so deploying ships the code without the
 *      tables until somebody runs `prisma migrate deploy`.
 *
 *   2. The migration ran against a DIFFERENT database from the one this
 *      deployment talks to. The Prisma CLI reads DIRECT_URL (see
 *      prisma.config.ts) from whatever .env the person running it has;
 *      the server reads DATABASE_URL from its own environment. On
 *      Vercel a variable belongs to ONE environment, so a Preview
 *      deployment does not see a Production-only value -- and the
 *      tables end up in a database nothing is reading.
 *
 * The host of the database the SERVER is using is written to the log
 * (credentials stripped) rather than into the response, because that is
 * the one fact that tells the two cases apart and it belongs in the
 * deployment's own logs, not in an HTTP body.
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '@utils/AppError';

/** "postgresql://user:pw@db.abc.supabase.co:5432/postgres" -> "db.abc.supabase.co:5432/postgres". */
export function describeDatabaseTarget(url: string | undefined): string {
  const value = String(url ?? '').trim();
  if (!value) return 'no DATABASE_URL is set';

  try {
    const parsed = new URL(value);
    // Host, port and database name only. Never the user or the password.
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return 'an unreadable DATABASE_URL';
  }
}

/**
 * Register AFTER a router's routes, so it only ever sees their errors.
 * Anything it does not recognise goes on to the global handler
 * untouched.
 *
 * @param what  what is missing, in the owner's words -- "client
 *              wishlist", "physical-sample". Used in the sentence.
 */
export function explainMissingTable(what: string) {
  return (error: unknown, _req: Request, _res: Response, next: NextFunction): void => {
    const code = (error as { code?: string } | null)?.code;

    if (code !== 'P2021' && code !== 'P2022') {
      next(error);
      return;
    }

    console.error(
      `[${what}] a table is missing (${code}). This deployment is reading `
      + `${describeDatabaseTarget(process.env.DATABASE_URL)} — the migration has to have been `
      + 'run against THAT database.',
    );

    next(AppError.badRequest(
      `The ${what} tables do not exist in the database this deployment is reading. `
      + 'Run `cd backend && npx prisma migrate deploy` against that database — this '
      + 'project’s build runs `prisma generate` only, so deploying does not create them. '
      + 'If you have already run it, it reached a different database: the Prisma CLI uses '
      + 'DIRECT_URL from your own .env, the server uses DATABASE_URL from its environment, '
      + 'and on Vercel a variable set for Production is not visible to a Preview deployment. '
      + 'The deployment’s runtime log names the database it is actually reading.',
    ));
  };
}
