#!/usr/bin/env bash
# stamp-release.sh — записывает текущий git commit hash в meta-тег
# floor-map-editor.html, чтобы Sentry мог привязывать каждое событие
# к конкретному релизу.
#
# Использование (вручную или из deploy-pipeline):
#   bash scripts/stamp-release.sh && firebase deploy --only hosting
#
# После деплоя возвращает meta обратно в "DEV", чтобы локальный devserver
# не показывал stale-хеш и чтобы git diff оставался чистым.
#
# Создан 2026-05-06.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="$REPO_ROOT/floor-map-editor.html"
HASH="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"

if [ ! -f "$FILE" ]; then
  echo "stamp-release: $FILE not found" >&2
  exit 1
fi

# Patch in commit hash (in-place; works on macOS BSD sed and GNU sed).
sed -i.bak -E 's|(<meta name="sfa-release" content=")[^"]*(">)|\1'"$HASH"'\2|' "$FILE"
rm -f "$FILE.bak"

echo "stamp-release: tagged release=$HASH in floor-map-editor.html"
