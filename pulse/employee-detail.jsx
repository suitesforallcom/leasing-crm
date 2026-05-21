/* global React, Icon, DATA, Avatar, CatIcon, StatusDot, Trend, Sparkline, HourBars, DayBar, fmt, parseTime, groupByBucket, metricsFor, StatusPill, TargetMeter, BonusBadge, HelpHint, CenterChip, AuditLogTab */

/* ================================================================
   Employee detail page — header + tab nav + tab body
   ================================================================ */

window.EmployeeDetail = function EmployeeDetail({ employeeId, tab, onTab, onOpenEvent, onBack, onCompareAdd, onMessage, onOpenFilter, onSendKudos, role }) {
  const u = DATA.USERS.find(x => x.id === employeeId);
  if (!u) return <div className="page">Employee not found.</div>;

  /* Events for this user (only Maya has detailed; others have micro events) */
  const events = DATA.ALL_EVENTS.filter(e => e.userId === u.id);
  const calls  = events.filter(e => e.cat === "call");
  const emails = events.filter(e => e.cat === "email");
  const docs   = events.filter(e => e.cat === "document");
  const contracts = events.filter(e => e.cat === "contract");

  /* ----------------------------------------------------------------
     Phase 17 — historical day view.
     Operator can scroll Prev / Next or pick a date. Today = live
     metrics from u.*. Past day = read snapshot from u._dailyHistory
     (Phase 15 cron writes one record per email per UTC day, 90-day
     retention). If a past day has no snapshot — all counters show 0.
     May-bonus / month-to-date cards stay MTD regardless of selected
     day; only «today»-scoped tiles + status pills shift.
     ---------------------------------------------------------------- */
  const todayStr = _localDateStr(new Date());
  const [selectedDate, setSelectedDate] = React.useState(todayStr);
  const isToday = selectedDate === todayStr;
  const snapshot = isToday
    ? null
    : (Array.isArray(u._dailyHistory) ? u._dailyHistory : []).find(s => s.date === selectedDate);

  // displayUser — патч живого u полями из снапшота, чтобы metricsFor
  // и все «сегодня»-плитки автоматически отражали выбранный день.
  // Идентичность (id/name/email/role/avatar) не трогаем.
  const displayUser = isToday
    ? u
    : {
        ...u,
        online: snapshot ? Math.round((snapshot.hoursWorked || 0) * 60) : 0,
        actions: snapshot ? ((snapshot.sentEmails || 0) + (snapshot.contracts || 0)) : 0,
        calls: 0, // not tracked in daily snapshot until telephony lands
        emails: snapshot ? (snapshot.sentEmails || 0) : 0,
        contracts: snapshot ? (snapshot.contracts || 0) : 0,
        score: snapshot ? (snapshot.score || 0) : 0,
        // Прошедший день — оператор уже офлайн с этого дня.
        status: "offline",
      };

  const m = metricsFor(displayUser);
  const tabs = [
    { id: "performance",  label: "Performance",   icon: "star" },
    { id: "timeline",     label: "Timeline",      icon: "activity", count: events.length },
    { id: "audit",        label: "Full audit log",icon: "signal",   count: u.id === "u1" ? 80 : null },
    { id: "documents",    label: "Documents",     icon: "doc",      count: docs.length },
    { id: "contracts",    label: "Contracts",     icon: "contract", count: contracts.length },
    { id: "calls",        label: "Calls",         icon: "phone",    count: u._aircallConnected && Array.isArray(u._callActivity) ? u._callActivity.length : calls.length },
    { id: "emails",       label: "Emails",        icon: "mail",     count: emails.length },
    { id: "logins",       label: "Login history", icon: "login" },
    { id: "productivity", label: "Productivity",  icon: "trendUp" },
  ];

  return (
    <div className="page">
      {/* Header */}
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn is-ghost is-small" onClick={onBack}>
          <Icon name="chevL" /> All people
        </button>
      </div>

      <div className="card" style={{ padding: 22, marginBottom: 22 }}>
        <div className="emp-head">
          <div className="row" style={{ gap: 16, flex: 1, minWidth: 0 }}>
            <Avatar user={u} size="xl" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-.02em" }}>{u.name}</h1>
                <span className="chip">{DATA.ROLES[u.role].label}</span>
                <span className={"chip is-" + (u.status === "online" ? "success" : u.status === "idle" ? "warning" : "")}>
                  <span className="dot" style={{ background: u.status === "online" ? "var(--success)" : u.status === "idle" ? "var(--warning)" : "var(--muted-2)" }} />
                  {u.status === "online"
                    ? "Online now"
                    : u.status === "idle"
                      ? "Idle " + (u._idleMinutes != null ? u._idleMinutes + "m" : "")
                      : (u._isReal && u.logout ? "Last seen " + u.logout : "Offline")}
                </span>
                {u._isReal && (
                  <HelpHint>
                    Presence derived from the last REAL user input (mouse / keyboard / touch / scroll / tab focus). Sitting AFK with a tab open does NOT keep the status «Online». &lt;2 min since last input = Online; &lt;15 min = Idle (exact minutes shown); else Offline (last-seen time shown). If no session was ever recorded — Offline.
                  </HelpHint>
                )}
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <StatusPill status={m.status} size="lg" />
                  <HelpHint>
                    Today's status, derived from how many of the five daily targets are hit: 5/5 = Crushing it, 3+ = On track, 2 = Behind pace, 1 = Slow start, 0 = Needs attention. «Offline» appears if the operator hasn't been active today.
                  </HelpHint>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <BonusBadge tier={m.tier} amount={m.bonusMtd} />
                  <HelpHint>
                    Bonus tier reached this month. None → Bronze ($150) → Silver ($350) → Gold ($650) → Platinum ($1000). Tier is unlocked when the operator's MTD contracts + emails + calls cross role-specific thresholds. Resets on the 1st of each month.
                  </HelpHint>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <CenterChip center={u.center} />
                  <HelpHint>
                    The center / workspace this employee belongs to. Used for leaderboard grouping and «All centers» filter. For real employees this reflects the workspace they signed into; demo seeds are assigned to demo centers.
                  </HelpHint>
                </span>
              </div>
              <div className="muted" style={{ marginTop: 4, fontSize: 13, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <span><Icon name="mail" style={{ width: 12, height: 12, verticalAlign: "-2px", marginRight: 4 }} />{u.email || (u.first.toLowerCase() + "." + u.last.toLowerCase().replace(/[^a-z]/g, "") + "@crestview.co")}</span>
                {/* Phase 18 rev — Aircall phone number(s) для оператора.
                    Format: «+1 984 261 1316 (Ann Noel Number)». Tony asked. */}
                {Array.isArray(u.phoneNumbers) && u.phoneNumbers.length > 0 && u.phoneNumbers.map((pn, i) => (
                  <span key={pn.id || i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Icon name="phone" style={{ width: 12, height: 12, verticalAlign: "-2px" }} />
                    <span style={{ fontWeight: 600, color: "var(--ink)" }}>{pn.digits || "—"}</span>
                    {pn.name && <span style={{ color: "var(--muted)" }}>({pn.name})</span>}
                  </span>
                ))}
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Icon name="ipin" style={{ width: 12, height: 12, verticalAlign: "-2px" }} />
                  {u.loc}
                  {u._isReal && <HelpHint>Location (Office / Remote / On-site). Not tracked yet — needs geo/IP-based detection or explicit user toggle. Shows «— not tracked —» until wired up.</HelpHint>}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Icon name="laptop" style={{ width: 12, height: 12, verticalAlign: "-2px" }} />
                  {u.device}
                  {u._isReal && <HelpHint>Device parsed from the User-Agent string captured on sign-in (e.g. «Mac · Chrome», «Windows · Edge»). Stored in the per-user session document and refreshed every 60 sec while the tab is alive.</HelpHint>}
                </span>
              </div>
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => onSendKudos && onSendKudos(u)}><Icon name="star" /> Kudos</button>
            <button className="btn" onClick={() => onCompareAdd(u.id)}><Icon name="compare" /> Compare</button>
            <button className="btn" onClick={() => window.toast("Employee report exported as PDF", "success")}><Icon name="download" /> Export</button>
            <button className="btn is-primary" onClick={() => onMessage && onMessage(u)}><Icon name="mail" /> Message</button>
          </div>
        </div>

        {/* Phase 17 — day navigator. ← / date picker / → / Jump-to-today.
            All «today»-scoped tiles below switch to the selected day's
            snapshot when not today. MTD cards (May bonus) stay current.  */}
        <DateNavigator value={selectedDate} onChange={setSelectedDate} todayStr={todayStr} hasSnapshot={!!snapshot} isToday={isToday} isRealUser={!!u._isReal} />

        {/* Phase 17 rev — упрощённая 3-колонная шапка. Hours/progress
            убраны: те же данные уже в Stat strip (FIRST LOGIN +
            LAST ACTIVITY). Слева у Activity-by-hour теперь два
            подзаголовка: «Started HH:MM» / «Last seen HH:MM». */}
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr", gap: 12 }} className="head-row-2">
          <WorkingTodayCard
            user={u}
            displayUser={displayUser}
            metrics={m}
            isToday={isToday}
            selectedDate={selectedDate}
            snapshot={snapshot}
          />

          <div style={{ padding: 12, background: "var(--surface-2)", borderRadius: 12 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <Icon name="signal" style={{ color: "var(--muted)", width: 14, height: 14 }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>{isToday ? "Targets hit" : "Targets"}</span>
              <HelpHint>
                Five daily targets, all role-tuned: Calls (target by role), Emails (sent vs role target), Hours (8h default), Reply time (SLA, default 60min), Pickup speed (telephony — MOCK until wired). Each one is hit or missed; the count «N / 5» drives the daily status pill (5/5 = Crushing it, 3+ = On track, 2 = Behind pace).
              </HelpHint>
              <div className="spacer" />
            </div>
            <div className="row" style={{ alignItems: "baseline", gap: 6 }}>
              <div className="num" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.025em" }}>{m.hits}<span className="muted" style={{ fontSize: 13, fontWeight: 600 }}>/{m.expected}</span></div>
              {isToday && <Trend now={m.hits} prev={Math.max(0, m.hits - 1)} suffix="" />}
            </div>
            <div className="row" style={{ gap: 3, marginTop: 6 }}>
              {[m.today.calls, m.today.emails, m.today.hours, m.today.reply, m.today.pickup].map((mm, i) => (
                <span key={i} title={mm.label} style={{ flex: 1, height: 6, borderRadius: 3, background: mm.tone === "success" ? "var(--success)" : mm.tone === "warning" ? "var(--warning)" : mm.tone === "danger" ? "var(--danger)" : "var(--surface-3)" }} />
              ))}
            </div>
            <div className="muted" style={{ fontSize: 10.5, marginTop: 5 }}>Calls · Emails · Hrs · Rply · Pkup</div>
          </div>

          <div style={{ padding: 12, background: m.tier.id !== "none" ? `linear-gradient(135deg, ${m.tier.color}10, ${m.tier.color}24)` : "var(--surface-2)", borderRadius: 12, border: m.tier.id === "gold" || m.tier.id === "platinum" ? `1px solid ${m.tier.color}55` : "1px solid transparent" }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <Icon name="star" style={{ color: m.tier.id !== "none" ? m.tier.color : "var(--muted)", width: 14, height: 14 }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>May · {m.tier.label}</span>
              <HelpHint>
                Month-to-date bonus based on monthly tier progression. Tiers: Bronze ($150), Silver ($350), Gold ($650), Platinum ($1000). Tier reached when the operator hits the role-specific monthly threshold for contracts + emails + calls. Always reflects the CURRENT month — scrolling the day navigator does not change this number.
              </HelpHint>
              <div className="spacer" />
            </div>
            <div className="num" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.025em", color: m.tier.id !== "none" ? m.tier.color : "var(--muted)" }}>${m.bonusMtd.toLocaleString()}</div>
            {m.nextTier ? (
              <>
                <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>+${m.nextTier.amount - m.tier.amount} → {m.nextTier.label}</div>
                <div style={{ height: 5, background: "var(--surface-3)", borderRadius: 999, marginTop: 5, overflow: "hidden" }}>
                  <span style={{ display: "block", height: "100%", width: Math.round(m.progressToNext * 100) + "%", background: m.nextTier.color, borderRadius: 999 }} />
                </div>
              </>
            ) : <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>Top tier 🎉</div>}
          </div>
        </div>

        {/* Compact stats strip.
            Phase 11d — hint on each tile explains data source + flags mock
            for real users without integration. Operator can hover any «?»
            to understand what the number is and why. */}
        <div className="emp-stats">
          <Stat icon="login"    label="First login"     value={isToday ? (u.login || "—") : "—"}                  sub={isToday ? "on time" : ""}
            hint={u._isReal
              ? "Time of today's first sign-in, captured by session heartbeat. Shows «—» if the user hasn't signed in today yet. Historical days do not store login time."
              : "First login time (demo seed mock data)."} />
          <Stat icon="logout"   label="Last activity"   value={isToday ? (u.status === "online" ? "now" : (u.logout || (u.status === "idle" && u._idleMinutes != null ? u._idleMinutes + "m ago" : "—"))) : "—"} sub={isToday && u.status === "online" ? "active" : (isToday && u.status === "idle" ? "idle" : "")}
            hint={u._isReal
              ? "Last REAL user input (mouse / keyboard / touch / scroll / tab focus). AFK with a tab open does NOT update this. Status: <2 min = online; <15 min = idle (exact minutes shown); else offline (shows last seen time)."
              : "Last activity time (demo mock)."} />
          <Stat icon="zap"      label={isToday ? "Actions today" : "Actions"}   value={displayUser.actions}                       trend={isToday ? <Trend now={displayUser.actions} prev={Math.round(displayUser.actions * .92)} /> : null}
            hint={u._isReal
              ? "Sum of all actions for the selected day: emails sent + contracts + invoices + payments + notes. Calls excluded until telephony is connected. Today — live count; past days — from daily snapshot."
              : "Actions count (demo mock)."} />
          {/* Phase 17 rev — Tony: «Убери с цифры с таргетом». Pure counts.
              Phase 18 — Aircall connected: REAL telephony stats when
              u._aircallConnected; otherwise MOCK pointer remains. */}
          <Stat icon="phone"    label="Calls"           value={displayUser.calls} sub={isToday ? (u._aircallConnected
            ? `pickup ${u.callPickupSec || 0}s · talk avg ${(u.callTalkSec || 0) >= 60 ? Math.round((u.callTalkSec || 0) / 60) + 'm' : (u.callTalkSec || 0) + 's'} · ${u.missedCalls || 0} missed${u.callbacksOwed > 0 ? ' · ⚠ ' + u.callbacksOwed + ' callback' + (u.callbacksOwed > 1 ? 's' : '') + ' owed' : ''}`
            : `pickup ${m.actuals.callPickupSec}s · ${m.actuals.missedCalls} missed`) : ""}
            hint={u._isReal
              ? (u._aircallConnected
                  ? "Calls made today. REAL data from Aircall API (polled every 5 min). Sub-line shows: average answer-time (pickup) + average talk time + missed-inbound count + callbacks owed (missed inbound without follow-up call within 7 days). Click row in Calls tab to play recording."
                  : "Calls made today. MOCK — Aircall integration not connected yet (no calls in state.callActivity for this email). Will go live as soon as the pullAircallStats CF starts seeing this operator's calls.")
              : "Calls (demo mock)."} />
          <Stat icon="mail"     label="Emails sent"     value={displayUser.emails} sub={isToday && displayUser.emails > 0 ? `avg reply ${m.actuals.emailReplyMin}m` : ""}
            hint={u._isReal
              ? "Emails sent + replies on the selected day. Counted from Gmail API SENT events + manual outreach records with type=email/lease. INCOMING (received) emails are NOT counted — only outbound activity is the operator's work. Today value updates live; past days come from the daily snapshot."
              : "Emails sent (demo mock)."} />
          {/* Phase 17 rev — Tony: «здесь мне нужно писать только
              контракты подписаны за этот месяц не нужно писать цель».
              Показываем contractsSignedMtd (envelopes со status=completed
              этого месяца по completedAt). Всегда MTD (не today). */}
          <Stat icon="contract" label="Contracts signed · MTD" value={u.contractsSignedMtd || 0} sub=""
            hint={u._isReal
              ? "Lease envelopes signed (status=completed) this month. Based on env.completedAt — envelope counts as «signed this month» if its completion timestamp falls in the current calendar month, regardless of when it was sent. Pre-DocuSign-integration envelopes that lack completedAt fall back to sentAt as a proxy."
              : "Contracts signed (demo mock)."} />
          {/* Phase 17 — Tours columns. Источник: HubSpot CRM (meetings +
              deal stages). Интеграция ещё не подключена; для real users
              сейчас 0/0; для демо-сидов — синтетические числа. */}
          <Stat icon="people"   label="Tours scheduled" value={u.toursScheduled != null ? u.toursScheduled : 0} sub={u._toursMock ? "pending HubSpot" : ""}
            hint={u._isReal
              ? "Tours scheduled this month — count of tour bookings linked to this employee in HubSpot CRM. PENDING — HubSpot integration not connected yet. Will pull from hubspotMeetingsByEmail once the API is wired up (meetings with type=tour and contact owner = this employee)."
              : "Tours scheduled this month (demo mock — placeholder for HubSpot data)."} />
          <Stat icon="check"    label="Tours done"      value={u.toursCompleted != null ? u.toursCompleted : 0} sub={u._toursMock ? "pending HubSpot" : ""}
            hint={u._isReal
              ? "Tours completed this month — count of tour bookings that moved to a «completed» / «toured» deal stage in HubSpot CRM. PENDING — HubSpot integration not connected yet."
              : "Tours completed this month (demo mock — placeholder for HubSpot data)."} />
          <Stat icon="star"     label="Productivity"    value={displayUser.score === 0 ? "—" : displayUser.score}   trend={isToday && displayUser.score > 0 ? <Trend now={displayUser.score} prev={u.prev} suffix=" / 30d" /> : null} onClick={isToday && displayUser.score > 0 ? () => window.openScoreExplainer(u) : null}
            hint={u._isReal
              ? "Composite score 0-100. Formula: contracts × 30% + emails × 25% + calls × 20% + invoices × 15% + notes × 10%, each component capped at 100% of role target. Click for breakdown."
              : "Score (demo mock from data.jsx)."} />
          <Stat icon="signal"   label="Status"          value={m.status.label}                 sub={""}
            hint="Daily status derived from the selected day's target hit rate (calls / emails / hours / reply / pickup). 5/5 = Crushing it, 3+ = On track, 2 = Behind pace, else Slow start / Needs attention. Offline if no activity that day." />
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map(t => (
          <button key={t.id} className={"tab" + (tab === t.id ? " is-active" : "")} onClick={() => onTab(t.id)}>
            <Icon name={t.icon} />
            {t.label}
            {t.count != null && <span className="count">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Tab body */}
      {tab === "performance" && <PerformanceTab user={u} metrics={m} />}
      {tab === "timeline" && <TimelineTab events={events} user={u} onOpenEvent={onOpenEvent} />}
      {tab === "audit" && <AuditLogTab user={u} onOpenEvent={onOpenEvent} />}
      {tab === "documents" && <DocumentsTab events={docs} onOpenEvent={onOpenEvent} />}
      {tab === "contracts" && <ContractsTab events={contracts} onOpenEvent={onOpenEvent} />}
      {tab === "calls" && <CallsTab events={calls} user={u} onOpenEvent={onOpenEvent} metrics={m} />}
      {tab === "emails" && <EmailsTab events={emails} user={u} onOpenEvent={onOpenEvent} metrics={m} />}
      {tab === "logins" && <LoginsTab user={u} />}
      {tab === "productivity" && <ProductivityTab user={u} />}

      <style>{`
        .emp-head { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
        .emp-stats {
          display: grid;
          grid-template-columns: repeat(10, 1fr);
          gap: 12px;
          margin-top: 20px;
          padding-top: 20px;
          border-top: 1px dashed var(--border);
        }
        @media (max-width: 1450px) { .emp-stats { grid-template-columns: repeat(5, 1fr); } }
        @media (max-width: 1200px) { .head-row-2 { grid-template-columns: 1fr 1fr !important; } }
        @media (max-width: 1100px) { .emp-stats { grid-template-columns: repeat(5, 1fr); } .head-row-2 { grid-template-columns: 1fr !important; } }
        @media (max-width: 800px)  { .emp-stats { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 540px)  { .emp-stats { grid-template-columns: repeat(2, 1fr); } }
      `}</style>
    </div>
  );
};

function Stat({ icon, label, value, sub, trend, onClick, hint }) {
  return (
    <div style={{ cursor: onClick ? "pointer" : "default" }} onClick={onClick}>
      <div className="kpi-head" style={{ marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
        <Icon name={icon} />
        <span>{label}</span>
        {hint && <HelpHint>{hint}</HelpHint>}
        {onClick && <Icon name="search" style={{ width: 10, height: 10, color: "var(--muted-2)" }} />}
      </div>
      <div className="num" style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-.01em", textDecoration: onClick ? "underline dotted var(--muted-2)" : "none" }}>{value}</div>
      {(sub || trend) && (
        <div className="kpi-foot" style={{ marginTop: 1 }}>
          {trend}{sub && <span>{sub}</span>}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Timeline tab — grouped by time bucket, vertical track
   ================================================================ */
function TimelineTab({ events, user, onOpenEvent }) {
  const [cats, setCats] = React.useState(new Set());
  const [query, setQuery] = React.useState("");

  const allCats = [...new Set(events.map(e => e.cat))];

  const filtered = events.filter(e => {
    if (cats.size > 0 && !cats.has(e.cat)) return false;
    if (query) {
      const q = query.toLowerCase();
      if (!e.desc.toLowerCase().includes(q) && !(e.ent && e.ent.name.toLowerCase().includes(q))) return false;
    }
    return true;
  });

  // Phase 12+ — newest first within each bucket + reverse bucket order
  // (Evening on top if any, Morning at bottom) so the operator sees the
  // most recent activity without scrolling.
  const buckets = groupByBucket([...filtered].sort((a, b) => parseTime(b.time) - parseTime(a.time))).reverse();

  function toggleCat(c) {
    const n = new Set(cats);
    n.has(c) ? n.delete(c) : n.add(c);
    setCats(n);
  }

  if (events.length === 0) {
    return <div className="card"><Empty icon="activity" title="No activity yet">When {user.first} starts working, events will stream in here in real time.</Empty></div>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 18 }} className="tl-grid">
      <div>
        {/* filters */}
        <div className="filters">
          <div className="search" style={{ minWidth: 240, padding: "6px 10px", background: "var(--surface)" }}>
            <Icon name="search" />
            <input placeholder="Search timeline…" value={query} onChange={e => setQuery(e.target.value)} />
          </div>
          {allCats.map(c => (
            <button
              key={c}
              className={"chip" + (cats.has(c) ? " is-accent" : "")}
              onClick={() => toggleCat(c)}
              style={{ cursor: "pointer" }}
            >
              <span className="dot" style={{ background: DATA.CATEGORIES[c].color }} />
              {DATA.CATEGORIES[c].label}
            </button>
          ))}
          {cats.size > 0 && (
            <button className="btn is-small is-ghost" onClick={() => setCats(new Set())}>Clear</button>
          )}
        </div>

        {buckets.map(b => (
          <div className="timeline-group" key={b.label}>
            <div className="grp-h">
              <div className="grp-name">{b.label}</div>
              <div className="grp-sub">{b.sub} · {b.list.length} event{b.list.length === 1 ? "" : "s"}</div>
              <div className="grp-line" />
            </div>
            <div className="tl-track">
              {b.list.map(e => (
                <div className="tl-event" key={e.id} onClick={() => onOpenEvent(e)}>
                  <div className="dot-pos">
                    <CatIcon cat={e.cat} size="sm" />
                  </div>
                  <div className="left">
                    <div className="body">
                      <div className="head">
                        <span className="desc">{e.desc}</span>
                        {e.ent && <span className="ent">{e.ent.name}</span>}
                      </div>
                      <div className="meta">
                        {e.before && e.after && (
                          <span className="chip">
                            <span style={{ color: "var(--danger-ink)", textDecoration: "line-through" }}>{e.before}</span>
                            <Icon name="arrowR" style={{ width: 10, height: 10 }} />
                            <span style={{ color: "var(--success-ink)", fontWeight: 600 }}>{e.after}</span>
                          </span>
                        )}
                        {e.ent && e.ent.durationSeconds > 0 && <span><Icon name="clock" style={{ width: 11, height: 11, verticalAlign: "-1px" }} /> {fmt.duration(e.ent.durationSeconds)}</span>}
                        {e.ent && e.ent.size && <span>{e.ent.size}</span>}
                        {e.isUnusual && <span className="chip is-warning"><Icon name="warning" /> unusual</span>}
                        {e.status === "pending" && <span className="chip is-info">pending</span>}
                        {e.source && <span className="muted">via {e.source}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="right">
                    <span className="time">{e.time}</span>
                    <button className="btn is-small">Open</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Right rail: today summary */}
      <div className="col">
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>Today by category</div>
          {Object.entries(events.reduce((acc, e) => { acc[e.cat] = (acc[e.cat] || 0) + 1; return acc; }, {}))
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => (
              <div key={c} className="row" style={{ padding: "6px 0", fontSize: 13 }}>
                <CatIcon cat={c} size="sm" />
                <span style={{ flex: 1 }}>{DATA.CATEGORIES[c].label}</span>
                <span className="num" style={{ fontWeight: 600 }}>{n}</span>
              </div>
            ))}
        </div>

        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>Workday</div>
          <DayBar segs={DATA.dayBarFor(user.id)} />
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            First login <span className="mono" style={{ color: "var(--ink)" }}>{user.login || "—"}</span><br />
            Last activity <span className="mono" style={{ color: "var(--ink)" }}>{user.status === "online" ? "now" : user.logout || "—"}</span><br />
            Active <span className="mono" style={{ color: "var(--ink)" }}>{fmt.hm(user.online)}</span> · idle {fmt.hm(Math.round(user.online * .14))}
          </div>
        </div>

        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>30-day score trend</div>
          <Sparkline values={DATA.trend30(user.id)} color="var(--success)" />
          <div className="kpi-foot" style={{ marginTop: 4 }}>
            <Trend now={user.score} prev={user.prev} /><span>vs. previous 30d</span>
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 980px) {
          .tl-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

function Empty({ icon, title, children }) {
  return (
    <div className="empty">
      <div className="icon-wrap"><Icon name={icon} /></div>
      <h4>{title}</h4>
      <p>{children}</p>
    </div>
  );
}

/* ================================================================
   Documents tab
   ================================================================ */
function DocumentsTab({ events, onOpenEvent }) {
  if (events.length === 0) return <div className="card"><Empty icon="doc" title="No documents touched">Uploads, downloads, and edits will show up here.</Empty></div>;
  return (
    <div className="card is-clean">
      <table className="table">
        <thead>
          <tr>
            <th>Document</th>
            <th>Action</th>
            <th>Related</th>
            <th>Status</th>
            <th>Time</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {events.map(e => (
            <tr key={e.id} className="is-clickable" onClick={() => onOpenEvent(e)}>
              <td>
                <div className="row">
                  <CatIcon cat="document" size="sm" />
                  <div>
                    <div style={{ fontWeight: 600 }}>{e.ent?.name || "Document"}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{e.ent?.id} {e.ent?.size && "· " + e.ent.size}</div>
                  </div>
                </div>
              </td>
              <td><span className="chip">{e.type}</span></td>
              <td className="muted">—</td>
              <td>{e.status === "ok" ? <span className="chip is-success">complete</span> : <span className="chip">{e.status}</span>}</td>
              <td className="mono">{e.time}</td>
              <td><button className="btn is-small">Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ================================================================
   Contracts tab — kanban-ish status board
   ================================================================ */
function ContractsTab({ events, onOpenEvent }) {
  if (events.length === 0) return <div className="card"><Empty icon="contract" title="No contracts touched">Sent, signed, and voided contracts will appear here.</Empty></div>;

  /* Group by contract id, keep the timeline of events per contract */
  const byContract = {};
  events.forEach(e => {
    const id = e.ent?.id || "unknown";
    if (!byContract[id]) byContract[id] = { id, name: e.ent?.name || id, events: [] };
    byContract[id].events.push(e);
  });
  const groups = Object.values(byContract);

  const statusOf = (group) => {
    const types = group.events.map(e => e.type);
    if (types.includes("signed")) return { l: "Signed", t: "success" };
    if (types.includes("completed")) return { l: "Completed", t: "success" };
    if (types.includes("opened")) return { l: "Opened", t: "info" };
    if (types.includes("sent")) return { l: "Out for signature", t: "warning" };
    return { l: "Draft", t: "" };
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      {groups.map(g => {
        const s = statusOf(g);
        return (
          <div className="card" key={g.id} style={{ padding: 0, overflow: "hidden" }}>
            <div className="row" style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
              <CatIcon cat="contract" />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{g.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>Envelope {g.id} · via DocuSign</div>
              </div>
              <span className={"chip is-" + s.t}>{s.l}</span>
              <button className="btn is-small" onClick={(ev) => { ev.stopPropagation(); window.toast(`Opening envelope ${g.id}`); }}>Open envelope</button>
            </div>
            <div style={{ padding: "8px 18px 14px" }}>
              {g.events.map(e => (
                <div className="row" key={e.id} style={{ padding: "6px 0", fontSize: 13 }} onClick={() => onOpenEvent(e)}>
                  <span className="cat-icon sm" style={{ background: DATA.CATEGORIES.contract.color }}>
                    <Icon name={e.type === "signed" ? "docSign" : e.type === "sent" ? "share" : e.type === "opened" ? "eye" : "doc"} />
                  </span>
                  <span style={{ flex: 1 }}><span style={{ fontWeight: 500 }}>{e.desc}</span> <span className="muted">· {e.source}</span></span>
                  <span className="mono muted" style={{ fontSize: 12 }}>{e.time}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ================================================================
   Calls tab — visual stats + list
   ================================================================ */
function CallsTab({ events, user, onOpenEvent, metrics }) {
  const m = metrics;

  // Phase 18 — real Aircall mode if connected. Render from u._callActivity
  // (sorted desc by ts) instead of legacy `events` array.
  if (user._aircallConnected && Array.isArray(user._callActivity) && user._callActivity.length > 0) {
    return <AircallCallsTab user={user} metrics={metrics} />;
  }

  const outgoing = events.filter(e => e.type === "outgoing").length;
  const incoming = events.filter(e => e.type === "incoming").length;
  const missed   = events.filter(e => e.type === "missed").length;
  const totalSec = events.reduce((s, e) => s + (e.ent?.durationSeconds || 0), 0);
  const avgSec   = events.length ? Math.round(totalSec / Math.max(1, events.length - missed)) : 0;
  const expected = m ? m.actuals.callsExpected : null;
  const pickup = m ? m.actuals.callPickupSec : null;
  const pickupOk = m ? m.today.pickup.hit : true;

  return (
    <div>
      {m && (
        <div className="card" style={{ padding: 14, marginBottom: 14, background: m.today.calls.hit && pickupOk && missed === 0 ? "var(--success-soft)" : missed > 1 ? "var(--danger-soft)" : "var(--warning-soft)", borderColor: "transparent" }}>
          <div className="row">
            <Icon name={m.today.calls.hit ? "check" : missed > 1 ? "warning" : "clock"} style={{ color: m.today.calls.hit ? "var(--success-ink)" : missed > 1 ? "var(--danger-ink)" : "var(--warning-ink)" }} />
            <span style={{ fontWeight: 600, fontSize: 13 }}>
              {m.today.calls.hit ? `Made ${events.length} calls today — hit the ${expected}-call target` : `${events.length} calls so far — ${expected - events.length} short of the ${expected}-call target`}
              {missed > 0 && `, ${missed} missed callback${missed > 1 ? "s" : ""} owed`}
              · average pickup {pickup}s
            </span>
          </div>
        </div>
      )}

      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(6, 1fr)", marginBottom: 18 }}>
        <KPILite label="Outgoing" value={outgoing} icon="phoneOut" color="var(--success)" />
        <KPILite label="Incoming" value={incoming} icon="phoneIn"  color="var(--info)" />
        <KPILite label="Missed"   value={missed}   icon="phoneMiss" color={missed > 0 ? "var(--danger)" : "var(--muted-2)"} tone={missed > 1 ? "danger" : null} />
        <KPILite label="Total time" value={fmt.duration(totalSec)} icon="clock" />
        <KPILite label="Avg call" value={fmt.duration(avgSec)} icon="bars" />
        {pickup !== null && <KPILite label="Pickup speed" value={pickup + "s"} icon="signal" color={pickupOk ? "var(--success)" : "var(--warning)"} />}
      </div>

      {events.length === 0 ? (
        <div className="card"><Empty icon="phone" title="No calls today">{user.first} hasn't made or received calls today.</Empty></div>
      ) : (
        <div className="card is-clean">
          <table className="table">
            <thead>
              <tr><th>Direction</th><th>Contact</th><th>Duration</th><th>Outcome</th><th>Time</th><th></th></tr>
            </thead>
            <tbody>
              {events.map(e => {
                const iconName = e.type === "outgoing" ? "phoneOut" : e.type === "incoming" ? "phoneIn" : "phoneMiss";
                const color = e.type === "missed" ? "var(--danger)" : e.type === "outgoing" ? "var(--success)" : "var(--info)";
                return (
                  <tr key={e.id} className="is-clickable" onClick={() => onOpenEvent(e)}>
                    <td>
                      <span className="cat-icon sm" style={{ background: color }}><Icon name={iconName} /></span>
                    </td>
                    <td><div style={{ fontWeight: 600 }}>{e.ent?.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{e.ent?.id}</div></td>
                    <td className="mono">{e.ent?.durationSeconds ? fmt.duration(e.ent.durationSeconds) : "—"}</td>
                    <td>{e.type === "missed" ? <span className="chip is-danger">missed</span> : <span className="chip is-success">completed</span>}</td>
                    <td className="mono">{e.time}</td>
                    <td>
                      {e.type !== "missed" && <button className="btn is-small" onClick={(ev) => { ev.stopPropagation(); window.toast("▶ Playing recording…"); }}><Icon name="play" /> Recording</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Phase 18 — Real Aircall Calls tab. Renders from u._callActivity.
   Shows audio player для записанных, tenant link если подобрался,
   talk time vs pickup time split, tags chip.
   ================================================================ */
function AircallCallsTab({ user, metrics }) {
  const m = metrics;
  const calls = user._callActivity || [];
  const outgoing = calls.filter(c => c.direction === 'outbound').length;
  const incoming = calls.filter(c => c.direction === 'inbound' && c.status !== 'missed').length;
  const missed   = calls.filter(c => c.status === 'missed').length;
  const answeredCalls = calls.filter(c => c.status !== 'missed');
  const totalTalkSec = answeredCalls.reduce((s, c) => s + (c.talkSec || 0), 0);
  const avgTalkSec = answeredCalls.length ? Math.round(totalTalkSec / answeredCalls.length) : 0;
  const pickup = user.callPickupSec || 0;
  const callbacksOwed = user.callbacksOwed || 0;

  return (
    <div>
      {/* Banner */}
      <div className="card" style={{ padding: 14, marginBottom: 14, background: callbacksOwed === 0 && missed <= 1 ? "var(--success-soft)" : "var(--warning-soft)", borderColor: "transparent" }}>
        <div className="row">
          <Icon name={callbacksOwed === 0 ? "check" : "warning"} style={{ color: callbacksOwed === 0 ? "var(--success-ink)" : "var(--warning-ink)" }} />
          <span style={{ fontWeight: 600, fontSize: 13 }}>
            {outgoing} outgoing · {incoming} answered · {missed} missed
            {callbacksOwed > 0 && ` · ${callbacksOwed} callback${callbacksOwed > 1 ? 's' : ''} owed (7-day window)`}
            {avgTalkSec > 0 && ` · avg talk ${fmt.duration(avgTalkSec)}`}
            {pickup > 0 && ` · avg pickup ${pickup}s`}
          </span>
        </div>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(6, 1fr)", marginBottom: 18 }}>
        <KPILite label="Outgoing" value={outgoing} icon="phoneOut" color="var(--success)" />
        <KPILite label="Incoming" value={incoming} icon="phoneIn"  color="var(--info)" />
        <KPILite label="Missed"   value={missed}   icon="phoneMiss" color={missed > 0 ? "var(--danger)" : "var(--muted-2)"} />
        <KPILite label="Talk time avg" value={fmt.duration(avgTalkSec)} icon="clock" />
        <KPILite label="Pickup speed" value={pickup + "s"} icon="signal" color={pickup > 0 && pickup < 30 ? "var(--success)" : "var(--warning)"} />
        <KPILite label="Callbacks owed" value={callbacksOwed} icon="warning" color={callbacksOwed > 0 ? "var(--danger)" : "var(--muted-2)"} tone={callbacksOwed > 0 ? "danger" : null} />
      </div>

      {calls.length === 0 ? (
        <div className="card"><Empty icon="phone" title="No calls yet">No calls in Aircall history yet.</Empty></div>
      ) : (
        <div className="card is-clean">
          <table className="table">
            <thead>
              <tr><th></th><th>Contact</th><th>Duration</th><th>Status</th><th>When</th><th>Recording</th></tr>
            </thead>
            <tbody>
              {calls.slice(0, 100).map(c => (
                <AircallCallRow key={c.aircallId} call={c} />
              ))}
            </tbody>
          </table>
          {calls.length > 100 && (
            <div className="muted" style={{ padding: "10px 16px", fontSize: 11.5, fontStyle: "italic", borderTop: "1px solid var(--border)" }}>
              Showing 100 most recent of {calls.length} calls. CF caps history at 1000 per operator.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AircallCallRow({ call }) {
  const [playing, setPlaying] = React.useState(false);
  const iconName = call.status === 'missed'
    ? 'phoneMiss'
    : call.direction === 'outbound' ? 'phoneOut' : 'phoneIn';
  const color = call.status === 'missed'
    ? 'var(--danger)'
    : call.direction === 'outbound' ? 'var(--success)' : 'var(--info)';
  const d = new Date(call.ts);
  const whenLabel = (function () {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const callDay = new Date(d); callDay.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((today.getTime() - callDay.getTime()) / 86400000);
    const hh = String(d.getHours() % 12 || 12).padStart(1, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
    const time = `${hh}:${mm} ${ampm}`;
    if (diffDays === 0) return time;
    if (diffDays === 1) return `Yesterday ${time}`;
    if (diffDays < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + time;
  })();
  const counterparty = call.direction === 'outbound' ? call.toNumber : call.fromNumber;

  return (
    <tr>
      <td>
        <span className="cat-icon sm" style={{ background: color }}><Icon name={iconName} /></span>
      </td>
      <td>
        {call.tenantMatch ? (
          <>
            <div style={{ fontWeight: 600 }}>Suite {call.tenantMatch.suite} · {call.tenantMatch.tenantName}</div>
            <div className="muted" style={{ fontSize: 11.5 }}>{counterparty || '—'}</div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600 }}>{counterparty || '(unknown)'}</div>
            <div className="muted" style={{ fontSize: 11.5 }}>{call.direction === 'outbound' ? 'outbound' : 'inbound'} · {call.numberName || ''}</div>
          </>
        )}
        {Array.isArray(call.tags) && call.tags.length > 0 && (
          <div className="row" style={{ marginTop: 4, gap: 4 }}>
            {call.tags.slice(0, 3).map(t => (
              <span key={t.id} className="chip is-small" style={{ background: (t.color || 'var(--surface-3)') + '33', color: 'var(--ink)', fontSize: 10 }}>{t.name}</span>
            ))}
          </div>
        )}
      </td>
      <td className="mono" style={{ fontSize: 11.5 }}>
        {call.status === 'missed' ? '—' : fmt.duration(call.talkSec || call.durationSec)}
        {call.answerSec > 0 && <div className="muted" style={{ fontSize: 10 }}>+{call.answerSec}s wait</div>}
      </td>
      <td>
        {call.status === 'missed' && <span className="chip is-danger" style={{ fontSize: 10.5 }}>missed</span>}
        {call.status === 'voicemail' && <span className="chip is-warning" style={{ fontSize: 10.5 }}>voicemail</span>}
        {call.status === 'answered' && <span className="chip is-success" style={{ fontSize: 10.5 }}>answered</span>}
      </td>
      <td className="mono muted" style={{ fontSize: 11 }}>{whenLabel}</td>
      <td>
        {call.recordingUrl ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {playing ? (
              <audio controls autoPlay src={call.recordingUrl} onEnded={() => setPlaying(false)} style={{ height: 28 }} />
            ) : (
              <button className="btn is-small" onClick={() => setPlaying(true)}>
                <Icon name="play" /> Play
              </button>
            )}
          </div>
        ) : (
          <span className="muted" style={{ fontSize: 10.5, fontStyle: 'italic' }}>—</span>
        )}
      </td>
    </tr>
  );
}

/* ================================================================
   Emails tab
   ================================================================ */
function EmailsTab({ events, user, onOpenEvent, metrics }) {
  const m = metrics;
  const sent     = events.filter(e => e.type === "sent" || e.type === "reply").length;
  const received = events.filter(e => e.type === "received").length;
  const replies  = events.filter(e => e.type === "reply").length;
  const replyMin = m ? m.actuals.emailReplyMin : 47;
  const replyOk  = m ? m.today.reply.hit : true;

  // Phase 12+ — direction filter. Default «sent» per operator request:
  // operator wants to see what THIS employee did (their outbound activity)
  // not incoming spam. Chips switch to received / replies / all.
  const [dirFilter, setDirFilter] = React.useState("sent");
  const visibleEvents = events.filter(e => {
    if (dirFilter === "all") return true;
    if (dirFilter === "sent") return e.type === "sent" || e.type === "reply";
    if (dirFilter === "received") return e.type === "received";
    if (dirFilter === "replies") return e.type === "reply";
    return true;
  });
  // Newest first — same convention as Timeline (Phase 12+).
  const sortedEvents = [...visibleEvents].sort((a, b) => parseTime(b.time) - parseTime(a.time));

  return (
    <div>
      {m && (
        <div className="card" style={{ padding: 14, marginBottom: 14, background: m.today.emails.hit && replyOk ? "var(--success-soft)" : "var(--warning-soft)", borderColor: "transparent" }}>
          <div className="row">
            <Icon name={m.today.emails.hit && replyOk ? "check" : "clock"} style={{ color: m.today.emails.hit && replyOk ? "var(--success-ink)" : "var(--warning-ink)" }} />
            <span style={{ fontWeight: 600, fontSize: 13 }}>
              {m.today.emails.hit ? `Sent ${sent} emails today — hit the ${m.targets.emails}-email target` : `${sent}/${m.targets.emails} emails sent so far`}
              · average reply time {replyMin}m {replyOk ? `(under ${m.targets.emailReplyMin}m SLA)` : `(over ${m.targets.emailReplyMin}m SLA)`}
            </span>
          </div>
        </div>
      )}

      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(5, 1fr)", marginBottom: 18 }}>
        <KPILite label="Sent"     value={sent}     icon="mailOut" color="var(--success)" />
        <KPILite label="Received" value={received} icon="mailIn"  color="var(--info)" />
        <KPILite label="Replies"  value={replies}  icon="mail"    color="var(--accent)" />
        <KPILite label="Avg reply" value={replyMin + "m"} icon="clock" color={replyOk ? "var(--success)" : "var(--warning)"} />
        <KPILite label="Reply SLA" value={m ? "<" + m.targets.emailReplyMin + "m" : "—"} icon="signal" />
      </div>

      {/* Phase 12+ — direction filter chips. Default «Sent». */}
      <div className="row" style={{ marginBottom: 12, gap: 8 }}>
        {[
          { id: "sent",     label: "Sent",     count: sent     },
          { id: "received", label: "Received", count: received },
          { id: "replies",  label: "Replies",  count: replies  },
          { id: "all",      label: "All",      count: events.length },
        ].map(f => (
          <button
            key={f.id}
            className={"chip" + (dirFilter === f.id ? " is-accent" : "")}
            onClick={() => setDirFilter(f.id)}
            style={{ cursor: "pointer" }}
          >
            {f.label} <span style={{ opacity: 0.6, marginLeft: 4 }}>{f.count}</span>
          </button>
        ))}
      </div>

      {sortedEvents.length === 0 ? (
        <div className="card"><Empty icon="mail" title={`No ${dirFilter === "all" ? "emails" : dirFilter + " emails"} today`}>{dirFilter === "sent" ? `${user.first} hasn't sent any emails today yet.` : `Try a different filter — there are ${events.length} email events in total.`}</Empty></div>
      ) : (
        <div className="card is-clean">
          <table className="table">
            <thead><tr><th>Direction</th><th>Subject / contact</th><th>Status</th><th>Time</th><th></th></tr></thead>
            <tbody>
              {sortedEvents.map(e => (
                <tr key={e.id} className="is-clickable" onClick={() => onOpenEvent(e)}>
                  <td>
                    <span className="cat-icon sm" style={{ background: e.type === "received" ? "var(--info)" : "var(--success)" }}>
                      <Icon name={e.type === "received" ? "mailIn" : "mailOut"} />
                    </span>
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{e.ent?.name}</div>
                    {e._tenantMatch ? (
                      <div style={{ fontSize: 11.5, marginTop: 2 }}>
                        <span className="chip is-info" style={{ marginRight: 6 }}>
                          <Icon name="building" style={{ width: 10, height: 10, marginRight: 3, verticalAlign: "-1px" }} />
                          Suite {e._tenantMatch.suite}
                        </span>
                        <span className="muted">{e._tenantMatch.tenantName}</span>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, marginTop: 2 }}>
                        <span className="chip is-warning">
                          <Icon name="user" style={{ width: 10, height: 10, marginRight: 3, verticalAlign: "-1px" }} />
                          New contact
                        </span>
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="chip is-success">delivered</span>
                    {e.type === "reply" && <span className="chip is-accent" style={{ marginLeft: 4 }}>reply</span>}
                  </td>
                  <td className="mono">{e.time}</td>
                  <td><button className="btn is-small">Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Login history tab
   ================================================================ */
function LoginsTab({ user }) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const isToday = i === 0;
    const isPto = i === 1 && user.id === "u7";
    days.push({
      day: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
      isToday,
      pto: isPto,
      login: isPto ? null : isToday ? user.login : ["8:54 AM", "8:48 AM", "9:02 AM", "8:39 AM", "8:55 AM", "9:11 AM"][i - 1],
      logout: isPto ? null : isToday ? "in progress" : ["5:18 PM", "5:31 PM", "5:08 PM", "5:42 PM", "5:21 PM", "4:58 PM"][i - 1],
      hours: isPto ? 0 : isToday ? Math.round(user.online / 60 * 10) / 10 : [7.8, 8.2, 7.6, 8.3, 7.9, 7.4][i - 1],
      segs: isToday ? DATA.dayBarFor(user.id) : null,
    });
  }

  const totalHours = days.filter(d => !d.pto).reduce((s, d) => s + d.hours, 0).toFixed(1);
  const sessions   = days.filter(d => !d.pto).length;

  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <KPILite label="This week" value={totalHours + "h"} icon="clock" />
        <KPILite label="Avg start" value="8:54 AM"        icon="login" />
        <KPILite label="Sessions"  value={sessions}        icon="signal" />
        <KPILite label="Failed attempts" value={user.id === "u12" ? "3" : "0"} icon="shield" color={user.id === "u12" ? "var(--danger)" : undefined} />
      </div>

      <div className="card is-clean">
        <div className="card-h"><div className="card-title">Last 7 days</div></div>
        <div style={{ padding: "12px 18px" }}>
          {days.map((d, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "80px 90px 90px 1fr 60px", gap: 14, alignItems: "center", padding: "10px 0", borderBottom: i < days.length - 1 ? "1px dashed var(--border)" : "none" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{d.day}{d.isToday && <span className="chip is-accent" style={{ marginLeft: 6 }}>today</span>}</div>
              <div className="mono" style={{ fontSize: 13 }}>{d.login || <span className="muted">—</span>}</div>
              <div className="mono" style={{ fontSize: 13, color: d.logout === "in progress" ? "var(--success-ink)" : "var(--ink)" }}>{d.logout || <span className="muted">PTO</span>}</div>
              <div>
                {d.pto ? (
                  <div className="muted" style={{ fontSize: 12 }}>Paid time off</div>
                ) : d.segs ? (
                  <DayBar segs={d.segs} />
                ) : (
                  <div className="day-bar"><span className="seg act" style={{ left: "20%", width: "62%" }} /></div>
                )}
              </div>
              <div className="num" style={{ fontWeight: 700, textAlign: "right" }}>{d.pto ? "—" : d.hours + "h"}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Devices & locations</div>
          <span className="chip is-success" style={{ marginLeft: 6 }}><Icon name="shield" /> all trusted</span>
        </div>
        <table className="table">
          <thead><tr><th>Device</th><th>IP address</th><th>Location</th><th>Last seen</th></tr></thead>
          <tbody>
            <tr><td><Icon name="laptop" style={{ verticalAlign: "-3px", marginRight: 6 }} />{user.device}</td><td className="mono">{user.ip}</td><td>{user.loc}</td><td>now</td></tr>
            <tr><td><Icon name="mobile" style={{ verticalAlign: "-3px", marginRight: 6 }} />iPhone · Safari</td><td className="mono">73.118.42.21</td><td>{user.loc}</td><td>yesterday</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ================================================================
   Productivity analytics tab
   ================================================================ */
function ProductivityTab({ user }) {
  const hourly = DATA.hourlyActionsFor(user.id);
  const trend = DATA.trend30(user.id);
  const teamAvg = Math.round(DATA.USERS.filter(u => u.score > 0).reduce((s, u) => s + u.score, 0) / DATA.USERS.filter(u => u.score > 0).length);

  return (
    <div className="col" style={{ gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18 }} className="prod-grid">
        <div className="card">
          <div className="row" style={{ marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>30-day productivity score</div>
              <div className="muted" style={{ fontSize: 12 }}>Composite of actions, response time, contracts moved, and engagement.</div>
            </div>
            <div className="spacer" />
            <div className="num" style={{ fontSize: 28, fontWeight: 700 }}>{user.score}</div>
            <Trend now={user.score} prev={user.prev} suffix=" vs. prev. 30d" />
          </div>
          <Sparkline values={trend} color="var(--accent)" />
          <div className="row muted" style={{ fontSize: 11.5, marginTop: 6, justifyContent: "space-between" }}>
            <span>30 days ago</span><span>today</span>
          </div>
        </div>

        <div className="card">
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>You vs. team average</div>
          <div className="col" style={{ gap: 10 }}>
            <CompareBar label={user.first} value={user.score} max={100} color="var(--accent)" />
            <CompareBar label="Team avg" value={teamAvg} max={100} color="var(--muted-2)" />
          </div>
          <hr className="divider" />
          <div className="col" style={{ gap: 6, fontSize: 13 }}>
            <div className="row"><Icon name="trendUp" style={{ color: "var(--success-ink)" }} /><span>Above team avg by <b>{user.score - teamAvg}</b> points</span></div>
            <div className="row"><Icon name="signal" style={{ color: "var(--muted)" }} /><span>Most productive hour: <b className="mono">{hourly.sort((a,b) => b.v - a.v)[0].h}:00</b></span></div>
            <div className="row"><Icon name="zap" style={{ color: "var(--muted)" }} /><span><b>{user.actions}</b> total actions today</span></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Actions per hour</div>
        <HourBars data={hourly} color="var(--accent)" height={120} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }} className="prod-mini">
        <MiniMetric label="Calls / day"     value={user.calls}     unit="avg" />
        <MiniMetric label="Emails / day"    value={user.emails}    unit="avg" />
        <MiniMetric label="Contracts / wk"  value={user.contracts * 4} unit="trend" />
        <MiniMetric label="Avg response"    value="47m" unit="email" />
      </div>

      <style>{`
        @media (max-width: 980px) {
          .prod-grid, .prod-mini { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

function KPILite({ icon, label, value, color, tone }) {
  const toneClass = tone === "danger" ? " is-danger" : tone === "warning" ? " is-warning" : "";
  return (
    <div className={"kpi" + toneClass}>
      <div className="kpi-head"><Icon name={icon} style={{ color }} />{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}

/* ================================================================
   Performance & Bonus tab
   ================================================================ */
function PerformanceTab({ user, metrics }) {
  const m = metrics;
  /* Auto-generated insights — saves managers 15min reading the data */
  const insights = buildInsights(user, m);

  return (
    <div className="col" style={{ gap: 18 }}>
      {/* AI insights summary — the headline that managers skim */}
      <div className="card" style={{ padding: 18, background: "linear-gradient(135deg, oklch(97% 0.03 264), oklch(98% 0.02 290))", borderColor: "transparent" }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="cat-icon" style={{ background: "var(--accent)" }}><Icon name="sparkle" /></span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Pulse summary · today</div>
            <div className="muted" style={{ fontSize: 11.5 }}>Auto-generated highlights for your 1:1 prep</div>
          </div>
          <div className="spacer" />
          <button className="btn is-small is-ghost" onClick={() => window.toast("Insights refreshed")}><Icon name="refresh" /></button>
        </div>
        <div className="col" style={{ gap: 8 }}>
          {insights.map((ins, i) => (
            <div key={i} className="row" style={{ alignItems: "flex-start", gap: 10, padding: "8px 12px", background: "rgba(255,255,255,.6)", borderRadius: 8 }}>
              <Icon name={ins.icon} style={{ color: ins.color, marginTop: 2, flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 13.5, lineHeight: 1.45 }}>
                <span style={{ fontWeight: 600 }}>{ins.title}</span>
                {ins.detail && <span className="muted"> · {ins.detail}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12, gap: 6, fontSize: 11.5, color: "var(--muted)" }}>
          <Icon name="check" style={{ color: "var(--success-ink)" }} />
          <span>Best talking point: <b style={{ color: "var(--ink-2)" }}>{insights[0]?.title}</b></span>
        </div>
      </div>

      {/* Plain-English headline */}
      <div className="card" style={{ padding: 18 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <Icon name={m.status.icon} style={{ color: "var(--" + (m.status.tone === "success" ? "success" : m.status.tone === "warning" ? "warning" : m.status.tone === "danger" ? "danger" : "muted") + "-ink)" }} />
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>How {user.first} is doing</span>
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.015em", marginBottom: 4 }}>
          {m.status.id === "crushing"  && <>{user.first} is <span style={{ color: "var(--success-ink)" }}>crushing it today</span> — {m.hits} of {m.expected} daily targets hit.</>}
          {m.status.id === "ontrack"   && <>{user.first} is <span style={{ color: "var(--success-ink)" }}>on track</span> — {m.hits} of {m.expected} daily targets hit.</>}
          {m.status.id === "behind"    && <>{user.first} is <span style={{ color: "var(--warning-ink)" }}>behind pace</span> — {m.hits} of {m.expected} targets hit so far.</>}
          {m.status.id === "low"       && <>{user.first} is having a <span style={{ color: "var(--warning-ink)" }}>slow start</span> — only {m.hits} of {m.expected} targets hit.</>}
          {m.status.id === "alert"     && <>{user.first} <span style={{ color: "var(--danger-ink)" }}>needs attention</span> — flagged activity or low productivity.</>}
          {m.status.id === "off"       && <>{user.first} is off today — {user.away || "no activity yet"}.</>}
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          Worked <b className="num" style={{ color: "var(--ink)" }}>{fmt.hm(user.online)}</b> of {m.targets.hoursWorked}h target ·
          {" "}sent <b className="num" style={{ color: "var(--ink)" }}>{user.emails}</b> emails ·
          {" "}made <b className="num" style={{ color: "var(--ink)" }}>{user.calls}</b> calls
          {m.actuals.missedCalls > 0 && <> · <b style={{ color: "var(--danger-ink)" }}>{m.actuals.missedCalls} missed</b></>}
        </div>
      </div>

      {/* Today's target meters — full size */}
      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Today's targets</div>
          <HelpHint>Daily expectations based on the {DATA.ROLES[user.role].label} role. Updated live as the day goes on.</HelpHint>
          <div className="spacer" />
          <span className="num muted" style={{ fontSize: 12 }}>{m.hits}/{m.expected} hit</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18 }} className="perf-targets">
          <TargetMeter icon="phone"    label="Calls made"      meter={m.today.calls}   hint={`Expected ${m.targets.calls} calls per workday`} />
          <TargetMeter icon="mail"     label="Emails sent"     meter={m.today.emails}  hint={`Expected ${m.targets.emails} manual emails per workday`} />
          {m.targets.contracts > 0
            ? <TargetMeter icon="contract" label="Contracts sent" meter={m.today.contracts} hint={`Expected ${m.targets.contracts} contracts per workday`} />
            : <TargetMeter icon="clock" label="Call pickup speed" meter={m.today.pickup} formatValue={v => v + "s"} formatTarget={v => "<" + v + "s"} hint="Target: answer in under 25 seconds" />}
          <TargetMeter icon="clock"    label="Hours worked"    meter={m.today.hours}   formatValue={v => v + "h"} formatTarget={v => v + "h"} hint="Expected workday length" />
          <TargetMeter icon="mail"     label="Email reply time" meter={m.today.reply}  formatValue={v => v + "m"} formatTarget={v => "<" + v + "m SLA"} hint={`Reply within ${m.targets.emailReplyMin} minutes`} />
          <TargetMeter icon="phoneMiss" label="Missed callbacks" meter={{ value: m.actuals.missedCalls, target: 1, pct: m.actuals.missedCalls === 0 ? 0 : 100, hit: m.actuals.missedCalls <= 1, tone: m.actuals.missedCalls === 0 ? "success" : m.actuals.missedCalls > 2 ? "danger" : "warning" }} formatValue={v => v + " open"} formatTarget={v => "max 1"} hint="Open missed calls without a callback" />
        </div>
      </div>

      {/* Bonus this month */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 18 }} className="perf-bonus-grid">
        <div className="card" style={{ padding: 22, background: m.tier.id !== "none" ? `linear-gradient(135deg, ${m.tier.color}10, ${m.tier.color}22)` : "var(--surface)", borderColor: m.tier.id === "gold" || m.tier.id === "platinum" ? m.tier.color : "var(--border)" }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <Icon name="star" style={{ color: m.tier.id !== "none" ? m.tier.color : "var(--muted)" }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>May bonus · <span style={{ color: m.tier.color }}>{m.tier.label}</span></div>
          </div>
          <div className="num" style={{ fontSize: 44, fontWeight: 800, letterSpacing: "-.03em", color: m.tier.id !== "none" ? m.tier.color : "var(--muted)" }}>
            ${m.bonusMtd.toLocaleString()}
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
            Earned month-to-date{m.extraFromContracts > 0 && <> · base ${m.tier.amount} + ${m.extraFromContracts} from contracts</>}
          </div>

          {m.nextTier ? (
            <div>
              <div className="row" style={{ fontSize: 12, marginBottom: 4 }}>
                <span>Progress to <b style={{ color: m.nextTier.color }}>{m.nextTier.label}</b></span>
                <div className="spacer" />
                <span className="num" style={{ fontWeight: 700, color: m.nextTier.color }}>+${m.nextTier.amount - m.tier.amount}</span>
              </div>
              <div style={{ height: 10, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: Math.round(m.progressToNext * 100) + "%", background: m.nextTier.color, borderRadius: 999 }} />
              </div>
            </div>
          ) : (
            <div className="row" style={{ padding: "10px 14px", background: "var(--success-soft)", borderRadius: 8, color: "var(--success-ink)", fontSize: 13 }}>
              <Icon name="check" /> Top tier reached this month — great job!
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Month-to-date targets</div>
          <div className="col" style={{ gap: 12 }}>
            <TargetMeter
              icon="phone" label="Calls"
              meter={{ value: m.mtd.calls, target: m.monthTargets.calls, pct: Math.round(m.mtd.calls / m.monthTargets.calls * 100), hit: m.mtd.calls >= m.monthTargets.calls, tone: m.mtd.calls >= m.monthTargets.calls ? "success" : m.mtd.calls >= m.monthTargets.calls * .7 ? "warning" : "danger" }}
            />
            <TargetMeter
              icon="mail" label="Emails"
              meter={{ value: m.mtd.emails, target: m.monthTargets.emails, pct: Math.round(m.mtd.emails / m.monthTargets.emails * 100), hit: m.mtd.emails >= m.monthTargets.emails, tone: m.mtd.emails >= m.monthTargets.emails ? "success" : m.mtd.emails >= m.monthTargets.emails * .7 ? "warning" : "danger" }}
            />
            {m.targets.contracts > 0 && (
              <TargetMeter
                icon="contract" label="Contracts"
                meter={{ value: m.mtd.contracts, target: Math.round(m.monthTargets.contracts), pct: Math.round(m.mtd.contracts / m.monthTargets.contracts * 100), hit: m.mtd.contracts >= m.monthTargets.contracts, tone: m.mtd.contracts >= m.monthTargets.contracts ? "success" : m.mtd.contracts >= m.monthTargets.contracts * .7 ? "warning" : "danger" }}
              />
            )}
            <TargetMeter
              icon="cal" label="Days worked"
              meter={{ value: m.mtd.daysWorked, target: m.mtd.daysExpected, pct: Math.round(m.mtd.daysWorked / m.mtd.daysExpected * 100), hit: m.mtd.daysWorked >= m.mtd.daysExpected, tone: m.mtd.daysWorked >= m.mtd.daysExpected ? "success" : "warning" }}
              formatValue={v => v + "d"} formatTarget={v => v + "d"}
            />
          </div>
        </div>
      </div>

      {/* Response speed comparison */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }} className="perf-bonus-grid">
        <div className="card">
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Responsiveness</div>
          <div className="col" style={{ gap: 14 }}>
            <ResponseRow icon="mail" label="Email reply" value={m.actuals.emailReplyMin + "m"} target={"under " + m.targets.emailReplyMin + "m"} hit={m.today.reply.hit} />
            <ResponseRow icon="phone" label="Call pickup" value={m.actuals.callPickupSec + "s"} target={"under " + m.targets.callPickupSec + "s"} hit={m.today.pickup.hit} />
            <ResponseRow icon="phoneMiss" label="Missed calls" value={m.actuals.missedCalls + " open"} target="max 1" hit={m.actuals.missedCalls <= 1} />
          </div>
        </div>
        <div className="card">
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Strengths & areas to improve</div>
          <div className="col" style={{ gap: 8 }}>
            {strengthsFor(m).map((s, i) => (
              <div key={i} className="row" style={{ padding: 10, background: s.kind === "good" ? "var(--success-soft)" : "var(--warning-soft)", borderRadius: 8, fontSize: 13, color: s.kind === "good" ? "var(--success-ink)" : "var(--warning-ink)" }}>
                <Icon name={s.kind === "good" ? "trendUp" : "trendDn"} />
                <span style={{ flex: 1 }}>{s.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 980px) {
          .perf-targets { grid-template-columns: repeat(2, 1fr) !important; }
          .perf-bonus-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 540px) {
          .perf-targets { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

function ResponseRow({ icon, label, value, target, hit }) {
  return (
    <div className="row" style={{ padding: "10px 12px", background: "var(--surface-2)", borderRadius: 10 }}>
      <span className="cat-icon sm" style={{ background: hit ? "var(--success)" : "var(--warning)" }}>
        <Icon name={icon} />
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>Target {target}</div>
      </div>
      <div className="num" style={{ fontWeight: 700, fontSize: 18, color: hit ? "var(--success-ink)" : "var(--warning-ink)" }}>{value}</div>
      {hit && <Icon name="check" style={{ color: "var(--success-ink)" }} />}
    </div>
  );
}

function strengthsFor(m) {
  const out = [];
  if (m.today.calls.hit) out.push({ kind: "good", text: `Hit the daily call target (${m.today.calls.value}/${m.today.calls.target})` });
  if (m.today.emails.hit) out.push({ kind: "good", text: `Exceeded email volume (${m.today.emails.value}/${m.today.emails.target})` });
  if (m.today.reply.hit && m.actuals.emailReplyMin > 0) out.push({ kind: "good", text: `Fast email reply: ${m.actuals.emailReplyMin}m (target <${m.targets.emailReplyMin}m)` });
  if (m.today.pickup.hit && m.actuals.callPickupSec > 0) out.push({ kind: "good", text: `Quick call pickup: ${m.actuals.callPickupSec}s` });
  if (!m.today.calls.hit && m.today.calls.target > 0) out.push({ kind: "bad", text: `Behind on calls — ${m.today.calls.value} of ${m.today.calls.target} (${Math.round((m.today.calls.target - m.today.calls.value))} more to hit target)` });
  if (!m.today.reply.hit && m.actuals.emailReplyMin > 0) out.push({ kind: "bad", text: `Slow email reply: ${m.actuals.emailReplyMin}m vs ${m.targets.emailReplyMin}m SLA` });
  if (m.actuals.missedCalls > 1) out.push({ kind: "bad", text: `${m.actuals.missedCalls} missed calls without callback — follow up` });
  if (out.length === 0) out.push({ kind: "good", text: "All metrics within targets — keep going!" });
  return out.slice(0, 5);
}

/* Auto-generated insights for 1:1 prep — what changed, what to talk about */
function buildInsights(user, m) {
  const ins = [];
  if (m.hits >= 4) ins.push({ icon: "trendUp", color: "var(--success-ink)", title: `Crushing it — ${m.hits} of ${m.expected} targets hit today`, detail: "above weekly average" });
  if (m.today.calls.hit) ins.push({ icon: "phone", color: "var(--success-ink)", title: `Hit the daily call target`, detail: `${m.today.calls.value}/${m.today.calls.target} calls` });
  else if (m.today.calls.target > 0 && m.today.calls.value < m.today.calls.target * .6) ins.push({ icon: "phone", color: "var(--warning-ink)", title: `Behind on calls`, detail: `only ${m.today.calls.value} of ${m.today.calls.target} — ${m.today.calls.target - m.today.calls.value} to go` });
  if (m.actuals.emailReplyMin > 0 && m.actuals.emailReplyMin < m.targets.emailReplyMin * .6) ins.push({ icon: "zap", color: "var(--success-ink)", title: `Top-tier response speed`, detail: `replies in ${m.actuals.emailReplyMin}m (SLA ${m.targets.emailReplyMin}m)` });
  if (m.actuals.missedCalls > 1) ins.push({ icon: "warning", color: "var(--danger-ink)", title: `${m.actuals.missedCalls} missed callbacks open`, detail: "needs follow-up today" });
  if (user.contracts > 0) ins.push({ icon: "contract", color: "var(--accent-ink)", title: `${user.contracts} contract${user.contracts === 1 ? "" : "s"} sent today`, detail: "moving deals forward" });
  if (m.tier.id === "gold" || m.tier.id === "platinum") ins.push({ icon: "star", color: m.tier.color, title: `Earning ${m.tier.label} tier bonus`, detail: `$${m.bonusMtd.toLocaleString()} accrued` });
  if (user.online > 9 * 60) ins.push({ icon: "clock", color: "var(--warning-ink)", title: `Working long hours`, detail: `${fmt.hm(user.online)} today — consider check-in on workload` });
  if (m.status.id === "alert") ins.push({ icon: "warning", color: "var(--danger-ink)", title: `Flagged for attention`, detail: user.away || "unusual activity detected" });
  if (ins.length === 0) ins.push({ icon: "check", color: "var(--success-ink)", title: "Quiet productive day", detail: "no anomalies detected" });
  return ins.slice(0, 5);
}
function CompareBar({ label, value, max, color }) {
  return (
    <div>
      <div className="row" style={{ fontSize: 12, marginBottom: 4 }}><span style={{ flex: 1 }}>{label}</span><span className="num" style={{ fontWeight: 700 }}>{value}</span></div>
      <div className="bar" style={{ height: 10, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: (value / max * 100) + "%", background: color, borderRadius: 999 }} />
      </div>
    </div>
  );
}
function MiniMetric({ label, value, unit }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="kpi-head">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="muted" style={{ fontSize: 11.5 }}>{unit}</div>
    </div>
  );
}

/* ================================================================
   Phase 17 rev — simplified WORKING TODAY card. Now just an enriched
   ACTIVITY-BY-HOUR chart with Started / Last-seen labels above the
   bars. Hours + progress bar removed — same info already in the Stat
   strip (FIRST LOGIN + LAST ACTIVITY cells).
   ================================================================ */
function WorkingTodayCard({ user, displayUser, metrics, isToday, selectedDate, snapshot }) {
  const startedStr = isToday
    ? (user.login || "—")
    : (snapshot ? "—" : "—"); // past days don't carry login time
  const lastSeenStr = isToday
    ? (user.status === "online" ? "now"
       : user.status === "idle" ? (user._idleMinutes != null ? user._idleMinutes + "m ago" : "—")
       : user.logout || "—")
    : (snapshot ? "—" : "—");

  return (
    <div style={{ padding: 14, background: "var(--surface-2)", borderRadius: 12, position: "relative" }}>
      {/* Header: title + ? + status chip */}
      <div className="row" style={{ marginBottom: 10 }}>
        <Icon name="activity" style={{ color: "var(--muted)", width: 14, height: 14 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>
          {isToday ? "Activity by hour · today" : "Activity · " + _shortDateLabel(selectedDate)}
        </span>
        <HelpHint>
          Outbound emails per hour, bucketed from Gmail API SENT events (office-hour window 7-19). Hover any bar to see recipients + subjects of emails in that hour. Received emails / incoming spam excluded — only the operator's outbound actions count. Past days have no hourly snapshot yet (Phase 18 todo).
        </HelpHint>
        <div className="spacer" />
        {isToday && displayUser.status === "online" && <span className="chip is-success is-small" style={{ fontSize: 10 }}>on time</span>}
        {isToday && displayUser.status === "idle" && <span className="chip is-warning is-small" style={{ fontSize: 10 }}>idle</span>}
        {isToday && displayUser.status === "offline" && user._isReal && <span className="chip is-small" style={{ fontSize: 10 }}>offline</span>}
        {!isToday && !snapshot && <span className="chip is-small" style={{ fontSize: 10 }}>no data</span>}
      </div>

      {/* Started / Last-seen labels — start/end of work day */}
      <div className="row" style={{ marginBottom: 8, fontSize: 11 }}>
        <span className="muted" style={{ textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 600 }}>Started</span>
        <span className="mono" style={{ fontWeight: 700, color: "var(--ink)", marginLeft: 6 }}>{startedStr}</span>
        <div className="spacer" />
        <span className="muted" style={{ textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 600 }}>Last seen</span>
        <span className="mono" style={{ fontWeight: 700, color: "var(--ink)", marginLeft: 6 }}>{lastSeenStr}</span>
      </div>

      {/* Hourly chart now full-width — was right column of merged tile */}
      <HourlyChart user={user} isToday={isToday} selectedDate={selectedDate} />
    </div>
  );
}

/* HourlyChart — без обёртки card, рендерит chart + footer-сводку.
   Используется внутри WorkingTodayCard. Hover popover anchor — на
   собственном relative-контейнере чтобы корректно позиционироваться
   под объединённой плиткой. */
function HourlyChart({ user, isToday, selectedDate }) {
  const isReal = !!user._isReal;
  const [hoveredHour, setHoveredHour] = React.useState(null);
  let data, totalActions, isMock = false, isMissing = false;

  if (isReal) {
    if (isToday) {
      data = Array.isArray(user._hourlyToday) && user._hourlyToday.length
        ? user._hourlyToday
        : DATA.hourlyActionsFor(user.id).map(d => ({ h: d.h, v: 0, items: [] }));
    } else {
      data = DATA.hourlyActionsFor(user.id).map(d => ({ h: d.h, v: 0, items: [] }));
      isMissing = true;
    }
    totalActions = data.reduce((s, d) => s + d.v, 0);
  } else {
    data = DATA.hourlyActionsFor(user.id).map(d => ({ h: d.h, v: d.v, items: [] }));
    totalActions = data.reduce((s, d) => s + d.v, 0);
    isMock = true;
  }

  const peak = data.reduce((best, d) => (d.v > best.v ? d : best), { h: -1, v: 0 });
  const max = Math.max(1, ...data.map(d => d.v));
  const hoveredBar = hoveredHour != null ? data.find(d => d.h === hoveredHour) : null;

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column" }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 600 }}>
          {isToday ? "Activity by hour · today" : "Activity by hour"}
        </span>
        <div className="spacer" />
        {totalActions > 0 && (
          <span className="muted" style={{ fontSize: 10.5 }}>
            {totalActions} {totalActions === 1 ? "action" : "actions"}
            {peak.v > 0 && <> · peak <span className="mono" style={{ color: "var(--ink)" }}>{String(peak.h).padStart(2, "0")}:00</span> · {peak.v}</>}
          </span>
        )}
      </div>

      {isMissing ? (
        <div className="muted" style={{ fontSize: 11.5, padding: "16px 4px", fontStyle: "italic" }}>
          No hourly data for this day yet.
        </div>
      ) : (
        <div
          style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 70 }}
          onMouseLeave={() => setHoveredHour(null)}
        >
          {data.map(d => {
            const barH = Math.max(2, (d.v / max) * 52);
            const isHover = d.h === hoveredHour;
            return (
              <div
                key={d.h}
                onMouseEnter={() => setHoveredHour(d.h)}
                style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, cursor: d.v > 0 ? "pointer" : "default" }}
              >
                <div
                  style={{
                    width: "100%",
                    height: barH + "px",
                    background: isHover ? "var(--accent-ink, var(--accent))" : "var(--accent)",
                    opacity: hoveredHour != null && !isHover ? 0.45 : 0.9,
                    borderRadius: "4px 4px 2px 2px",
                    transition: "opacity 120ms, background 120ms",
                  }}
                />
                <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: isHover ? "var(--ink)" : "var(--muted)", fontWeight: isHover ? 700 : 400 }}>
                  {d.h % 4 === 0 ? d.h : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Hover popover — anchored to this chart container (not the
          outer merged card) so it floats right under the chart. */}
      {hoveredBar && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)", left: 0, right: 0,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: 12,
            boxShadow: "0 8px 24px rgba(0,0,0,.12)",
            zIndex: 30,
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="mono" style={{ fontWeight: 700, color: "var(--ink)", fontSize: 13 }}>
              {String(hoveredBar.h).padStart(2, "0")}:00 – {String(hoveredBar.h + 1).padStart(2, "0")}:00
            </span>
            <div className="spacer" />
            <span className="chip is-accent" style={{ fontSize: 10.5 }}>
              {hoveredBar.v} {hoveredBar.v === 1 ? "email" : "emails"}
            </span>
          </div>
          {hoveredBar.v === 0 ? (
            <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>No outbound emails in this hour.</div>
          ) : isMock ? (
            <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>Per-email detail unavailable for demo seed users.</div>
          ) : !Array.isArray(hoveredBar.items) || hoveredBar.items.length === 0 ? (
            <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>Email metadata still loading.</div>
          ) : (
            <div className="col" style={{ gap: 4 }}>
              {hoveredBar.items.slice(0, 8).map((it, i) => {
                const t = new Date(it.ts);
                const hh = String(t.getHours()).padStart(2, "0");
                const mm = String(t.getMinutes()).padStart(2, "0");
                const recipient = typeof it.to === "string" ? it.to : (Array.isArray(it.to) ? it.to.join(", ") : "");
                return (
                  <div key={i} className="row" style={{ alignItems: "baseline", gap: 6 }}>
                    <span className="mono muted" style={{ fontSize: 10.5, width: 38, flexShrink: 0 }}>{hh}:{mm}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ color: "var(--accent-ink)", fontWeight: 600 }}>→ {recipient}</span>
                      {it.subject && <span className="muted"> · {it.subject}</span>}
                    </span>
                  </div>
                );
              })}
              {hoveredBar.v > hoveredBar.items.length && (
                <div className="muted" style={{ fontSize: 10.5, fontStyle: "italic", marginTop: 2 }}>
                  + {hoveredBar.v - hoveredBar.items.length} more…
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* HourlyCard — legacy standalone card wrapper. Kept for backwards
   compatibility if anything outside employee-detail still imports it
   (none currently); thin wrap around HourlyChart with own header. */
function HourlyCard({ user, displayUser, isToday, selectedDate }) {
  // Источник данных:
  //  - real user + today → u._hourlyToday (заполнен data-shim'ом из
  //    gmailActivity SENT events with today timestamp).
  //  - real user + past day → нет hourly в snapshot (Phase 18 todo).
  //    Покажем плоскую полосу + надпись «No hourly data».
  //  - mock user → DATA.hourlyActionsFor(u.id) (статичный mock,
  //    нечуствительный к дате — для демо-сидов).
  const isReal = !!user._isReal;
  const [hoveredHour, setHoveredHour] = React.useState(null);
  let data, totalActions, isMock = false, isMissing = false;

  if (isReal) {
    if (isToday) {
      data = Array.isArray(user._hourlyToday) && user._hourlyToday.length
        ? user._hourlyToday
        : DATA.hourlyActionsFor(user.id).map(d => ({ h: d.h, v: 0, items: [] }));
    } else {
      // Прошлый день без снапшота — нули.
      data = DATA.hourlyActionsFor(user.id).map(d => ({ h: d.h, v: 0, items: [] }));
      isMissing = true;
    }
    totalActions = data.reduce((s, d) => s + d.v, 0);
  } else {
    // Mock seeds — добавим items: [] для совместимости с hover-логикой.
    data = DATA.hourlyActionsFor(user.id).map(d => ({ h: d.h, v: d.v, items: [] }));
    totalActions = data.reduce((s, d) => s + d.v, 0);
    isMock = true;
  }

  // Пиковый час — для подсказки «peak 14:00 → 12 events».
  const peak = data.reduce((best, d) => (d.v > best.v ? d : best), { h: -1, v: 0 });
  const max = Math.max(1, ...data.map(d => d.v));
  const hoveredBar = hoveredHour != null ? data.find(d => d.h === hoveredHour) : null;

  return (
    <div style={{ padding: 12, background: "var(--surface-2)", borderRadius: 12, display: "flex", flexDirection: "column", position: "relative" }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <Icon name="activity" style={{ color: "var(--muted)", width: 14, height: 14 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>
          {isToday ? "Activity by hour · today" : "Activity by hour · " + _shortDateLabel(selectedDate)}
        </span>
        <div className="spacer" />
        {isReal && (
          <HelpHint>
            {isToday
              ? "Outbound emails per hour today, bucketed from Gmail API SENT events. Office-hour window 7-19. Hover any bar to see the recipients and subjects of emails sent in that hour. Received emails and incoming spam are excluded — only the operator's outbound actions count."
              : "Hourly distribution is not yet stored in daily snapshots. Past-day buckets will appear once Phase 18 snapshot extension lands."}
          </HelpHint>
        )}
        {isMock && <HelpHint>Hourly distribution (demo seed mock data — no per-email detail available).</HelpHint>}
      </div>

      <div style={{ flex: 1, minHeight: 70, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        {isMissing ? (
          <div className="muted" style={{ fontSize: 11.5, padding: "12px 4px", fontStyle: "italic" }}>
            No hourly data for this day yet.
          </div>
        ) : (
          <div
            style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 70 }}
            onMouseLeave={() => setHoveredHour(null)}
          >
            {data.map(d => {
              const h = Math.max(2, (d.v / max) * 52);
              const isHover = d.h === hoveredHour;
              return (
                <div
                  key={d.h}
                  onMouseEnter={() => setHoveredHour(d.h)}
                  style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, cursor: d.v > 0 ? "pointer" : "default" }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: h + "px",
                      background: isHover ? "var(--accent-ink, var(--accent))" : "var(--accent)",
                      opacity: hoveredHour != null && !isHover ? 0.45 : 0.9,
                      borderRadius: "4px 4px 2px 2px",
                      transition: "opacity 120ms, background 120ms",
                    }}
                  />
                  <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: isHover ? "var(--ink)" : "var(--muted)", fontWeight: isHover ? 700 : 400 }}>
                    {d.h % 4 === 0 ? d.h : ""}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="row" style={{ marginTop: 6, fontSize: 10.5 }}>
          <span className="muted">
            {totalActions} {totalActions === 1 ? "action" : "actions"}
          </span>
          {peak.v > 0 && (
            <>
              <div className="spacer" />
              <span className="muted">peak <span className="mono" style={{ color: "var(--ink)" }}>{String(peak.h).padStart(2, "0")}:00</span> · {peak.v}</span>
            </>
          )}
        </div>
      </div>

      {/* Hover popover — appears anchored to the card. Shows time-range
          + per-email detail (recipient + subject) for the hovered bar. */}
      {hoveredBar && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)", left: 0, right: 0,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: 12,
            boxShadow: "0 8px 24px rgba(0,0,0,.12)",
            zIndex: 30,
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="mono" style={{ fontWeight: 700, color: "var(--ink)", fontSize: 13 }}>
              {String(hoveredBar.h).padStart(2, "0")}:00 – {String(hoveredBar.h + 1).padStart(2, "0")}:00
            </span>
            <div className="spacer" />
            <span className="chip is-accent" style={{ fontSize: 10.5 }}>
              {hoveredBar.v} {hoveredBar.v === 1 ? "email" : "emails"}
            </span>
          </div>
          {hoveredBar.v === 0 ? (
            <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>No outbound emails in this hour.</div>
          ) : isMock ? (
            <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>Per-email detail unavailable for demo seed users.</div>
          ) : !Array.isArray(hoveredBar.items) || hoveredBar.items.length === 0 ? (
            <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>Email metadata still loading.</div>
          ) : (
            <div className="col" style={{ gap: 4 }}>
              {hoveredBar.items.slice(0, 8).map((it, i) => {
                const t = new Date(it.ts);
                const hh = String(t.getHours()).padStart(2, "0");
                const mm = String(t.getMinutes()).padStart(2, "0");
                const recipient = typeof it.to === "string" ? it.to : (Array.isArray(it.to) ? it.to.join(", ") : "");
                return (
                  <div key={i} className="row" style={{ alignItems: "baseline", gap: 6 }}>
                    <span className="mono muted" style={{ fontSize: 10.5, width: 38, flexShrink: 0 }}>{hh}:{mm}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ color: "var(--accent-ink)", fontWeight: 600 }}>→ {recipient}</span>
                      {it.subject && <span className="muted"> · {it.subject}</span>}
                    </span>
                  </div>
                );
              })}
              {hoveredBar.v > hoveredBar.items.length && (
                <div className="muted" style={{ fontSize: 10.5, fontStyle: "italic", marginTop: 2 }}>
                  + {hoveredBar.v - hoveredBar.items.length} more…
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Phase 17 — date helpers + DateNavigator (Prev / picker / Next / Today)
   ================================================================ */
function _localDateStr(d) {
  // YYYY-MM-DD in local TZ. Cron writes snapshots keyed by local-civil-date
  // (computed in functions/daily-snapshots.js using the same offset).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function _shortDateLabel(s) {
  // s = "YYYY-MM-DD" → "Mon May 12" (US locale, short). Used in card titles
  // when the operator scrolls back to a historical day.
  if (!s) return "—";
  const d = new Date(s + "T00:00:00");
  if (isNaN(d.getTime())) return s;
  const today = new Date();
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

function _humanDateLabel(s) {
  // «Today» / «Yesterday» / «Mon May 12». Slightly friendlier than the
  // raw short form — used in the day-navigator pill.
  if (!s) return "—";
  const todayStr = _localDateStr(new Date());
  if (s === todayStr) return "Today";
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (s === _localDateStr(yest)) return "Yesterday";
  return _shortDateLabel(s);
}

function DateNavigator({ value, onChange, todayStr, hasSnapshot, isToday, isRealUser }) {
  function shift(days) {
    const d = new Date(value + "T00:00:00");
    if (isNaN(d.getTime())) return;
    d.setDate(d.getDate() + days);
    const next = _localDateStr(d);
    if (next > todayStr) return; // нельзя в будущее
    onChange(next);
  }

  return (
    <div className="row" style={{
      marginTop: 18, padding: "10px 12px", borderRadius: 12,
      background: isToday ? "var(--surface-2)" : "var(--accent-soft)",
      border: isToday ? "1px solid transparent" : "1px solid var(--accent-border, rgba(99,102,241,.25))",
      gap: 8, flexWrap: "wrap",
    }}>
      <button className="btn is-small" onClick={() => shift(-1)} title="Previous day">
        <Icon name="chevL" /> Prev day
      </button>
      <input
        type="date"
        value={value}
        max={todayStr}
        onChange={e => e.target.value && onChange(e.target.value)}
        style={{
          padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)",
          background: "var(--surface)", fontSize: 13, fontWeight: 600,
          fontFamily: "inherit", color: "var(--ink)",
        }}
      />
      <button className="btn is-small" onClick={() => shift(1)} disabled={value >= todayStr} title="Next day">
        Next day <Icon name="chevR" />
      </button>
      <div style={{
        padding: "4px 12px", borderRadius: 999,
        background: isToday ? "var(--success-soft)" : "var(--surface)",
        color: isToday ? "var(--success-ink)" : "var(--ink)",
        fontSize: 12, fontWeight: 700, letterSpacing: ".02em",
        border: "1px solid var(--border)",
      }}>
        {_humanDateLabel(value)}
      </div>
      {!isToday && (
        <>
          {isRealUser && !hasSnapshot && (
            <span className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>
              No snapshot recorded for this day yet.
            </span>
          )}
          <div className="spacer" />
          <button className="btn is-small is-primary" onClick={() => onChange(todayStr)}>
            <Icon name="clock" /> Jump to today
          </button>
        </>
      )}
    </div>
  );
}
