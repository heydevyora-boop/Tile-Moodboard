#!/bin/sh
set -e

# schema.prisma references DIRECT_URL directly (used only for migrations —
# see the datasource block's comment). When there's no connection pooler
# in front of Postgres (the bundled docker-compose container, or most
# non-Supabase setups), it's identical to DATABASE_URL — this fallback
# means a .env that only sets DATABASE_URL still works, rather than
# failing on a cryptic "Environment variable not found: DIRECT_URL".
export DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"

echo "Applying database migrations..."
npx prisma migrate deploy

echo "Starting server..."
exec "$@"
