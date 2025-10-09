#!/usr/bin/env bash
set -euo pipefail

echo "🚑 FlashPay • TekeTeke — Project Doctor"
echo "────────────────────────────────────────"

# ---------- CONFIG ----------
APP_URL="${APP_URL:-https://<your-vercel-app>.vercel.app}"
API_URL="${API_URL:-https://<your-vercel-app>.vercel.app}"
SUPABASE_URL="${SUPABASE_URL:-${SUPABASE_URL:-}}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-${SUPABASE_ANON_KEY:-}}"
SUPABASE_SERVICE_ROLE="${SUPABASE_SERVICE_ROLE:-${SUPABASE_SERVICE_ROLE:-}}"
ADMIN_TOKEN="${ADMIN_TOKEN:-${ADMIN_TOKEN:-}}"

REQ_ENV=(SUPABASE_URL SUPABASE_ANON_KEY ADMIN_TOKEN)
NODE_REQ=">=18.18.0"

echo "📦 Node: $(node -v 2>/dev/null || echo 'not installed')"
echo "📦 NPM : $(npm -v 2>/dev/null || echo 'not installed')"
echo "🌐 APP_URL = ${APP_URL}"
echo "🛠️  API_URL = ${API_URL}"

# ---------- 0) Basic tooling ----------
missing=()
command -v node >/dev/null 2>&1 || missing+=("node")
command -v npm  >/dev/null 2>&1 || missing+=("npm")
command -v curl >/dev/null 2>&1 || missing+=("curl")
command -v jq   >/dev/null 2>&1 || missing+=("jq")
if [ ${#missing[@]} -gt 0 ]; then
  echo "❌ Missing tools: ${missing[*]} (install them and rerun)"; exit 1;
fi

# ---------- 1) Env guard ----------
echo "🔐 Checking required env vars…"
fail_env=false
for v in "${REQ_ENV[@]}"; do
  if [ -z "${!v:-}" ]; then echo "   ❌ $v is missing"; fail_env=true; fi
done
if [ "$fail_env" = true ]; then
  echo "   ➜ Create .env (local) and Vercel Project Env (prod) with these keys, then rerun."
  exit 1
fi
echo "   ✅ Env looks present"

# ---------- 2) Install & audit ----------
if [ -f package.json ]; then
  echo "🧩 npm ci…"
  npm ci --silent || npm install --silent
  echo "🔎 npm audit (high+critical only)…"
  npm audit --audit-level=high || true
fi

# ---------- 3) Lint (if configured) ----------
if npm run | grep -q "lint"; then
  echo "🧹 npm run lint…"
  npm run lint || true
fi

# ---------- 4) Build (if frontend present) ----------
if npm run | grep -q "build"; then
  echo "🏗️ npm run build…"
  npm run build || true
fi

# ---------- 5) API surface sanity ----------
declare -a endpoints=(
  "/ping"
  "/__version"
  "/openapi.json"
  "/docs"
  "/redoc"
)
echo "🌍 Probing API endpoints on ${API_URL} …"
for ep in "${endpoints[@]}"; do
  url="${API_URL}${ep}"
  code=$(curl -sk -o /dev/null -w "%{http_code}" "$url")
  echo "   ${ep} → ${code}"
done

# ---------- 6) Security headers check ----------
check_headers() {
  local url="$1"
  echo "🛡️  Security headers on: $url"
  curl -skI "$url" | awk '/^HTTP|content-security-policy|x-frame-options|x-content-type-options|referrer-policy|strict-transport-security|permissions-policy|cross-origin-opener-policy|cross-origin-resource-policy|x-xss-protection/i'
}
check_headers "${API_URL}/ping"
check_headers "${API_URL}/docs"

# ---------- 7) CORS (simple preflight) ----------
echo "🧪 CORS preflight on /ping …"
curl -skI -X OPTIONS "${API_URL}/ping" \
  -H "Origin: ${APP_URL}" \
  -H "Access-Control-Request-Method: GET" | awk '/^HTTP|access-control-allow-origin|access-control-allow-methods|access-control-allow-headers/i'

# ---------- 8) Supabase reachability ----------
echo "🟢 Supabase reachability…"
curl -sk "${SUPABASE_URL}" >/dev/null && echo "   ✅ reachable" || echo "   ❌ not reachable"

# ---------- 9) Login flow smoke (tokenless + admin) ----------
echo "🔑 Login smoke:"
echo "   • Tokenless /me (should be 401/403)…"
curl -sk -o /dev/null -w "%{http_code}\n" "${API_URL}/api/me"

if [ -n "${ADMIN_TOKEN:-}" ]; then
  echo "   • Admin /api/me with ADMIN_TOKEN…"
  code=$(curl -sk -o /dev/null -w "%{http_code}" "${API_URL}/api/me" -H "Authorization: Bearer ${ADMIN_TOKEN}")
  echo "     → ${code}"
echo "   • Admin /api/admin/system-overview…"
curl -sk -o /dev/null -w "%{http_code}\n" "${API_URL}/api/admin/system-overview" -H "Authorization: Bearer ${ADMIN_TOKEN}"
fi
echo "👥 RLS test hint:"
echo "  1) Login to get a user token:"
echo "     curl -s ${API_URL}/api/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"you\",\"password\":\"pass\"}' | jq"
echo "  2) With that token:"
echo "     curl -s ${API_URL}/api/sacco/profile -H \"Authorization: Bearer <TOKEN>\" | jq"
echo "     # SYSTEM_ADMIN can inspect any sacco: ?sacco_id=<UUID>"
echo "🧪 SACCO overview (supply sacco_id):"
echo "   curl -s \"${API_URL}/api/admin/sacco-overview?sacco_id=<ID>\" -H \"Authorization: Bearer <TOKEN>\" | jq"
echo "🛡️  Secured writes should fail without token:"
echo "   curl -i ${API_URL}/api/pos/latest -X POST"
echo "   curl -i ${API_URL}/fees/record -X POST"
echo "🧩 With a user token, writes may still be 403 if RLS denies (not SACCO_ADMIN for the sacco):"
echo "   curl -s ${API_URL}/fees/record -H \"Authorization: Bearer <TOKEN>\" -H 'Content-Type: application/json' -d '{\"matatu_id\":\"<UUID>\",\"amount\":100}' | jq"
echo "🧰 SYSTEM_ADMIN (admin token) can write regardless of RLS:"
echo "   curl -s ${API_URL}/fees/record -H \"Authorization: Bearer ${ADMIN_TOKEN}\" -H 'Content-Type: application/json' -d '{\"matatu_id\":\"<UUID>\",\"amount\":100}' | jq"
echo "📈 Metrics:"
echo " curl -s ${API_URL}/metrics | jq"
echo " curl -s ${API_URL}/metrics -H \"Authorization: Bearer ${ADMIN_TOKEN}\" | jq"
echo "🧾 Activity (auth required):"
echo " curl -s ${API_URL}/api/sacco/activity?sacco_id=<UUID> -H \"Authorization: Bearer <TOKEN>\" | jq"

# ---------- 10) CSP exceptions for docs ----------
echo "📚 Swagger/Redoc CSP sanity:"
curl -skI "${API_URL}/docs"  | awk '/content-security-policy/i'
curl -skI "${API_URL}/redoc" | awk '/content-security-policy/i'

# ---------- 11) Report ----------
echo "✅ Doctor run complete. Check the statuses above."
