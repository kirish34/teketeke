#!/usr/bin/env bash
set -euo pipefail

# ========== CONFIG ==========
# Required:
BASE="${BASE:-https://teketeke-an8u1azlg-teketeke.vercel.app}"   # current prod deploy URL
ADMIN_TOKEN="${ADMIN_TOKEN:-}"                                    # x-admin-token (no quotes in logs)

# Optional (for domain checks):
APEX="${APEX:-teketeke.app}"
WWW="${WWW:-www.teketeke.app}"

# Optional (for deeper checks):
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"
SUPABASE_SERVICE_ROLE="${SUPABASE_SERVICE_ROLE:-}"  # do NOT print

# Test user (will be created/confirmed for RLS tests via admin endpoint):
RND=$(date +%s)-$RANDOM
TEST_EMAIL="${TEST_EMAIL:-ops+${RND}@example.com}"
TEST_PASS="${TEST_PASS:-P@ss-${RND}}"

# ========== HELPERS ==========
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1"; exit 1; }; }
need curl; need jq

hr(){ printf "\n——— %s ———\n" "$1"; }

code(){ curl -s -o /dev/null -w "%{http_code}" "$1"; }

json(){ curl -sS -H "content-type: application/json" "$@"; }

ok(){ echo "PASS | $1"; }
bad(){ echo "FAIL | $1"; }

req_admin(){ [ -n "$ADMIN_TOKEN" ] || { bad "ADMIN_TOKEN not set"; exit 1; }; }

# ========== 1) BASIC ENDPOINTS ==========
hr "BASIC ENDPOINTS"
for p in /ping /__version /__healthz /openapi.json /docs /redoc; do
  c=$(code "${BASE}${p}")
  [ "$c" = "200" ] && ok "$p -> 200" || bad "$p -> $c"
done

CFG=$(curl -sS "${BASE}/config.json" || true)
if echo "$CFG" | jq -e '.SUPABASE_URL,.SUPABASE_ANON_KEY' >/dev/null 2>&1; then
  ok "/config.json contains SUPABASE_URL/ANON"
else
  bad "/config.json missing expected keys"
fi

# ========== 2) HEALTH FLAGS ==========
hr "HEALTH FLAGS"
HEALTH=$(curl -sS "${BASE}/__healthz" || true)
echo "$HEALTH" | jq . >/dev/null 2>&1 || { bad "__healthz not JSON"; }
HAS_DB=$(echo "$HEALTH" | jq -r '.has_db // .data.env.has_SUPABASE_ANON_KEY // empty' 2>/dev/null || true)
HAS_SVC=$(echo "$HEALTH" | jq -r '.has_db_admin // .data.env.has_SUPABASE_SERVICE_ROLE // empty' 2>/dev/null || true)
[ "$HAS_DB" = "true" ] || [ "$HAS_DB" = "1" ] && ok "Anon DB configured" || bad "Anon DB not configured"
[ "$HAS_SVC" = "true" ] || [ "$HAS_SVC" = "1" ] && ok "Service-role configured" || bad "Service-role not configured"

# ========== 3) DOMAIN / REDIRECT / HSTS (optional) ==========
hr "DOMAIN / REDIRECT / HSTS"
if [ -n "$APEX" ]; then
  c=$(code "https://${APEX}/ping"); [ "$c" = "200" ] && ok "Apex ${APEX} serves 200" || bad "Apex ${APEX} not serving 200"
  c=$(curl -sI "https://${WWW}/" | awk 'BEGIN{IGNORECASE=1}/^HTTP/{print $2}'); [ "$c" = "308" ] && ok "WWW ${WWW} -> 308 redirect" || bad "WWW ${WWW} not redirecting 308"
  hsts=$(curl -sI "https://${APEX}/" | awk 'BEGIN{IGNORECASE=1}/^strict-transport-security:/{print}'); 
  [ -n "$hsts" ] && ok "HSTS present: $hsts" || bad "HSTS missing on apex"
else
  echo "SKIP domain checks (APEX unset)"
fi

# ========== 4) ADMIN OPS (requires ADMIN_TOKEN) ==========
hr "ADMIN OPS"
req_admin
# List saccos
c=$(curl -s -o /dev/null -w "%{http_code}" -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE}/api/admin/saccos")
[ "$c" = "200" ] && ok "GET /api/admin/saccos -> 200" || bad "GET /api/admin/saccos -> $c"

