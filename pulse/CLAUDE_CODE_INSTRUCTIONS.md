# Pulse — Activity & Productivity Center
## Claude Code implementation guide

This document is the source of truth for engineering Pulse from the design prototype into a production system. Read it end-to-end before writing code.

---

## 1. Product overview

Pulse is an **internal employee activity & productivity dashboard** for a multi-location commercial real-estate / leasing company. It serves two distinct audiences:

| Audience | What they see | Why |
|---|---|---|
| **Owner / Admin** | Every employee, every center, every metric, full audit log | Operational visibility, coaching, payroll |
| **Employee** (Agent / Manager / Accountant) | Only their own data, gamified, motivating | Self-improvement, transparency on how bonuses work |

The core insight: **the same activity data feeds two completely different UIs**. Admin gets analytical depth; employees get a personal, motivating, no-comparison-by-default experience.

---

## 2. Tech stack & migration path

### Prototype (current)
- React 18 via UMD + Babel-standalone (in-browser transform)
- Vanilla CSS with custom properties (oklch color space)
- No backend — all data is mocked client-side
- Two entry HTMLs: `Activity Center.html` (sidebar variant) + `Activity Center · Top Nav.html` (top-nav variant)

### Production target
- **Frontend**: Next.js 14 (App Router) + TypeScript + React Server Components where possible
- **Styling**: Keep the vanilla-CSS approach OR migrate to Tailwind. Do not introduce a runtime CSS-in-JS solution. The design tokens (`--accent`, `--success`, `--ink`, etc.) must port directly.
- **Backend**: PostgreSQL (events, users, contracts, calls, emails, bonuses) + Redis for caching aggregated metrics
- **Real-time**: Server-Sent Events or WebSockets for the Live Feed and notification updates
- **Auth**: SSO (Google Workspace / Microsoft Entra) — match what the company already uses for email
- **Background jobs**: nightly metric recalculation, bonus tier calculation, anomaly detection

Do NOT rewrite the UI from scratch. The component composition in the prototype reflects real product decisions. Port file-by-file.

---

## 3. File structure (current prototype)

```
icons.jsx           Original line-art SVG icon set (40+ icons)
data.jsx            Mock users + categories + centers + event seed
components.jsx      Shared UI primitives (Avatar, Trend, KPI, StatusPill, etc.)
forms.jsx           FormDrawer + FilterDrawer + MessageDrawer + QuickActionDrawer + confirmModal
metrics.jsx         Derived metrics + bonus tier computation (computeMetricsFor)
layout.jsx          Sidebar + Topbar + MobileMenu (sidebar variant)
top-nav.jsx         TopNavShell (top-nav variant)
overview.jsx        OverviewPage (Activity Center)
employee-detail.jsx EmployeeDetail with 9 tabs (Performance/Timeline/Audit/Docs/Contracts/Calls/Emails/Logins/Productivity)
compare.jsx         ComparePage (side-by-side 2-4 employees)
bonuses.jsx         BonusesPage (leaderboard + tier breakdown + history)
bonus-rules.jsx     BonusRulesPage (admin configures rules)
earn-page.jsx       EarnPage (employee read-only view of rules)
centers.jsx         CentersPage (table-first + cards + cross-center people)
tree.jsx            GrowthTree SVG component
my-day.jsx          MyDayPage (employee personal dashboard)
my-journey.jsx      MyJourneyPage (employee long-term history)
audit.jsx           Audit log (every micro-action, AuditLogTab)
calendar.jsx        Google Calendar integration widgets
drawer.jsx          EventDrawer (right-side activity detail)
other-views.jsx     PeoplePage + AlertsPage
enhancements.jsx    CommandPalette + NotificationPanel + KudosDrawer + openScoreExplainer
tweaks-panel.jsx    Tweaks panel scaffold (host protocol)
app.jsx             Sidebar-variant App root
app-topnav.jsx      Top-nav-variant App root
styles.css          All styles (design tokens + layout + components)
```

**Each file is single-purpose.** When porting to Next.js, mirror this: one route per page-level component, components.jsx → `components/` directory of feature-split files, metrics.jsx → server-side metric computation.

---

## 4. Data model

