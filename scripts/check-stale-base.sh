#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Stale-base warning — fires on Claude Code SessionStart.
#
# Цель: предупредить ДО первой правки, если активная ветка отстаёт от
# других живых feature/fix-веток. Иначе сессия начинается «слепо»:
# фиксы делаются на устаревшей базе, deploy потом стирает чужую работу.
# Прецеденты: 2026-05-13, 2026-05-16. См. memory
# `feedback_worktree_must_merge_main_first.md`.
#
# Hook exit code: всегда 0 (это warning, не блокер). Сообщение идёт в
# stdout — Claude Code показывает оператору + добавляет в context.
# ─────────────────────────────────────────────────────────────────────
set -u

# Найти project root через CLAUDE_PROJECT_DIR (Claude Code задаёт),
# fallback на git rev-parse.
ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ] || [ ! -d "$ROOT/.git" ] && [ ! -f "$ROOT/.git" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
fi
cd "$ROOT" || exit 0

# Если не git — молча выходим.
git rev-parse HEAD >/dev/null 2>&1 || exit 0

THRESHOLD=50
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || echo '')"
WARNINGS=()

# Walk через локальные ветки с префиксами claude/, feature/, fix/, feat/.
# `HEAD..<branch>` считает коммиты, которых нет в HEAD — если ветка
# является предком HEAD или той же самой, ahead == 0.
while IFS= read -r branch; do
  [ -z "$branch" ] && continue
  [ "$branch" = "$CURRENT_BRANCH" ] && continue
  ahead="$(git rev-list --count "HEAD..$branch" 2>/dev/null || echo 0)"
  if [ "$ahead" -gt "$THRESHOLD" ]; then
    WARNINGS+=("$branch is $ahead commits ahead of HEAD")
  fi
done < <(git for-each-ref --format='%(refname:short)' \
           refs/heads/claude/ refs/heads/feature/ refs/heads/feat/ refs/heads/fix/ 2>/dev/null)

if [ ${#WARNINGS[@]} -eq 0 ]; then
  # Тихий success — не зашумляем сессии где всё ровно.
  exit 0
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "⚠  STALE-BASE WARNING — HEAD missing significant work:"
echo ""
for w in "${WARNINGS[@]}"; do
  echo "   • $w"
done
echo ""
echo "   Current branch: ${CURRENT_BRANCH:-(detached HEAD)}"
echo "   Threshold: >${THRESHOLD} commits."
echo ""
echo "   Before deploy or large edits — merge one of those branches in,"
echo "   or switch to it. Deploying from a stale base silently overwrites"
echo "   work that already shipped on feature branches."
echo ""
echo "   See memory: feedback_worktree_must_merge_main_first.md"
echo "═══════════════════════════════════════════════════════════════"
exit 0
