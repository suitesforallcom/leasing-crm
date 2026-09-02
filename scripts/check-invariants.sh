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

# ─── Behind-main check (set 2026-05-13) ────────────────────────────
# Защита от отката прода во времени. Worktree-ветки иногда отстают
# от main на несколько коммитов (например, ветка уже была смержена
# в main, потом в main прилетели ещё фичи). Если в этой ситуации
# запустить `firebase deploy --only hosting`, прод получит файл из
# ветки — БЕЗ свежих коммитов с main → потеря фич, которые оператор
# выкатил вчера. Так и случилось 2026-05-13: ветка
# `fix/port-lease-start-gate` была на 10 коммитов позади main,
# деплой стёр кнопку «Link to month», «Open report», Stripe manual-
# link фиксы и пр. Этот гейт делает такой откат невозможным.
# Skip-условие: только если `git` доступен И мы внутри git-репо И
# main-ветка известна. В CI/edge-кейсах без origin/main — пропускаем
# проверку (но печатаем warning).
echo "── Branch sync check ─────────────────────────────────────"
if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  # Тихий fetch — не валим деплой если оффлайн, просто warning
  if git -C "$ROOT" fetch origin main --quiet 2>/dev/null; then
    BEHIND=$(git -C "$ROOT" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
    if [ "${BEHIND:-0}" -gt 0 ]; then
      echo "  ✗ DEPLOY BLOCKED — branch is $BEHIND commit(s) behind origin/main"
      echo
      echo "  Missing from this branch (would be wiped by deploy):"
      git -C "$ROOT" log --oneline HEAD..origin/main | sed 's/^/    /'
      echo
      echo "  Run:  git merge origin/main"
      echo "        bash scripts/check-invariants.sh"
      echo "        firebase deploy --only hosting"
      exit 1
    else
      echo "  ✓ branch is up-to-date with origin/main"
    fi
  else
    echo "  ⚠ could not fetch origin/main (offline?) — skipping sync check"
  fi
else
  echo "  ⚠ not a git repo or git unavailable — skipping sync check"
fi
echo

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

# ─── Entry 35: loadPaymentsData fill-only (no static-seed clobber) ──────
# Object.assign(u.payments, seed) ПЕРЕЗАПИСЫВАЛ живые оплаты статическим
# сидом PAYMENTS_DATA на загрузке → реальные paid затирались в stale
# `late $0` и сохранялись (инцидент 433/413/408 2026-05-31). Должно быть
# fill-only (только дозаполнять отсутствующие месяцы). См. FIXES_LOG Entry 35.
echo "Entry 35 — loadPaymentsData is fill-only (no Object.assign over u.payments):"
if grep -A 25 "^function loadPaymentsData(" "$HTML" | grep -qE "Object\.assign\(u\.payments"; then
  echo "  ✗ loadPaymentsData uses Object.assign(u.payments…) — REGRESSION: static seed clobbers live payments (FIXES_LOG Entry 35)"
  FAIL=1
else
  echo "  ✓ loadPaymentsData fill-only"
fi

echo

# ═══ Audit 2026-06-06 (workflow woboipj8u) — 3 reintroduced regressions ═══

# ─── Entry-2 reintro: openBouncedCheckModal lease-start guard (audit H14) ──
# `if (startMs && ...) break` short-circuits when startMs==null → the bounced-
# check picker surfaced the PREVIOUS tenant's paid months. Must be `!startMs ||`.
echo "Audit H14 — openBouncedCheckModal lease-start guard:"
if grep -A 55 "^function openBouncedCheckModal(" "$HTML" | grep -qE "if \(startMs && .* < startMs\) break"; then
  echo "  ✗ openBouncedCheckModal — broken 'if (startMs && ...) break' (must be '!startMs ||') — audit H14 regression"
  FAIL=1
else
  echo "  ✓ openBouncedCheckModal (no broken short-circuit)"
fi

echo

# ─── LLC-only occupancy gate: _isUnitOverdue honors u.company (audit M7) ───
# Company-only leases carry u.company without u.tenant. Checking only u.tenant
# hides their overdue state on the floor map. Must use (!u.tenant && !u.company).
echo "Audit M7 — _isUnitOverdue honors u.company (LLC-only):"
if grep -A 3 "^function _isUnitOverdue(" "$HTML" | grep -qE "!u\.tenant && !u\.company"; then
  echo "  ✓ _isUnitOverdue (u.company honored)"
else
  echo "  ✗ _isUnitOverdue — missing u.company fallback (LLC-only leases never overdue) — audit M7 regression"
  FAIL=1
fi

echo

# ─── Entry-44 class: fixFloorAssignments pre-mutation backup (audit H11/H12) ─
# Destructive fixFloorAssignments (floor/unit dedupe) must take a
# _localBackupCreate('pre-mutation') snapshot BEFORE mutating — the 2026-06-04
# data-loss incident class. Without it a bad dedupe is unrecoverable.
echo "Audit H11/H12 — fixFloorAssignments pre-mutation backup:"
if grep -A 14 "^function fixFloorAssignments(" "$HTML" | grep -qE "_localBackupCreate\('pre-mutation'"; then
  echo "  ✓ fixFloorAssignments (pre-mutation backup present)"
else
  echo "  ✗ fixFloorAssignments — missing _localBackupCreate('pre-mutation') before dedupe — audit H11/H12 (Entry-44 class)"
  FAIL=1
fi

echo
echo "Audit [9] — addendum DocuSign anchor re-substitute (escaped quotes):"
if grep -A 70 "^function _aeBuildEnvelopeHtml(" "$HTML" | grep -qE '&quot;font-size:1px'; then
  echo "  ✓ _aeBuildEnvelopeHtml (re-substitute matches the escaped &quot; span — anchor restored, not printed)"
else
  echo "  ✗ _aeBuildEnvelopeHtml — re-substitute regex must use &quot; (escTxt escapes the span's quotes); literal \" silently re-breaks: /signHere/ renders visible + tenant tab lands on wrong line — audit [9] (Entry 54)"
  FAIL=1
fi

echo
echo "Entry 66 — entire-floor lease: pure resolver + keepStatus opt:"
if grep -qE "^function _floorRentableSqft\(f, baseSqft\)" "$HTML" \
   && grep -qE "opts && opts\.keepStatus" "$HTML"; then
  echo "  ✓ _floorRentableSqft resolver + _groupCreate keepStatus present"
else
  echo "  ✗ Entry 66 — _floorRentableSqft (pure rentable→gross resolver) or _groupCreate opts.keepStatus missing — entire-floor lease math regresses (FIXES_LOG 66 / EQ-8)"
  FAIL=1
fi

echo
echo "Entry 16 — follower-tab guard on destructive actions:"
# Follower-вкладка не пушит и не зеркалит (защита от инцидента 2026-06-08), но
# сами действия не были заблокированы: удаление сьюта отрабатывало локально,
# карта его убирала, а onSnapshot возвращал его через пару секунд. Оператор
# удалял Suite 418 трижды подряд, каждый раз видя успех.
if grep -qE "^function requireLeaderTab\(what\)" "$HTML" \
   && grep -qE "requireLeaderTab\('Archiving Suite " "$HTML" \
   && grep -qE "requireLeaderTab\('Deleting Suite " "$HTML" \
   && grep -qE "requireLeaderTab\('Saving unit details'\)" "$HTML" \
   && grep -qE "requireLeaderTab\('Edit Mode'\)" "$HTML"; then
  echo "  ✓ requireLeaderTab wired into archive + delete + unit edits + Edit Mode"
else
  echo "  ✗ Entry 16 — requireLeaderTab missing or unwired: a read-only tab silently loses deletes OR edits (mass type change vanished 2026-08-16)"
  FAIL=1
fi

echo
echo "Audit 2026-08-16 — ds-reconcile must not guess the unit:"
# Номер сьюта уникален только внутри здания (208 из 815 повторяются). Резолв
# по голому id и по почте разложил подписанные договоры по чужим зданиям:
# конверты Pinnellas Park 201/304/344 оказались на Bay Vista с теми же номерами.
if grep -qE "unitIdCount\.get\(r\.unitId\) === 1" "$HTML" \
   && ! grep -qE "ctx = allUnits\.find\(x => \(x\.u\.email" "$HTML" \
   && grep -qE "if \(!uLive\.currentLeaseEnvelopeId\) uLive\.currentLeaseEnvelopeId" "$HTML"; then
  echo "  ✓ ds-reconcile: suite-number fallback gated on uniqueness, email fallback gone, pointer not overwritten"
else
  echo "  ✗ ds-reconcile guesses the unit again (bare suite-number or email fallback, or overwrites currentLeaseEnvelopeId) — signed leases land on foreign suites"
  FAIL=1
fi

echo
echo "Audit 2026-08-16 — nested-rentable guard (sub-room без parentId):"
# 440/441 нарисованы внутри 442 без parentId → rentable-площадь этажа
# задвоена. Гейт: commit геометрии прогоняет _nestedRentableGuardCheck
# (confirm → parentId), byte-identical прямоугольник всегда даёт warn.
if grep -qE "^function _nestedRentableGuardCheck\(u, f\)" "$HTML" \
   && grep -qE "_nestedRentableGuardCheck\(newUnit, f\)" "$HTML" \
   && grep -qE "identical geometry" "$HTML"; then
  echo "  ✓ nested-rentable guard present and wired into geometry commits"
else
  echo "  ✗ nested-rentable guard missing/unwired — офис внутри офиса снова задвоит площадь этажа (audit 2026-08-16 #5)"
  FAIL=1
fi


echo
echo "Entry 77 — stored lease templates substitute live values on send/preview:"
# unit/workspace-шаблон возвращался вербатим: liveOverrides (новые даты
# продления) игнорировались, {{токены}} уходили клиенту литералами —
# renewal через DocuSign уносил в конверт СТАРУЮ дату окончания.
check_gate 77 _resolveLeaseTemplate "_renderStoredLeaseTpl\('unit'" 40
check_gate 77 _resolveLeaseTemplate "_renderStoredLeaseTpl\('workspace'" 200
check_gate 77 _renderStoredLeaseTpl '_ldSubstituteMergeTokens\(' 30
check_gate 77 _slOpenLeasePreview 'liveOverrides\.lease_end = _pr\.until' 30

echo
echo "Mobile cache-busting — versioned module loading:"
# Статический import без версии Safari на iOS не обновляет никогда (no-store
# не выселяет уже закэшированный ответ). Оператор дважды сообщал об уже
# исправленной ошибке, потому что телефон выполнял старую сборку.
M_HTML="$(dirname "$HTML")/m.html"; M_APP="$(dirname "$HTML")/m/app.js"
if grep -qE 'src="/m/app\.js\?v=' "$M_HTML" \
   && grep -qE "import\.meta\.url\).searchParams.get\('v'\)" "$M_APP" \
   && ! grep -qE "^import .* from '\./(lib|ui)/" "$M_APP"; then
  echo "  ✓ m.html versions app.js; app.js versions its module imports"
else
  echo "  ✗ mobile module loading lost its version stamps — deploys will not reach cached phones"
  FAIL=1
fi

# ── Движок фото документов: vendor-файлы существуют и совпадают с путями в
# idphoto.js (2026-08-16). Файлы именуются С ВЕРСИЕЙ и не перезаписываются;
# пропажа vendor/ из раздачи молча роняет OpenCV-путь в canvas-фолбэк.
IDP="$(dirname "$HTML")/m/lib/idphoto.js"
VOK=1
for var in VENDOR_CV VENDOR_SCANNER; do
  vp=$(grep -oE "export const $var = '[^']+'" "$IDP" | sed "s/.*'\(.*\)'/\1/")
  if [ -z "$vp" ] || [ ! -s "$(dirname "$HTML")$vp" ]; then
    echo "  ✗ $var: '$vp' — файла нет или он пуст (vendor не поедет в деплой)"
    VOK=0; FAIL=1
  fi
done
[ "$VOK" -eq 1 ] && echo "  ✓ vendor-движок фото (OpenCV+jscanify) на месте и путями совпадает"

echo
echo "──────────────────────────────────────────────────────────"
if [ "$FAIL" -ne 0 ]; then
  echo "✗ DEPLOY BLOCKED — FIXES_LOG invariants missing."
  echo "  Open FIXES_LOG.md, find the failing Entry, restore the gate, retry."
  exit 1
fi
echo "✓ All FIXES_LOG invariants OK — safe to deploy."
