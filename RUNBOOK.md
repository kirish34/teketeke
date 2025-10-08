# TekeTeke – Runbook (Operations)

_Last updated: 2025-01-01_

## 0) Environments & Secrets
- Supabase: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE`, `SUPABASE_JWT_SECRET`
- App: `ADMIN_TOKEN`, `CORS_ORIGIN`, `PORT`, `NODE_ENV`, `GIT_SHA`
- CI secrets:
  - Remote tests: `TEKETEKE_BASE_URL`, `TEKETEKE_ADMIN_TOKEN`
  - Seeder: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`
- Docs: `/docs`, `/docs/light`, `/redoc`, `/openapi.json` ship with the service.

## 1) Health & Version
- `GET /ping` → "pong" (LB/uptime probe)
- `GET /health` → `{ ok, env, time }`
- `GET /__health` → detailed internal probe
- `GET /__version` → `{ name, version, git_sha, node, env, time }`

## 2) Deploy
### Render (recommended)
- Ensure `render.yaml` exists (service name: `teketeke`)
- Set env vars/secrets in Render Dashboard
- Build command: `npm ci`
- Start command: `node server.js`
- Health check: `/health`
- Inject `GIT_SHA=${GITHUB_SHA}` from CI when deploying.

### Vercel (optional)
- `vercel.json` routes `/public/*` statically, everything else → `/server.js`
- Use Project Settings → Environment Variables for secrets
- Development: `npm run dev` or `vercel dev`

## 3) Seed USSD Pool
Node-based seeder (preferred)
```
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE=...
# defaults: start=110, count=30; use staging range in CI nightly
npm run seed:ussd-pool
```

- CI supports `SEED_ENV=staging` and `SEED_START/SEED_COUNT`.

SQL-based (manual)
- Run `supabase/seed_ussd_pool.sql` via Supabase SQL editor.

## 4) E2E Tests
- Admin flow: `npm run test:admin-flow`
- Rules flow: `npm run test:rules-flow`
- Chain run: `npm run test:e2e`

Artifacts saved to `artifacts/`:
- `admin-flow.json`, `rules-flow.json`
- JUnit: `junit-admin.xml`, `junit-rules.xml`

CI will:
- seed pool
- verify pool has codes
- run E2E with timeout + single retry
- upload artifacts
- post PR summary from JUnit

## 5) Logging & Tracing
- Structured logs via **pino-http**
- Request correlation: `X-Request-ID` (incoming or generated)
- Pretty local logs: `npm run start:pretty`
- In production, ship JSON logs to your aggregator (e.g., Loki/Datadog).

## 6) Rollback
1. Deploy previous known-good commit SHA (set `GIT_SHA` accordingly).
2. Confirm `/__version` shows the rolled-back SHA.
3. Run E2E (`npm run test:e2e`) against the environment.
4. If USSD pool got altered, reseed or restore (see §7).

## 7) Backups & Restore (Supabase)
- Backups: enable daily automated backups in Supabase
- Manual export (psql):
  ```
  pg_dump $SUPABASE_URL > backup_$(date +%F).sql
  ```
- Restore:
  ```
  psql $SUPABASE_URL < backup_<date>.sql
  ```
- USSD pool: use `npm run seed:ussd-pool` to reinitialize a small range (idempotent, upsert)

## 8) Incident Response
- Check `/__health` and `/__version`.
- Inspect logs by `request_id`; verify upstream LB health.
- Confirm Supabase status.
- Run E2E to detect schema/API drift.
- If rate-limiting is tripping:
  - Admin endpoints: 429s indicate burst limits exceeded
  - Tune per-IP rate or introduce token bucket (TODO if needed)
- Roll back if new deploy correlates with regression.

## 9) Route & Auth Policy (quick ref)
- `/api/public/*` → open
- `/api/admin/*` → **requireAdmin** + x-admin-token
- `/u/*` → **requireUser** + Bearer JWT
- `/u/sacco/:saccoId/*` → **requireUser + requireSaccoMember**
- USSD supports only **SACCO / MATATU** (no CASHIER)
- Consistent envelopes: UIs handle `r.data || r.items || r`

## 10) Known Tasks
- Optional CORS pin-down per env (already supported: `CORS_ORIGIN`)
- Optional pagination for large list endpoints
- Optional structured JSON logs → centralized aggregator
- Optional secrets rotation policy docs

---

*This runbook travels with the repo. Keep it updated on every infra or contract change.*
