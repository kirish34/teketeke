# TekeTeke Route Guide

This doc lists API namespaces, required guards, standard shapes, and quick examples. Use it to add/verify routes fast.

## 0) Namespaces & Guards (at a glance)

| Namespace / Prefix                     | Purpose                       | Required Guards                                 |
| -------------------------------------- | ----------------------------- | ----------------------------------------------- |
| `/health`, `/__health`, `/config.json` | Health/config probes          | none                                            |
| `/api/public/*`                        | Public read-only lookup lists | none                                            |
| `/auth/*`, `/api/auth/*`               | Auth & session                | none (uses body credentials / bearer as needed) |
| `/api/admin/*`                         | System Admin ops              | `requireAdmin`                                  |
| `/u/*`                                 | Authenticated user space      | `requireUser`                                   |
| `/u/sacco/:saccoId/*`                  | Member-scoped SACCO data      | `requireUser` **and** `requireSaccoMember`      |

> Guard rules are enforced in CI via `npm run check:deadcode`. If you add a route under `/api/admin/*` or `/u/*` without the guard, CI fails.

---

## 1) Response Shapes

Prefer these shapes consistently:

* **Success (generic):**

  ```json
  { "success": true, "data": { /* … */ } }
  ```

* **List:**

  ```json
  { "success": true, "items": [ /* … */ ], "count": 42 }
  ```

* **Error:**

  ```json
  { "success": false, "error": "Human readable message" }
  ```

  * Avoid leaking SQL or stack traces — use `sanitizeErr()`.

Some legacy endpoints return arrays directly; new code should normalize to the shapes above. UI clients already handle `r.data || r.items || r`.

---

## 2) Endpoints by Area

### A) Health & Config (no auth)

* `GET /health` → `200 { ok, env, time }`
* `GET /__health` → `200 { success:true, data:{ uptime_seconds, env } }`
* `GET /config.json` → `200 { SUPABASE_URL, SUPABASE_ANON_KEY }`

### B) Auth

* `POST /auth/signup`
  Body: `{ email, password, [sacco_id, sacco_role='STAFF', matatu_id, member_role='conductor'] }`
  → `200 { ok:true, needs_confirmation, session|null }`
* `POST /auth/login` / `POST /api/auth/login`
  Body: `{ email, password }`
  → `200 { ok/success:true, access_token, refresh_token, user, saccos:[{ sacco_id, role, sacco_name, default_till }], matatus:[...] }`
* `POST /auth/logout` (Bearer) → `200 { ok:true }`
* `GET /api/me` (Bearer) → `200 { id, email }`
* `GET /api/my-roles` (Bearer) → `200 { success:true, data:{ saccos:[...], matatus:[...] } }`

### C) System Admin — Saccos/Matatus/Rules (requireAdmin)

* `GET /api/admin/saccos?q&limit&offset`
  → `200 { success:true, items:[{ id,name, ... }], count }`
* `POST /api/admin/register-sacco`
  Body: `{ name, contact_*?, default_till? }`
  → `200 { success:true, data:{ id } }`
* `POST /api/admin/update-sacco`
  Body: `{ id, ...fields }` → `200 { success:true, data:{ updated:true } }`
* `DELETE /api/admin/delete-sacco/:id` → `200 { success:true, data:{ deleted:true } }`
* `GET /api/admin/matatus?sacco_id&limit&offset` → `200 { success:true, items:[...], count }`
* `POST /api/admin/register-matatu`
  Body: `{ sacco_id, number_plate, owner_name?, owner_phone?, vehicle_type?, tlb_number?, till_number? }`
  → `200 { success:true, data:{ id } }`
* `POST /api/admin/update-matatu`
  Body: `{ id, ...fields }` → `200 { success:true, data:{ updated:true } }`
* `DELETE /api/admin/delete-matatu/:id` → `200 { success:true, data:{ deleted:true } }`
* `GET /api/admin/rulesets/:saccoId` → `200 { success:true, data:{ rules:{ ... } } }`
* `POST /api/admin/rulesets`
  Body: `{ sacco_id, fare_fee_flat_kes, savings_percent, sacco_daily_fee_kes, loan_repay_percent }`
  → `200 { success:true, data:{ rules: payload } }`

### D) System Admin — USSD Pool (requireAdmin)

> **Levels supported:** `SACCO`, `MATATU` (CASHIER is blocked)

* `GET /api/admin/ussd/pool/available`
  → `200 { success:true, items:[{ base, checksum, full_code }] }`
* `GET /api/admin/ussd/pool/allocated`
  → `200 { success:true, items:[{ full_code, level, sacco_id, matatu_id, allocated_at }] }`
