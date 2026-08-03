#!/usr/bin/env bash
#
# One-command local development stack.
#
#   ./scripts/dev.sh          start everything
#   ./scripts/dev.sh --seed   start everything and reload the demo dataset
#   ./scripts/dev.sh --stop   stop everything and free every port
#   ./scripts/dev.sh --status show what is running
#
# Starts MongoDB + Redis (Docker), the API and the Vite client, waits until each
# is genuinely healthy, and prints the URLs and demo logins.
#
# Windows Server deployment is a different thing entirely — see
# docs/DEPLOY-WINDOWS.md. This script is for a developer machine.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"
CLIENT_DIR="$ROOT/client"
LOG_DIR="$ROOT/.dev-logs"

MONGO_CONTAINER="maildesk-mongo"
REDIS_CONTAINER="maildesk-redis"
DB_NAME="${DB_NAME:-maildesk_run}"
MONGO_URI="mongodb://127.0.0.1:27017/$DB_NAME"
REDIS_URL="redis://127.0.0.1:6379"
API_PORT="${API_PORT:-5015}"
CLIENT_PORT="${CLIENT_PORT:-5174}"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }
bold()  { printf '\033[1m%s\033[0m\n' "$1"; }

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

stop_all() {
  bold "Stopping MailDesk"
  pkill -f "node index.js" 2>/dev/null && echo "  API stopped" || echo "  API was not running"
  pkill -f "vite" 2>/dev/null && echo "  client stopped" || echo "  client was not running"
  sleep 2
  docker stop "$MONGO_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 && echo "  containers stopped" || true
  sleep 2
  for p in "$API_PORT" "$CLIENT_PORT" 27017 6379; do
    port_busy "$p" && red "  port $p STILL LISTENING" || echo "  port $p free"
  done
}

status_all() {
  bold "MailDesk status"
  for p in "$API_PORT" "$CLIENT_PORT" 27017 6379; do
    port_busy "$p" && green "  port $p  in use" || dim "  port $p  free"
  done
  docker ps --format '  {{.Names}}  {{.Status}}' | grep maildesk || dim "  no containers running"
}

case "${1:-}" in
  --stop)   stop_all; exit 0 ;;
  --status) status_all; exit 0 ;;
esac

SEED=0
[ "${1:-}" = "--seed" ] && SEED=1

mkdir -p "$LOG_DIR"

# --- preflight -------------------------------------------------------------
command -v docker >/dev/null || { red "docker not found — needed for MongoDB and Redis"; exit 1; }
docker info >/dev/null 2>&1 || { red "Docker daemon is not running. Start Docker Desktop and retry."; exit 1; }
[ -f "$SERVER_DIR/.env" ] || { red "server/.env is missing. Copy server/.env.example and fill it in."; exit 1; }

bold "Starting MailDesk"

# --- data stores -----------------------------------------------------------
# `docker start` on a missing container fails; create it on first run.
docker start "$MONGO_CONTAINER" >/dev/null 2>&1 || \
  docker run -d --name "$MONGO_CONTAINER" -p 27017:27017 -v maildesk-mongo-data:/data/db mongo:7 >/dev/null
docker start "$REDIS_CONTAINER" >/dev/null 2>&1 || \
  docker run -d --name "$REDIS_CONTAINER" -p 6379:6379 redis:7-alpine >/dev/null

printf '  waiting for MongoDB'
for _ in $(seq 1 30); do
  docker exec "$MONGO_CONTAINER" mongosh --quiet --eval 'db.adminCommand("ping").ok' >/dev/null 2>&1 && break
  printf '.'; sleep 1
done
docker exec "$MONGO_CONTAINER" mongosh --quiet --eval 'db.adminCommand("ping").ok' >/dev/null 2>&1 \
  && green ' ok' || { red ' MongoDB never became ready'; exit 1; }

printf '  waiting for Redis'
for _ in $(seq 1 20); do
  docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1 && break
  printf '.'; sleep 1
done
green ' ok'

# --- optional reseed -------------------------------------------------------
if [ "$SEED" = "1" ]; then
  echo "  seeding demo data (this replaces the contents of $DB_NAME)"
  ( cd "$SERVER_DIR" && MONGO_URI="$MONGO_URI" node scripts/seedDemoData.js >"$LOG_DIR/seed.log" 2>&1 ) \
    && green "  seed ok" || { red "  seed failed — see $LOG_DIR/seed.log"; exit 1; }
fi

# --- API -------------------------------------------------------------------
if port_busy "$API_PORT"; then
  dim "  API already listening on $API_PORT — leaving it alone"
else
  # nohup + disown so the API outlives this script and, more importantly, does
  # not keep the shell attached — without it the script finishes its work but
  # never returns the prompt, which reads as a hang.
  ( cd "$SERVER_DIR" && MONGO_URI="$MONGO_URI" REDIS_URL="$REDIS_URL" NODE_ENV=development \
      PORT="$API_PORT" FRONTEND_URL="http://localhost:$CLIENT_PORT" \
      nohup node index.js >"$LOG_DIR/api.log" 2>&1 & disown )
  printf '  waiting for API'
  for _ in $(seq 1 40); do
    # /api/health returns 503 until Mongo is connected, so grep the payload
    # rather than trusting a 200 that the server would not yet send.
    curl -sf "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null | grep -q '"database":"connected"' && break
    printf '.'; sleep 1
  done
  if curl -sf "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null | grep -q '"database":"connected"'; then
    green ' ok'
  else
    red " API did not become healthy — see $LOG_DIR/api.log"; tail -20 "$LOG_DIR/api.log"; exit 1
  fi
fi

# --- client ----------------------------------------------------------------
if port_busy "$CLIENT_PORT"; then
  dim "  client already listening on $CLIENT_PORT — leaving it alone"
else
  ( cd "$CLIENT_DIR" && nohup npm run dev >"$LOG_DIR/client.log" 2>&1 & disown )
  printf '  waiting for client'
  for _ in $(seq 1 40); do
    curl -sf "http://localhost:$CLIENT_PORT/" >/dev/null 2>&1 && break
    printf '.'; sleep 1
  done
  curl -sf "http://localhost:$CLIENT_PORT/" >/dev/null 2>&1 \
    && green ' ok' || { red " client did not start — see $LOG_DIR/client.log"; exit 1; }
fi

# --- summary ---------------------------------------------------------------
echo
bold "Ready"
echo "  App          http://localhost:$CLIENT_PORT"
echo "  API health   http://127.0.0.1:$API_PORT/api/health"
echo "  Logs         $LOG_DIR/"
echo
bold "Demo logins — password for all: RunTest!2345"
echo "  Admin      admin@demo.test     sees everything"
echo "  Head       head@demo.test      billing@ mailbox, own delegations"
echo "  Head       ops.head@demo.test  ops@ mailbox"
echo "  Employee   emp@demo.test       only work assigned to them"
echo
dim "  Pending approvals live under Users & Approvals (3 accounts await a decision)."
dim "  Stop everything with: ./scripts/dev.sh --stop"

# Both servers are detached; return the prompt instead of lingering.
exit 0
