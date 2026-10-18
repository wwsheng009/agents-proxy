#!/usr/bin/env bash
# Keep opencode-proxy-bun alive on Linux.
#
# Restart rules:
#   1. /healthz unavailable -> restart immediately (local process is dead/wedged).
#   2. /healthz reports status=degraded -> restart only when a fresh supported
#      Bun process can reach upstream (probe-upstream.ts).
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

supported_bun_version() {
  local version="${1%%[-+]*}"
  case "$version" in
    1.4.*) return 0 ;;
    1.3.*)
      local patch="${version#1.3.}"
      case "$patch" in ''|*[!0-9]*) return 1 ;; esac
      [ "$patch" -ge 14 ]
      return $?
      ;;
    *) return 1 ;;
  esac
}

bun=""
for candidate in \
  "${BUN_BIN:-}" \
  "${BUN_1314:-}" \
  "$here/.bun1314/node_modules/bun/bin/bun" \
  "$here/.bun142/node_modules/bun/bin/bun" \
  "$here/../.bun1314/node_modules/bun/bin/bun" \
  "$here/../.bun142/node_modules/bun/bin/bun" \
  "$here/../.tmp-bun1314/node_modules/bun/bin/bun" \
  "$here/../.tmp-bun142/node_modules/bun/bin/bun" \
  "bun"; do
  [ -n "$candidate" ] || continue
  if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
    version="$("$candidate" --version 2>/dev/null | head -n1 || true)"
    if supported_bun_version "$version"; then
      bun="$candidate"
      break
    fi
  fi
done

if [ -z "$bun" ]; then
  echo "需要 Bun 1.3.14+ 或 1.4.x（已验证 1.3.14 / 1.4.2 / 1.4.3）。" >&2
  echo "可通过 BUN_BIN 指定二进制，或安装到 .bun1314 / .bun142。" >&2
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
  health_unavailable=0
  if [ -z "$health" ]; then
    log_watchdog "[watchdog] /healthz unavailable" >&2
    health_unavailable=1
    consecutive=$((consecutive + 1))
  elif printf '%s' "$health" | grep -q '"status":"degraded"'; then
    log_watchdog "[watchdog] healthz degraded: $health" >&2
    consecutive=$((consecutive + 1))
  else
    consecutive=0
  fi

  if [ "$consecutive" -ge "$threshold" ]; then
    log_watchdog "[watchdog] threshold reached ($consecutive); checking upstream admission" >&2
    if [ "$health_unavailable" -eq 1 ]; then
      # Local process is gone or wedged; restart even if upstream is 403.
      log_watchdog "[watchdog] /healthz unavailable; restarting local proxy" >&2
      stop_proxy
      stop_listener_on_port
      sleep 2
      start_proxy
      consecutive=0
    elif probe_upstream; then
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
