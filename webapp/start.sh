#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt && .venv/bin/python -m playwright install chromium || \
    echo "⚠ Không cài được Playwright – webapp vẫn chạy ở chế độ 'browser'"
fi
exec .venv/bin/python server.py "$@"
