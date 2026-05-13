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

# ─── Entry 6: «Open report» button in all 3 Invoice History states ──
# Кнопка `class="upv2-inv-report-btn"` должна рендериться в трёх местах:
# Loading state, Empty state, List state. Если меньше — оператор не может
# открыть отчёт на свежедобавленном/пустом юните.
echo "Entry 6 — Open report button in all Invoice History states:"
btn_count=$(grep -c 'onclick="openUnitInvoiceReport()"' "$HTML" || true)
if [ "$btn_count" -lt 3 ]; then
  echo "  ✗ Open-report button found in only $btn_count places (need 3: loading / empty / list)"
  echo "      See FIXES_LOG Entry 6"
  FAIL=1
else
  echo "  ✓ Open-report button rendered in $btn_count places (≥3 required)"
fi

echo

# ─── Entry 3: _healStaleStripeStamps must not wipe manual bindings ─
# Heal-pass удаляет u.stripe.depositInvoice / moveInRent если sentAt
# старше lease-start. Это убивает ручные привязки оператора (через
# "Link as deposit") — у них sentAt легитимно может быть до lease-start
# (старый Stripe-счёт). Фикс: di?.sentAt && di.manualLink !== true
# (heal трогает штамп ТОЛЬКО если manualLink не выставлен).
echo "Entry 3 — _healStaleStripeStamps respects manualLink flag:"
check_gate 3 _healStaleStripeStamps 'di\?\.sentAt && di\.manualLink !== true'

echo

# ─── Entry 7: Deposit display in fmtBillingMonth ───────────────────
# fmtBillingMonth должен короткозамыкать deposit-инвойсы в «Deposit»,
# иначе deposit-инвойс показывает месяц создания (например «May») и
# оператор путает депозит с rent-обязательством. После Entry 5 функция
# возвращает объект-дескриптор { kind, text, ym }, поэтому ищем оба
# исторических варианта: строку 'Deposit' и descriptor с kind:'deposit'.
echo "Entry 7 — Deposit display in fmtBillingMonth:"
if grep -qE "purpose === 'deposit'\) return (\{ kind: 'deposit', text: 'Deposit' \}|'Deposit')" "$HTML"; then
  echo "  ✓ fmtBillingMonth short-circuits deposit invoices to 'Deposit'"
else
  echo "  ✗ fmtBillingMonth missing the deposit short-circuit"
  echo "      Expected one of:"
  echo "        purpose === 'deposit') return 'Deposit'             (pre-Entry-5)"
  echo "        purpose === 'deposit') return { kind: 'deposit', text: 'Deposit' }   (post-Entry-5)"
  echo "      See FIXES_LOG Entry 7"
  FAIL=1
fi

echo
echo "──────────────────────────────────────────────────────────"
if [ "$FAIL" -ne 0 ]; then
  echo "✗ DEPLOY BLOCKED — FIXES_LOG invariants missing."
  echo "  Open FIXES_LOG.md, find the failing Entry, restore the gate, retry."
  exit 1
fi
echo "✓ All FIXES_LOG invariants OK — safe to deploy."
