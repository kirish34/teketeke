#!/usr/bin/env bash
set -euo pipefail

BRANCH="fix/e2e-workflow"
PR_TITLE="ci(e2e): fix YAML + failure email notifications"
PR_BODY_FILE="artifacts/e2e-pr-body.txt"
WF_NAME="E2E"   # matches .github/workflows/e2e.yml 'name'

# 1) open (or reuse) PR
if ! gh pr view "$BRANCH" &>/dev/null; then
  mkdir -p artifacts
  cat > "$PR_BODY_FILE" <<'MD'
Fixes the E2E workflow YAML (adds steps, timeout) and adds failure email
notifications via Zoho SMTP. Runs health-check and uploads artifacts.
MD
  gh pr create -H "$BRANCH" -B main -t "$PR_TITLE" -F "$PR_BODY_FILE"
else
  echo "PR already exists."
fi

PR_NUMBER=$(gh pr view "$BRANCH" --json number -q .number)
echo "PR #$PR_NUMBER"

# 2) dispatch the workflow
echo "Dispatching workflow '$WF_NAME'…"
gh workflow run "$WF_NAME" --ref "$BRANCH"

# 3) wait for the latest run on this branch to finish
echo "Waiting for run to finish…"
RUN_ID=$(gh run list --branch "$BRANCH" --workflow "$WF_NAME" -L 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --interval 5 || true   # don't exit on failure—still want logs

# 4) collect status, logs, and artifact
STATUS=$(gh run view "$RUN_ID" --json conclusion -q .conclusion)
mkdir -p artifacts/e2e
gh run view "$RUN_ID" --log > artifacts/e2e/run.log || true
gh run download "$RUN_ID" -n e2e-health -D artifacts/e2e || true

# 5) comment summary back on PR
echo "Posting summary (status: $STATUS)…"
{
  echo "### E2E run on \`$BRANCH\` — **$STATUS**"
  echo ""
  echo "**Run:** $GITHUB_SERVER_URL/${GITHUB_REPOSITORY}/actions/runs/$RUN_ID"
  echo ""
  echo "<details><summary>Tail of logs</summary>"
  echo
  echo '```text'
  tail -n 120 artifacts/e2e/run.log || true
  echo '```'
  echo "</details>"
  if [ -f artifacts/e2e/health.txt ]; then
    echo ""
    echo "<details><summary>health.txt (first 120 lines)</summary>"
    echo
    echo '```text'
    sed -n '1,120p' artifacts/e2e/health.txt
    echo '```'
    echo "</details>"
  fi
} > artifacts/e2e/comment.md

gh pr comment "$PR_NUMBER" -F artifacts/e2e/comment.md
echo "Done."

