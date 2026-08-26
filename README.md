# Casa de Aurum — Internal Tool

Backend + frontend in one place. See `backend/README.md` and
`frontend/README.md` for the full details on each half — this file is
just the fastest path to running them together.

```
casa-de-aurum/
├── backend/     Express + TypeScript API, PostgreSQL/Prisma, JWT auth, RBAC
└── frontend/    Static HTML/CSS/JS pages, wired to the backend via fetch()
```

## Run both

**1. Backend** (needs PostgreSQL running somewhere — a local install, the bundled Docker container, or a hosted provider like Supabase all work; see `DEPLOYMENT.md` for the Supabase-specific connection string setup):

```bash
cd backend
npm install
cp .env.example .env        # then fill in DATABASE_URL, DIRECT_URL, JWT_SECRET, JWT_REFRESH_SECRET
npx prisma generate
npx prisma migrate dev
npm run prisma:seed         # creates sample users, roles, brands, tiles, design rules...
npm run dev                 # http://localhost:5000
```

**2. Frontend** (any static file server — it's plain HTML/JS, no build step):

```bash
cd frontend
npx serve .                 # http://localhost:3000
```

**3. Open it**

Go to `http://localhost:3000/login.html` and sign in with a seeded account:

| Email | Password | Role |
|---|---|---|
| `owner@casadeaurum.com` | `ChangeMe123!` | Owner |
| `admin@casadeaurum.com` | `ChangeMe123!` | Admin |
| `priya@casadeaurum.com` | `ChangeMe123!` | Staff |

You'll land on **User & Staff Management** — the one page currently wired
end-to-end to real data. Change the password on any seeded account before
using this outside local development.

## Where things stand

| Backend module | Status | Frontend page it powers |
|---|---|---|
| 1–2. Project setup & database | ✅ | — |
| 3. Authentication | ✅ | `login.html` |
| 4. User management | ✅ | `03-user-staff-management.html` (fully wired) |
| 5. Dashboard | ✅ | `dashboard.html` (fully wired) |
| 6–7. Catalog Extractor + PDF Processing (real Python extraction, duplicate detection, queue, processing logs) | ✅ | `catalog-upload.html` (fully wired) |
| 9–10. Design Rules + Version History (create/edit/draft/publish/preview/compare/restore) | ✅ | `design-rules.html` (fully wired) |
| 11. Reference Image Library (upload/replace/delete/search/filter/categories) | ✅ | `reference-images.html` (fully wired) |
| 12. Gemini Integration (connection/error handling/retry/config) | ✅ | `04-api-keys-integrations.html` (Gemini card wired; rest preview-only) |
| 13. Prompt Builder (design rules + tile DB + client brief → structured AI JSON) | ✅ | backend only — no natural standalone page; real UI lands with Module 14 |
| 14. Mood Board API (save/update/delete/approve) | ✅ | `00-casa-de-aurum-tool-REFERENCE.html` (Mood Board Generator tab fully wired) |
| 15. Print Board Designer (real PDF export at exact dimensions) | ✅ | `00-casa-de-aurum-tool-REFERENCE.html` (Print Board Designer tab fully wired) |
| Tile Recommendation Engine (filtering/style/room/color/ranking) | ✅ | backend only — improves Mood Board Generator's tile selection invisibly, plus a new `/tiles/recommendations` browsing endpoint |
| 16. Customer Management (CRUD/history/saved boards/favorites) | ✅ | backend only — no frontend page yet |
| 17. Print Board: Edit + Templates (Create/Delete/Layout/Dimensions were already in Module 15) | ✅ | `00-casa-de-aurum-tool-REFERENCE.html` (Templates panel added to the Print Board Designer tab) |
| 18. Export Engine (real PDF + real PNG, DPI-aware, Export History) | ✅ | `00-casa-de-aurum-tool-REFERENCE.html` (PNG export now genuinely works from the Export panel) |
| 19. Google Drive Integration (upload/delete/folders/public links) | ✅ | `04-api-keys-integrations.html` (Drive card wired) + `00-casa-de-aurum-tool-REFERENCE.html` (share-to-Drive link on export) |
| 20. Notification System (success/error/processing/export toasts) | ✅ | 5 pages — replaced all 19 `alert()` calls, added processing/export toasts to key async actions |
| 21. Admin: API Keys (real storage/rotation, encrypted at rest), Logs, Analytics, Application Settings | ✅ | `04-api-keys-integrations.html`, `05-system-logs-monitoring.html`, `06-analytics-usage-stats.html`, `07-application-settings.html` (all fully wired) |
| 22. Logging System (User Activity, Login History, Catalog/Mood Board/Print Board/Error Logs) | ✅ | `05-system-logs-monitoring.html` — real log-type switcher across all six views |
| 23. Queue System (Catalog Processing, Image Processing, Export queues + real retry logic) | ✅ | `05-system-logs-monitoring.html` — real "Background Queues" panel with failed-job retry |
| 24. Customer Management frontend page | ✅ | `08-customer-management.html` (new page) — list, add/edit/delete, mood board history, favorites |
| 25. Security (rate limiting, CORS, Helmet, input/file validation, XSS/SQL injection protection) | ✅ | Fixed real XSS in 4 pages; real magic-byte file validation; Helmet CORP fix; multer 1.x→2.x upgrade; targeted rate limiting |
| 26. Swagger/OpenAPI Documentation | ✅ | `GET /api-docs` (interactive UI), `GET /api-docs.json` (raw spec) — 102 operations documented |
| 27. Production Deployment (Docker, Compose, Nginx, PM2, env config, health checks) | ✅ | `Dockerfile`, `docker-compose.yml`, `nginx/nginx.conf`, `ecosystem.config.js`, `DEPLOYMENT.md`, `docker-compose.supabase.yml` — Supabase-ready via `directUrl` |
| 28. Complete Integration (full workflow verification, real bug fixes, nav audit) | ✅ | Fixed a real catalog-extraction error-handling bug + a real dashboard navigation gap; 16-check end-to-end pipeline test |

Both READMEs go into more depth — `backend/README.md` covers the API
surface, schema, and security decisions module by module; `frontend/README.md`
explains why the `casa-de-aurum-handoff` HTML pages were used instead of
the `.dc.html` Design Canvas files, and exactly what's real vs. still a
mockup on each page.

## Connecting them elsewhere

If frontend and backend aren't both on `localhost`, two things need to
point at each other:

- Backend: set `CORS_ORIGINS` in `backend/.env` to your frontend's origin.
- Frontend: set `window.CASA_API_BASE` before `api-client.js` loads:
  ```html
  <script>window.CASA_API_BASE = "https://your-api.example.com/api/v1";</script>
  <script src="assets/api-client.js"></script>
  ```