* `POST /api/admin/ussd/pool/assign-next`
  Body: `{ level:'SACCO'|'MATATU', sacco_id?|matatu_id?, prefix='*001*' }`
  → `200 { success:true, ussd_code }`
* `POST /api/admin/ussd/bind-from-pool`
  Body: `{ level:'SACCO'|'MATATU', sacco_id?|matatu_id?, ussd_code:'*001*<base><checksum>#' }`
  → `200 { success:true, data:{ ussd_code } }`

### E) System Admin — Transactions (requireAdmin)

* `GET /api/admin/transactions/fees?from&to`
  → `200 { success:true, data:[{ date,sacco,amount,matatu,time }] }`
* `GET /api/admin/transactions/loans?from&to`
  → `200 { success:true, data:[ ... ] }`

### F) Public Read-Only (no auth)

* `GET /api/public/saccos` → `200 { items:[{ id,name }] }`
* `GET /api/lookup/matatu?plate|till` → `200 { id,sacco_id,number_plate,... }` or `404 { error }`
* `GET /api/sacco/:saccoId/matatus` → `200 { items:[...] }`
* `GET /api/sacco/:saccoId/transactions?status&limit=50` → `200 { items:[...] }`
* `GET /api/sacco/:saccoId/summary?from&to` → `200 { range, totals }`

### G) Member Space (Bearer)

* `GET /u/my-saccos` → `200 { items:[{ sacco_id, role, name, default_till }] }`
* `GET /u/sacco/:saccoId/transactions?status&limit=50`
  → `requireUser + requireSaccoMember`
  → `200 { items:[...] }`
* `GET /u/sacco/:saccoId/matatus`
  → `requireUser + requireSaccoMember`
  → `200 { items:[...] }`
* `GET /u/sacco/:saccoId/summary?from&to`
  → `requireUser + requireSaccoMember`
  → `200 { range, totals }`

---

## 3) USSD Format Notes

* Always produce `*001*<base><checksum>#`.
* `checksum` is **digital root** of the 3-digit base (`110 → 1+1+0=2 → '2'`).
* Pool table: unique `base`, `allocated` defaults to `false`.

---

## 4) Curl Examples

Replace placeholders: `$ADMIN_TOKEN`, `$BEARER`, `$SACCO_ID`, `$MATATU_ID`, `$BASE_URL`.

**Admin list saccos**

```bash
curl -sS -H "x-admin-token: $ADMIN_TOKEN" "$BASE_URL/api/admin/saccos?limit=50"
```

**Admin create sacco**

```bash
curl -sS -X POST -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"CityRiders","contact_name":"Juma"}' \
  "$BASE_URL/api/admin/register-sacco"
```

**Admin assign next USSD to matatu**

```bash
curl -sS -X POST -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"level\":\"MATATU\",\"matatu_id\":\"$MATATU_ID\",\"prefix\":\"*001*\"}" \
  "$BASE_URL/api/admin/ussd/pool/assign-next"
```

**Member sacco summary (Bearer)**

```bash
curl -sS -H "Authorization: Bearer $BEARER" \
  "$BASE_URL/u/sacco/$SACCO_ID/summary?date=2025-01-01"
```

**Public matatus by sacco**

```bash
curl -sS "$BASE_URL/api/sacco/$SACCO_ID/matatus"
```

---

## 5) Adding a New Route (checklist)

1. Choose prefix:

   * read-only open? → `/api/public`
   * sysadmin? → `/api/admin` + **requireAdmin**
   * user-scoped? → `/u` + **requireUser** (+ **requireSaccoMember** when sacco path param present)
2. Validate inputs; do **not** log secrets/tokens.
3. Return `{ success:true, data: ... }` (or list with `items`/`count`).
4. Update dashboards if needed (use `TT.jget/jpost/jdel` and parse `r.data || r.items || r`).
5. Run:

   ```bash
   npm run check:deadcode   # guards + banned patterns + duplicates
   npm run test:e2e         # artifacts + JUnit
   ```

---

## 6) Common Pitfalls

* Missing guard on `/api/admin/*` or `/u/*` → CI fails via guard checker.
* Returning arrays directly → OK for legacy, but **prefer** `{ success:true, data:[...] }`.
* Inconsistent USSD format → always `*001*...#`.
* Forgetting to seed `ussd_pool` → E2E will warn/skip USSD steps unless seeded.

---

## 7) Glossary

* **SACCO**: Transport cooperative.
* **Matatu**: Vehicle entry associated with a SACCO.
* **USSD Pool**: Pre-generated codes assignable to `SACCO` or `MATATU`.

