#!/usr/bin/env bash
#
# Alias a Vercel deployment to apex + www, then run domain + API smokes.
#
# Usage:
#   chmod +x scripts/alias-and-smoke.sh
#   scripts/alias-and-smoke.sh -d https://<deploy>.vercel.app -a teketeke.app -w www.teketeke.app [-t "$ADMIN_TOKEN"] [-s]
#
# Flags:
#   -d  DEPLOY_URL      (required) e.g. https://teketeke-abc123.vercel.app
#   -a  APEX            (required) e.g. teketeke.app
#   -w  WWW             (required) e.g. www.teketeke.app
#   -t  ADMIN_TOKEN     (optional) for /metrics/prom check
#   -s                  (optional) strict mode: exit 1 if any FAIL occurs
#
# Env:
#   VERCEL_FLAGS        (optional) extra flags for `vercel` (e.g., "--scope your-team")
#
# Requirements: vercel CLI (logged in & linked), curl, jq

set -euo pipefail

# --- CLI args ---
STRICT=false
DEPLOY_URL=""
APEX=""
WWW=""
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

while getopts ":d:a:w:t:s" opt; do
  case $opt in
    d) DEPLOY_URL="$OPTARG" ;;
    a) APEX="$OPTARG" ;;
    w) WWW="$OPTARG" ;;
    t) ADMIN_TOKEN="$OPTARG" ;;
    s) STRICT=true ;;
    \?) echo "Invalid option: -$OPTARG" >&2; exit 2 ;;
    :) echo "Option -$OPTARG requires an argument." >&2; exit 2 ;;
  esac
done

if [[ -z "${DEPLOY_URL}" || -z "${APEX}" || -z "${WWW}" ]]; then
  echo "Usage: $0 -d <deploy_url> -a <apex> -w <www> [-t <admin_token>] [-s]"
  exit 2
fi

# --- deps ---
for cmd in vercel curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing dependency: $cmd"
    exit 2
  fi
done

# --- styling ---
GREEN='\033[0;32m'; RED='\033[0;31m'; YEL='\033[0;33m'; NC='\033[0m'
PASS() { echo -e "${GREEN}PASS${NC} - $*"; }
FAIL() { echo -e "${RED}FAIL${NC} - $*"; FAIL_COUNT=$((FAIL_COUNT+1)); }
WARN() { echo -e "${YEL}WARN${NC} - $*"; }

FAIL_COUNT=0
ARTDIR="artifacts"
mkdir -p "$ARTDIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$ARTDIR/alias-smoke-$STAMP.txt"

log() { echo "$*" | tee -a "$LOG"; }

http_code() {
  local url="$1"
  curl -sI "$url" | awk '/^HTTP\/[0-9.]+/ {code=$2} END{print code}'
}

header() {
  local url="$1" name="$2"
  curl -sI "$url" | tr -d '\r' | awk -v name="$(echo "$name" | tr '[:upper:]' '[:lower:]')" '
    BEGIN{IGNORECASE=1}
    tolower($0) ~ "^"name":" { sub("^"name":[ ]*", "", $0); print; exit }
  '
}

# --- 1) Alias apex + www ---
log "== Alias =="
set +e
ALIAS_APEX_OUT=$(vercel alias set ${VERCEL_FLAGS:-} "$DEPLOY_URL" "$APEX" 2>&1)
ALIAS_APEX_RC=$?
ALIAS_WWW_OUT=$(vercel alias set ${VERCEL_FLAGS:-} "$DEPLOY_URL" "$WWW" 2>&1)
ALIAS_WWW_RC=$?
set -e

log "Apex alias output:"
log "$ALIAS_APEX_OUT"
log "WWW alias output:"
log "$ALIAS_WWW_OUT"

if [[ $ALIAS_APEX_RC -ne 0 ]]; then
  if echo "$ALIAS_APEX_OUT" | grep -qi "not verified\|Response Error"; then
    FAIL "Apex alias failed. DNS likely not verified. Set: @ A 76.76.21.21 for $APEX"
  else
    FAIL "Apex alias failed. See logs."
  fi
else
  PASS "Apex aliased: $APEX → $DEPLOY_URL"
