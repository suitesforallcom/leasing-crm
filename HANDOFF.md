# SuitesForAll — handoff message for new chat

> Copy everything between the `=====` markers below and paste it as your **first message** in a new chat. Claude will pick up the project context, read the necessary files, and continue without losing time on rediscovery.

---

```
=====

Я продолжаю работу над SuitesForAll — управление офисными floor plans, single-page HTML app
в `/Users/diskc/Documents/Claude/Projects/Office map/floor-map-editor.html` (~2.67 MB).

Stack: vanilla JS + Firebase (Firestore + Auth + Storage + Functions) + Stripe + DocuSign.
Hosting: https://suitesforall.web.app
Деплой: `firebase deploy --only hosting`

ПЕРЕД ЛЮБОЙ РАБОТОЙ прочитай в этом порядке:

1. `/Users/diskc/Documents/Claude/Projects/Office map/CLAUDE.md` — принципы проекта,
   архитектура, non-negotiables. Это override behavior.

2. `/Users/diskc/Documents/Claude/Projects/Office map/PLAN.md` — полный backlog по темам,
   приоритеты, что DONE, какие правила (workflow rules) выработаны после инцидентов.

3. Транскрипты прошлых сессий через `mcp__session_info__list_sessions` →
   `mcp__session_info__read_transcript` — нужно прочитать last 100 messages из 3-4
   последних сессий проекта чтобы знать что обсуждалось.

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
   через `Agent` tool с subagent_type='general-purpose' — экономит контекст
   главного чата.

g) Большие правки лучше одним Edit (замещение 50-line блока) чем десятью
   мелкими — экономит turn budget.

h) При ~50-70 substantive edits предложи новый чат с обновлённой PLAN.md +
   HANDOFF.md handoff. Не упирайся в context limit.

ПРИОРИТЕТНЫЕ ЗАДАЧИ из PLAN.md (Stage 2/3 finalization):

- Stripe: Send reminder вместо повторной отправки, invoice duplication guard,
  failed payment UI, refund flow.
- Teamviewer role restrictions: скрыть rent/payments/financials от teamviewer.
- DocuSign: multi-signer, counter-signature, decline reason capture.
- Reports: vacancy report, lease expiration calendar, P&L by month, churn.

Что планирую сегодня: [НАПИШИ ЗДЕСЬ ЗАДАЧУ ИЛИ "Открой PLAN.md и предложи
с какого пункта начать в свете моего последнего скриншота"]

=====
```

---

## После того как вставишь и Claude ответит

Если Claude правильно подхватил контекст, его первое сообщение будет включать:
- Подтверждение что прочитал CLAUDE.md и PLAN.md
- Краткое резюме что Done и что в очереди
- Вопрос о конкретной задаче на сегодня

Если что-то не сходится — попроси: "Прочитай ещё раз CLAUDE.md и проверь что ты понял правила работы".

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
