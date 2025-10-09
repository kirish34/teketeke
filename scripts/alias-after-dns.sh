#!/usr/bin/env bash
set -euo pipefail

APEX="teketeke.app"
WWW="www.teketeke.app"
DEPLOY_URL="${DEPLOY_URL:-https://teketeke-an8u1azlg-teketeke.vercel.app}"
MAX_WAIT="${MAX_WAIT:-1800}"   # seconds (30m)
SLEEP="${SLEEP:-20}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1"; exit 1; }; }
need curl
if ! command -v dig >/dev/null 2>&1; then
  echo "dig not found; falling back to nslookup"
  DNS_TOOL="nslookup"
else
  DNS_TOOL="dig"
fi

apex_ok() {
  if [ "$DNS_TOOL" = "dig" ]; then
    ips=$(dig +short A "$APEX" @8.8.8.8 || true)
  else
    ips=$(nslookup -type=A "$APEX" 8.8.8.8 2>/dev/null | awk '/Address: /{print $2}' || true)
  fi
  echo "$ips" | grep -q '^76\.76\.21\.21$'
}

www_ok() {
  if [ "$DNS_TOOL" = "dig" ]; then
    cname=$(dig +short CNAME "$WWW" @8.8.8.8 || true)
    if [ -n "$cname" ]; then
      echo "$cname" | grep -qi 'vercel-dns\.com\.'
    else
      ips=$(dig +short A "$WWW" @8.8.8.8 || true)
      echo "$ips" | grep -q '^76\.76\.21\.21$'
    fi
  else
    # nslookup path (prefer CNAME)
    cname=$(nslookup -type=CNAME "$WWW" 8.8.8.8 2>/dev/null | awk '/canonical name|canonical/{print $NF}')
    if [ -n "$cname" ]; then
      echo "$cname" | grep -qi 'vercel-dns\.com\.'
    else
      ips=$(nslookup -type=A "$WWW" 8.8.8.8 2>/dev/null | awk '/Address: /{print $2}')
      echo "$ips" | grep -q '^76\.76\.21\.21$'
    fi
  fi
}

echo "==> Waiting for DNS to resolve to Vercel…"
elapsed=0
while true; do
  ok1=false; ok2=false
  apex_ok && ok1=true
  www_ok && ok2=true
  echo "  apex:${ok1} www:${ok2} (t=${elapsed}s)"
  if $ok1 && $ok2; then break; fi
  [ "$elapsed" -ge "$MAX_WAIT" ] && { echo "Timed out waiting for DNS."; exit 1; }
  sleep "$SLEEP"; elapsed=$((elapsed+SLEEP))
done

echo "==> Vercel auth & project link"
vercel whoami
vercel link --yes >/dev/null 2>&1 || true
vercel domains add "$APEX" || true

echo "==> Alias apex and www to $DEPLOY_URL"
vercel alias set "$DEPLOY_URL" "$APEX"
vercel alias set "$DEPLOY_URL" "$WWW"

echo "==> Smoke tests"
APEX_BASE="https://${APEX}"
WWW_BASE="https://${WWW}"

check_code () {
  local url="$1" expect="$2"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  printf "%-45s -> %s (expect %s)\n" "$url" "$code" "$expect"
  [ "$code" = "$expect" ] || { echo "FAIL ${url}"; exit 1; }
}

# apex should 200
for p in /ping /__version /__healthz /openapi.json /docs /redoc; do
  check_code "$APEX_BASE$p" 200
done

# www should 308 -> apex
for p in / /ping /docs; do
  check_code "$WWW_BASE$p" 308
  loc=$(curl -sI "$WWW_BASE$p" | awk 'BEGIN{IGNORECASE=1}/^location:/{print $2}' | tr -d '\r')
  echo "  location: $loc"
  case "$loc" in
    https://$APEX/*|https://$APEX) ;;
    *) echo "Unexpected redirect location"; exit 1;;
  esac
done

# HSTS on apex
echo "==> Check HSTS header on apex"
curl -sI "$APEX_BASE" | awk 'BEGIN{IGNORECASE=1}/^strict-transport-security:/{print}'
echo "All set — ${WWW} redirects (308) to ${APEX}, endpoints healthy."