# Create a sacco (throw-away for smoke)
SACCO_NAME="Smoke Sacco ${RND}"
resp=$(json -X POST -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE}/api/admin/register-sacco" -d "{\"name\":\"${SACCO_NAME}\"}")
sid=$(echo "$resp" | jq -r '.data.id // .id // empty')
if [ -n "$sid" ] && [ "$sid" != "null" ]; then ok "Created sacco id=${sid}"; else bad "Failed to create sacco: $resp"; fi

# ========== 5) AUTH + RLS (create user -> admin confirm -> login -> member endpoints) ==========
hr "AUTH + RLS"
# signup
sresp=$(json -X POST "${BASE}/auth/signup" -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASS}\"}")
echo "$sresp" | jq . >/dev/null 2>&1 || true
echo "$sresp" | jq -e '.ok' >/dev/null 2>&1 && ok "Signup accepted for ${TEST_EMAIL}" || bad "Signup failed"

# admin confirm
cresp=$(json -X POST -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE}/admin/users/confirm" -d "{\"email\":\"${TEST_EMAIL}\"}")
echo "$cresp" | jq -e '.ok' >/dev/null 2>&1 && ok "Email confirmed (admin helper)" || bad "Email confirm failed"

# login
lresp=$(json -X POST "${BASE}/auth/login" -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASS}\"}")
AT=$(echo "$lresp" | jq -r '.access_token // empty')
[ -n "$AT" ] && ok "User login OK (access token received)" || bad "User login failed: $lresp"

# link user to sacco as ADMIN to exercise member endpoints
link=$(json -X POST -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE}/admin/saccos/add-user" -d "{\"sacco_id\":\"${sid}\",\"role\":\"SACCO_ADMIN\",\"email\":\"${TEST_EMAIL}\"}")
echo "$link" | jq -e '.ok' >/dev/null 2>&1 && ok "Linked ${TEST_EMAIL} to sacco ${sid} as SACCO_ADMIN" || bad "Link user to sacco failed: $link"

# RLS-scoped summary for sacco
sum=$(curl -sS -H "authorization: Bearer ${AT}" "${BASE}/u/sacco/${sid}/summary?date=$(date +%F)" || true)
echo "$sum" | jq -e '.totals' >/dev/null 2>&1 && ok "RLS summary readable for sacco ${sid}" || bad "RLS summary read failed"

# ========== 6) FEES / QUOTES / USSD ==========
hr "FEES / QUOTES / USSD"
# quote (no matatu daily fee if not present)
q=$(json -X POST "${BASE}/api/fees/quote" -d "{\"sacco_id\":\"${sid}\",\"amount\":100}")
echo "$q" | jq -e '.success==true and (.splits|type=="array")' >/dev/null 2>&1 && ok "Fee quote OK" || bad "Fee quote failed: $q"

# USSD pool availability
u=$(curl -sS -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE}/api/admin/ussd/pool/available" || true)
if echo "$u" | jq -e '.success==true and (.items|type=="array")' >/dev/null 2>&1; then
  COUNT=$(echo "$u" | jq '.items|length')
  if [ "$COUNT" -gt 0 ]; then ok "USSD pool has ${COUNT} free codes"; else bad "USSD pool empty (seed needed)"; fi
else
  bad "USSD pool check failed"
fi

# ========== 7) ACTION PLAN SUMMARY ==========
hr "ACTION PLAN"
echo "- If any BASIC endpoints failed: re-check server.js routes and vercel.json"
echo "- If Anon/Service-role show FAIL: set Vercel env vars (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE, SUPABASE_JWT_SECRET, ADMIN_TOKEN)"
echo "- If domain checks failed: add DNS (A @ -> 76.76.21.21; CNAME www -> cname.vercel-dns.com), then alias deploy to ${APEX} and ${WWW}"
echo "- If RLS summary failed: verify Supabase RLS policies for sacco_users / ledger_entries and that views exist"
echo "- If USSD pool empty: seed the pool (see SQL block below)"
echo "- If fee quote failed: ensure sacco_settings row exists for sacco_id=${sid}"

echo "Done."

