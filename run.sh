#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

while [ $# -gt 0 ]; do
  case "$1" in
    --tunnel) export TUNNEL=1 ;;
    --lan)    export HOST=0.0.0.0 ;;
    --https)  export SSL=1 ;;
    *) echo "usage: ./run.sh [--tunnel] [--lan] [--https]" >&2; exit 2 ;;
  esac
  shift
done

NEEDS="flask faster_whisper requests dotenv"

has_deps() {
  "$1" - "$NEEDS" <<'PY' 2>/dev/null
import importlib.util, sys
sys.exit(0 if all(importlib.util.find_spec(m) for m in sys.argv[1].split()) else 1)
PY
}

CANDIDATES=(
  "${PYTHON:-}"
  /Library/Frameworks/Python.framework/Versions/3.12/bin/python3
  /opt/homebrew/bin/python3
  /usr/local/bin/python3
  "$(command -v python3 || true)"
)

PY=""
for c in "${CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -x "$c" ] || continue
  if has_deps "$c"; then PY="$c"; break; fi
  [ -z "$PY" ] && FALLBACK="$c"
done

if [ -z "$PY" ]; then
  PY="${FALLBACK:?no usable python3 found}"
  echo "Installing dependencies into $PY ..."
  "$PY" -m pip install -r requirements.txt
fi

if [ ! -f .env ]; then
  echo
  echo "  No .env yet. Copy it and add your key:"
  echo "    cp .env.example .env"
  echo "    # key from https://ai.hackclub.com/dashboard"
  echo
fi

PORT="${PORT:-5001}"

if [ "${TUNNEL:-}" != "1" ]; then
  exec "$PY" app.py
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "--tunnel needs cloudflared. Install it with:  brew install cloudflared" >&2
  exit 2
fi

LOG="$(mktemp -t ask-tunnel)"
APP_PID=""
TUNNEL_PID=""
cleanup() { kill "${TUNNEL_PID:-}" "${APP_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

"$PY" app.py &
APP_PID=$!

for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  kill -0 "$APP_PID" 2>/dev/null || { wait "$APP_PID"; exit $?; }
  sleep 0.5
done

cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > "$LOG" 2>&1 &
TUNNEL_PID=$!

URL=""
for _ in $(seq 1 80); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 0.5
done

if [ -z "$URL" ]; then
  echo "The tunnel did not come up. Its output is in $LOG" >&2
else
  "$PY" - "$URL" "$PORT" <<'PY'
import sys
import messages

url, port = sys.argv[1], sys.argv[2]
print()
print("  On any phone, anywhere - a real certificate, so no warning:")
for contact in messages.CONTACTS:
    who = f"{contact['name']} ({contact['relation'].lower()})"
    print(f"    {who:<24}{url}/{contact['slug']}")
print()
print(f"  Keep the assistant itself on http://127.0.0.1:{port} - localhost")
print("  counts as secure, so its camera works with no warning either.")
print()
print("  That link is public while this is running. Ctrl-C closes it.")
print()
PY
fi

wait "$APP_PID"
