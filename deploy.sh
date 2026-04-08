#!/usr/bin/env bash
set -euo pipefail

ENV="${1:-production}"

if [ "$ENV" != "production" ] && [ "$ENV" != "staging" ]; then
  echo "Usage: deploy.sh [production|staging]"
  exit 1
fi

API_CONFIG="workers/api/wrangler.jsonc"
INGEST_CONFIG="workers/ingest/wrangler.jsonc"
PROCESSOR_CONFIG="workers/processor/wrangler.jsonc"

if [ "$ENV" = "staging" ]; then
  ENV_FLAG="--env staging"
else
  API_SCRIPT_NAME="newsroll-workers"
  OLD_MEDIA_SCRIPT_NAME="newsroll-media"
  MEDIA_QUEUE_NAME="newsroll-media"
  ENV_FLAG=""
fi

FAILED=0

# ── 0. Ensure pnpm is available ──────────────────────────────────────
if ! command -v pnpm &>/dev/null; then
  echo "--- pnpm not found — installing via npm ---"
  npm install -g pnpm
fi

echo "==> Deploying workers (${ENV})"
echo ""

echo "--- Installing Workers dependencies ---"
pnpm install
echo ""

if [ "$ENV" = "staging" ]; then
  # ── Staging: deploy API worker only ──────────────────────────────────
  echo "--- Deploying API worker (staging) ---"
  if npx wrangler deploy --config "$API_CONFIG" $ENV_FLAG; then
    echo "  ✓ API deployed (staging)"
  else
    echo "  ✗ API failed"
    FAILED=1
  fi
  echo ""
else
  # ── Production: detach stale queue consumers, deploy all workers ─────

  # Detach stale queue consumers
  for STALE_CONSUMER in "$API_SCRIPT_NAME" "$OLD_MEDIA_SCRIPT_NAME"; do
    echo "--- Checking stale queue consumer (${STALE_CONSUMER} <- ${MEDIA_QUEUE_NAME}) ---"
    if QUEUE_INFO=$(npx wrangler queues info "$MEDIA_QUEUE_NAME" 2>&1); then
      if printf '%s\n' "$QUEUE_INFO" | grep -Fq "worker:${STALE_CONSUMER}"; then
        if npx wrangler queues consumer remove "$MEDIA_QUEUE_NAME" "$STALE_CONSUMER"; then
          echo "  ✓ ${STALE_CONSUMER} consumer removed"
        else
          echo "  ! Could not remove ${STALE_CONSUMER} consumer cleanly; continuing"
        fi
      else
        echo "  - ${STALE_CONSUMER} not attached; skipping"
      fi
    else
      echo "  ! Could not inspect queue consumers; skipping"
    fi
    echo ""
  done

  # Deploy all workers
  WORKERS=("$API_CONFIG" "$INGEST_CONFIG" "$PROCESSOR_CONFIG")
  LABELS=("API" "Ingest" "Processor")

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
fi

if [ "$FAILED" -ne 0 ]; then
  echo "==> Some deployments failed!"
  exit 1
fi

echo "==> All workers deployed successfully (${ENV})"
