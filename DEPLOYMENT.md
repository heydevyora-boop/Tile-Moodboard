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

4. **Python AI service config** (`catalog_processor` — powers AI bathroom visualization; required to exist even if you leave it mostly blank):
   ```bash
   cp catalog_processor/.env.example catalog_processor/.env
   # edit catalog_processor/.env — at minimum GEMINI_API_KEY.
   #
   # IMPORTANT: this is a SEPARATE Gemini key from the Node backend's.
   # backend/.env's GEMINI_API_KEY (or a key rotated in via Admin -> API
   # Keys) is used by the Node side's own Gemini calls only — the Node
   # backend never forwards it to this service. catalog_processor reads
   # its own GEMINI_API_KEY independently (app/gemini_service.py). Set
   # both, even if the value is identical, or AI visualization will fail
   # with a Gemini auth error despite backend/.env looking correctly
   # configured.
   ```
   `backend/.env`'s `PYTHON_AI_BASE_URL` should be `http://catalog_processor:8000` for this stack — `backend/.env.production.example` already has that as the default.

5. **Build and start**:
   ```bash
   docker compose up -d --build
   ```
   On first boot, the backend container's entrypoint runs `prisma migrate deploy` automatically before starting the server — the schema is created for you, no manual migration step needed. `docker compose ps` should show four healthy services: `postgres`, `catalog_processor`, `backend`, `nginx` (that's `depends_on: condition: service_healthy` order — nginx won't come up healthy until backend is, and backend won't start until both postgres and catalog_processor report healthy).

