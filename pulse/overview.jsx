/* global React, Icon, DATA, Avatar, CatIcon, StatusDot, KPI, Sparkline, Trend, fmt, parseTime, metricsFor, StatusPill, TargetMeter, BonusBadge, HelpHint */

/* ================================================================
   Activity Center — main overview page (v2)
   ================================================================ */

window.OverviewPage = function OverviewPage({ centerFilter, onOpenEmployee, onOpenEvent, onNav, onOpenFilter }) {
  const [range, setRange] = React.useState("Today");
  const [sortBy, setSortBy] = React.useState("status");
  const [leaderTab, setLeaderTab] = React.useState("score");

  const allUsers = [...DATA.USERS].map(u => ({ u, m: metricsFor(u) }));
  const users = centerFilter && centerFilter !== "all"
    ? allUsers.filter(x => x.u.centerId === centerFilter)
    : allUsers;

  /* Sort */
  users.sort((a, b) => {
    if (sortBy === "status") {
      const order = ["crushing", "ontrack", "behind", "low", "alert", "off"];
      return order.indexOf(a.m.status.id) - order.indexOf(b.m.status.id);
    }
    if (sortBy === "score") return b.u.score - a.u.score;
    if (sortBy === "actions") return b.u.actions - a.u.actions;
    if (sortBy === "name") return a.u.name.localeCompare(b.u.name);
    if (sortBy === "bonus") return b.m.bonusMtd - a.m.bonusMtd;
    return 0;
  });

  /* derived totals — from filtered users */
  const totalActions = users.reduce((s, x) => s + x.u.actions, 0);
  const totalCalls   = users.reduce((s, x) => s + x.u.calls, 0);
  const totalEmails  = users.reduce((s, x) => s + x.u.emails, 0);
  const totalContracts = users.reduce((s, x) => s + x.u.contracts, 0);
  const totalBonus = users.reduce((s, x) => s + x.m.bonusMtd, 0);
  const statusCounts = users.reduce((acc, x) => { acc[x.m.status.id] = (acc[x.m.status.id] || 0) + 1; return acc; }, {});

  /* Live feed (filtered to selected center) */
  const filteredUserIds = new Set(users.map(x => x.u.id));
  const feed = [...DATA.ALL_EVENTS]
    .filter(e => filteredUserIds.has(e.userId))
    .filter(e => e.cat !== "system" || e.type !== "view")
    .sort((a, b) => parseTime(b.time) - parseTime(a.time))
    .slice(0, 12);

  /* Leaderboard sorting */
  const leaderSorts = {
    score:     (a, b) => b.u.score - a.u.score,
    calls:     (a, b) => b.u.calls - a.u.calls,
    emails:    (a, b) => b.u.emails - a.u.emails,
    contracts: (a, b) => b.u.contracts - a.u.contracts,
    response:  (a, b) => a.m.actuals.emailReplyMin - b.m.actuals.emailReplyMin,
  };
  const leaders = [...users].filter(x => x.u.status !== "offline").sort(leaderSorts[leaderTab]).slice(0, 5);

  return (
    <div className="page">
      {/* Page header */}
      <div className="page-h">
        <div>
          <h1 className="title">Activity Center</h1>
          <div className="subtitle">
            <span><StatusDot status="online" /> {users.filter(x => x.u.status === "online").length} of {DATA.USERS.length} people working</span>
            <span>·</span>
            <span className="mono">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
            <span>·</span>
            <span className="mono">{new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
          </div>
        </div>
        <div className="row">
          <div className="f-segment">
            {["Today", "Yesterday", "7d", "30d", "Custom"].map(r => (
              <button key={r} className={range === r ? "is-active" : ""} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
          <button className="btn" onClick={onOpenFilter}><Icon name="filter" /> Filters</button>
          <button className="btn" onClick={() => window.toast("Activity exported as CSV", "success")}><Icon name="download" /> Export</button>
        </div>
      </div>

      {/* TODAY AT A GLANCE — plain-English hero */}
      <div className="glance card" style={{ marginBottom: 18, padding: 18, background: "linear-gradient(180deg, var(--surface), var(--surface-2))" }}>
        <div className="row" style={{ marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase" }}>How today is going</div>
          <span className="chip is-success"><span className="dot" style={{ background: "var(--success)" }} /> Live</span>
          <div className="spacer" />
          <button className="btn is-small is-ghost" onClick={() => onNav("alerts")}>
            View {statusCounts.alert || 0} alert{(statusCounts.alert || 0) === 1 ? "" : "s"} <Icon name="arrowR" />
          </button>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <GlancePill icon="zap"     count={statusCounts.crushing || 0} label="Crushing it"    tone="success" />
          <GlancePill icon="check"   count={statusCounts.ontrack || 0}  label="On track"       tone="success" subtle />
          <GlancePill icon="clock"   count={statusCounts.behind || 0}   label="Behind pace"    tone="warning" />
          <GlancePill icon="signal"  count={statusCounts.low || 0}      label="Slow start"     tone="warning" subtle />
          <GlancePill icon="warning" count={statusCounts.alert || 0}    label="Needs attention" tone="danger" />
          <GlancePill icon="minus"   count={statusCounts.off || 0}      label="Off today"      tone="muted" />
        </div>
        <hr className="divider" />
        <div className="row" style={{ flexWrap: "wrap", gap: 24, fontSize: 13 }}>
          <SummaryStat icon="zap"      label="Actions"   value={totalActions.toLocaleString()} sub={`vs. ${(totalActions * .91 | 0).toLocaleString()} avg`} good />
          <SummaryStat icon="phone"    label="Calls"     value={totalCalls}                    sub="1 missed callback owed" />
          <SummaryStat icon="mail"     label="Emails"    value={totalEmails}                   sub="avg reply 47m" good />
          <SummaryStat icon="contract" label="Contracts" value={totalContracts}                sub="4 signed today" good />
          <SummaryStat icon="clock"    label="Avg pickup" value="14s"                          sub="under 25s target" good />
          <SummaryStat icon="star"     label="Bonus pool MTD" value={"$" + totalBonus.toLocaleString()} sub={users.filter(x => x.m.tier.id !== "none").length + " earning"} good />
        </div>
      </div>

      {/* LEADERBOARD */}
      <div className="card is-clean" style={{ marginBottom: 18 }}>
        <div className="card-h">
          <div className="row">
            <Icon name="star" style={{ color: "var(--warning-ink)" }} />
            <div className="card-title">Today's leaders</div>
            <HelpHint>Top performers across the metrics you care about. Tap a tab to re-rank.</HelpHint>
          </div>
          <div className="f-segment">
            {[
              ["score", "Productivity"],
              ["calls", "Most calls"],
              ["emails", "Most emails"],
              ["contracts", "Contracts"],
              ["response", "Fastest reply"],
            ].map(([k, l]) => (
              <button key={k} className={leaderTab === k ? "is-active" : ""} onClick={() => setLeaderTab(k)}>{l}</button>
            ))}
          </div>
        </div>
        <div className="leaders">
          {leaders.map((x, i) => {
            const u = x.u, m = x.m;
            const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : null;
            const metricValue = leaderTab === "score" ? u.score
                              : leaderTab === "calls" ? u.calls
                              : leaderTab === "emails" ? u.emails
                              : leaderTab === "contracts" ? u.contracts
                              : leaderTab === "response" ? fmt.hm(m.actuals.emailReplyMin)
                              : "—";
            const metricLabel = leaderTab === "score" ? "score"
                              : leaderTab === "calls" ? "calls"
                              : leaderTab === "emails" ? "emails"
                              : leaderTab === "contracts" ? "contracts sent"
                              : leaderTab === "response" ? "avg email reply"
                              : "";
            return (
              <button key={u.id} className="leader-row" onClick={() => onOpenEmployee(u.id)}>
                <span className="rank">{medal || ("#" + (i + 1))}</span>
                <Avatar user={u} size="md" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{u.name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{DATA.ROLES[u.role].label}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="num" style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.01em" }}>{metricValue}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{metricLabel}</div>
                </div>
                <StatusPill status={m.status} />
                <BonusBadge tier={m.tier} />
              </button>
            );
          })}
        </div>
      </div>

      {/* HubSpot Insights — Sprint 1 + 2 (Tony 2026-05-23) */}
      <HubspotInsights users={users} />

      {/* People + Live feed */}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 18 }} className="grid-2col">
        <div>
          <div className="row" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.015em" }}>Team today</h2>
            <span className="muted" style={{ fontSize: 12 }}>{users.length} people · sorted by {sortBy}</span>
            <div className="spacer" />
            <div className="f-segment">
              {[["status", "Status"], ["score", "Score"], ["bonus", "Bonus"], ["actions", "Actions"], ["name", "A–Z"]].map(([k, l]) => (
                <button key={k} className={sortBy === k ? "is-active" : ""} onClick={() => setSortBy(k)}>{l}</button>
              ))}
            </div>
          </div>
          <div className="people-grid">
            {users.map(({ u, m }) => (
              <PersonCardV2 key={u.id} user={u} metrics={m} onOpen={onOpenEmployee} />
            ))}
          </div>
        </div>

        <div>
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.015em" }}>Live activity</h2>
            <span className="chip is-success" style={{ height: 18 }}>
              <span className="dot" style={{ background: "var(--success)" }} /> Live
            </span>
            <div className="spacer" />
            <button className="btn is-small is-ghost"><Icon name="refresh" /></button>
          </div>
          <div className="card is-clean live-feed">
            {feed.map((e, i) => {
              const u = DATA.USERS.find(x => x.id === e.userId);
              // Fallback for events without explicit id (Phase 7+ shim
              // builds events from outreach without an id field) — combine
              // ts + userId + index to stay unique within this render.
              const key = e.id || (e.ent?.id) || `${e.time}-${e.userId || 'x'}-${i}`;
              return (
                <button key={key} className="live-row" onClick={() => onOpenEvent(e)}>
                  <CatIcon cat={e.cat} size="sm" />
                  <span className="time">{e.time}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="who">
                      {u && <Avatar user={u} size="sm" showStatus={false} />}
                      <span className="name">{u ? u.first + " " + u.last[0] + "." : "—"}</span>
                    </div>
                    <div className="desc">
                      {e.desc}
                      {e.ent && <> <span className="ent">{e.ent.name}</span></>}
                    </div>
                  </div>
                  <div className="right">
                    {e.isUnusual && <span className="chip is-warning"><Icon name="warning" /> unusual</span>}
                    {e.status === "pending" && <span className="chip is-info">pending</span>}
                    <Icon name="chevR" style={{ width: 14, height: 14, color: "var(--muted-2)" }} />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Bonus pool widget */}
          <button className="card bonus-mini" onClick={() => onNav("bonuses")} style={{ marginTop: 14, width: "100%", textAlign: "left", padding: 14 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <Icon name="star" style={{ color: "var(--warning-ink)" }} />
              <div style={{ fontWeight: 700, fontSize: 14 }}>May bonus pool</div>
              <div className="spacer" />
              <Icon name="arrowR" style={{ color: "var(--muted)" }} />
            </div>
            <div className="num" style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.02em" }}>${totalBonus.toLocaleString()}</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{users.filter(x => x.m.tier.id !== "none").length} people earning · {users.filter(x => x.m.tier.id === "gold" || x.m.tier.id === "platinum").length} hitting Gold or above</div>
            <div style={{ display: "flex", gap: -8 }}>
              {users.filter(x => x.m.tier.id !== "none").sort((a, b) => b.m.bonusMtd - a.m.bonusMtd).slice(0, 8).map((x, i) => (
                <span key={x.u.id} style={{ marginLeft: i === 0 ? 0 : -6 }}>
                  <Avatar user={x.u} size="sm" showStatus={false} />
                </span>
              ))}
            </div>
          </button>
        </div>
      </div>

      <style>{`
        @media (max-width: 1100px) {
          .grid-2col { grid-template-columns: 1fr !important; }
        }
        .leaders { display: flex; flex-direction: column; }
        .leader-row {
          display: grid;
          grid-template-columns: 32px 36px 1fr auto auto auto;
          gap: 14px; align-items: center;
          padding: 12px 18px;
          border-top: 1px solid var(--border);
          text-align: left; width: 100%;
        }
        .leader-row:hover { background: var(--surface-2); }
        .leader-row .rank {
          font-size: 18px; text-align: center;
          color: var(--muted);
          font-family: var(--font-mono); font-weight: 700;
        }
        @media (max-width: 720px) {
          .leader-row { grid-template-columns: 24px 30px 1fr auto; gap: 10px; padding: 10px 14px; }
          .leader-row > .chip:last-of-type { display: none; }
        }
        .bonus-mini { transition: border-color .14s, box-shadow .14s; cursor: pointer; }
        .bonus-mini:hover { border-color: var(--border-strong); box-shadow: var(--shadow-md); }
      `}</style>
    </div>
  );
};

/* ================================================================
   Glance pill — count + label for a status group
   ================================================================ */
function GlancePill({ icon, count, label, tone, subtle }) {
  const colors = {
    success: { bg: subtle ? "var(--surface-2)" : "var(--success-soft)", fg: "var(--success-ink)" },
    warning: { bg: subtle ? "var(--surface-2)" : "var(--warning-soft)", fg: "var(--warning-ink)" },
    danger:  { bg: count > 0 ? "var(--danger-soft)" : "var(--surface-2)", fg: count > 0 ? "var(--danger-ink)" : "var(--muted)" },
    muted:   { bg: "var(--surface-2)", fg: "var(--muted)" },
  };
  const c = colors[tone] || colors.muted;
  const isEmpty = count === 0 && tone !== "danger";
  return (
    <div style={{
      flex: "1 1 140px",
      background: c.bg,
      color: isEmpty ? "var(--muted)" : c.fg,
      padding: "10px 14px",
      borderRadius: 12,
      display: "flex", alignItems: "center", gap: 10,
      minWidth: 0,
      opacity: isEmpty ? .6 : 1,
    }}>
      <Icon name={icon} style={{ width: 18, height: 18 }} />
      <div style={{ minWidth: 0 }}>
        <div className="num" style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1 }}>{count}</div>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", marginTop: 2 }}>{label}</div>
      </div>
    </div>
  );
}

function SummaryStat({ icon, label, value, sub, good }) {
  return (
    <div style={{ minWidth: 110 }}>
      <div className="row" style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 2 }}>
        <Icon name={icon} style={{ width: 12, height: 12 }} /> {label}
      </div>
      <div className="num" style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-.02em" }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: good ? "var(--success-ink)" : "var(--muted)" }}>{sub}</div>}
    </div>
  );
}

/* ================================================================
   Person card v2 — status pill, hours+bonus row, target meters
   ================================================================ */
function PersonCardV2({ user, metrics, onOpen }) {
  const u = user, m = metrics;
  const offline = u.status === "offline";

  return (
    <button className="person-card" onClick={() => onOpen(u.id)} style={{ textAlign: "left" }}>
      {/* Top row: avatar + name + status */}
      <div className="row">
        <Avatar user={u} size="md" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="name" style={{ fontWeight: 700, fontSize: 14 }}>{u.name}</span>
          </div>
          <div className="role">{DATA.ROLES[u.role].label}</div>
        </div>
        <StatusPill status={m.status} />
      </div>

      {/* Hours worked + bonus row */}
      <div className="row" style={{ padding: "8px 10px", background: "var(--surface-2)", borderRadius: 8, fontSize: 12, gap: 12 }}>
        <span className="row" style={{ gap: 4 }}>
          <Icon name="clock" style={{ color: "var(--muted)" }} />
          <span className="num" style={{ fontWeight: 700 }}>{offline ? "—" : fmt.hm(u.online)}</span>
          <span className="muted">/ {m.targets.hoursWorked}h</span>
        </span>
        <div className="spacer" />
        {m.tier.id !== "none" ? (
          <span className="row" style={{ gap: 4, fontWeight: 600, color: m.tier.color }}>
            <Icon name="star" />
            <span className="num">${m.bonusMtd.toLocaleString()}</span>
            <span className="muted" style={{ fontWeight: 500 }}>· {m.tier.label}</span>
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 11.5 }}>No bonus yet</span>
        )}
      </div>

      {/* Targets — 2x2 grid */}
      {!offline && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <TargetMeter compact icon="phone"    label="Calls"    meter={m.today.calls} />
          <TargetMeter compact icon="mail"     label="Emails"   meter={m.today.emails} />
          {m.targets.contracts > 0 && <TargetMeter compact icon="contract" label="Contracts" meter={m.today.contracts} />}
          <TargetMeter
            compact icon="clock" label="Reply time"
            meter={m.today.reply}
            formatValue={v => v + "m"} formatTarget={v => "<" + v + "m"}
          />
          {m.targets.contracts === 0 && (
            <TargetMeter
              compact icon="clock" label="Call pickup"
              meter={m.today.pickup}
              formatValue={v => v + "s"} formatTarget={v => "<" + v + "s"}
            />
          )}
        </div>
      )}

      {offline && u.away && (
        <div style={{ padding: "8px 10px", color: "var(--muted)", fontSize: 12, textAlign: "center", background: "var(--surface-2)", borderRadius: 8 }}>
          {u.away}
        </div>
      )}

      {/* Bottom: actions + score */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, alignItems: "center", borderTop: "1px dashed var(--border)", paddingTop: 10 }}>
        <Mini icon="zap" v={u.actions} l="actions" />
        <Mini icon="phoneMiss" v={m.actuals.missedCalls} l="missed" warn={m.actuals.missedCalls > 1} />
        <Mini icon="signal" v={m.hits + "/5"} l="targets hit" />
        <div style={{ textAlign: "right" }}>
          <div className="num" style={{ fontSize: 18, fontWeight: 700, color: offline ? "var(--muted-2)" : "var(--ink)" }}>
            {offline ? "—" : u.score}
          </div>
          {!offline && <Trend now={u.score} prev={u.prev} />}
        </div>
      </div>
    </button>
  );
}

function Mini({ icon, v, l, warn }) {
  return (
    <div>
      <div className="row" style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".03em" }}>
        <Icon name={icon} style={{ width: 10, height: 10, color: warn ? "var(--danger-ink)" : "var(--muted)" }} />
        {l}
      </div>
      <div className="num" style={{ fontWeight: 700, fontSize: 14, color: warn ? "var(--danger-ink)" : "var(--ink)" }}>{v}</div>
    </div>
  );
}

