#!/usr/bin/env bash
set -euo pipefail
API_URL="${API_URL:-http://localhost:5001}"
echo "Ping:";           curl -s -o /dev/null -w "%{http_code}\n" "$API_URL/ping"
echo "__version:";      curl -s -o /dev/null -w "%{http_code}\n" "$API_URL/__version"
echo "OpenAPI:";        curl -s -o /dev/null -w "%{http_code}\n" "$API_URL/openapi.json"
echo "Metrics:";        curl -s -o /dev/null -w "%{http_code}\n" "$API_URL/metrics"
if [[ -n "${ADMIN_TOKEN:-}" ]]; then
  echo "System overview (admin):"; curl -s -o /dev/null -w "%{http_code}\n" "$API_URL/api/admin/system-overview" -H "Authorization: Bearer $ADMIN_TOKEN"
  echo "Prom metrics (admin):";    curl -s -o /dev/null -w "%{http_code}\n" "$API_URL/metrics/prom" -H "Authorization: Bearer $ADMIN_TOKEN"
fi

