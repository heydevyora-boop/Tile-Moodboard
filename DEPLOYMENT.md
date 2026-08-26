# Deployment Guide

Two supported paths: **Docker Compose** (recommended — postgres, backend, and nginx all managed together) or a **bare VM with PM2** (if you already have Postgres and a reverse proxy managed some other way). Don't mix them — running PM2 *inside* the Docker container on top of the container's own process supervision is redundant and makes shutdown signal handling worse, not better.

## Docker Compose (recommended)

### Prerequisites
- Docker Engine 24+ and the Docker Compose plugin (`docker compose version` should work)
- A Gemini API key (can also be added later via Admin → API Keys once the app is running)
- If you use the Google Sheets/Drive integration: a service account JSON key file

### Steps

1. **Root-level config** (docker-compose variables — Postgres credentials, the port nginx binds):
   ```bash
   cp .env.example .env
   # edit .env — set a real POSTGRES_PASSWORD at minimum
   ```

2. **Backend config**:
   ```bash
   cp backend/.env.production.example backend/.env
   # edit backend/.env — fill in JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY
   # (openssl rand -base64 48 for each), and CORS_ORIGINS/FRONTEND_URL to
   # match wherever this is actually being served from
   ```
   The `DATABASE_URL` in this file gets overridden by `docker-compose.yml` to point at the `postgres` service automatically — you don't need to hand-edit it to match the container network.

3. **Optional: Google service account key**, if you use Drive/Sheets:
   ```bash
   mkdir -p secrets
   cp /path/to/your/casadeaurum_key.json secrets/
   ```

4. **Build and start**:
   ```bash
   docker compose up -d --build
   ```
   On first boot, the backend container's entrypoint runs `prisma migrate deploy` automatically before starting the server — the schema is created for you, no manual migration step needed.

