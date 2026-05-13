#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# FIXES_LOG invariant check — runs BEFORE `firebase deploy --only hosting`
# Если хоть один инвариант сломан → exit 1 → деплой блокируется.
# Документация и контекст каждого инварианта: ./FIXES_LOG.md
#
# Зачем нужно: фиксы могут жить на feature-branch и НЕ доезжать до main.
# Этот скрипт проверяет, что собираемый в прод файл содержит все
# защитные паттерны, которые мы один раз уже починили. Без него
# можно тихо задеплоить main, где гейта нет, и регрессия выходит
# в продакшен.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HTML="$ROOT/floor-map-editor.html"
FAIL=0

if [ ! -f "$HTML" ]; then
  echo "✗ check-invariants: $HTML not found"
  exit 1
fi

# check_gate <entry-number> <function-name> <egrep-pattern> [window-lines]
# Берёт N строк после `function NAME(` и проверяет, что внутри есть
# линия, матчащая pattern. Если нет — пишет ошибку и взводит FAIL=1.
# Window=100 по умолчанию — достаточно чтобы поймать гейт даже в
# длинных функциях вроде _renderUnitPaymentHealth (700+ строк).
check_gate() {
  local entry="$1" fn="$2" pattern="$3" window="${4:-100}"

  if ! grep -q "^function $fn(" "$HTML"; then
    echo "  ✗ $fn() — function not found (FIXES_LOG Entry $entry)"
    FAIL=1
    return
  fi

  if grep -A "$window" "^function $fn(" "$HTML" | grep -qE "$pattern"; then
    echo "  ✓ $fn"
  else
    echo "  ✗ $fn — missing gate (FIXES_LOG Entry $entry)"
    echo "      Expected: $pattern"
    FAIL=1
  fi
}

echo "── FIXES_LOG invariant check ─────────────────────────────"
echo

# ─── Entry 1: Lease-start gate (anti-phantom finance) ──────────────
# 9 функций, каждая walk-back через 12+ месяцев. Без top-of-function
# гейта `if (!startDate || isNaN(...))` свежедобавленный тенант
# показывает фантомный $7,800 owed + $624 late fees. Третий повтор
# бага наблюдался 2026-05-12 на Suite 367 (тенант "fdsfas").
echo "Entry 1 — Lease-start gate (9 functions):"
check_gate 1 _computeUnitMoney         'if \(!startDate \|\| isNaN\(startDate\.getTime\(\)\)\)'
check_gate 1 _renderUnitLateFeeOwed    'if \(!startDate \|\| isNaN\(startDate\.getTime\(\)\)\) return'
check_gate 1 _renderUnitPaymentHealth  'if \(!startDate \|\| isNaN\(startDate\.getTime\(\)\)\)'
check_gate 1 _outstandingForUnit       'if \(!startMs \|\| .*startMs.*\) break'
check_gate 1 _bvComputeTenantBalance   'if \(!_bvStartDate \|\| isNaN\(_bvStartDate\.getTime\(\)\)\) return 0'
check_gate 1 _bvCountOutstandingMonths 'if \(!_bvStartDate \|\| isNaN\(_bvStartDate\.getTime\(\)\)\) return 0'
check_gate 1 dsoForTenant              'if \(!_dsoStartDate \|\| isNaN\(_dsoStartDate\.getTime\(\)\)\) return 0'
check_gate 1 trendForTenant            'if \(!_trStartDate \|\| isNaN\(_trStartDate\.getTime\(\)\)\)'
check_gate 1 buildAgingRows            'if \(!_startDate \|\| isNaN\(_startDate\.getTime\(\)\)\) continue'

echo

# ─── Entry 2: Anti-pattern `if (X && cond) break;` ─────────────────
# Когда X == null, `X && cond` короткозамыкается в false, break/continue
# не срабатывает, цикл проходит все 12-24 итерации. Проверяем что
# конкретно в _outstandingForUnit паттерн правильный (`!X || cond`).
echo 'Entry 2 — No-op short-circuit pattern check:'
if grep -A 30 "^function _outstandingForUnit(" "$HTML" | grep -qE "if \(startMs && .*startMs\) break"; then
  echo '  ✗ _outstandingForUnit — broken short-circuit `if (startMs && ...) break` still present'
  echo '      See FIXES_LOG Entry 2 — must use `if (!startMs || ...) break`'
  FAIL=1
else
  echo "  ✓ _outstandingForUnit (no broken short-circuit)"
fi

echo
echo "──────────────────────────────────────────────────────────"
if [ "$FAIL" -ne 0 ]; then
  echo "✗ DEPLOY BLOCKED — FIXES_LOG invariants missing."
  echo "  Open FIXES_LOG.md, find the failing Entry, restore the gate, retry."
  exit 1
fi
echo "✓ All FIXES_LOG invariants OK — safe to deploy."
