#!/usr/bin/env bash
# Keep opencode-proxy-bun alive on Linux.
#
# Restarts the proxy only when:
#   1. /healthz is unavailable or reports status=degraded, AND
#   2. a fresh Bun 1.3.14 process can reach upstream (probe-upstream.ts).
#
# If the fresh-process probe also fails, the upstream itself is unavailable;
# restarting the long-lived proxy would not help.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
listen="${LISTEN:-127.0.0.1:8788}"
port="${listen##*:}"
base="http://127.0.0.1:${port}"
threshold="${FAILURE_THRESHOLD:-3}"
interval="${PROBE_INTERVAL_SECONDS:-30}"
watchdog_log="$here/watchdog.log"

log_watchdog() {
  local line
  line="$(date -Iseconds) $*"
  echo "$line"
  echo "$line" >>"$watchdog_log"
}

bun=""
for candidate in \
  "${BUN_1314:-}" \
  "$here/.bun1314/node_modules/bun/bin/bun" \
  "$here/../.bun1314/node_modules/bun/bin/bun" \
  "$here/../.tmp-bun1314/node_modules/bun/bin/bun" \
  "bun"; do
  [ -n "$candidate" ] || continue
  if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
    version="$("$candidate" --version 2>/dev/null | head -n1 || true)"
    if [ "$version" = "1.3.14" ]; then
      bun="$candidate"
      break
    fi
  fi
done

if [ -z "$bun" ]; then
  echo "需要 Bun 1.3.14（上游 TLS/HTTP2 指纹门；1.4.x 会 403）。" >&2
  echo "安装: npm install bun@1.3.14 --prefix .bun1314" >&2
  exit 1
fi

pid=""
consecutive=0
attached=0
own_process=0

if command -v ss >/dev/null 2>&1 && ss -lnt "sport = :$port" 2>/dev/null | grep -q LISTEN; then
  attached=1
  log_watchdog "[watchdog] found existing listener on $port; monitoring only"
fi

start_proxy() {
  log_watchdog "[watchdog] starting Bun 1.3.14: $bun"
  (cd "$here" && exec "$bun" run "$here/src/index.ts" >>"$here/proxy.console.log" 2>>"$here/proxy.console.err.log") &
  pid=$!
  own_process=1
  attached=0
  log_watchdog "[watchdog] pid=$pid"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    log_watchdog "[watchdog] failed to start proxy; see proxy.console.err.log" >&2
    pid=""
    own_process=0
    return 1
  fi
}

stop_proxy() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log_watchdog "[watchdog] stopping pid=$pid"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  pid=""
  own_process=0
}

stop_listener_on_port() {
  local pids
  pids="$(ss -lntp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u || true)"
  for p in $pids; do
    log_watchdog "[watchdog] stopping listener pid=$p"
    kill "$p" 2>/dev/null || true
  done
  sleep 0.5
}

probe_upstream() {
  local output
  if output="$("$bun" run "$here/scripts/probe-upstream.ts" 2>&1)"; then
    log_watchdog "[watchdog] upstream probe: $output"
    return 0
  fi
  log_watchdog "[watchdog] upstream probe failed: $output" >&2
  return 1
}

cleanup() {
  if [ "$own_process" -eq 1 ]; then
    stop_proxy
  fi
  exit 0
}

trap cleanup INT TERM

while true; do
  health="$(curl -fsS --max-time 5 "$base/healthz" 2>/dev/null || true)"
  if [ -z "$health" ]; then
    log_watchdog "[watchdog] /healthz unavailable" >&2
    consecutive=$((consecutive + 1))
  elif printf '%s' "$health" | grep -q '"status":"degraded"'; then
    log_watchdog "[watchdog] healthz degraded: $health" >&2
    consecutive=$((consecutive + 1))
  else
    consecutive=0
  fi

  if [ "$consecutive" -ge "$threshold" ]; then
    log_watchdog "[watchdog] threshold reached ($consecutive); checking upstream admission" >&2
    if probe_upstream; then
      health_now="$(curl -fsS --max-time 5 "$base/healthz" 2>/dev/null || true)"
      if [ -z "$health_now" ] || printf '%s' "$health_now" | grep -q '"status":"degraded"'; then
        log_watchdog "[watchdog] upstream probe passed but /healthz is still degraded; restarting local proxy" >&2
        stop_proxy
        stop_listener_on_port
        sleep 2
        start_proxy
        consecutive=0
      else
        log_watchdog "[watchdog] upstream admission is healthy and /healthz recovered; not restarting" >&2
        consecutive=0
      fi
    else
      log_watchdog "[watchdog] upstream admission also failing; not restarting" >&2
      consecutive=0
    fi
  fi

  if [ -z "$pid" ] && [ "$attached" -eq 0 ]; then
    start_proxy
  fi

  sleep "$interval"
done
