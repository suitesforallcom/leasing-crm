# SuitesForAll — handoff message for new chat

> Copy everything between the `=====` markers below and paste it as your **first message** in a new chat. Claude will pick up the project context, read the necessary files, and continue without losing time on rediscovery.
>
> **Last refreshed:** 2026-05-17. Main tip: `865262d`. App file: `floor-map-editor.html` is **~6.43 MB / 132k lines**.

---

```
=====

Я продолжаю работу над SuitesForAll — управление офисными floor plans, single-page HTML app
в `/Users/diskc/Documents/Claude/Projects/Office map/floor-map-editor.html` (~6.43 MB,
~132,000 строк).

Stack: vanilla JS + Firebase (Firestore + Auth + Storage + Functions) + Stripe + DocuSign.
Hosting: https://suitesforall.web.app
Деплой: `firebase deploy --only hosting` (auto после каждого коммита — option A, set 2026-05-03).

ПЕРЕД ЛЮБОЙ РАБОТОЙ прочитай в этом порядке:

1. `/Users/diskc/Documents/Claude/Projects/Office map/CLAUDE.md` — принципы проекта,
   архитектура, non-negotiables. Это override behavior.

2. `/Users/diskc/Documents/Claude/Projects/Office map/FIXES_LOG.md` — canonical regression
   memory. **Mandatory reading** перед любой правкой payment/finance/lease/invoice/balance/
   late-fee/deposit/Stripe/report/floor-map логики. Каждая запись описывает invariant
   который future change не должен сломать. Сейчас в логе entries 1-17 (все active).

3. `/Users/diskc/Documents/Claude/Projects/Office map/PLAN.md` — полный backlog по темам,
   приоритеты, DONE история.

4. SessionStart hook автоматически предупреждает если HEAD отстаёт от feature-веток
   на >50 коммитов. Скрипт `scripts/check-stale-base.sh` зарегистрирован в
   `.claude/settings.json`. Сейчас main подтянут — должен молчать.

5. Pre-deploy guard: `scripts/check-invariants.sh` запускается как hosting.predeploy
   в firebase.json и блокирует деплой если хоть один invariant из FIXES_LOG отсутствует
   в HTML. Не пытайся обходить через --skip-hooks без явного указания оператора.

6. (Опционально) Транскрипты прошлых сессий через `mcp__ccd_session_mgmt__list_sessions`
   → `mcp__ccd_session_mgmt__search_session_transcripts` — для контекста что обсуждалось.

ВАЖНЫЕ ПРАВИЛА (lessons learned):

a) Lease document is single source of truth for rent. u.contractRent всегда
   зеркалит активный rent doc — auto-sync через _leaseDocSyncContractRent.

b) Никогда Object.assign на user-editable fields. Любая migration/seed-merge —
   fill-only by construction. Иначе silent corruption и потеря данных
   (что произошло 2026-04-28, потеряли 1.5 часа работы).

c) `node --check` — это ТОЛЬКО синтаксис. Поведение проверяется в браузере.
   Любую правку, которая трогает loadState / migrations / state shape —
   smoke-test в браузере перед declaring "done".

d) Pre-mutation snapshot перед любой массовой операцией. Engine уже работает,
   wired для 7 операций. Если добавляешь новую массовую операцию — wire туда же:
   `_localBackupCreate('pre-mutation', 'Before <description>')` перед mutation.

e) Local backups в Settings → Data → Local backups. Console API:
   sfaBackup() / sfaListBackups() / sfaRestore("key") / sfaBackupHelp().

f) Используй Read с offset/limit (не весь файл). Используй Grep вместо
   широкого Read. Делегируй verification (parse + grep audits) субагенту
   через `Agent` tool с subagent_type='general-purpose' или 'Explore' —
   экономит контекст главного чата.

g) Большие правки лучше одним Edit (замещение 50-line блока) чем десятью
   мелкими — экономит turn budget.

h) При ~50-70 substantive edits предложи новый чат с обновлённой PLAN.md +
   HANDOFF.md handoff. Не упирайся в context limit.

i) Envelope writer пишет `envelopeId` (НЕ `id`). Все find/some по envelope'ам
   MUST принимать оба ключа: `e.envelopeId || e.id`. См. FIXES_LOG Entry 17.

j) Multi-tab: Web Locks API установлен (FIXES_LOG Entry 16). Active writer =
   leader; остальные вкладки = read-only follower с оранжевым баннером
   «Read-only tab — another SuitesForAll tab is actively editing». Take over
   через `steal: true`.

ПОСЛЕДНИЕ КРУПНЫЕ MERGE / ПОРТЫ (2026-05-17):

- Merge `5ad0661` (cool-faraday → main): +113k/-50k строк, 64 файла.
  Принёс: FIXES_LOG entries 8-17, Web Locks tab-sync, Send-lease CTA, lease
  preview modal, multi-document timeline, signatory-from-settings, error-memory
  protocol, Move-tenant restoration, dedupe topbar pill, tests/overdue.test.js.
- Commit `865262d`: FIXES_LOG status flip — Entry 4 переведён в active.
- Все 7+ feature-веток (autobilling, port-lease-start-gate, consolidate-overdue,
  ...) теперь на main. Локально остаются 3 ветки-дубликата с уник SHA —
  кандидаты на архив.

ПРИОРИТЕТНЫЕ ЗАДАЧИ из PLAN.md (Stage 2/3 finalization):

- Stripe: Send reminder вместо повторной отправки, invoice duplication guard,
  failed payment UI, refund flow.
- Teamviewer role restrictions: скрыть rent/payments/financials от teamviewer.
- DocuSign: multi-signer, counter-signature, decline reason capture, **починить
  prospect.stage='signed' promotion path** — сейчас может промоутить prospect
  БЕЗ записи envelope в `u.leaseEnvelopes` (Suite 20512 — пример).
- Reports: vacancy report, lease expiration calendar, P&L by month, churn.

Что планирую сегодня: [НАПИШИ ЗДЕСЬ ЗАДАЧУ ИЛИ "Открой PLAN.md и предложи
с какого пункта начать в свете моего последнего скриншота"]

=====
```

---

## После того как вставишь и Claude ответит

Если Claude правильно подхватил контекст, его первое сообщение будет включать:
- Подтверждение что прочитал CLAUDE.md, FIXES_LOG.md, PLAN.md
- Краткое резюме что Done и что в очереди
- Вопрос о конкретной задаче на сегодня

Если что-то не сходится — попроси: "Прочитай ещё раз CLAUDE.md + FIXES_LOG.md и проверь что ты понял правила работы".

---

## Если хочешь начать с конкретной правки

Замени строку `Что планирую сегодня: [...]` на что-то конкретное, например:

```
Что планирую сегодня: Заняться Teamviewer role restrictions — нужно скрыть
все финансовые данные от роли teamviewer. Список surfaces которые надо
ограничить лежит в PLAN.md секция B.
```

или

```
Что планирую сегодня: Нашёл баг — [описание + скриншот]. Сначала диагностика,
потом fix.
```
