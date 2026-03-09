#!/bin/bash
# arkos-delegate.sh — Submit a coding goal to the local Arkos server
# Usage: arkos-delegate.sh "build a REST API with Express" [TypeScript]
# Daemon (Claude) calls this instead of writing code directly → saves API cost

GOAL="$1"
LANG="${2:-TypeScript}"
PORT="${ARKOS_PORT:-3847}"
BASE="http://localhost:$PORT"

if [ -z "$GOAL" ]; then
  echo "Usage: arkos-delegate.sh \"goal\" [language]"
  exit 1
fi

# Check server is up
if ! curl -s "$BASE/status" > /dev/null 2>&1; then
  echo "❌ Arkos server not running. Start it with:"
  echo "   cd ~/.openclaw/workspace/arkos && npm run dev serve"
  echo "   or: nohup npm run dev serve > ~/.arkos/server.log 2>&1 &"
  exit 1
fi

# Submit job
echo "📤 Submitting to Arkos..."
RESPONSE=$(curl -s -X POST "$BASE/run" \
  -H "Content-Type: application/json" \
  -d "{\"goal\": $(echo "$GOAL" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read().strip()))"), \"language\": \"$LANG\", \"sim\": false}")

RUN_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['runId'])" 2>/dev/null)

if [ -z "$RUN_ID" ]; then
  echo "❌ Failed to submit job: $RESPONSE"
  exit 1
fi

echo "🚀 Job started: $RUN_ID"
echo "⏳ Streaming progress..."
echo ""

# Stream live progress
curl -s --no-buffer "$BASE/run/$RUN_ID/stream" | while IFS= read -r line; do
  CONTENT=$(echo "$line" | sed 's/^data: //')
  if [ "$CONTENT" = "__DONE__" ]; then
    break
  elif [ -n "$CONTENT" ]; then
    echo "$CONTENT"
  fi
done

echo ""

# Final result
RESULT=$(curl -s "$BASE/run/$RUN_ID")
STATUS=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))")
SCORE=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"score\"]:.3f}' if 'score' in d else '?')")
OUTPUT=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('outputDir','?'))")
ACCEPTANCE=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print('✅' if d.get('acceptancePassed') else '❌')")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Status:     $STATUS"
echo "Score:      $SCORE"
echo "Acceptance: $ACCEPTANCE"
echo "Output:     $OUTPUT"

# List files
echo ""
echo "Files written:"
echo "$RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
files = d.get('files', [])
for f in sorted(files)[:20]:
    if 'node_modules' not in f:
        print(f'  {f}')
if len(files) > 20:
    print(f'  ... and {len(files)-20} more')
" 2>/dev/null

echo ""
echo "Run 'ls $OUTPUT' to explore the output"
