#!/usr/bin/env bash
#
# Regenerate media for unresolved placeholder stories.
# Reads story IDs from CSV, fetches story data, and triggers media generation.
# If story content is missing (no extractedText or sourceUrl), sets recrawl=true.
#
# Usage: ./scripts/regenerate-media.sh
#

set -euo pipefail

BASE_URL="https://api-staging.newsroll.app"
AUTH_HEADER="Authorization: Bearer ZXztHPeHBGzo6Zq6HFjrz4oL"
CSV_FILE="data/placeholder-audit/newsroll-placeholder-matches-2026-04-13.csv"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_DIR="data/placeholder-audit/logs"
SUCCESS_LOG="${LOG_DIR}/success_${TIMESTAMP}.csv"
ERROR_LOG="${LOG_DIR}/errors_${TIMESTAMP}.csv"

mkdir -p "$LOG_DIR"

# Write headers
echo "storyId,mediaUrl,headline,status,recrawl,latencyMs" > "$SUCCESS_LOG"
echo "storyId,step,httpStatus,error" > "$ERROR_LOG"

TOTAL=$(tail -n +2 "$CSV_FILE" | wc -l | tr -d ' ')
CURRENT=0
SUCCESS_COUNT=0
ERROR_COUNT=0

echo "Starting media regeneration for ${TOTAL} stories..."
echo "Success log: ${SUCCESS_LOG}"
echo "Error log:   ${ERROR_LOG}"
echo "---"

tail -n +2 "$CSV_FILE" | while IFS=',' read -r storyId rest; do
  CURRENT=$((CURRENT + 1))
  echo "[${CURRENT}/${TOTAL}] Processing story ${storyId}..."

  # Step 1: GET story data
  HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
    "${BASE_URL}/admin/stories/${storyId}" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" 2>&1) || true

  HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
  HTTP_STATUS=$(echo "$HTTP_RESPONSE" | tail -1)

  if [[ "$HTTP_STATUS" != "200" ]]; then
    echo "  WARN: GET story returned HTTP ${HTTP_STATUS}, skipping."
    echo "${storyId},get_story,${HTTP_STATUS},\"non-200 response\"" >> "$ERROR_LOG"
    ERROR_COUNT=$((ERROR_COUNT + 1))
    continue
  fi

  # Check if story content has missing data -> need recrawl
  RECRAWL=false
  EXTRACTED_TEXT=$(echo "$HTTP_BODY" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    sc = d.get('storyContent') or {}
    print(sc.get('extractedText') or '')
except:
    print('')
" 2>/dev/null)

  SOURCE_URL=$(echo "$HTTP_BODY" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    sc = d.get('storyContent') or {}
    print(sc.get('sourceUrl') or '')
except:
    print('')
" 2>/dev/null)

  if [[ -z "$EXTRACTED_TEXT" || -z "$SOURCE_URL" ]]; then
    RECRAWL=true
    echo "  INFO: Missing content data, will recrawl."
  fi

  # Step 2: POST media generate
  GENERATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
    "${BASE_URL}/admin/media/generate" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "{
      \"storyId\": ${storyId},
      \"recrawl\": ${RECRAWL},
      \"applyToStory\": true,
      \"replaceStoryContent\": true
    }" 2>&1) || true

  GEN_BODY=$(echo "$GENERATE_RESPONSE" | sed '$d')
  GEN_STATUS=$(echo "$GENERATE_RESPONSE" | tail -1)

  if [[ "$GEN_STATUS" != "200" ]]; then
    echo "  ERROR: Generate returned HTTP ${GEN_STATUS}"
    # Escape any commas/quotes in the error body for CSV
    SAFE_ERR=$(echo "$GEN_BODY" | tr '\n' ' ' | tr ',' ';' | head -c 200)
    echo "${storyId},generate,${GEN_STATUS},\"${SAFE_ERR}\"" >> "$ERROR_LOG"
    ERROR_COUNT=$((ERROR_COUNT + 1))
    continue
  fi

  # Extract fields from response
  PARSED=$(echo "$GEN_BODY" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    ar = d.get('appliedResult') or {}
    media_url = ar.get('mediaUrl') or d.get('imageUrl') or 'unknown'
    headline = (ar.get('headline') or '').replace('\"', '\"\"')
    status = d.get('status') or 'unknown'
    latency = d.get('totalMs') or 0
    print(f'{media_url}\t{headline}\t{status}\t{latency}')
except:
    print('unknown\t\tunknown\t0')
" 2>/dev/null)

  NEW_MEDIA_URL=$(echo "$PARSED" | cut -f1)
  HEADLINE=$(echo "$PARSED" | cut -f2)
  STATUS=$(echo "$PARSED" | cut -f3)
  LATENCY=$(echo "$PARSED" | cut -f4)

  echo "  OK: status=${STATUS} mediaUrl=${NEW_MEDIA_URL} recrawl=${RECRAWL} latency=${LATENCY}ms"
  echo "${storyId},${NEW_MEDIA_URL},\"${HEADLINE}\",${STATUS},${RECRAWL},${LATENCY}" >> "$SUCCESS_LOG"
  SUCCESS_COUNT=$((SUCCESS_COUNT + 1))

  # Small delay to avoid hammering the API
  sleep 1
done

echo "---"
echo "Done! Success: ${SUCCESS_COUNT}, Errors: ${ERROR_COUNT}"
echo "Success log: ${SUCCESS_LOG}"
echo "Error log:   ${ERROR_LOG}"
