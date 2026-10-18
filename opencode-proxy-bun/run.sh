#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

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

candidates=(
  "${BUN_BIN:-}"
  "${BUN_1314:-}"
  "$here/.bun1314/node_modules/bun/bin/bun"
  "$here/.bun142/node_modules/bun/bin/bun"
  "$here/../.bun1314/node_modules/bun/bin/bun"
  "$here/../.bun142/node_modules/bun/bin/bun"
  "$here/../.tmp-bun1314/node_modules/bun/bin/bun"
  "$here/../.tmp-bun142/node_modules/bun/bin/bun"
  "bun"
)
for candidate in "${candidates[@]}"; do
  [ -n "$candidate" ] || continue
  if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
    version="$("$candidate" --version 2>/dev/null | head -n1 || true)"
    if supported_bun_version "$version"; then
      echo "using Bun $version: $candidate"
      if [ "${NO_WATCHDOG:-0}" = "1" ]; then
        exec "$candidate" run "$here/src/index.ts"
      fi
      export BUN_1314="$candidate"
      exec "$here/watchdog.sh" "$@"
    fi
  fi
done
echo "需要 Bun 1.3.14+ 或 1.4.x（已验证 1.3.14 / 1.4.2 / 1.4.3）。" >&2
echo "可通过 BUN_BIN 指定二进制，或安装到 .bun1314 / .bun142。" >&2
exit 1