### Users
```ts
{
  id: string,             // u1, u2, ...
  first: string, last: string, name: string, initials: string,
  role: "agent" | "manager" | "accountant" | "admin",
  centerId: string,       // c1, c2, c3, c4
  status: "online" | "idle" | "offline",
  online: number,         // active minutes today
  login: string | null,   // "8:42 AM" — first login timestamp today
  logout: string | null,
  ip: string, device: string, loc: string,
  // daily counters
  actions: number, calls: number, emails: number,
  contracts: number, docs: number,
  // score
  score: number,          // 0-100, recomputed nightly
  prev: number,           // score from previous 30d period
  unusual?: boolean,      // flagged by anomaly detection
  away?: string,          // "PTO" / "Sick leave" / etc.
}
```

### Centers
```ts
{
  id: string, name: string, short: string,    // "DT", "WS", "CP", "RS"
  address: string, properties: number,
  color: string,                              // oklch — visible everywhere
}
```

### Events (the heart of the system)
Every action a user takes generates an event. The audit log shows raw events; the timeline / tabs filter & enrich them.

```ts
{
  id: string,                                 // EV-10001+
  userId: string,
  timestamp: string,                          // ISO 8601, server-issued
  category: "login" | "logout" | "document" | "contract" | "email" | "call" |
            "lead" | "tenant" | "invoice" | "task" | "system" | "security",
  type: string,                               // "sent", "opened", "signed", "missed", etc.
  description: string,                        // plain-English summary
  entity?: {                                  // related object
    kind: "doc" | "contract" | "email" | "call" | "tenant" | "lead" | "invoice" | "task",
    id: string, name: string,
    durationSeconds?: number,
    size?: string,
  },
  status: "ok" | "pending" | "warn" | "failed",
  source: "web" | "mobile" | "phone" | "email" | "docusign" | "crm",
  metadata: {
    ip: string, device: string, sessionId: string,
    before?: any, after?: any,                // for edits — diffable
    importance: "normal" | "high",
    isUnusual: boolean,
  }
}
```

### Detailed audit micro-events (per-user, per-day high-resolution)
Stored in a separate table for performance — `audit_micro_events`. Every page view, every field copy, every search, every scroll-to-bottom, every keyboard shortcut. Retention: 90 days. After that, aggregate and drop raw.

```ts
{
  id: string,                                 // AUD-90000+
  userId: string,
  timestamp: string,                          // second-resolution
  kind: "login" | "nav" | "view" | "open" | "copy" | "paste" | "search" |
        "click" | "scroll" | "hover" | "type" | "send" | "call" | "email" |
        "doc" | "contract" | "upload" | "download" | "edit" | "save" |
        "create" | "delete" | "idle" | "active" | "shortcut" | "print" | "tab",
  action: string,                             // "Copied phone number"
  entity?: string,                            // human-readable target name
  value?: string,                             // copied text, search query, etc.
  // PRIVACY: never store full keystrokes — only summary like "typed 24 chars in subject"
  page?: string,
  before?: string, after?: string,            // edit diff
  durationSeconds?: number,
}
```

### Calls, Emails, Contracts, Documents
Each is its own table with `userId`, timestamps, and rich metadata. The Pulse UI joins these to the event stream.

### Bonus rules
```ts
{
  id: string,
  category: "action" | "streak" | "team" | "wellness",
  name: string, shortDescription: string, fullDescription: string,
  amount: number,                             // cents (avoid floats)
  eligibleRoles: string[],                    // ["agent", "manager"]
  trigger: {
    kind: "event_match" | "metric_threshold" | "streak" | "team_aggregate",
    rule: object,                             // discriminated by kind
  },
  cap: { kind: "per_month" | "per_quarter" | "per_year", value: number } | null,
  active: boolean,
  createdAt: string, updatedAt: string, updatedBy: string,
}
```

---

## 5. Role-based access — STRICT

**Failure to enforce these is a P0 bug.**

### `owner` / `admin`
- Read every employee's profile, audit log, calls, emails, contracts
- Read every center's aggregate data
- See full IP address, device fingerprint, session ID in audit details
- Configure bonus rules (BonusRulesPage)
- Send messages, kudos to any employee
- Export data
- Switch between any employee from the people grid, leaderboards, and search

### `manager`
- Read their own profile + audit + history (MyDay, MyJourney, EarnPage)
- **Cannot** view another employee's profile
- **Cannot** see the team leaderboards with names — only aggregate "you're top 12%" framing
- **Cannot** configure bonus rules (read-only view via EarnPage)
- Can send kudos but only via the dedicated kudos flow (no general messaging)

