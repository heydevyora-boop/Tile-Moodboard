#!/bin/sh
set -e

# prisma.config.ts uses DIRECT_URL for migrations when it is set, and
# DATABASE_URL otherwise — the CLI only, never the running server. When
# there's no connection pooler in front of Postgres (the bundled
# docker-compose container, or most non-Supabase setups) the two are
# identical, so this fallback just keeps a .env that sets only
# DATABASE_URL working.
export DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"

echo "Applying database migrations..."
npx prisma migrate deploy

echo "Starting server..."
exec "$@"