/* =================================================================
   HubspotInsights — Sprint 1+2+3 unified panel (Tony 2026-05-23)
   Reads window._hsDataCache populated by data-shim. Renders:
     • Sync status + «Open HubSpot» button
     • Tour leaderboard (this month)
     • Conversion funnel (Inquiry → Tour scheduled → Tour done → Contract)
     • Trend sparklines per manager (last 6 months)
     • Coaching alerts (auto-detected anomalies)
     • Pipeline forecasting (expected signs next 30d)
   ================================================================= */
function HubspotInsights({ users }) {
  const hs = window._hsDataCache;
  if (!hs) {
    return (
      <div className="card is-clean" style={{ marginBottom: 18, padding: 16, borderLeft: "3px solid #ff7a59" }}>
        <div className="row">
          <div style={{ fontSize: 14, fontWeight: 700 }}>🎯 HubSpot insights</div>
          <span className="muted" style={{ fontSize: 12 }}>Loading from HubSpot…</span>
        </div>
      </div>
    );
  }
  // Time helpers
  const now = new Date();
  const thisYm = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  const prevYm = (() => {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  })();
  // Last 6 months keys (oldest → newest)
  const last6 = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    last6.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
  }

  // Per-owner aggregates for this month
  const ownerStats = [];
  for (const [email, months] of Object.entries(hs.toursByMonth || {})) {
    const tCur = months[thisYm] || { scheduled: 0, conducted: 0 };
    const tPrev = months[prevYm] || { scheduled: 0, conducted: 0 };
    const signs = ((hs.signsByMonth || {})[email] || {})[thisYm] || 0;
    const ownerObj = Object.values(hs.owners || {}).find(o => o.email === email) || { id: null, name: email, email };
    const conv = tCur.conducted > 0 ? Math.round((signs / tCur.conducted) * 100) : 0;
    ownerStats.push({
      email,
      ownerId: ownerObj.id,
      name: ownerObj.name,
      toursThis: tCur.scheduled,
      toursDone: tCur.conducted,
      toursPrev: tPrev.scheduled,
      signs,
      conversionPct: conv,
      sparkline: last6.map(ym => (months[ym] || { scheduled: 0 }).scheduled),
    });
  }
  // Sort by tours this month, desc
  ownerStats.sort((a, b) => (b.toursThis - a.toursThis) || (b.signs - a.signs));

  // Funnel: aggregate across all owners using dealsByStage + stageMeta.
  // Counts of deals currently sitting in each stage class.
  const stageMeta = hs.stageMeta || {};
  const funnel = { inquiry: 0, scheduledTour: 0, pastTour: 0, signed: 0 };
  for (const stageMap of Object.values(hs.dealsByStage || {})) {
    for (const [stageId, count] of Object.entries(stageMap)) {
      const m = stageMeta[stageId];
      if (!m) continue;
      if (m.isSigned)             funnel.signed += count;
      else if (m.isPastTour)      funnel.pastTour += count;
      else if (m.isScheduledTour) funnel.scheduledTour += count;
      else if (m.isLost)          { /* lost is excluded from funnel */ }
      else                        funnel.inquiry += count;
    }
  }
  const funnelTotal = funnel.inquiry + funnel.scheduledTour + funnel.pastTour + funnel.signed;
  // Stage diagnostics from CF — array of { stageId, label, bucket, deals, isWon }
  // Used for the "stage breakdown" collapsible at the bottom and the
  // "no signs detected" warning. Falsy means CF hasn't synced the new
  // hubspot-sync.js code yet.
  const stageDiag = hs.stageDiagnostics || [];
  const diagByBucket = { signed: [], pastTour: [], scheduledTour: [], inquiry: [], lost: [] };
  for (const d of stageDiag) {
    if (diagByBucket[d.bucket]) diagByBucket[d.bucket].push(d);
  }
  // Warning: looks like the pipeline isn't classifying signed deals
  // correctly. Show a hint to Tony so he can rename stages or report.
  const shouldWarnNoSigns = funnelTotal >= 10 && funnel.signed === 0;

  // Pipeline forecasting — naive historical conv rate.
  const totalToursLast3 = ownerStats.reduce((s, o) => s + (o.sparkline[3] + o.sparkline[4] + o.sparkline[5]), 0) || 1;
  const totalSignsLast3 = Object.values(hs.signsByMonth || {}).reduce((s, m) => {
    return s + last6.slice(3).reduce((acc, ym) => acc + (m[ym] || 0), 0);
  }, 0);
  const historicalConvPct = Math.round((totalSignsLast3 / totalToursLast3) * 100);
  const activeTourPipeline = funnel.scheduledTour + funnel.pastTour;
  const expectedSigns30d = Math.round(activeTourPipeline * (historicalConvPct / 100));

  // Coaching alerts — auto-derived from stats
  const alerts = [];
  for (const o of ownerStats) {
    if (o.toursPrev >= 5 && o.toursThis === 0) {
      alerts.push({ severity: "high", text: `${o.name} — 0 tours this month (was ${o.toursPrev} in ${prevYm}). Possible burnout or process gap.` });
    } else if (o.toursPrev > 0 && o.toursThis > 0 && o.toursThis < o.toursPrev * 0.4) {
      const drop = Math.round((1 - o.toursThis / o.toursPrev) * 100);
      alerts.push({ severity: "med", text: `${o.name} — tour volume down ${drop}% MoM (${o.toursThis} vs ${o.toursPrev}). Worth checking pipeline.` });
    } else if (o.toursDone === 0 && o.toursThis >= 5) {
      alerts.push({ severity: "med", text: `${o.name} — scheduled ${o.toursThis} tours but conducted 0 this month. Confirm outcomes are logged.` });
    } else if (o.conversionPct === 0 && o.toursDone >= 3) {
      alerts.push({ severity: "med", text: `${o.name} — ${o.toursDone} tours conducted, 0 signed contracts. Tour quality / qualification issue?` });
    }
  }
  if (alerts.length === 0) alerts.push({ severity: "low", text: "All managers on pace — nothing flagged this month." });

  // Sync status
  const syncedAt = hs.syncedAt ? new Date(hs.syncedAt) : null;
  const syncedAgo = syncedAt ? Math.round((Date.now() - syncedAt.getTime()) / 60000) : null;
  const syncedFresh = syncedAgo !== null && syncedAgo < 60;
  // HubSpot portal id baked from the API; portal 243651196 is na2.
  const hubspotBase = "https://app-na2.hubspot.com/contacts/243651196";

  return (
    <div className="card is-clean" style={{ marginBottom: 18, padding: 16, borderLeft: "3px solid #ff7a59" }}>
      {/* Header */}
      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>🎯 HubSpot insights</div>
        {syncedAt && (
          <span style={{ fontSize: 11, color: syncedFresh ? "var(--muted)" : "var(--danger-ink)" }}>
            {syncedFresh ? "🟢" : "🟡"} Synced {syncedAgo < 1 ? "just now" : syncedAgo + "m ago"}
          </span>
        )}
        <div className="spacer" />
        <a href={hubspotBase + "/objects/0-3/views/all/list"} target="_blank" rel="noopener" className="btn is-small is-ghost" style={{ textDecoration: "none" }}>
          Open in HubSpot ↗
        </a>
      </div>

      {/* Warning banner — pipeline stages don't seem to include signed/won.
          Likely a custom HubSpot pipeline with unusual stage names.
          Tony can open the diagnostics collapsible below to see what's
          actually being captured and rename stages in HubSpot if needed. */}
      {shouldWarnNoSigns && (
        <div style={{
          padding: "8px 12px", marginBottom: 12, borderRadius: 6,
          background: "rgba(245,158,11,.10)", borderLeft: "3px solid #d97706",
          fontSize: 12, color: "var(--ink)",
        }}>
          <strong>No "signed" deals detected in the pipeline.</strong> Your HubSpot pipeline stages don't match standard closed-won patterns. Open <em>Stage breakdown</em> below to see what's classified where, or rename a stage in HubSpot to include "Contract", "Signed", "Won", or "Active Lease".
        </div>
      )}

      {/* 3-column grid: Funnel + Forecast + Alerts */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.2fr", gap: 14, marginBottom: 14 }}>
        {/* Conversion Funnel */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Conversion funnel · all owners</div>
          {[
            { l: "Inquiry / other", n: funnel.inquiry, c: "#6b7280" },
            { l: "Tour scheduled", n: funnel.scheduledTour, c: "#3b82f6" },
            { l: "Tour done", n: funnel.pastTour, c: "#a16207" },
            { l: "Signed / contract", n: funnel.signed, c: "#16a34a" },
          ].map((row, i) => {
            const pct = funnelTotal > 0 ? Math.round((row.n / funnelTotal) * 100) : 0;
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "100px 1fr 50px", gap: 6, alignItems: "center", marginBottom: 4, fontSize: 12 }}>
                <div style={{ color: "var(--muted)" }}>{row.l}</div>
                <div style={{ background: "var(--surface-2)", borderRadius: 3, height: 14, overflow: "hidden" }}>
                  <div style={{ background: row.c, width: pct + "%", height: "100%", transition: "width 300ms" }} />
                </div>
                <div className="mono" style={{ textAlign: "right", fontWeight: 700, color: "var(--ink)" }}>{row.n}</div>
              </div>
            );
          })}
        </div>

        {/* Forecast */}
        <div style={{ padding: "8px 12px", background: "var(--surface-2)", borderRadius: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Forecast · next 30d</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: "var(--success-ink)" }}>{expectedSigns30d}</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>expected signings</div>
          <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
            {activeTourPipeline} active tours × {historicalConvPct}% historical conv
          </div>
        </div>

        {/* Coaching Alerts */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Coaching alerts</div>
          {alerts.slice(0, 4).map((a, i) => (
            <div key={i} style={{
              padding: "6px 8px", marginBottom: 4, borderRadius: 5, fontSize: 11.5,
              background: a.severity === "high" ? "rgba(239,68,68,.08)" : a.severity === "med" ? "rgba(245,158,11,.08)" : "var(--surface-2)",
              borderLeft: "2px solid " + (a.severity === "high" ? "#dc2626" : a.severity === "med" ? "#d97706" : "var(--border)"),
              color: "var(--ink)",
            }}>
              {a.text}
            </div>
          ))}
        </div>
      </div>

      {/* Tour leaderboard */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Tour leaderboard · this month ({thisYm})</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px 60px 70px 110px", gap: 6, fontSize: 11.5, color: "var(--muted)", padding: "4px 8px", fontWeight: 600 }}>
          <div>Manager</div>
          <div style={{ textAlign: "right" }}>Scheduled</div>
          <div style={{ textAlign: "right" }}>Done</div>
          <div style={{ textAlign: "right" }}>Signs</div>
          <div style={{ textAlign: "right" }}>Conv%</div>
          <div>Trend · last 6mo</div>
        </div>
        {ownerStats.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: "var(--muted)", textAlign: "center" }}>
            No tours data for this month yet.
          </div>
        )}
        {ownerStats.map((o, idx) => (
          <div key={o.email} style={{
            display: "grid", gridTemplateColumns: "1fr 60px 60px 60px 70px 110px", gap: 6,
            padding: "8px 8px", borderTop: "1px solid var(--border)", alignItems: "center", fontSize: 12.5,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 18, height: 18, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                background: idx === 0 ? "#fbbf24" : idx === 1 ? "#d1d5db" : idx === 2 ? "#d97706" : "var(--surface-2)",
                color: idx < 3 ? "#fff" : "var(--muted)", fontSize: 10, fontWeight: 700,
              }}>{idx + 1}</span>
              <span style={{ fontWeight: 600, color: "var(--ink)" }}>{o.name}</span>
              {o.ownerId && (
                <a href={hubspotBase + "/objects/0-3/views/all/list?hubspot_owner_id=" + o.ownerId} target="_blank" rel="noopener" title="Open in HubSpot" style={{ fontSize: 11, color: "var(--muted)", textDecoration: "none" }}>↗</a>
              )}
            </div>
            <div className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{o.toursThis}</div>
            <div className="mono" style={{ textAlign: "right", color: o.toursDone > 0 ? "var(--success-ink)" : "var(--muted)", fontWeight: 700 }}>{o.toursDone}</div>
            <div className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{o.signs}</div>
            <div className="mono" style={{ textAlign: "right", color: o.conversionPct >= 30 ? "var(--success-ink)" : o.conversionPct >= 10 ? "var(--warning-ink)" : "var(--muted)", fontWeight: 700 }}>
              {o.toursDone > 0 ? o.conversionPct + "%" : "—"}
            </div>
            <Sparkline6 data={o.sparkline} />
          </div>
        ))}
      </div>

      {/* Stage breakdown — collapsible. Shows EVERY pipeline stage seen
          (with at least 1 deal) grouped by detected bucket. Lets Tony
          eyeball which stages aren't classified as expected and either
          rename them in HubSpot or report it back so we can extend the
          regex in functions/hubspot-sync.js. */}
      {stageDiag.length > 0 && (
        <details style={{ marginTop: 14, fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)", padding: "6px 0", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>
            🔎 Stage breakdown · how funnel was classified ({stageDiag.length} stages with deals)
          </summary>
          <div style={{ marginTop: 8, padding: "8px 10px", background: "var(--surface-2)", borderRadius: 6 }}>
            {[
              { key: "signed", label: "Signed / contract", color: "#16a34a" },
              { key: "pastTour", label: "Tour done", color: "#a16207" },
              { key: "scheduledTour", label: "Tour scheduled", color: "#3b82f6" },
              { key: "inquiry", label: "Inquiry / other", color: "#6b7280" },
              { key: "lost", label: "Lost / disqualified (excluded from funnel)", color: "#9ca3af" },
            ].map(b => {
              const rows = diagByBucket[b.key];
              if (!rows || rows.length === 0) return null;
              return (
                <div key={b.key} style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, color: b.color, fontSize: 11.5, marginBottom: 4 }}>
                    {b.label} · {rows.reduce((s, r) => s + r.deals, 0)} deals
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {rows.map(r => (
                      <span key={r.stageId} style={{
                        padding: "3px 7px", borderRadius: 4, background: "var(--surface)",
                        border: "1px solid var(--border)", fontSize: 11.5, color: "var(--ink)",
                      }} title={r.isWon ? "Marked as Won by HubSpot" : (r.isClosed ? "Marked as Closed by HubSpot" : "")}>
                        {r.label} <span className="mono" style={{ color: "var(--muted)", marginLeft: 4 }}>{r.deals}</span>
                        {r.isWon && <span style={{ marginLeft: 4 }}>★</span>}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--border)" }}>
              ★ = HubSpot's "Won" flag. Stages with this flag count as signed regardless of name.
              To reclassify, rename the stage in HubSpot or ping engineering to extend the detection regex.
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

// Inline 6-month sparkline (SVG).
function Sparkline6({ data }) {
  if (!data || data.length === 0) return <div style={{ color: "var(--muted)", fontSize: 10 }}>—</div>;
  const max = Math.max(...data, 1);
  const w = 100, h = 22, pad = 1;
  const pts = data.map((v, i) => {
    const x = pad + (i * (w - 2 * pad)) / (data.length - 1);
    const y = pad + (h - 2 * pad) - (v / max) * (h - 2 * pad);
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  const last = data[data.length - 1];
  const prev = data[data.length - 2] || 0;
  const trend = last > prev ? "↗" : last < prev ? "↘" : "→";
  const trendCol = last > prev ? "var(--success-ink)" : last < prev ? "var(--danger-ink)" : "var(--muted)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <svg width={w} height={h} style={{ display: "block" }}>
        <polyline fill="none" stroke="#ff7a59" strokeWidth="1.5" points={pts} />
        {data.map((v, i) => {
          const x = pad + (i * (w - 2 * pad)) / (data.length - 1);
          const y = pad + (h - 2 * pad) - (v / max) * (h - 2 * pad);
          return <circle key={i} cx={x} cy={y} r={1.5} fill="#ff7a59" />;
        })}
      </svg>
      <span style={{ fontSize: 10, color: trendCol, fontWeight: 700 }}>{trend}</span>
    </div>
  );
}