### `agent` / `accountant`
- Same as `manager` — only personal data
- Audit log on their own profile **hidden** from them (only admins see audit detail)

### Implementation requirements

1. **Router guard.** Every admin route MUST check `currentUser.role === 'owner'`. On failure, redirect to `/my-day` and show a toast: `"You don't have permission to view this page."`

2. **Server-side enforcement.** Never trust the client. Every API endpoint that returns another employee's data must verify the caller's role server-side. Return `403` on mismatch. Log unauthorized attempts.

3. **Audit log access tier.** Detailed audit (per-second micro-events with IP/device) is `owner` only. Even managers cannot see peers' audit logs.

4. **Component-level guard.** Person cards, leaderboard rows, and live feed items must only be clickable for owners. For non-owners, render the same visual but as a non-interactive div. Do NOT just hide the link — the data shouldn't reach the client.

5. **My Day = current user.** The MyDayPage and MyJourneyPage components must always render data for the authenticated user. Never accept a `userId` query parameter for these pages.

6. **Role switcher.** The role switcher in the top bar exists for demo/staging only. **Disable it in production** unless the user has a special `dev` flag.

### Tests that MUST pass
```ts
test("agent navigating to /people redirects to /my-day", ...);
test("manager calling GET /api/users/u3/events returns 403", ...);
test("manager calling GET /api/users/u3/audit returns 403", ...);
test("owner can switch employees freely", ...);
test("agent's audit log is not in client bundle", ...);
test("role switcher is hidden in production builds", ...);
```

---

## 6. Routing

| Path | Component | Roles |
|---|---|---|
| `/overview` | OverviewPage | owner |
| `/people` | PeoplePage | owner |
| `/centers` | CentersPage | owner |
| `/compare` | ComparePage | owner |
| `/bonuses` | BonusesPage | owner |
| `/bonus-rules` | BonusRulesPage | owner |
| `/alerts` | AlertsPage | owner |
| `/people/:userId` | EmployeeDetail | owner |
| `/my-day` | MyDayPage | all |
| `/my-journey` | MyJourneyPage | all |
| `/earn` | EarnPage | all |

Default landing page after login:
- `owner` → `/overview`
- everyone else → `/my-day`

---

## 7. Page-by-page implementation notes

### OverviewPage (Activity Center)
The main owner dashboard. Sections in order:

1. **Page header** with date-range segment (Today / Yesterday / 7d / 30d / Custom), Filters button, Export button.
2. **Today-at-a-glance hero**: a card with 6 status pills (Crushing it / On track / Behind pace / Slow start / Needs attention / Off today). Each shows a count. Below: 6 summary stats (Actions, Calls, Emails, Contracts, Avg pickup, Bonus pool MTD).
3. **Leaderboard card** with 5 sortable tabs (Productivity / Most calls / Most emails / Contracts / Fastest reply). Top 5 employees with 🥇🥈🥉 medals.
4. **Two-column main**: left = people grid with PersonCardV2 (status pill, hours worked / target, bonus row, 4 target meters, mini stats), right = live activity feed (real-time event stream).
5. **Bonus pool widget** in the right column.

### EmployeeDetail
Header strip with avatar, name, role, status, tier badge, center chip, action buttons (Kudos, Compare, Export, Message). Below: 3 large stat blocks (Working today, Targets hit, Bonus this month). Then the row of 8 small stats. Tabs:

- **Performance** — AI insights summary (3-5 auto-generated bullets for 1:1 prep), plain-English status, target meters grid, large bonus card, MTD targets, responsiveness rows, strengths/areas to improve
- **Timeline** — vertical event track grouped by Morning/Midday/Afternoon/Evening
- **Full audit log** — every micro-event for the day, grouped by 5-min windows, with category filter chips
- **Documents / Contracts / Calls / Emails** — table views with stat banner above
- **Login history** — last 7 days with visual day-bars (active/idle/away segments)
- **Productivity** — charts + you-vs-team comparison

### MyDayPage (Employee personal)
This is the most thoughtfully designed page. Sections:

