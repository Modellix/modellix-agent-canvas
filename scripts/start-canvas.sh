#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIRECTORY/.." && pwd)"
WORKSPACE="${MODELLIX_PROJECT_DIR:-${1:-$PWD}}"
PORT="${MODELLIX_CANVAS_PORT:-43217}"

if [[ ! -x "$PROJECT_ROOT/node_modules/.bin/vite" ]]; then
  echo "Development dependencies are missing. Run npm ci in $PROJECT_ROOT first." >&2
  exit 1
fi

export MODELLIX_PROJECT_DIR="$WORKSPACE"
echo "Canvas URL: http://127.0.0.1:$PORT"
echo "Workspace data: $WORKSPACE/.modellix/canvas/"
cd -- "$PROJECT_ROOT"
exec "$PROJECT_ROOT/node_modules/.bin/vite" --host 127.0.0.1 --port "$PORT"
