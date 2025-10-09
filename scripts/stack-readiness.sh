#!/usr/bin/env bash
set -euo pipefail

# ===== Inputs (set if you have them) =====
BASE="${BASE:-https://teketeke-an8u1azlg-teketeke.vercel.app}"   # deploy or alias
APEX="${APEX:-teketeke.app}"
WWW="${WWW:-www.teketeke.app}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"       # leave empty if not available (will mark admin checks UNKNOWN)

# ===== Helpers =====
have(){ command -v "$1" >/dev/null 2>&1; }
safe_curl(){ curl -sS -m 20 "$@"; }
json_code(){ curl -s -o /dev/null -w "%{http_code}" "$1"; }
pass(){ echo "PASS | $*"; }
fail(){ echo "FAIL | $*"; }
warn(){ echo "WARN | $*"; }
note(){ echo "NOTE | $*"; }
hr(){ printf "\n=== %s ===\n" "$1"; }

REPORT="$(mktemp)"; trap 'cat "$REPORT"' EXIT
echo "# TekeTeke Readiness Report" > "$REPORT"
echo "_Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")_  \nTarget: \`$BASE\`" >> "$REPORT"

# ===== Scoring rubric (100 pts total) =====
# 30 API backend (routes healthy, OpenAPI parity)
# 20 Infra/Deploy (Vercel config, redirects, HSTS, env wiring)
# 15 Auth/RLS (signup, confirm, login, member reads)
# 10 Admin ops (admin endpoints usable)
# 10 Data model (SQL/migrations present; essential views/indexes)
# 10 Observability (logs, /metrics, CI health-checks)
# 5  Security (helmet, rate-limit, CORS)
# =====

declare -A SCORE=( [api]=0 [infra]=0 [auth]=0 [admin]=0 [data]=0 [obs]=0 [sec]=0 )

# ---------- API backend (30) ----------
hr "API backend"
codes_ok=1
for p in /ping /__version /__healthz /openapi.json /docs /redoc; do
  c=$(json_code "${BASE}${p}")
  echo "$p -> $c"
  [ "$c" = "200" ] || codes_ok=0
done
if [ $codes_ok -eq 1 ]; then SCORE[api]=$((SCORE[api]+15)); pass "Core routes 200"; else fail "Core routes not healthy"; fi

# Route surface vs OpenAPI parity (static heuristics)
api_routes=$(grep -Eo "app\.(get|post|put|patch|delete)\(['\"][^'\"]+" -n server.js | awk -F"'" '{print $2}' | sort -u || true)
doc_paths=$(awk '/^paths:/{flag=1;next}/^[^ \t]/{flag=0}flag' openapi.yaml 2>/dev/null | grep -E '^[[:space:]]+/[^:]+' | awk '{print $1}' | tr -d ':' | sort -u || true)

missing_in_docs=0
while read -r r; do
  [ -z "$r" ] && continue
  echo "$doc_paths" | grep -qx "$r" || { echo "Undocumented route: $r"; missing_in_docs=$((missing_in_docs+1)); }
done <<< "$api_routes"

if [ "$missing_in_docs" -eq 0 ]; then SCORE[api]=$((SCORE[api]+10)); pass "OpenAPI covers server routes"; else warn "$missing_in_docs routes missing in OpenAPI"; fi

# JSON spec shape
if safe_curl "$BASE/openapi.json" | jq '.info.title,.paths' >/dev/null 2>&1; then SCORE[api]=$((SCORE[api]+5)); pass "OpenAPI serves valid JSON"; else warn "OpenAPI JSON invalid"; fi

# ---------- Infra/Deploy (20) ----------
hr "Infra / Deploy"
# HSTS + redirect + apex health
apex200=$(json_code "https://${APEX}/ping" || true)
wwwcode=$(curl -sI "https://${WWW}/" | awk 'BEGIN{IGNORECASE=1}/^HTTP/{print $2}')
hsts=$(curl -sI "https://${APEX}/" | awk 'BEGIN{IGNORECASE=1}/^strict-transport-security:/{print}')

[ "$apex200" = "200" ] && SCORE[infra]=$((SCORE[infra]+6)) && pass "Apex 200" || warn "Apex not 200"
[ "$wwwcode" = "308" ] && SCORE[infra]=$((SCORE[infra]+6)) && pass "www→apex 308" || warn "www redirect not 308"
[ -n "$hsts" ] && SCORE[infra]=$((SCORE[infra]+4)) && pass "HSTS present" || warn "HSTS missing/unknown"

# vercel.json presence
[ -f vercel.json ] && SCORE[infra]=$((SCORE[infra]+4)) && pass "vercel.json present" || warn "vercel.json not found"

# ---------- Auth/RLS (15) ----------
hr "Auth / RLS"
if [ -n "$ADMIN_TOKEN" ]; then
  RND=$(date +%s)-$RANDOM
  EMAIL="ops+${RND}@example.com"
  PASS="P@ss-${RND}"
  signup=$(curl -sS -H "content-type: application/json" -X POST "$BASE/auth/signup" -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" || true)
  ok_signup=$(echo "$signup" | jq -r '.ok' 2>/dev/null || echo "")
  if [ "$ok_signup" = "true" ]; then
    pass "Signup accepted"
    confirm=$(curl -sS -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" -X POST "$BASE/admin/users/confirm" -d "{\"email\":\"$EMAIL\"}" || true)
    if echo "$confirm" | jq -e '.ok==true' >/dev/null 2>&1; then
      pass "Admin confirm OK"
      login=$(curl -sS -H "content-type: application/json" -X POST "$BASE/auth/login" -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
      AT=$(echo "$login" | jq -r '.access_token // empty')
      if [ -n "$AT" ]; then
        pass "Login OK"
        SCORE[auth]=$((SCORE[auth]+15))
      else
        warn "Login failed"; SCORE[auth]=$((SCORE[auth]+10))
      fi
    else
      warn "Admin confirm failed"; SCORE[auth]=$((SCORE[auth]+5))
    fi
  else
    warn "Signup failed"; SCORE[auth]=$((SCORE[auth]+0))
  fi
else
  warn "ADMIN_TOKEN not set; Auth/RLS deep checks UNKNOWN"
fi

# ---------- Admin ops (10) ----------
hr "Admin Ops"
if [ -n "$ADMIN_TOKEN" ]; then
  code_saccos=$(curl -s -o /dev/null -w "%{http_code}" -H "x-admin-token: $ADMIN_TOKEN" "$BASE/api/admin/saccos")
  [ "$code_saccos" = "200" ] && SCORE[admin]=$((SCORE[admin]+5)) && pass "List saccos OK" || warn "Admin list saccos failed"

  resp=$(curl -sS -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" -X POST "$BASE/api/admin/register-sacco" -d "{\"name\":\"Smoke Sacco $(date +%s)\"}" || true)
  sid=$(echo "$resp" | jq -r '.data.id // .id // empty')
  if [ -n "$sid" ]; then SCORE[admin]=$((SCORE[admin]+5)); pass "Create sacco OK"; else warn "Create sacco failed"; fi
else
  warn "ADMIN_TOKEN not set; Admin ops UNKNOWN"
fi

# ---------- Data model (10) ----------
hr "Data Model"
sql_count=$(ls -1 supabase/*.sql 2>/dev/null | wc -l | tr -d ' ')
[ "$sql_count" -gt 0 ] && SCORE[data]=$((SCORE[data]+5)) && pass "SQL/migrations present ($sql_count files)" || warn "No supabase/*.sql found"
# check for expected artifacts
expected=("saccos" "matatus" "sacco_users" "matatu_members" "sacco_settings" "transactions" "ledger_entries" "ussd_pool" "daily_fees" "pos_latest" "v_tx_today_by_sacco" "v_tx_yesterday_by_sacco")
missing=0
for t in "${expected[@]}"; do
  grep -Eiq "$t" supabase/*.sql 2>/dev/null || { echo "Missing in SQL (heuristic): $t"; missing=$((missing+1)); }
done
if [ "$missing" -le 2 ]; then SCORE[data]=$((SCORE[data]+5)); pass "Expected schema largely present"; else warn "$missing schema items possibly missing"; fi

# ---------- Observability (10) ----------
hr "Observability"
# logging & metrics
grep -q "pino-http" server.js && SCORE[obs]=$((SCORE[obs]+3)) && pass "Structured logs (pino) in use" || warn "pino-http not found"
grep -qE "app\.get\('/metrics'|'\/metrics'" server.js && SCORE[obs]=$((SCORE[obs]+2)) && pass "/metrics present" || warn "No /metrics route"
# CI health workflows
ls .github/workflows/* 2>/dev/null | grep -E "stack-health|openapi-validate" >/dev/null 2>&1 && SCORE[obs]=$((SCORE[obs]+5)) && pass "CI health checks present" || warn "CI health checks missing"

# ---------- Security (5) ----------
hr "Security"
grep -q "helmet(" server.js && SCORE[sec]=$((SCORE[sec]+2)) && pass "helmet configured" || warn "helmet not found"
grep -q "express-rate-limit" server.js && SCORE[sec]=$((SCORE[sec]+2)) && pass "rate limits configured" || warn "rate limits missing"
grep -q "cors(" server.js && SCORE[sec]=$((SCORE[sec]+1)) && pass "CORS in place" || warn "CORS not found"

# ===== Compute total =====
TOTAL=$(( SCORE[api]+SCORE[infra]+SCORE[auth]+SCORE[admin]+SCORE[data]+SCORE[obs]+SCORE[sec] ))
echo >> "$REPORT"
echo "## Score" >> "$REPORT"
printf "- API backend: **%d/30**\n" "${SCORE[api]}" >> "$REPORT"
printf "- Infra/Deploy: **%d/20**\n" "${SCORE[infra]}" >> "$REPORT"
printf "- Auth/RLS: **%d/15**\n" "${SCORE[auth]}" >> "$REPORT"
printf "- Admin ops: **%d/10**\n" "${SCORE[admin]}" >> "$REPORT"
printf "- Data model: **%d/10**\n" "${SCORE[data]}" >> "$REPORT"
printf "- Observability: **%d/10**\n" "${SCORE[obs]}" >> "$REPORT"
printf "- Security: **%d/5**\n" "${SCORE[sec]}" >> "$REPORT"
printf "\n# **Readiness: %d/100 (%.0f%%)**\n" "$TOTAL" "$TOTAL" >> "$REPORT"

# ===== Backlog (auto) =====
echo -e "\n## Prioritized Backlog" >> "$REPORT"
[ "$apex200" = "200" ] || echo "1. Configure DNS/alias so apex \`$APEX\` serves 200; then rerun health." >> "$REPORT"
[ "$wwwcode" = "308" ] || echo "2. Ensure 308 redirect \`www -> apex\` via \`vercel.json\` and redeploy." >> "$REPORT"
[ -n "$hsts" ] || echo "3. Add HSTS header in \`vercel.json\` (includeSubDomains; preload) and redeploy." >> "$REPORT"
[ "$missing_in_docs" -eq 0 ] || echo "4. Document $missing_in_docs server routes in \`openapi.yaml\` and re-run CI." >> "$REPORT"
[ -n "$ADMIN_TOKEN" ] || echo "5. Set \`ADMIN_TOKEN\` in CI secrets to enable admin+RLS checks." >> "$REPORT"
[ "$sql_count" -gt 0 ] || echo "6. Add supabase SQL/migrations (tables, views, indexes) and run in Supabase." >> "$REPORT"
grep -qE "app\.get\('/metrics'" server.js || echo "7. Add \`/metrics\` (Prometheus-style) for production monitoring." >> "$REPORT"

# Save report
mkdir -p REPORTS
cp "$REPORT" REPORTS/READINESS.md
echo -e "\n---\nReport written to REPORTS/READINESS.md"

