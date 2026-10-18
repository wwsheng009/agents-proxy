#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
candidates=(
  "${BUN_1314:-}"
  "$here/../.bun1314/node_modules/bun/bin/bun"
  "$here/.bun1314/node_modules/bun/bin/bun"
  "$here/../../.bun1314/node_modules/bun/bin/bun"
  "$here/../../.tmp-bun1314/node_modules/bun/bin/bun"
  "bun"
)
for candidate in "${candidates[@]}"; do
  [ -n "$candidate" ] || continue
  if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
    version="$("$candidate" --version 2>/dev/null | head -n1 || true)"
    if [ "$version" = "1.3.14" ]; then
      echo "using Bun 1.3.14: $candidate"
      exec "$candidate" run "$here/forward.ts"
    fi
  fi
done
echo "需要 Bun 1.3.14（上游 TLS/HTTP2 指纹门；1.4.x 会 403）。" >&2
echo "安装: npm install bun@1.3.14 --prefix .bun1314" >&2
exit 1
