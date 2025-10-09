#!/usr/bin/env bash
set -euo pipefail

# ====== CONFIG (export these before running) ======
# Required (server needs these):
: "${SUPABASE_URL:?Missing SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?Missing SUPABASE_ANON_KEY}"
: "${SUPABASE_SERVICE_ROLE:?Missing SUPABASE_SERVICE_ROLE}"
: "${SUPABASE_JWT_SECRET:?Missing SUPABASE_JWT_SECRET}"
: "${ADMIN_TOKEN:?Missing ADMIN_TOKEN}"

# Recommended for CORS & docs:
: "${APP_URL:?Missing APP_URL (e.g., https://teketeke.app or deploy URL)}"
: "${API_URL:?Missing API_URL (usually same as APP_URL)}"
: "${CORS_ORIGIN:?Missing CORS_ORIGIN (comma-separate APP/API/dashboard origins)}"
DOCS_CSP_EXTRA="${DOCS_CSP_EXTRA:-}"   # optional comma CSV, e.g. cdn.example.com

# Domains (set if you want aliasing in this run)
APEX="${APEX:-teketeke.app}"
WWW="${WWW:-www.teketeke.app}"
DO_ALIAS="${DO_ALIAS:-true}"           # set to "" to skip alias
WAIT_DNS_SECS="${WAIT_DNS_SECS:-0}"    # set >0 to wait for DNS propagate

# ====== Helpers ======
need(){ command -v "$1" >/dev/null 2>&1 || { echo "Missing $1"; exit 1; }; }
say(){ printf "\n==> %s\n" "$*"; }
now(){ date -u +%FT%TZ; }
code(){ curl -s -o /dev/null -w "%{http_code}" "$1"; }

# ====== Preflight ======
need node; need npm; need curl
if ! command -v vercel >/dev/null 2>&1; then
  say "Installing Vercel CLI"
  npm i -g vercel@latest
fi

# ====== Link project ======
say "Vercel auth & link"
vercel whoami
vercel link --yes || true

# ====== Push Production env vars ======
push_env () { # name value
  local N="$1" V="$2"
  printf "%s" "$V" | vercel env add "$N" production --yes >/dev/null 2>&1 || {
    # fallback remove+add to avoid “already exists”
    vercel env rm "$N" production --yes >/dev/null 2>&1 || true
    printf "%s" "$V" | vercel env add "$N" production --yes
  }
}

say "Syncing Production env vars to Vercel"
push_env SUPABASE_URL "$SUPABASE_URL"
push_env SUPABASE_ANON_KEY "$SUPABASE_ANON_KEY"
push_env SUPABASE_SERVICE_ROLE "$SUPABASE_SERVICE_ROLE"
push_env SUPABASE_JWT_SECRET "$SUPABASE_JWT_SECRET"
push_env ADMIN_TOKEN "$ADMIN_TOKEN"
push_env APP_URL "$APP_URL"
push_env API_URL "$API_URL"
push_env CORS_ORIGIN "$CORS_ORIGIN"
[ -n "$DOCS_CSP_EXTRA" ] && push_env DOCS_CSP_EXTRA "$DOCS_CSP_EXTRA" || true

# ====== Deploy to Production ======
say "Deploying to Production"
DEPLOY_URL=$(vercel --prod --confirm | awk '/https:\/\/.*\.vercel\.app/{print $1}' | tail -1)
[ -n "$DEPLOY_URL" ] || { echo "Could not parse deploy URL from Vercel output"; exit 1; }
echo "Deployed: $DEPLOY_URL"

# ====== Smoke checks on deploy URL ======
say "Smoke checks on $DEPLOY_URL"
declare -a P=(/ping /__version /__healthz /openapi.json /docs /redoc)
for p in "${P[@]}"; do
  c=$(code "${DEPLOY_URL}${p}")
  echo "  ${p} -> $c"
  [ "$c" = "200" ] || { echo "Smoke failed on ${p}"; exit 1; }
done

# Prometheus endpoint (admin-gated)
PC=$(curl -s -o /dev/null -w "%{http_code}" -H "x-admin-token: $ADMIN_TOKEN" "${DEPLOY_URL}/metrics/prom")
echo "  /metrics/prom -> $PC (expect 200)"
[ "$PC" = "200" ] || { echo "/metrics/prom failed (check ADMIN_TOKEN env)"; exit 1; }

# ====== Optional: alias apex + www (requires DNS) ======
if [ "$DO_ALIAS" = "true" ]; then
  say "Adding domains"
  vercel domains add "$APEX" || true
  vercel domains add "$WWW"  || true

  if [ "$WAIT_DNS_SECS" -gt 0 ]; then
    say "Waiting up to $WAIT_DNS_SECS s for DNS (A @$APEX → 76.76.21.21, CNAME www → cname.vercel-dns.com)"
    if command -v dig >/dev/null 2>&1; then DNS=dig; else DNS=nslookup; fi
    until [ "$WAIT_DNS_SECS" -le 0 ]; do
      ok1=false; ok2=false
      if [ "$DNS" = "dig" ]; then
        a=$(dig +short A "$APEX" @8.8.8.8 | grep -c '^76\.76\.21\.21$' || true)
        cn=$(dig +short CNAME "$WWW" @8.8.8.8 || true)
        awww=$(dig +short A "$WWW" @8.8.8.8 | grep -c '^76\.76\.21\.21$' || true)
        [ "$a" -ge 1 ] && ok1=true
        { [ -n "$cn" ] && echo "$cn" | grep -qi vercel-dns.com; } || [ "$awww" -ge 1 ] && ok2=true
      else
        a=$(nslookup -type=A "$APEX" 8.8.8.8 2>/dev/null | grep 'Address:' | grep -c 76.76.21.21 || true)
        cn=$(nslookup -type=CNAME "$WWW" 8.8.8.8 2>/dev/null | awk '/canonical/{print $NF}' || true)
        awww=$(nslookup -type=A "$WWW" 8.8.8.8 2>/dev/null | grep 'Address:' | grep -c 76.76.21.21 || true)
        [ "$a" -ge 1 ] && ok1=true
        { [ -n "$cn" ] && echo "$cn" | grep -qi vercel-dns.com; } || [ "$awww" -ge 1 ] && ok2=true
      fi
      echo "  $(now) apex:$ok1 www:$ok2 (remaining ${WAIT_DNS_SECS}s)"
      $ok1 && $ok2 && break
      sleep 10; WAIT_DNS_SECS=$((WAIT_DNS_SECS-10))
    done
  fi

  say "Alias apex + www to $DEPLOY_URL"
  vercel alias set "$DEPLOY_URL" "$APEX"
  vercel alias set "$DEPLOY_URL" "$WWW"

  say "Apex/www smoke"
  for p in /ping /__version /openapi.json; do
    c=$(code "https://${APEX}${p}")
    echo "  https://${APEX}${p} -> $c"; [ "$c" = "200" ] || exit 1
  done
  rc=$(curl -sI "https://${WWW}/" | awk 'BEGIN{IGNORECASE=1}/^HTTP/{print $2}')
  echo "  https://${WWW}/ -> $rc (expect 308)"; [ "$rc" = "308" ] || exit 1
fi

say "All good ✅"
echo "Prod:  $DEPLOY_URL"
[ "$DO_ALIAS" = "true" ] && echo "Alias: https://${APEX}  (www→apex 308)" || true

