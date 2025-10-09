#!/usr/bin/env bash
set -euo pipefail

# Fail if BOM is present
if head -c 3 package.json | od -An -t x1 | awk '{print $1$2$3}' | grep -qi '^efbbbf$'; then
  echo "ERROR: BOM detected in package.json" >&2
  exit 1
fi

# Fail if JSON is invalid
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" >/dev/null
echo "package.json OK"

