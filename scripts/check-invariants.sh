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
  # Entry 79: функции бывают и `async function NAME(` — матчим оба вида.
  local head_re="^(async )?function $fn\("

  if ! grep -qE "$head_re" "$HTML"; then
    echo "  ✗ $fn() — function not found (FIXES_LOG Entry $entry)"
    FAIL=1
    return
  fi

  if grep -A "$window" -E "$head_re" "$HTML" | grep -qE "$pattern"; then
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
echo "Entry 78 — preview does not un-fill live values; renewal envelope carries commencement date:"
# (1) Smart-map превью «выдирал» подставленные значения обратно в {{токены}}
# на уже отрендеренном live-документе (Suite 346: Start Date → голый чип).
# (2) Конверт продления уносил дату ПОДПИСАНИЯ (u.signed) вместо даты начала
# (u.leaseStart) — расходился и с превью, и с решением §3 (2026-07-03).
check_gate 78 _ltPreviewTokenize 'skipAutoExtract' 15
check_gate 78 _previewLeaseTemplate 'skipAutoExtract: !!u' 80
check_gate 78 _slBuildPayloadFromForm 'pend \? \(u\.leaseStart \|\| u\.signed' 60

echo
echo "Entry 79 — no-document auto-renewal: record it, don't fake a signing; leader-tab guard on doc saves:"
# (1) Договор с auto-renewal клаузой продлевается сам — режим «условия не
#     меняются» пишет только u.until (годовщинная арифметика, НЕ end-of-month)
#     + запись в leaseDocuments + outreach; leaseStart/рента не трогаются.
# (2) Незаписанное продление молча останавливало серверный авто-инвойсинг
#     (гейт по until) — expired-ветка алерта больше не гаснет.
# (3) _saveAddLeaseDocModal обязан звать requireLeaderTab (Entry 16-класс).
check_gate 79 _saveAddLeaseDocModal 'requireLeaderTab' 15
check_gate 79 _saveAddLeaseDocModal '_saveAutoRenewalRecord\(\)' 25
check_gate 79 _saveAutoRenewalRecord 'requireLeaderTab' 15
check_gate 79 _saveAutoRenewalRecord '_autoRenewEligible\(u\)' 30
check_gate 79 _renderRenewalAlert "mode:'auto'" 60

echo
echo "Entry 80 — renewal/amendment envelopes carry the Amendment doc, not a second full agreement:"
# Полный новый договор для продления = два живых контракта + двойная
# обязанность по депозиту (юр-разбор 2026-09-02). renewal/amendment
# резолвятся своим kind → генерируемый Amendment (текст согласован Tony);
# превью и конверт обязаны использовать один и тот же docKind.
check_gate 80 _dsBuildAmendmentHtml 'No Other Changes' 200
check_gate 80 _dsBuildAmendmentHtml 'no additional' 200
check_gate 80 _resolveLeaseTemplate "_dsBuildAmendmentHtml\(fields" 220
check_gate 80 docusignSendEnvelope 'docKind' 15
check_gate 80 _slBuildPayloadFromForm 'docKind' 80
check_gate 80 _slOpenLeasePreview 'previewKind' 30
check_gate 80 _slRenderPreviewBody 'payload\.docKind' 15

echo
echo "Entry 81 — inactive Stripe FC account is surfaced as 'relink required', never as a silent successful poll:"
# 2026-10-01: Capital One ····5709 inactive at Stripe с 2026-09-19 — крон «успешно»
# читал старый кэш, lastPolledAt полз вперёд, окно опроса уезжало за разрыв,
# баннер говорил «may need a refresh» и вёл в Connect (новый fca → дубли, Entry 30).
check_gate 81 _checkBankSyncHealth "needsRelink === true \|\| c\.status === 'inactive'" 80
check_gate 81 _checkBankSyncHealth "status = 'relink'" 120
check_gate 81 _refreshBankSyncBanner "h\.status === 'relink'" 40
check_gate 81 _renderBankConnections 'Request relink' 120
FN_JS="$ROOT/functions/index.js"
# grep -c (не -q): под `set -o pipefail` ранний выход grep -q даёт SIGPIPE
# первому grep на длинном окне → ложный провал гейта.
fn_has() {  # $1 header regex, $2 pattern, $3 window
  local n; n=$(grep -A "$3" -E "$1" "$FN_JS" | grep -cE "$2" || true); [ "${n:-0}" -gt 0 ]; }
