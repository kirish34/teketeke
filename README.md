# TekeTeke

Backend (Node/Express + Supabase) and static dashboards for a matatu/SACCO platform.

<!-- Badges: replace <ORG>/<REPO> with your repo path -->

[![Perf (k6) - smoke](https://github.com/kirish34/teketeke/actions/workflows/perf.yml/badge.svg?branch=main)](https://github.com/kirish34/teketeke/actions/workflows/perf.yml)
[![E2E](https://github.com/kirish34/teketeke/actions/workflows/e2e.yml/badge.svg?branch=main)](https://github.com/kirish34/teketeke/actions/workflows/e2e.yml)
[![OpenAPI Validate](https://github.com/kirish34/teketeke/actions/workflows/openapi-validate.yml/badge.svg?branch=main)](https://github.com/kirish34/teketeke/actions/workflows/openapi-validate.yml)
[![Stack Health](https://github.com/kirish34/teketeke/actions/workflows/stack-health.yml/badge.svg?branch=main)](https://github.com/kirish34/teketeke/actions/workflows/stack-health.yml)
[![Stack Readiness](https://github.com/kirish34/teketeke/actions/workflows/stack-readiness.yml/badge.svg?branch=main)](https://github.com/kirish34/teketeke/actions/workflows/stack-readiness.yml)

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](
  https://vercel.com/new/clone
  ?repository-url=https%3A%2F%2Fgithub.com%2Fkirish34%2Fteketeke
  &project-name=teketeke
  &repository-name=teketeke
  &env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE,SUPABASE_JWT_SECRET,ADMIN_TOKEN,APP_URL,API_URL,CORS_ORIGIN,DOCS_CSP_EXTRA
  &envDescription=Set%20Supabase%20keys%2C%20ADMIN_TOKEN%2C%20APP_URL%2C%20API_URL.%20CORS_ORIGIN%20should%20include%20your%20Vercel%20URL(s)%20and%20dashboard%20origin(s).
)

After deploy, set Environment Variables in Vercel:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE` (non‑prod key for staging)
- `SUPABASE_JWT_SECRET`
- `ADMIN_TOKEN`
- `CORS_ORIGIN` → `https://<your-vercel-domain>` (comma‑separate if multiple)

## Contributing

See CONTRIBUTING.md for setup, coding conventions, route/auth rules, tests, and CI.

## 🛡️ Code Quality & Security Checks

TekeTeke’s backend is protected by a built-in static integrity script that runs automatically **before every test** in CI and can also be executed locally.

### 🔍 Overview

The checker (`scripts/check-deadcode.js`) acts as a lightweight static analysis tool to prevent regressions, insecure routes, or reintroduction of deprecated code.

It performs **four categories of verification**:

| Check Type                   | What It Detects                                                                      | Example Violation                                               | Status  |
| ---------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------- |
| **Banned Code**              | Any use of legacy “cashier” endpoints or identifiers.                                | `/api/cashier/initiate`                                         | ❌ Error |
| **Duplicate Routes**         | Same method + path defined twice in Express.                                         | `GET /health` in two places                                     | ❌ Error |
| **Missing Auth Guards**      | `/api/admin/*` routes without `requireAdmin` or `/u/*` routes without `requireUser`. | Missing `requireAdmin` on `POST /api/admin/saccos`              | ❌ Error |
| **Missing Membership Guard** | `/u/sacco/:saccoId/*` routes missing `requireSaccoMember`.                           | Missing `requireSaccoMember` on `GET /u/sacco/:saccoId/summary` | ❌ Error |

### 🧠 How It Works

* Scans only relevant source areas (`server.js`, `routes/`, `public/`, `scripts/`).
* Skips build artifacts, tests, and dependencies (`node_modules`, `.git`, `dist`, `artifacts`).
* Uses lightweight regex parsing — no heavy AST parser needed.
* Runs automatically in CI via `.github/workflows/e2e.yml`.

### 🚦 Running Locally

You can run the guard manually at any time:

```bash
npm run check:deadcode
```

If everything is clean, you’ll see:

```
✅ No banned patterns, duplicate routes, or missing auth guards found.
```

Otherwise, the output clearly lists offending files, lines, and snippets, for example:

```
❌ Missing auth guards detected:
⚠️ GET /api/admin/saccos (server.js:312) — requireAdmin not found
⚠️ GET /u/sacco/:saccoId/summary (server.js:645) — requireSaccoMember not found
```

### ⚙️ Continuous Integration

In CI, this step runs before seeding and E2E tests:

```yaml
- name: Check for banned 'cashier' code
  run: npm run check:deadcode
```

If the check fails, the pipeline stops immediately to save time and protect main.

### ✅ Best Practice

* Always run `npm run check:deadcode` before committing large backend changes.
* Never disable this step in CI — it ensures long-term route integrity and secure access control.
* When adding new routes:

  * `/api/admin/...` → include `requireAdmin`
  * `/u/...` → include `requireUser`
  * `/u/sacco/:saccoId/...` → include both `requireUser` **and** `requireSaccoMember`

## Performance tests (k6)

We ship two profiles via a unified loader:

- **Smoke** (default): small, steady load for quick health + latency checks  
  Defaults: `VUS=5`, `DURATION=2m`, thresholds `p95 < 500ms`, `error rate < 1%`.
- **Spike**: short ramp to stress endpoints  
  Defaults: `0→50→100→0` VUs (~3m), thresholds `p95 < 800ms`, `error rate < 2%`.

The loader reads `MODE=smoke|spike` and optional thresholds:
- `THRESH_P95_MS` — e.g. `700`
- `THRESH_ERR_RATE` — e.g. `0.01` (1%)

### Local
```bash
# smoke (default thresholds)
BASE_URL=http://localhost:5001 ADMIN_TOKEN=… AUTH_TOKEN=… npm run perf:smoke

# spike
BASE_URL=http://localhost:5001 ADMIN_TOKEN=… AUTH_TOKEN=… npm run perf:spike

# override thresholds (example: smoke, tighter limits)
THRESH_P95_MS=450 THRESH_ERR_RATE=0.005 BASE_URL=… npm run perf:smoke
```

### CI (manual)

* GitHub → **Actions** → **Perf (k6)** → *Run workflow*
  Choose `MODE` (smoke/spike).
  The job summary shows **p95**, **p99**, **error rate**, **iterations**, **max VUs**, and data in/out.
* The **Perf Gate** step fails the job if thresholds are exceeded.

### Endpoints covered

* Always: `/ping`, `/__version`, public read endpoints.
* If `ADMIN_TOKEN` set (and/or `RUN_ADMIN=true`): `/api/admin/*` reads.
* If `AUTH_TOKEN` set (and/or `RUN_MEMBER=true`): `/u/*` reads.

### Troubleshooting

* **401/403**: missing/expired `ADMIN_TOKEN` / `AUTH_TOKEN`.
* **429** on `/api/admin/*`: admin rate limiter—reduce VUs or raise limit for CI IPs.
* **Gate failed**: inspect artifacts `artifacts/k6-<mode>.json` and job summary.

## Vercel deploy & smoke checklist

App URL: https://teketeke-3wmdki35z-teketeke.vercel.app

### 1) Basic page checks
- Open `/auth/role-select.html` → page loads, no console errors
- Open `/admin.html` (System Admin) → token box visible at top
- Open `/sacco/sacco.html` (classic) and `/sacco/admin.html` (new) → both render

### 2) Tokens + auth (set from browser console)
Open DevTools on your Vercel site and run:

```js
// Replace values with your real tokens
localStorage.setItem('tt_root_token', 'YOUR_ADMIN_TOKEN');      // x-admin-token for System Admin
localStorage.setItem('auth_token',    'YOUR_USER_BEARER_TOKEN'); // Supabase JWT for member routes
// Reload the page after setting tokens
location.reload();
```

### 3) Quick endpoint sanity

* `/openapi.json` → JSON spec
* `/docs` and `/redoc` → API docs UIs load
* `/api/public/saccos` → returns list (open)
* `/api/admin/saccos` → returns data when `tt_root_token` is set (x-admin-token)
* `/u/my-saccos` → returns memberships when `auth_token` is set (Bearer)

### 4) CORS tip (backend)

If you see CORS issues, set on the backend (include APP_URL and API_URL too):

```
CORS_ORIGIN=https://teketeke-3wmdki35z-teketeke.vercel.app
```

(Comma-separate if multiple origins), then redeploy backend.

## Project Doctor

Run a one-shot audit for backend, docs, security headers, CORS, and Supabase reachability.

1) Make executable and run (Mac/Linux/WSL/Git Bash):

```
chmod +x scripts/project-doctor.sh
APP_URL=https://<your-vercel-app>.vercel.app \
API_URL=https://<your-vercel-app>.vercel.app \
SUPABASE_URL=https://xxxxx.supabase.co \
SUPABASE_ANON_KEY=eyJ... \
ADMIN_TOKEN=claire.1leah.2seline.3zara.4 \
scripts/project-doctor.sh
```

On Windows PowerShell, set env vars with `$env:APP_URL="..."` etc, then run via WSL or Git Bash.

## Two Roles Only (TekeTeke)

This deployment operates with two roles: `SYSTEM_ADMIN` and `SACCO_ADMIN`.
- SYSTEM_ADMIN: use `ADMIN_TOKEN` as a Bearer token for admin-only endpoints (or x-admin-token for legacy admin routes).
- SACCO_ADMIN: requires a Supabase user linked in `sacco_users` with role `SACCO_ADMIN`.

Ensure in Vercel → Environment Variables:
- `SUPABASE_JWT_SECRET` is set (enables local JWT verification).
- `APP_URL` and `API_URL` include your production hostname.

### 5) Docs CSP (env)

To allow extra script/style hosts for Swagger/Redoc without code changes, set in Vercel env:

```
DOCS_CSP_EXTRA=cdn.skypack.dev,cdn.example.com
```

Comma-separated list of extra hosts allowed for `/docs` and `/redoc` scripts/styles.

## What’s Live Now

| Area    | Status                                            |
| ------- | ------------------------------------------------- |
| Roles   | SYSTEM_ADMIN, SACCO_ADMIN                         |
| Auth    | Supabase JWT + ADMIN_TOKEN                        |
| RLS     | Reads + Writes enforced                           |
| Admin   | system-overview, sacco-overview                   |
| SACCO   | profile, activity                                 |
| Metrics | `/metrics` JSON (public), `/metrics/prom` (admin) |
| Docs    | `/openapi.json`, `/docs`, `/redoc`                |

### Troubleshooting
- 401: Missing/invalid token (use Authorization: Bearer <token> or ADMIN_TOKEN)
- 403: RLS denied (user lacks SACCO_ADMIN for target sacco)
- 422: Bad body (missing required fields or wrong types)
- CORS: Ensure APP_URL/API_URL/CORS_ORIGIN include your domain
