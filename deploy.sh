#!/usr/bin/env bash
set -euo pipefail

ENV="${1:-production}"

if [ "$ENV" != "production" ] && [ "$ENV" != "staging" ]; then
  echo "Usage: deploy.sh [production|staging]"
  exit 1
fi

API_CONFIG="workers/api/wrangler.jsonc"
ADMIN_CONFIG="workers/admin/wrangler.jsonc"
MEDIA_CONFIG="workers/media/wrangler.jsonc"

if [ "$ENV" = "staging" ]; then
  API_SCRIPT_NAME="newsroll-workers-staging"
  MEDIA_QUEUE_NAME="newsroll-media-staging"
  ENV_FLAG="--env staging"
else
  API_SCRIPT_NAME="newsroll-workers"
  MEDIA_QUEUE_NAME="newsroll-media"
  ENV_FLAG=""
fi

FAILED=0

# ── 0. Ensure pnpm is available ──────────────────────────────────────
if ! command -v pnpm &>/dev/null; then
  echo "--- pnpm not found — installing via npm ---"
  npm install -g pnpm
fi

echo "==> Deploying all workers (${ENV})"
echo ""

echo "--- Installing Workers dependencies ---"
pnpm install
echo ""

echo "--- Building NewsRoll Admin UI ---"
pnpm --prefix ../NewsRollAdmin install
if pnpm --prefix ../NewsRollAdmin run build; then
  echo "  ✓ Admin UI built"
else
  echo "  ✗ Admin UI build failed — aborting deploy"
  exit 1
fi
echo ""

# ── 1. Detach stale queue consumer ───────────────────────────────────
echo "--- Detaching stale API queue consumer (${API_SCRIPT_NAME} <- ${MEDIA_QUEUE_NAME}) ---"
if QUEUE_INFO=$(npx wrangler queues info "$MEDIA_QUEUE_NAME" 2>&1); then
  if printf '%s\n' "$QUEUE_INFO" | grep -Fq "worker:${API_SCRIPT_NAME}"; then
    if npx wrangler queues consumer remove "$MEDIA_QUEUE_NAME" "$API_SCRIPT_NAME"; then
      echo "  ✓ API consumer removed"
    else
      echo "  ! API consumer appears attached but could not be removed cleanly; continuing"
    fi
  else
    echo "  - API consumer not attached; skipping removal"
  fi
else
  echo "  ! Could not inspect queue consumers; skipping stale consumer removal"
fi
echo ""

# ── 2. Deploy workers ────────────────────────────────────────────────
WORKERS=("$API_CONFIG" "$ADMIN_CONFIG" "$MEDIA_CONFIG")
LABELS=("API" "Admin" "Media")

for i in "${!WORKERS[@]}"; do
  CONFIG="${WORKERS[$i]}"
  LABEL="${LABELS[$i]}"

  echo "--- Deploying ${LABEL} worker (${CONFIG}) ---"
  if npx wrangler deploy --config "$CONFIG" $ENV_FLAG; then
    echo "  ✓ ${LABEL} deployed (${ENV})"
  else
    echo "  ✗ ${LABEL} failed"
    FAILED=1
  fi
  echo ""
done

if [ "$FAILED" -ne 0 ]; then
  echo "==> Some deployments failed!"
  exit 1
fi

echo "==> All workers deployed successfully (${ENV})"