fi

if [[ $ALIAS_WWW_RC -ne 0 ]]; then
  if echo "$ALIAS_WWW_OUT" | grep -qi "not verified\|Response Error"; then
    FAIL "WWW alias failed. DNS likely not verified. Set: www CNAME cname.vercel-dns.com"
  else
    FAIL "WWW alias failed. See logs."
  fi
else
  PASS "WWW aliased: $WWW → $DEPLOY_URL"
fi

# --- 2) Domain smokes ---
log ""
log "== Domain smokes =="

# www must redirect to apex with 308 (preferred; accept 301 as warn)
WWW_CODE=$(http_code "https://$WWW" || true)
WWW_LOC=$(header "https://$WWW" "Location" || true)
if [[ "$WWW_CODE" == "308" && "$WWW_LOC" == *"$APEX"* ]]; then
  PASS "www → $WWW_CODE to $WWW_LOC"
elif [[ "$WWW_CODE" == "301" && "$WWW_LOC" == *"$APEX"* ]]; then
  WARN "www uses 301 (not 308) → $WWW_LOC"
else
  FAIL "www expected redirect to apex. Got code=$WWW_CODE location='$WWW_LOC'"
fi

# apex must serve 200 and HSTS present
APEX_CODE=$(http_code "https://$APEX" || true)
APEX_HSTS=$(header "https://$APEX" "Strict-Transport-Security" || true)
if [[ "$APEX_CODE" == "200" ]]; then
  PASS "apex 200 OK"
else
  FAIL "apex expected 200, got $APEX_CODE"
fi

if [[ -n "$APEX_HSTS" ]]; then
  PASS "HSTS present: $APEX_HSTS"
else
  FAIL "HSTS missing at apex. Ensure vercel.json sets Strict-Transport-Security."
fi

# --- 3) API smokes on apex ---
log ""
log "== API smokes (apex) =="
check_200() {
  local path="$1"
  if curl -fsS "https://$APEX$path" >/dev/null; then
    PASS "$path → 200"
  else
    FAIL "$path → not 200"
  fi
}

check_200 "/ping"
check_200 "/__version"
check_200 "/__healthz"
if curl -fsS "https://$APEX/openapi.json" | jq -e '.info' >/dev/null; then
  PASS "/openapi.json parses"
else
  FAIL "/openapi.json not valid JSON"
fi
check_200 "/docs"
check_200 "/redoc"

# --- 4) Metrics (optional) ---
log ""
log "== Metrics (/metrics/prom) =="

if [[ -n "${ADMIN_TOKEN}" ]]; then
  METRICS_HEAD=$(curl -sS -D - -o /dev/null -H "x-admin-token: $ADMIN_TOKEN" "https://$APEX/metrics/prom" | tr -d '\r')
  METRICS_CODE=$(echo "$METRICS_HEAD" | awk '/^HTTP\/[0-9.]+/ {print $2; exit}')
  if [[ "$METRICS_CODE" == "200" ]]; then
    # basic content sanity (don’t fetch all to keep output short)
    METRICS_SAMPLE=$(curl -sS -H "x-admin-token: $ADMIN_TOKEN" "https://$APEX/metrics/prom" | head -n 20)
    if echo "$METRICS_SAMPLE" | grep -q "teketeke_up"; then
      PASS "metrics 200 OK and contains teketeke_up"
      log "--- metrics sample ---"
      log "$METRICS_SAMPLE"
      log "----------------------"
    else
      FAIL "metrics 200 but expected 'teketeke_up' not found"
    fi
  else
    FAIL "metrics expected 200, got $METRICS_CODE"
  fi
else
  WARN "ADMIN_TOKEN not provided; skipping metrics check"
fi

# --- Summary ---
log ""
log "== Summary =="
if [[ $FAIL_COUNT -eq 0 ]]; then
  log "$(echo -e \"${GREEN}All checks PASS${NC}\")"
else
  log "$(echo -e \"${RED}$FAIL_COUNT checks FAILED${NC}\")"
fi

log ""
log "Log saved to: $LOG"

$STRICT && [[ $FAIL_COUNT -gt 0 ]] && exit 1 || exit 0