1. **Wellness banner** (only if `online > 9h`) — yellow card recommending wrap-up
2. **Hero**: avatar + greeting + status pill + 🔥 streak chip + center chip + actions (Quick log, My Journey, Plan today)
3. **One Big Thing + Coach's note** (2-column)
4. **Today's schedule + Calendar widget** (2-column) — schedule strip pulls real Google Calendar events; calendar widget on right shows upcoming meetings with "Block focus" + "Open Google Calendar" (new tab)
5. **Growth Tree + Level/Bonus** (2-column)
   - Tree SVG with sky/sun/hills/trunk/canopy/fruits/decorations
   - Fruit types map to bonus rules (apple=contract, plum=renewal, star=review, lemon=referral, golden=multi-year, gem=NPS)
   - Decorations: 👑 crown (Gold tier), 🐦 bird (top reply speed), 🏮 lanterns (streak)
   - Attention signals: fallen brown leaves (missed calls), closed buds (unanswered SMS), wilted leaves (stale leads)
   - **Clickable legend** — each row opens an inline detail panel with description + tip + count
6. **Today's quests** — 3-5 specific actionable cards with XP rewards
7. **Records + Achievements** (2-column)
8. **This week vs last week** — 4 metric cards with mini bar comparisons
9. **Friendly peer leaderboard** — you + 2 above + 2 below in your center only

### MyJourneyPage (Employee history)
Long-term motivating view based on 10 motivation books (Atomic Habits, Drive, Reality is Broken, Mindset, Flow, Influence, Peak, Power of Habit, Grit, Hooked). Sections:

1. Identity card with mood check-in (4 emoji pills)
2. Goal stack (Year → Quarter → Month → Today) with progress bars
3. Year heatmap (52w × 7d GitHub-style)
4. Monthly metric charts (4 metrics × 12 months)
5. Mastery skill tree (5 skills with level bars)
6. Last 12 weeks table
7. Records & achievements timeline
8. Social proof + Mystery reward + Manager's note (3-column)
9. Reflection journal

### EarnPage (Employee bonus rules read-only)
- Hero: "$X earned this month" with tier breakdown
- "3 easiest wins for you right now" green card
- Sort toolbar
- All bonus rules grouped by category with EarnRuleCard:
  - Title + $ amount + tip badge (Easy / Medium / High value / Team)
  - "You earned: N× · $XX this month"
  - How-to description
  - Next-step suggestion in accent box
  - CTA button

### CentersPage
Tab toggle: Compare table (DEFAULT) / Cards / People.
- **Compare table**: side-by-side metrics, best-in-row highlighted
- **Cards**: 4 centers, each with sparkline + MVP + team avatars + headline stats
- **People**: every employee across centers in one sortable table, plus grouped-by-center sections below

### BonusRulesPage (admin only)
4 sections (Per-action / Streak / Team / Wellness), each containing rule cards.
Each rule card: icon, name, $ amount, eligibility, monthly trigger count, monthly cost, toggle, edit pencil, expandable description.
Edit modal lets owner change amount, eligibility, description, see forecast.
Bottom: industry benchmark + 5 design principles.

### BonusesPage (admin only)
Two implicit modes:
- **Leaderboard** view (default) — ranked list of who's earning what, with tier badges and progress to next tier
- **History** — monthly bonus pool over time

---

## 8. Bonus computation

### Per-action rules (event-triggered)
A nightly job (or real-time, if scaled) listens for events that match a rule's trigger and credits the bonus to the right user.

```ts
function processEvent(event, rules) {
  for (const rule of rules.filter(r => r.active)) {
    if (rule.trigger.kind !== "event_match") continue;
    if (matchesEvent(rule.trigger.rule, event)) {
      const cap = rule.cap;
      if (cap && countTriggersForUser(rule.id, event.userId, cap) >= cap.value) {
        log("cap_hit", rule.id, event.userId);
        continue;
      }
      createBonusCredit({
        userId: event.userId,
        ruleId: rule.id,
        amount: rule.amount,
        sourceEventId: event.id,
        accruedAt: event.timestamp,
      });
    }
  }
}
```

### Monthly tier
Composite score from MTD progress vs target across:
- Calls / monthly call target
- Emails / monthly email target
- Contracts / monthly contract target
- Presence (days worked / days expected)

Weights vary by role:
- Agent: calls 30%, emails 20%, contracts 30%, presence 20%
- Manager: calls 15%, emails 25%, contracts 40%, presence 20%
- Accountant: calls 10%, emails 30%, contracts 0%, presence 60%
- Admin: calls 10%, emails 40%, contracts 0%, presence 50%

Composite ≥ 1.10 → Platinum ($800), ≥ 1.00 → Gold ($500), ≥ 0.85 → Silver ($300), ≥ 0.70 → Bronze ($150).

