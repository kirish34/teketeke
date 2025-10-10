#!/usr/bin/env bash
set -euo pipefail

PR_TITLE="fix(ui): dashboards in role-select + legacy aliases"
PR_BODY_FILE="artifacts/pr-body.txt"
BRANCH="fix/dashboards-and-role-select"

# ensure dirs
mkdir -p artifacts

# 1) Open (or reuse) PR
echo "Opening PR for $BRANCH…"
if ! gh pr view "$BRANCH" &>/dev/null; then
  cat > "$PR_BODY_FILE" <<'MD'
The screenshots showed JSON 404s for dashboard routes.

**This PR:**
- Adds 308 redirects for legacy dashboard filenames
- Ensures five dashboards exist (System Admin, SACCO Admin, SACCO Staff, Matatu Owner, Conductor)
- Updates Welcome and Role Select to include all five roles
- Leaves docs and metrics routes untouched

**Smoke steps** will be posted automatically below once the Vercel preview is ready.
MD
  gh pr create -H "$BRANCH" -B main -t "$PR_TITLE" -F "$PR_BODY_FILE"
else
  echo "PR already exists. Continuing…"
fi

PR_NUMBER=$(gh pr view "$BRANCH" --json number -q .number)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
SHA=$(git rev-parse "$BRANCH")

echo "PR #$PR_NUMBER on $REPO (sha $SHA)"

# 2) Wait for a Vercel 'Preview' deployment to succeed and grab the URL
echo "Waiting for Vercel preview deployment…"
PREVIEW_URL=""
for i in {1..60}; do
  DEPLOY_ID=$(gh api "repos/$REPO/deployments" -q \
    ".[] | select(.ref==\"$BRANCH\" or .sha==\"$SHA\") | select(.environment | test(\"(?i)preview\")) | .id" \
    | head -n1 || true)
  if [[ -n "${DEPLOY_ID:-}" ]]; then
    ENV_URL=$(gh api "repos/$REPO/deployments/$DEPLOY_ID/statuses" -q \
      "map(select(.state==\"success\")) | last | .environment_url" || true)
    if [[ -n "${ENV_URL:-}" && "$ENV_URL" != "null" ]]; then
      PREVIEW_URL="$ENV_URL"
      break
    fi
  fi
  sleep 5
done

if [[ -z "${PREVIEW_URL:-}" ]]; then
  echo "Failed to resolve preview URL from GitHub deployments."
  gh pr comment "$PR_NUMBER" -b ":warning: Could not detect Vercel preview URL automatically. Please paste it and re-run smokes."
  exit 1
fi

echo "Preview URL: $PREVIEW_URL"

# 3) Run health smokes against the preview
export BASE="$PREVIEW_URL"
: "${ADMIN_TOKEN:=""}" # read from env if set
bash scripts/health-check.sh | tee artifacts/health.txt

# 4) Comment results back on the PR
{
  echo "### Preview smokes for \`$PREVIEW_URL\`"
  echo
  echo '```text'
  sed -n '1,120p' artifacts/health.txt
  echo '```'
} > artifacts/comment.md

gh pr comment "$PR_NUMBER" -F artifacts/comment.md
echo "Done."

