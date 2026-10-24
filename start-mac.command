#!/bin/bash
# macOS launcher: double-click in Finder or run ./start-mac.command
# 本机调试默认不跑推送调度（免得抢先认领线上提醒，见 server/keys.js）；确需在本机测推送：WB_PUSH=1 ./start-mac.command
cd "$(dirname "$0")"
PORT="${PORT:-3000}"
( sleep 1; open "http://127.0.0.1:$PORT/" ) &
HOST=127.0.0.1 PORT="$PORT" exec node server.js