6. **Seed the first Owner account** (one-time, since there's no self-registration by design):
   ```bash
   docker compose exec backend npm run prisma:seed
   ```

7. **Verify**:
   ```bash
   curl http://localhost/health          # nginx -> backend health passthrough
   curl http://localhost/api/v1/health   # same thing, direct API path
   ```
   Open `http://localhost/login.html` in a browser. To specifically confirm the Python side is reachable, sign in as an Owner and check API Keys & Integrations — it now has a "Python AI Service" status card alongside Gemini/Drive.

### Day-to-day operations

```bash
docker compose logs -f backend             # tail backend logs
docker compose logs -f catalog_processor   # tail the Python AI service's logs
docker compose ps                          # see health status of all four services
docker compose restart backend             # restart just the API (e.g. after changing backend/.env)
docker compose restart catalog_processor   # restart just the Python service (e.g. after changing its .env)
docker compose exec backend npx prisma studio   # inspect the DB
docker compose down                        # stop everything (add -v to also delete volumes — careful, that deletes uploads/DB/generated-image data)
```

### Updating to a new version

```bash
git pull
docker compose up -d --build backend catalog_processor   # rebuilds both app images; migrations run automatically on backend start
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

This path also needs the Python AI service (`catalog_processor`) running and supervised separately — it's a second process, not something PM2's `ecosystem.config.js` starts for you.

```bash
cd catalog_processor
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # fill in GEMINI_API_KEY — see the Docker Compose
                             # steps above for why this is separate from
                             # backend/.env's key

# Supervise this however you supervise long-running processes on this VM —
# pm2 works for a plain Python process too, not just Node:
pm2 start ".venv/bin/python3" --name casa-python-ai \
  --interpreter none \
  -- -m uvicorn main_step6_complete:app --host 0.0.0.0 --port 8000
```

```bash
cd backend
npm ci --omit=dev
npm run build
cp .env.production.example .env   # fill in real values, same as the Docker path above
# ...including PYTHON_AI_BASE_URL=http://127.0.0.1:8000 (both processes
# share this host here, unlike the Docker path's service-name URL) and
# PYTHON_EXECUTABLE pointed at backend/python/.venv/bin/python3 if you set
# up that venv per backend/python/README.md, rather than relying on
# whatever "python3" resolves to on PATH
npx prisma migrate deploy
npm run prisma:seed               # first-time only

npm install -g pm2
npm run pm2:start
pm2 save
pm2 startup   # follow the printed instructions to survive a reboot
```

`ecosystem.config.js` is intentionally configured for a **single instance, fork mode — not cluster mode**. The catalog extraction queue and the generic job queue (Modules 6 and 23) both hold in-process state and don't yet do atomic job claiming across multiple processes, so running more than one instance risks the same job being picked up twice. Scale by giving the one process more CPU/memory, not by clustering it.

Point your existing reverse proxy at `http://localhost:5000` (or whatever `PORT` you set) for `/api/*`, and serve the `frontend/` directory as static files — see `nginx/nginx.conf` in this repo for a config you can adapt even outside Docker.

## Python AI service (`catalog_processor`) — things worth knowing

- **Its Google Drive/Sheets integration uses a different auth model than the Node backend's.** The Node backend uses a service-account JSON key (`GOOGLE_SERVICE_ACCOUNT_KEY_PATH`) — fully headless, works fine in a container. `catalog_processor/app/google_services.py` instead uses interactive OAuth (`InstalledAppFlow`, expects a `credentials.json` and generates a `token.json` after a one-time browser consent). That flow cannot complete inside a headless Docker container or a remote server with no browser. In practice this only matters if you actually need this service's own Drive/Sheets features (persisting the MASTER product sheet, uploading generated visualizations to Drive from this side) — AI visualization generation itself already degrades gracefully to local-only storage when Drive/Sheets aren't configured (see `visualization_orchestrator.py`), so a fresh deploy with no Drive/Sheets config still works for the core feature. If you do need it, run the one-time OAuth consent somewhere with a browser first and ship the resulting `token.json` in, rather than expecting it to work from inside the container.
- **Its `GEMINI_API_KEY` is independent from the Node backend's** — see the config step above. Set it in both places.
- **Generated visualizations save under `catalog_processor/output/`** inside the container — that's what the `catalog_processor_output` Docker volume in `docker-compose.yml` persists across restarts/rebuilds.

### Optional: pen-drive auto-detect agent (`usb_agent.py`)

`catalog_processor/usb_agent.py` is a **separate, standalone script**, unrelated to the "upload a PDF from the frontend" flow (`extract.py`/`admin-catalog-extractor.html`) and unrelated to the containerized FastAPI service. It watches for a USB drive being plugged in and automatically runs the same catalog pipeline (`process_drive()` in `main_step6_complete.py`) against it — no browser or upload step involved.

It is **Windows-only** (`ctypes.windll`) and cannot run inside the Linux Docker containers this stack otherwise uses, and it cannot be triggered from a web browser — it must run as its own long-lived process on a Windows machine that has physical access to the pen drive:

```bat
cd catalog_processor
:: one-time setup on that machine
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
:: edit .env — same GOOGLE_SHEET_ID / Drive-Sheets / Gemini config as the
:: containerized service (see the two points above)

:: run it (leave this running — it polls every 2s for a newly attached drive)
.venv\Scripts\python usb_agent.py
```

Since it imports `main_step6_complete.py` directly (not over HTTP), it needs the *same* Python dependencies as the containerized service (`requirements.txt`) installed locally on that Windows machine, and reads its config from `catalog_processor/.env` — same file, just read from disk instead of an env var passed into a container. It resolves both `.env` and its `output/` write directory relative to its own script location, so it works the same way regardless of what directory it's launched from (double-click, a desktop shortcut, Task Scheduler, etc.).

When it detects a new removable drive, it walks the drive for PDF catalogs and runs the full pipeline — no separate step needed.

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
| `catalog_processor/.env.example` | The Python AI service's own env vars (its own separate `GEMINI_API_KEY`, Sheets/Drive config) | Yes (template only) |
| `.env` / `backend/.env` / `catalog_processor/.env` | Your real filled-in values | **Never** — gitignored |

Secrets that must be genuinely random and unique per deployment: `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, `POSTGRES_PASSWORD`. Generate each with `openssl rand -base64 48` — don't reuse one value across multiple of these, and don't reuse the `.env.example` placeholder text.

`DATABASE_URL` and `DIRECT_URL` must both always be set — Prisma's schema references both directly, so a missing `DIRECT_URL` fails even if nothing about your setup uses a connection pooler. For the bundled Postgres container (or any plain, unpooled Postgres) they're identical; for Supabase they genuinely differ — see "Using Supabase" above.

## Security notes carried over from Module 25

- `CORS_ORIGINS` must list only real frontend origins in production — no `localhost` entries, no wildcards.
- The rate limiters (global, login, forgot-password, mood-board-generation, print-board-export) all key off `req.ip`. Behind nginx, this only works correctly because `nginx.conf` sets `X-Forwarded-For` and the backend's `trust proxy` setting is configured for exactly one hop. If you add another proxy/load balancer in front of nginx, adjust the trust-proxy hop count accordingly or every request will appear to come from nginx's own IP and the per-IP limiters become meaningless.
- File uploads are verified by real magic bytes, not just declared MIME type (Module 25) — this happens in the backend, not nginx, so it applies regardless of which deployment path you use.