5. **Seed the first Owner account** (one-time, since there's no self-registration by design):
   ```bash
   docker compose exec backend npm run prisma:seed
   ```

6. **Verify**:
   ```bash
   curl http://localhost/health          # nginx -> backend health passthrough
   curl http://localhost/api/v1/health   # same thing, direct API path
   ```
   Open `http://localhost/login.html` in a browser.

### Day-to-day operations

```bash
docker compose logs -f backend        # tail backend logs
docker compose ps                     # see health status of all three services
docker compose restart backend        # restart just the API (e.g. after changing backend/.env)
docker compose exec backend npx prisma studio   # inspect the DB
docker compose down                   # stop everything (add -v to also delete volumes — careful, that deletes uploads/DB data)
```

### Updating to a new version

```bash
git pull
docker compose up -d --build backend   # rebuilds only the backend image; migrations run automatically on start
```

## Using Supabase instead of the bundled Postgres container

The app talks to Postgres purely through a standard `DATABASE_URL`/`DIRECT_URL` connection string via Prisma — nothing about it depends on running Postgres locally, so pointing it at a hosted Supabase project instead of the bundled container is a configuration change, not a code change. There's no Supabase-specific SDK involved (no `supabase-js`, no Row Level Security policies to write) — from this app's point of view, Supabase is just Postgres with a connection pooler in front of it.

### Get the connection strings

In the Supabase dashboard: **Project Settings → Database → Connection string**. You need two different ones:

- **`DATABASE_URL`** — the **Transaction pooler** string (port `6543`). This is what the running app uses for every normal query. Append `&pgbouncer=true` to the query string — this tells Prisma to disable prepared statements, which pgbouncer's transaction mode doesn't support.
- **`DIRECT_URL`** — the **direct connection** string (port `5432`, host `db.<project-ref>.supabase.co`). Only `prisma migrate deploy` uses this, never the running app. Pooled connections can't run schema migrations, so this bypasses the pooler.

Both need `sslmode=require` — Supabase rejects unencrypted connections. `backend/.env.production.example` has both filled in as commented-out examples ready to uncomment and fill in.

```bash
DATABASE_URL="postgresql://postgres.<project-ref>:REPLACE_ME@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true"
DIRECT_URL="postgresql://postgres.<project-ref>:REPLACE_ME@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require"
```

### Run it

```bash
cp backend/.env.production.example backend/.env
# edit backend/.env — uncomment and fill in the Supabase DATABASE_URL/DIRECT_URL lines above
# instead of the default "postgres" service ones, plus JWT_SECRET etc. as usual

docker compose -f docker-compose.yml -f docker-compose.supabase.yml up -d --build backend nginx
```

The `-f docker-compose.supabase.yml` override removes `backend`'s dependency on the local `postgres` service, so it's never started — Supabase is the only Postgres involved. Everything else (migrations running automatically via `docker-entrypoint.sh`, health checks, seeding the first Owner account, day-to-day operations) works exactly as described above.

Running the backend outside Docker entirely (the bare-VM/PM2 path below) works the same way — just set `DATABASE_URL`/`DIRECT_URL` in `backend/.env` to the Supabase strings and skip installing Postgres locally.

### A few things worth knowing

- **Migrations bypass the pooler on purpose.** If `DIRECT_URL` is accidentally left pointed at the pooler too, `prisma migrate deploy` will fail with an error about prepared statements or transaction mode — that's the signal something's using the wrong one of the two connection strings.
- **Connection limits.** Supabase's free tier caps direct (non-pooled) connections fairly low. The pooler exists precisely so the running app doesn't eat into that limit — this is why `DATABASE_URL` should always be the pooled string in production, not the direct one, even outside Supabase-specific concerns.
- **Row Level Security doesn't apply here.** Supabase's dashboard and docs push RLS heavily, but that's relevant when a browser talks to Supabase directly via `supabase-js`/PostgREST using the anon key. This app never does that — Prisma connects with the Postgres role in the connection string and enforces every permission check in the Express layer (`requirePermission`/`authorize`, Module 1 and Module 25), the same as it does against the bundled container. Enabling RLS on these tables would have no effect on how this app behaves either way, since nothing here queries through PostgREST.
- **`docker-entrypoint.sh` falls back `DIRECT_URL` to `DATABASE_URL` if it's ever left unset** — a safety net for the bundled-Postgres path, where the two are identical anyway. For Supabase, always set both explicitly; letting the fallback kick in there would point migrations at the pooler by accident.

## Bare VM with PM2 (alternative)

Use this if Postgres, nginx, and TLS are already managed some other way and you just need the Node process supervised.

```bash
cd backend
npm ci --omit=dev
npm run build
cp .env.production.example .env   # fill in real values, same as the Docker path above
npx prisma migrate deploy
npm run prisma:seed               # first-time only

npm install -g pm2
npm run pm2:start
pm2 save
pm2 startup   # follow the printed instructions to survive a reboot
```

`ecosystem.config.js` is intentionally configured for a **single instance, fork mode — not cluster mode**. The catalog extraction queue and the generic job queue (Modules 6 and 23) both hold in-process state and don't yet do atomic job claiming across multiple processes, so running more than one instance risks the same job being picked up twice. Scale by giving the one process more CPU/memory, not by clustering it.

Point your existing reverse proxy at `http://localhost:5000` (or whatever `PORT` you set) for `/api/*`, and serve the `frontend/` directory as static files — see `nginx/nginx.conf` in this repo for a config you can adapt even outside Docker.

## Health Checks

`GET /health` (also reachable as `GET /api/v1/health`) is the single source of truth every layer of this stack checks against:
- The Dockerfile's own `HEALTHCHECK` instruction
- `docker-compose.yml`'s `healthcheck:` block for the `backend` service (nginx won't route to a backend that hasn't passed this yet, via `depends_on: condition: service_healthy`)
- nginx's own healthcheck (`/health` locally, proxied through to the backend)

It returns `200` with `{ db: "up" }` when the database connection is genuinely alive (a real `SELECT 1`, not just "the process didn't crash"), and a non-200 status if the database is unreachable — so a container that's technically running but can't talk to Postgres is correctly reported as unhealthy rather than silently serving broken requests.

## Environment Configuration Reference

| File | Purpose | Committed? |
|---|---|---|
| `.env.example` (root) | Docker Compose variables (Postgres creds, host port) | Yes (template only) |
| `backend/.env.example` | Full dev-oriented reference for every backend env var, with inline explanations | Yes (template only) |
| `backend/.env.production.example` | The same variables with production-appropriate defaults and secret-generation reminders | Yes (template only) |
| `.env` / `backend/.env` | Your real filled-in values | **Never** — gitignored |

Secrets that must be genuinely random and unique per deployment: `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, `POSTGRES_PASSWORD`. Generate each with `openssl rand -base64 48` — don't reuse one value across multiple of these, and don't reuse the `.env.example` placeholder text.

`DATABASE_URL` and `DIRECT_URL` must both always be set — Prisma's schema references both directly, so a missing `DIRECT_URL` fails even if nothing about your setup uses a connection pooler. For the bundled Postgres container (or any plain, unpooled Postgres) they're identical; for Supabase they genuinely differ — see "Using Supabase" above.

## Security notes carried over from Module 25

- `CORS_ORIGINS` must list only real frontend origins in production — no `localhost` entries, no wildcards.
- The rate limiters (global, login, forgot-password, mood-board-generation, print-board-export) all key off `req.ip`. Behind nginx, this only works correctly because `nginx.conf` sets `X-Forwarded-For` and the backend's `trust proxy` setting is configured for exactly one hop. If you add another proxy/load balancer in front of nginx, adjust the trust-proxy hop count accordingly or every request will appear to come from nginx's own IP and the per-IP limiters become meaningless.
- File uploads are verified by real magic bytes, not just declared MIME type (Module 25) — this happens in the backend, not nginx, so it applies regardless of which deployment path you use.