### Total payout
`monthly_total = tier_amount + sum(per_action_credits) + sum(streak_bonuses) + team_bonuses + wellness_bonuses`

### Caps & anti-gaming
- FB / Google review bonuses: max 4 per agent per month each
- NPS bonus: max 1 per tenant per quarter
- All caps enforced at credit-time, not display-time

### Payroll export
Owner can export bonus accruals as CSV with columns: `employee, role, center, tier_base, action_breakdown (json), total, payout_date`. Format matches the company's payroll system (QuickBooks / ADP / etc.).

---

## 9. Punctuality, attendance, and the no-penalty rule

**Do NOT auto-deduct bonus for late logins or early logoffs.** Research from Kahneman (loss aversion 2×), Gneezy & Rustichini (Israeli daycare), Pink (Drive), and Marciano (Carrots and Sticks Don't Work) shows fines destroy motivation while increasing the unwanted behaviour.

Instead:
1. **Positive bonus**: "On-time arrival streak — $25/month for 95%+ of days logged in by shift start"
2. **Visibility for the manager**: Login History tab shows the truth. Manager has a private conversation if a pattern emerges.
3. **Separate discipline track**: HR-managed, written warning → PIP → termination. **Not connected to bonus pool.**

**Source of truth for arrival/departure**: workstation login time. Do NOT use camera footage as the primary signal — it's invasive, creates resentment, and breeds presenteeism. Cameras may be used as backup only for dispute resolution.

---

## 10. Audit log requirements

### Privacy

- **Never log full keystrokes.** "Typed 24 chars in subject field" — not the actual text.
- **Never log passwords.** Mask any field marked as password.
- **Hash & truncate sensitive values.** Phone numbers and emails copied to clipboard: log only the action + the *type* of value (e.g. "Copied phone number"), not the actual digits, unless it's needed for tenant attribution.
- **PII redaction.** Audit values shown to the owner should be redacted for non-owner viewers (none should be able to access another user's audit anyway).
- **Right-to-be-forgotten.** When an employee leaves, retain audit for 12 months for compliance, then purge.

### Retention
- High-resolution audit (per-second): 90 days
- Aggregated daily totals: 24 months
- Bonus credit history: 7 years (payroll compliance)

### Anomaly detection
Flag events as `isUnusual` when:
- Login outside the user's typical hours (95% confidence interval)
- Login from a new IP address not previously seen for this user
- Bulk delete operations (>5 records in 60 seconds)
- Contract voiding without manager approval
- More than 3 failed login attempts in 10 minutes

Flagged events surface on the Alerts page and as red-dot notifications.

---

## 11. Integrations

### Google Calendar (and Outlook later)
- OAuth 2.0 connection per user
- Pull events 30 days back, 60 days forward
- Sync every 5 min during work hours, hourly otherwise
- Two-way write for "Block focus time" — create a calendar event in the user's primary calendar
- Always have a fallback if the user is not connected — show the Connect card
- "Open Google Calendar" buttons must `target="_blank"` to a deep link, not embed Google's app inside Pulse (CSP/iframe issues)

### DocuSign (for contracts)
- Webhook on envelope state changes (sent, opened, signed, completed, voided)
- Each webhook creates a contract event with the right user attribution

### Phone system (for calls)
- Webhook on call start, end, missed
- Match the called number against tenant/lead database to enrich

### Email
- IMAP/Microsoft Graph / Gmail API
- Record sent + received emails for the user. Subject + recipient + reply timestamps. **Never store body.**

### Review platforms (Facebook, Google)
- Polling / webhook integration to detect new 5-star reviews
- Match by tenant name → attribute to the responsible agent

---

## 12. UI patterns to preserve

### Design tokens (CSS custom properties)
Use the existing oklch palette. Don't introduce new colors without updating the central palette. Status colors map 1:1 to semantics:
- `--success` = good / target hit
- `--warning` = behind / needs attention
- `--danger` = critical / unusual / over SLA
- `--accent` = neutral primary action
- Category dot colors (login, doc, contract, etc.) — preserve hue assignments

### Status language
Plain English. The four statuses (Crushing it / On track / Behind pace / Slow start / Needs attention / Off today) are user-facing copy. Don't translate them to scores — translate scores to language.

### Loss-aversion sensitivity
When showing comparisons or trends, lead with the positive frame when accurate. "You're in top 12%" not "You're at rank #8 of 12 ahead of you". Negative info goes in dedicated places (Alerts page, attention signals on the tree).

### "Yet" language
In growth-mindset framing: "you haven't hit Gold *yet* — 84% there". Never "you failed to hit Gold".

### Surface ratios
Active rules vs total rules: always show "12/14 active" not just "12 active". Same for headcount, contracts, etc. — give the denominator.

### Avoid these tropes
- Star ratings (we use $ values)
- Emoji-heavy UI (only domain-appropriate emoji: 🥇 for leaderboard ranks, currency icons, the tree fruits)
- Hard-coded gradients without a token
- Generic "You're doing great!" pep-talk copy — always pair with a number

---

## 13. Performance

- Server-aggregated metrics. Don't ship raw event tables to the client. The OverviewPage should load < 500ms with 100+ employees.
- Index audit_micro_events on `(userId, timestamp)`. Partition by month.
- Cache `metricsFor(user, date)` per user per day in Redis with 1-hour TTL.
- The Live Feed shows 12-20 events. Use SSE with backfill on connect.
- The growth tree SVG is ~5KB inline — fine to render server-side.
- Pre-compute month-to-date totals nightly so the My Day hero loads instantly.

---

## 14. Testing

### Unit
- Bonus rule trigger matching: 100% coverage of category × type combinations
- Tier calculation: every score boundary
- Anomaly detection: known-good and known-bad event sequences

### Integration
- E2E test of a full workday for one employee: login → events → MTD updates → bonus accrual → logout
- Role-based access (see Section 5 tests)

### Visual regression
- Snapshot test of MyDayPage at multiple states: streak=0, streak=14, tier=bronze, tier=platinum, missed_calls=0, missed_calls=3
- Snapshot the growth tree at different leaf/fruit combinations

### Performance
- 100-employee, 100k-event load test on OverviewPage → < 500ms p95
- Audit log scroll on a heavy day (500+ events) → 60fps smooth

---

## 15. Deployment

- Two-environment minimum: staging + production. Mirror data anonymized in staging.
- Feature flags for:
  - `role_switcher` (off in prod)
  - `mystery_reward` (on/off per quarter)
  - `wellness_signal_threshold` (tune the 9h cutoff)
  - `bonus_rule_v2` (gradual rollout of rule changes)
- DB migrations versioned. Bonus rule changes require approval from owner + finance.
- Background job monitoring (sentry/datadog) — failed bonus accrual = page on-call

---

## 16. Branching & PR rules

- One feature per branch
- Always run lint + typecheck + tests + build before opening PR
- PR must include screenshots of changed pages (light + dark mode if both supported)
- Do NOT auto-merge. Owner reviews every change to the bonus engine.
- Do NOT auto-deploy on merge. Tag releases and deploy explicitly.

---

## 17. Open product questions (decide with owner before building)

1. **Per-employee bonus rule overrides?** — Should the owner be able to set custom amounts per individual (rare cases like top performer retention)? Currently: no, all rules are global. Pro: simplicity. Con: less flexibility.
2. **Team bonus split when team grows mid-month?** — Pro-rate or all-or-nothing? Currently spec'd as all-or-nothing.
3. **Inactive employees on PTO and bonus tier?** — Should PTO days count as "presence" for tier calc? Currently: yes, paid time counts. (See "Quarterly PTO used" bonus.)
4. **Negative score floor?** — Should very low performers see "0" or the actual negative? Currently: 0 floor, displayed as "—".
5. **What's the audit retention for terminated employees?** — Legal will weigh in. Currently spec'd as 12 months.

Resolve these in writing before shipping.

---

## 18. Out of scope for v1

- Mobile native app (Pulse is mobile-web only for v1)
- Custom report builder (export to CSV is enough)
- AI-generated coaching scripts (the AI Insights card is rule-based, not LLM-generated)
- Anonymous mode for owners (bias reduction) — design it in v2
- Real-time co-presence (seeing who else is viewing what)
- Multi-language UI — English only for v1; design strings to be ICU-MessageFormat compatible

---

## 19. When in doubt

Re-read the prototype. The components encode hundreds of small product decisions. If you change something, ask: *"Why was it built this way in the prototype?"* before deciding it was wrong.

Ship boring, ship correct, ship soon. Pulse exists to help people do better work — not to admire itself.
