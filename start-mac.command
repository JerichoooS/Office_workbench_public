#!/bin/bash
# macOS launcher: double-click in Finder or run ./start-mac.command
cd "$(dirname "$0")"
PORT="${PORT:-3000}"
( sleep 1; open "http://127.0.0.1:$PORT/" ) &
HOST=127.0.0.1 PORT="$PORT" exec node server.js
