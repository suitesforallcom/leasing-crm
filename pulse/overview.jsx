/* global React, Icon, DATA, Avatar, CatIcon, StatusDot, KPI, Sparkline, Trend, fmt, parseTime, metricsFor, StatusPill, TargetMeter, BonusBadge, HelpHint, PageHelp */

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
          <h1 className="title">Activity Center <PageHelp pageId="overview" /></h1>
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

      {/* HubSpot Insights moved to its own page (Tony 2026-05-24) —
          see /pulse/hubspot.jsx + Sidebar «HubSpot» nav item. */}

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