if grep -qE "^function _bankFeedSinceUnix\(" "$FN_JS" \
   && fn_has "^async function _pullTransactionsForAccount\(" "_ensureFreshTransactions" 12 \
   && fn_has "^async function _pullTransactionsForAccount\(" "accountStatus !== 'active'" 30 \
   && fn_has "^async function _markAccountPolled\(" "accountStatus !== 'active'" 30 \
   && [ "$(grep -cE "_bankFeedSinceUnix\(c, " "$FN_JS")" -ge 2 ] \
   && fn_has "^exports\.finalizeBankConnection = " "c\.status === 'inactive'" 50 \
   && grep -qE "skippedDuplicates\.push" "$FN_JS" \
   && fn_has "^async function _autoApplyAfterPoll\(" "_writeAutoApplyLedgerV2\(p\.b, p\.f, p\.u, p\.ym, p\.rec, p\.txnId\)" 400 \
   && fn_has "^async function _autoApplyAfterPoll\(" "toConfirm\.slice" 400 \
   && fn_has "^async function _autoApplyAfterPoll\(" "txn\.autoApplied === false" 120 \
   && fn_has "^async function _autoApplyAfterPoll\(" "ledgerRequired = _ledgerIsCollectionCF\(s\)" 400 \
   && fn_has "^async function _autoApplyAfterPoll\(" "_monthHasStripeInvoice\(c\.u, c\.ym, existing\)" 180; then
  echo "  ✓ functions/index.js bank-feed: inactive short-circuit, frozen watermark, anchored window, ghost/dup guards, durable auto-apply"
else
  echo "  ✗ functions/index.js bank-feed lost an Entry 81 guard (inactive short-circuit / watermark / window / dup guard / durable auto-apply)"
  FAIL=1
fi
if fn_has "^exports\.disconnectBankAccount = " "preConn\.sharedConnection" 30 \
   && fn_has "^exports\.adoptBankFcAccount = " "includes\('transactions'\)" 40 \
   && fn_has "^exports\.adoptBankFcAccount = " "_bankSameAccountKind\(c0, acc\)" 90 \
   && fn_has "^async function _pullTransactionsForAccount\(" "_prevIdxTakeSameDay\(dedupeIdx" 140 \
   && fn_has "^async function _autoApplyAfterPoll\(" "_prevIdxNear\(prevIdx" 140 \
   && fn_has "^exports\.syncBankConnections = " "supersededFcIds" 90; then
  echo "  ✓ Entry 82: shared connection never detached at Stripe; adopt guards; UTC-day dedupe + auto-apply guard; superseded ids"
else
  echo "  ✗ Entry 82 guard missing (shared-disconnect / adopt guards / UTC-day dedupe / auto-apply guard / superseded ids)"
  FAIL=1
fi

if fn_has "^exports\.attachStripeInvoiceToUnit = " "custEmail !== tenantEmail" 60 \
   && fn_has "^exports\.attachStripeInvoiceToUnit = " "inv\.status !== 'open' && inv\.status !== 'draft'" 40 \
   && fn_has "^exports\.attachStripeInvoiceToUnit = " "_isRootAdmin\(email\)" 8; then
  echo "  ✓ Entry 84: attachStripeInvoiceToUnit guards (root admin, open/draft only, tenant-email match)"
else
  echo "  ✗ Entry 84 guard missing (attachStripeInvoiceToUnit)"
  FAIL=1
fi
if fn_has "^function _methodFamily\(" "'cash', 'bank'\]" 6 \
   && fn_has "^function _unitPrimaryPaymentMethod\(" "_recPaymentMethod\(p\)" 20 \
   && fn_has "^function _recPaymentMethod\(" "p\.stripe && p\.stripe\.invoiceId" 8 \
   && fn_has "^function _findOldestUnpaidYm\(" "candidates\.push\(\`\\\$\{dF" 30 \
   && ! fn_has "^function _findOldestUnpaidYm\(" "candidates\.unshift" 30 \
   && fn_has "^exports\.bankFeedScheduledPoll = " "await _autoApplyAfterPoll\(c\.stripeFcAccountId\)" 140 \
   && fn_has "^function _recPaymentMethod\(" "p\.bankTxnId \|\| p\.source === .bank-feed." 10 \
   && fn_has "^function _unitPrimaryPaymentMethod\(" "_ymInLease\(u, k\)" 8 \
   && fn_has "^function _findAutoApplyCandidate\(" "if \(ym < currentYm\) \{" 260 \
   && fn_has "^function _findAutoApplyCandidate\(" "if \(ym > currentYm\) \{" 260 \
   && fn_has "^function _findAutoApplyCandidate\(" "_txnYm\(txn\) !== ym" 260 \
   && fn_has "^function _findAutoApplyCandidate\(" "reason: 'name-conflict'" 200 \
   && fn_has "^function _findAutoApplyCandidate\(" "_methodFamily\(primary\) !== 'bank' \|\| incomingFamily !== 'bank'" 260 \
   && fn_has "^function _findAutoApplyCandidate\(" "candidates\.length > 1 \|\| contenders > 0" 80 \
   && fn_has "^function _findAutoApplyCandidate\(" "_descNamesOther\(txn\.description, cand\.u\)" 200 \
   && fn_has "^function _findAutoApplyCandidate\(" "reason: 'amount-changed'" 200 \
   && fn_has "^function _findAutoApplyCandidate\(" "candidate\(\{ ym: oldestOpen \}\)" 260 \
   && fn_has "^function _findAutoApplyCandidate\(" "_monthInvoicedViaStripe\(cand\.u, ym\)" 260 \
   && fn_has "^function _unitPrimaryPaymentMethod\(" "return 'unknown';" 6 \
   && fn_has "^async function _autoApplyAfterPoll\(" "const decided = !!\(txn\.autoApplyEvaluatedAt \|\| txn\.autoApplyBlockedReason\)" 140 \
   && fn_has "^async function _autoApplyAfterPoll\(" "if \(decided\) \{ skipped\+\+; continue; \}" 160 \
   && fn_has "^async function _autoApplyAfterPoll\(" "_findAutoApplyCandidate\(state, txn, \{ pendingTxns, recentTxns \}\)" 140 \
   && fn_has "^async function _autoApplyAfterPoll\(" "\['not-posted', 'not-credit', 'lookback-unavailable'\]\.includes\(check\.reason\)" 160 \
   && fn_has "^function _findAutoApplyCandidate\(" "reason: 'internal-transfer'" 200 \
   && fn_has "^function _findAutoApplyCandidate\(" "series \|\| openForUnit \|\| _amountPaidRecentlyByOther\(state, cand, targetCents, nowMs\)" 200 \
   && fn_has "^function _isAutoApplyContender\(" "at\(dep\.paidAt \|\| dep\.date\) >= sinceMs" 25; then
  echo "  ✓ Entry 89: auto-apply — 'bank' family survives the gate, webhook/bank-feed recs carry a method, next month last, cron auto-apply, positive bank evidence, arrival-month + current-month + no-arrears + name/contender/amount/invoice/series/transfer gates, decide-once (pending not stamped)"
else
  echo "  ✗ Entry 89 guard missing (_methodFamily 'bank' / _recPaymentMethod / next-month-last in _findOldestUnpaidYm / cron auto-apply)"
  FAIL=1
fi
# Entry 90: Stripe-billed tenants never get a bank-deposit suggestion (matcher) or deferral (auto-apply).
if fn_has "^function _matcherCandidates\(" "if \(_unitBilledViaStripe\(u\)\) continue;" 12 \
   && fn_has "^function _findAutoApplyCandidate\(" "reason: 'stripe-billed'" 120; then
  echo "  ✓ Entry 90: Stripe-billed tenants are excluded from bank-deposit suggestions"
else
  echo "  ✗ Entry 90 guard missing (_matcherCandidates / _findAutoApplyCandidate stripe-billed)"
  FAIL=1
fi
# Entry 89 rev 6: name check BEFORE the method gate; look-back failure applies nothing.
_aa_n=$(grep -nE "^function _findAutoApplyCandidate\(" "$FN_JS" | head -1 | cut -d: -f1)
_aa_name=$(awk -v s="${_aa_n:-0}" 'NR>s && /reason: .name-conflict./ {print NR; exit}' "$FN_JS")
_aa_meth=$(awk -v s="${_aa_n:-0}" 'NR>s && /reason: .method-mismatch./ {print NR; exit}' "$FN_JS")
if [ -n "$_aa_name" ] && [ -n "$_aa_meth" ] && [ "$_aa_name" -lt "$_aa_meth" ] \
   && fn_has "^async function _autoApplyAfterPoll\(" "recentTxns = null;" 60 \
   && fn_has "^async function _autoApplyAfterPoll\(" "reason: 'lookback-unavailable'" 140; then
  echo "  ✓ Entry 89 rev 6: name gate precedes the method gate; look-back failure fails closed"
else
  echo "  ✗ Entry 89 rev 6 guard missing (name-before-method order / look-back fail-closed)"
  FAIL=1
fi
if fn_has "^async function _mirrorBuildingV2CF\(" "_savedRev: curRev \+ 2" 30; then
  echo "  ✓ Entry 87: server building mirror writes curRev + 2"
else
  echo "  ✗ Entry 87 hotfix missing (_mirrorBuildingV2CF must write curRev + 2)"
  FAIL=1
fi
echo
echo "Entry 88 — suite groups resolve members inside ONE floor, never by bare suite number across buildings:"
check_gate 88 _groupCreate "scopeFloor\.units\.filter" 40
if grep -A 40 -E "^function _groupCreate\(" "$HTML" | grep -qE "unitIds\.includes\(u\.id\)"; then
  echo "  ✗ Entry 88: _groupCreate scans the whole portfolio by bare suite id again"
  FAIL=1
fi
if grep -qE "_groupCreate\(draft\.ids, tenantData, \{ buildingId: draft\.buildingId, floorId: draft\.floorId \}\)" "$HTML" \
   && grep -qE "_groupCreate\(offices\.map\(u => u\.id\), td, \{ keepStatus: !src, floor: f \}\)" "$HTML"; then
  echo "  ✓ Entry 88: both _groupCreate callers pass a floor scope"
else
  echo "  ✗ Entry 88: a _groupCreate caller lost its floor scope"
  FAIL=1
fi
echo
echo "Entry 86 — stamp self-heal never re-stamps a voided invoice:"
check_gate 86 _fetchUnitInvoicesFromStripe "_st === 'void' \|\| _st === 'uncollectible'" 120
echo
echo "Entry 83 — ledger records are removed durably (repo), never by in-memory wipe on move-out / deposit reverse:"
check_gate 83 markUnitDepositUnpaid "_deleteLedgerRecDurable\(u, 'deposit'\)" 60
check_gate 83 submitMoveOut "_wipeUnitLedgerDurable\(u\)" 260
check_gate 83 submitMoveOut "_ledgerArchiveExtras\(" 140
check_gate 83 moveOutCurrentTenant "_wipeUnitLedgerDurable\(u\)" 160
check_gate 83 moveOutCurrentTenant "_ledgerArchiveExtras\(" 120
check_gate 83 _deleteLedgerRecDurable "repo\.deletePayment" 8
echo
echo "Entry 92 — signing link / PDF on the lease card: server-issued link, admin/manager gate, no unit-state writes:"
check_gate 92 _leaseDocSignLinkCreate "_dsCallCF\('dsCreateSigningLink'" 40
check_gate 92 _leaseDocDownloadPdf "_dsCallCF\('dsDownloadCombinedPdf'" 80
# grep -c (не -q): длинное окно + pipefail → SIGPIPE у первого grep при раннем выходе -q.
if [ "$(grep -A 260 -E "^function _renderLeaseDocCard\(" "$HTML" | grep -cE "const _canDs = \(typeof canSendLeases === 'function'\)" || true)" -ge 1 ]; then
  echo "  ✓ _renderLeaseDocCard: signing-link / PDF buttons gated by canSendLeases()"
else
  echo "  ✗ Entry 92: _renderLeaseDocCard lost the canSendLeases() gate for signing-link / PDF buttons"
  FAIL=1
fi
# Копирование ссылки — не отправка (§0.2 правило 3): ни saveState, ни записи в юнит.
if [ "$(grep -A 220 -E "^async function _leaseDocShareSigningLink\(" "$HTML" \
   | sed '/^async function _leaseDocSignLinkCopy(/,$d' \
   | grep -cE "saveState\(|recordOutreach\(|leaseEnvelopes\.push|fbPushNow\(" || true)" -ge 1 ]; then
  echo "  ✗ Entry 92: _leaseDocShareSigningLink writes unit state — copying a link is not a send"
  FAIL=1
else
  echo "  ✓ Entry 92: _leaseDocShareSigningLink leaves unit state untouched"
fi
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
echo "Entry 95 — tenant email validation + Stripe error mapping:"
# 2026-10-29, Suite 107 / Bay Vista Dr: u.email хранился как "ZGLUCK@VIVOHC .COM"
# (обычный пробел перед .COM). Все клиентские гейты путей отправки и CF
# проверяли только /@/ → адрес ушёл в Stripe → 400 email_invalid →
# необработанный StripeInvalidRequestError → onCall отдал голый INTERNAL;
# оператор шесть раз увидел «Failed: INTERNAL — checking Stripe for orphan
# invoice…» без указания на поле. Заодно: тумблер «$» (u.stripeBillingContact
# === 'cc') учитывал только Invoice Generator — пути Move-in всегда слали на
# u.email; а _verifyAndStampAfterSend матчил только legacy purpose:'custom' и
# не мог восстановить новый штамп депозита.
# Гейты: строгий isValidEmail на каждом пути отправки (_tenantEmailProblem),
# получатель через _unitStripeBillingEmail, Title Case имён при сохранении
# (saveDetail → _normPersonName); CF валидирует адрес до любого вызова Stripe
# (_assertTenantEmail) и маппит 4xx Stripe в HttpsError с настоящей причиной
# (_stripeErrToHttps на customer / invoice / finalize). Тест: tests/email-guard.test.mjs.
check_gate 95 _sendMoveInDirect '_tenantEmailProblem\(' 40
check_gate 95 _ntoSendRent '_tenantEmailProblem\(' 40
check_gate 95 _ntoSendDeposit '_tenantEmailProblem\(' 40
check_gate 95 _verifyAndStampAfterSend "purpose === 'deposit'" 40
check_gate 95 saveDetail '_normPersonName\(' 120
# Ревью Entry 95: остальные пути отправки + авто-счёт при включении AUTO обязаны
# идти через тот же гейт; детектор смены арендатора и матчеры имени — через _tenantKey
# (иначе Title Case при Save выглядит как другой арендатор → Tier A wipe ledger'а);
# групповое назначение пишет нормализованные контакты.
check_gate 95 _triggerAutoInvoiceNowIfNeeded '_tenantEmailProblem\(' 60
check_gate 95 _sendInvoiceWithLateFees '_tenantEmailProblem\(' 60
check_gate 95 createMoveInInvoices '_tenantEmailProblem\(' 40
check_gate 95 _confirmSplitMoveInRent '_tenantEmailProblem\(' 60
check_gate 95 openSplitMoveInRentModal '_tenantEmailProblem\(' 40
check_gate 95 saveUnitDetail '_tenantKey\(' 60
check_gate 95 _promoteProspectToTenant '_tenantKey\(' 20
check_gate 95 _stampTenantAdded '_tenantKey\(' 20
check_gate 95 saveGroupAssign '_normPersonName\(' 20
if [ "$(grep -c "emailOverride: u.email" "$HTML" || true)" -eq 0 ]; then
  echo "  ✓ emailOverride: u.email — нигде (получатель всегда через _unitStripeBillingEmail)"
else
  echo "  ✗ emailOverride: u.email всё ещё встречается — путь отправки обходит _unitStripeBillingEmail (FIXES_LOG Entry 95)"
  FAIL=1
fi
# CF-гейты по МЕСТУ вызова (ревью: счётчик вхождений проходил и при убранном вызове
# на пути инцидента). Тело createStripeInvoice лежит либо inline в
# exports.createStripeInvoice = onCall(, либо вынесено в _createStripeInvoiceImpl
# (agent-gateway) — берём регион от первого из якорей до exports.startAutoPay.
_e95_inv="$(awk '/^async function _createStripeInvoiceImpl\(|^exports\.createStripeInvoice = onCall\(/ {on=1} /^exports\.startAutoPay/ {on=0} on' "$FN_JS")"
_e95_ens="$(awk '/^exports\.ensureStripeCustomer = onCall\(/ {on=1; print; next} on && /^(exports\.|async function |function |const )/ {on=0} on' "$FN_JS")"
_e95_cf_ok=1
printf '%s' "$_e95_inv" | grep -q "_assertTenantEmail(" || _e95_cf_ok=0
printf '%s' "$_e95_inv" | grep -qF "'invoicing')" || _e95_cf_ok=0
for _ctx in customer invoice finalize; do
  printf '%s' "$_e95_inv" | grep -qF "_stripeErrToHttps(e, '$_ctx')" || _e95_cf_ok=0
done
printf '%s' "$_e95_ens" | grep -q "_assertTenantEmail(" || _e95_cf_ok=0
printf '%s' "$_e95_ens" | grep -qF "_stripeErrToHttps(e, 'customer')" || _e95_cf_ok=0
if [ "$_e95_cf_ok" = 1 ]; then
  echo "  ✓ functions/index.js — _assertTenantEmail до Stripe и _stripeErrToHttps(e, customer/invoice/finalize) по месту вызова в createStripeInvoice + ensureStripeCustomer"
else
  echo "  ✗ functions/index.js — Entry 95: в createStripeInvoice / ensureStripeCustomer нет _assertTenantEmail( или _stripeErrToHttps(e, 'customer'|'invoice'|'finalize') на месте вызова"
  FAIL=1
fi

echo
echo "Entry 96 — AutoPay email guard · CF retry по кодам модульного SDK · общий модуль контактов (m/ + CF):"
# Хвосты Entry 95 (2026-10-30). (1) startAutoPay передавал unit.email в Stripe с одной
# проверкой на пустоту — тот же класс инцидента Suite 107 (голый INTERNAL). (2) isRetriable
# в stripeCallable сравнивал код без префикса, а модульный SDK отдаёт 'functions/<code>' —
# транзиентные ошибки не ретраились никогда; срез префикса + allowlist безопасных вызовов
# (чтения, createStripeInvoice с ключом идемпотентности, ensureStripeCustomer), чтобы
# повтор не дал вторую мутацию; тот же срез в audit-outbox (битые записи крутились вечно).
# (3) Нормализаторы контактов вынесены в functions/lib/contact.js ≡ m/lib/contact.js
# (UMD, байт-в-байт): их зовут _dsSanitizeTenancy (аренда с телефона) и m/ui/lease.js.
# Тесты: tests/email-guard.test.mjs, tests/tenancy.test.mjs, tests/m-harness.html (4n2).
_e96_ok=1
_e96_ap="$(awk '/^exports\.startAutoPay = onCall\(/ {on=1; print; next} on && /^(exports\.|async function |function |const )/ {on=0} on' "$FN_JS")"
printf '%s' "$_e96_ap" | grep -qF "_assertTenantEmail(unit.email, 'starting AutoPay')" || _e96_ok=0
printf '%s' "$_e96_ap" | grep -qF "_stripeErrToHttps(e, 'customer')" || _e96_ok=0
printf '%s' "$_e96_ap" | grep -qF "_stripeErrToHttps(e, 'checkout')" || _e96_ok=0
if [ "$_e96_ok" = 1 ]; then
  echo "  ✓ functions/index.js — startAutoPay: _assertTenantEmail до Stripe, _stripeErrToHttps(e, customer/checkout) по месту вызова"
else
  echo "  ✗ functions/index.js — Entry 96: в startAutoPay нет _assertTenantEmail(unit.email, 'starting AutoPay') или _stripeErrToHttps(e, 'customer'|'checkout')"
  FAIL=1
fi
_e96_sc="$(awk '/^function stripeCallable\(name\) \{/ {on=1} on {print} on && /^\}/ {on=0}' "$HTML")"
if printf '%s' "$_e96_sc" | grep -qF "replace(/^functions\\//, '')" && printf '%s' "$_e96_sc" | grep -qF "_CF_RETRY_SAFE"; then
  echo "  ✓ stripeCallable — isRetriable срезает префикс functions/ и ретраит серверные коды только из _CF_RETRY_SAFE"
else
  echo "  ✗ stripeCallable — Entry 96: нет среза префикса functions/ или allowlist _CF_RETRY_SAFE"
  FAIL=1
fi
check_gate 96 _auditOutboxDrain 'replace\(/\^functions' 60
_e96_ds="$(awk '/^function _dsSanitizeTenancy\(t\) \{/ {on=1} on {print} /^exports\.dsSendEnvelope/ {on=0}' "$FN_JS")"
_e96_ok=1
for _fn in _contact.normPersonName _contact.normCompanyName _contact.normEmail _contact.emailLooksValid _contact.normPhone; do
  printf '%s' "$_e96_ds" | grep -qF "$_fn(" || _e96_ok=0
done
grep -qF "require('./lib/contact.js')" "$FN_JS" || _e96_ok=0
if [ "$_e96_ok" = 1 ]; then
  echo "  ✓ functions/index.js — require('./lib/contact.js'); _dsSanitizeTenancy нормализует tenant/company/email/tel через _contact.*"
else
  echo "  ✗ functions/index.js — Entry 96: нет require('./lib/contact.js') или _dsSanitizeTenancy не зовёт _contact.norm*/emailLooksValid"
  FAIL=1
fi
_e96_c1="$ROOT/functions/lib/contact.js"; _e96_c2="$ROOT/m/lib/contact.js"
if [ -s "$_e96_c1" ] && cmp -s "$_e96_c1" "$_e96_c2" && ! grep -qE '^[[:space:]]*(import|export)[[:space:]]|[^A-Za-z_]require\(' "$_e96_c1"; then
  echo "  ✓ functions/lib/contact.js ≡ m/lib/contact.js (байт-в-байт, UMD без import/export/require)"
else
  echo "  ✗ Entry 96: m/lib/contact.js разошёлся с functions/lib/contact.js (cp functions/lib/contact.js m/lib/contact.js) или модуль содержит import/export/require"
  FAIL=1
fi
M_LEASE="$(dirname "$HTML")/m/ui/lease.js"
_e96_send="$(awk '/^async function send\(ctx, L\) \{/ {on=1} on {print} on && /^\}/ {on=0}' "$M_LEASE")"
_e96_ok=1
for _fn in normPersonName normCompanyName normPhone normEmail emailLooksValid; do
  printf '%s' "$_e96_send" | grep -qF "$_fn(" || _e96_ok=0
done
grep -qF "'./lib/contact.js'" "$M_APP" || _e96_ok=0
grep -qF "callCF, contact" "$M_APP" || _e96_ok=0
if [ "$_e96_ok" = 1 ]; then
  echo "  ✓ m/ — app.js грузит ./lib/contact.js и отдаёт contact в ctx; lease.js send() нормализует имя/компанию/телефон/email до отправки"
else
  echo "  ✗ m/ — Entry 96: app.js не грузит ./lib/contact.js / ctx без contact, или lease.js send() не зовёт норм-функции"
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
