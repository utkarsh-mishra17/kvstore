#!/usr/bin/env bash
# One-command launcher:  ./start.sh          -> C++ server + FastAPI + Vite dev server (http://localhost:5173)
#                        ./start.sh --prod   -> C++ server + FastAPI serving the built UI (http://localhost:8000)
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-dev}"
KV_PORT="${KV_PORT:-7070}"
WORKERS="${KV_WORKERS:-8}"
mkdir -p data build

echo "==> Building C++ server and clients"
make -s all

if ! python3 -c "import fastapi, uvicorn" 2>/dev/null; then
  echo "==> Installing Python dependencies"
  pip3 install -r dashboard/backend/requirements.txt || pip3 install --break-system-packages -r dashboard/backend/requirements.txt
fi
if [ ! -d dashboard/frontend/node_modules ]; then
  echo "==> Installing frontend dependencies"
  (cd dashboard/frontend && npm install --no-audit --no-fund)
fi
if [ "$MODE" = "--prod" ] && [ ! -d dashboard/frontend/dist ]; then
  echo "==> Building the dashboard"
  (cd dashboard/frontend && npm run build)
fi

PIDS=()
cleanup() { echo; echo "==> Stopping"; for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "==> Starting KVStore server on :$KV_PORT"
./build/kvserver --port "$KV_PORT" --workers "$WORKERS" --queue 64 --frames 8 >> data/server.out 2>&1 &
PIDS+=($!)
sleep 0.7

echo "==> Starting dashboard API on :8000"
(cd dashboard/backend && KV_PORT="$KV_PORT" exec python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --log-level warning) &
PIDS+=($!)

if [ "$MODE" = "--prod" ]; then
  echo "==> Dashboard ready:  http://localhost:8000"
else
  (cd dashboard/frontend && exec npm run dev -- --host) &
  PIDS+=($!)
  echo "==> Dashboard ready:  http://localhost:5173   (API: http://localhost:8000/docs)"
fi
echo "    Press Ctrl+C to stop everything (dirty cache frames are flushed to data/data.db)."
wait
