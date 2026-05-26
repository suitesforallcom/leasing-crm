/* global React, Icon, DATA, Avatar, CenterChip, Trend, Sparkline, fmt, metricsFor, PageHelp */

/* ================================================================
   Centers — branch comparison for the owner / admin
   Shows each center's headcount, output, productivity, bonuses.
   ================================================================ */

window.CentersPage = function CentersPage({ onOpenEmployee }) {
  const [view, setView] = React.useState("table"); /* table | cards | people */
  const [sortBy, setSortBy] = React.useState("score");
  const [centerFilter, setCenterFilter] = React.useState("all");

  /* aggregate per center */
  const byCenter = DATA.CENTERS.map(c => {
    const users = DATA.USERS.filter(u => u.centerId === c.id);
    const usersMetrics = users.map(u => ({ u, m: metricsFor(u) }));
    const activeCount = users.filter(u => u.status === "online").length;
    const totalActions = users.reduce((s, u) => s + u.actions, 0);
    const totalCalls = users.reduce((s, u) => s + u.calls, 0);
    const totalEmails = users.reduce((s, u) => s + u.emails, 0);
    const totalContracts = users.reduce((s, u) => s + u.contracts, 0);
    const scored = users.filter(u => u.score > 0);
    const avgScore = scored.length ? Math.round(scored.reduce((s, u) => s + u.score, 0) / scored.length) : 0;
    const totalBonus = usersMetrics.reduce((s, x) => s + x.m.bonusMtd, 0);
    const totalHours = users.reduce((s, u) => s + u.online, 0);
    const onTimeCount = users.filter(u => u.login).length;
    const mvp = usersMetrics.sort((a, b) => b.u.score - a.u.score)[0]?.u;
    const unusual = usersMetrics.filter(x => x.u.unusual || x.m.status.id === "alert").length;
    /* simulated weekly trend (last 7 days output) */
    const trend = [60, 72, 68, 80, 75, 88, 82].map(v => Math.round(v * (avgScore / 80 || 1)));
    return {
      ...c, users, usersMetrics, activeCount, totalActions, totalCalls, totalEmails, totalContracts,
      avgScore, totalBonus, totalHours, onTimeCount, mvp, unusual, trend,
    };
  });

  /* totals across all centers */
  const grand = {
    headcount: DATA.USERS.length,
    active: DATA.USERS.filter(u => u.status === "online").length,
    actions: byCenter.reduce((s, c) => s + c.totalActions, 0),
    bonus: byCenter.reduce((s, c) => s + c.totalBonus, 0),
  };

  const ranked = [...byCenter].sort((a, b) => b.avgScore - a.avgScore);

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1 className="title">Centers <PageHelp pageId="centers" /></h1>
          <div className="subtitle">
            <span>{byCenter.length} branches · {grand.headcount} people · {grand.active} working now</span>
            <span>·</span>
            <span className="num">${grand.bonus.toLocaleString()} bonus pool MTD</span>
          </div>
        </div>
        <div className="row">
          <div className="f-segment">
            <button className={view === "table" ? "is-active" : ""} onClick={() => setView("table")}>Compare table</button>
            <button className={view === "cards" ? "is-active" : ""} onClick={() => setView("cards")}>Cards</button>
            <button className={view === "people" ? "is-active" : ""} onClick={() => setView("people")}>People</button>
          </div>
          <button className="btn" onClick={() => window.toast("Filters coming")}><Icon name="filter" /> Filters</button>
          <button className="btn" onClick={() => window.toast("Centers report exported", "success")}><Icon name="download" /> Export</button>
        </div>
      </div>

      {/* PRIMARY: Side-by-side comparison table */}
      {view === "table" && (
        <div className="card is-clean">
          <div className="card-h">
            <div className="row">
              <Icon name="compare" style={{ color: "var(--accent)" }} />
              <div className="card-title">Side-by-side · {byCenter.length} centers</div>
            </div>
            <span className="muted" style={{ fontSize: 12 }}>Best in row highlighted</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <CompareTable rows={byCenter} />
          </div>
        </div>
      )}

      {/* SECONDARY: Cards view */}
      {view === "cards" && (
        <div className="centers-grid">
          {byCenter.map(c => (
            <CenterCard key={c.id} c={c} ranked={ranked} onOpenEmployee={onOpenEmployee} />
          ))}
        </div>
      )}

      {/* CROSS-CENTER PEOPLE TABLE */}
      {view === "people" && (
        <CrossCenterPeople
          centerFilter={centerFilter}
          onCenterFilterChange={setCenterFilter}
          sortBy={sortBy}
          onSortChange={setSortBy}
          onOpenEmployee={onOpenEmployee}
        />
      )}

      {/* Cross-center MVP leaderboard — always visible */}
      <div className="card is-clean" style={{ marginTop: 18 }}>
        <div className="card-h">
          <div className="row">
            <Icon name="star" style={{ color: "var(--warning-ink)" }} />
            <div className="card-title">Top performers across all centers</div>
          </div>
          <span className="muted" style={{ fontSize: 11.5 }}>By productivity score · today</span>
        </div>
        <div>
          {DATA.USERS
            .filter(u => u.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 8)
            .map((u, i) => {
              const m = metricsFor(u);
              return (
                <button
                  key={u.id}
                  onClick={() => onOpenEmployee(u.id)}
                  className="row"
                  style={{ width: "100%", padding: "12px 18px", borderTop: i === 0 ? "none" : "1px solid var(--border)", textAlign: "left" }}
                >
                  <span className="num" style={{ width: 32, fontWeight: 800, fontSize: 16, color: i < 3 ? "var(--warning-ink)" : "var(--muted-2)" }}>
                    {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1)}
                  </span>
                  <Avatar user={u} size="md" />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>{u.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{DATA.ROLES[u.role].label}</div>
                  </div>
                  <CenterChip center={u.center} />
                  <div className="num" style={{ fontSize: 18, fontWeight: 800, minWidth: 36, textAlign: "right" }}>{u.score}</div>
                  <span style={{ minWidth: 50 }}>{<Trend now={u.score} prev={u.prev} />}</span>
                  <span className="chip" style={{ background: m.tier.color + "22", color: m.tier.color, border: "none", fontWeight: 600 }}>${m.bonusMtd.toLocaleString()}</span>
                </button>
              );
            })}
        </div>
      </div>

      <style>{`
        .centers-grid {
          display: grid; gap: 14px;
          grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        }
      `}</style>
    </div>
  );
};

/* ================================================================
   Cross-center People table — every employee across all branches
   ================================================================ */
function CrossCenterPeople({ centerFilter, onCenterFilterChange, sortBy, onSortChange, onOpenEmployee }) {
  let users = DATA.USERS.map(u => ({ u, m: metricsFor(u) }));
  if (centerFilter !== "all") users = users.filter(x => x.u.centerId === centerFilter);

  const sorts = {
    score:     (a, b) => b.u.score - a.u.score,
    name:      (a, b) => a.u.name.localeCompare(b.u.name),
    center:    (a, b) => a.u.center.name.localeCompare(b.u.center.name),
    bonus:     (a, b) => b.m.bonusMtd - a.m.bonusMtd,
    calls:     (a, b) => b.u.calls - a.u.calls,
    emails:    (a, b) => b.u.emails - a.u.emails,
    contracts: (a, b) => b.u.contracts - a.u.contracts,
    response:  (a, b) => a.m.actuals.emailReplyMin - b.m.actuals.emailReplyMin,
    hours:     (a, b) => b.u.online - a.u.online,
  };
  users.sort(sorts[sortBy] || sorts.score);

  /* Group by center for the grouped view */
  const grouped = {};
  DATA.CENTERS.forEach(c => { grouped[c.id] = { center: c, users: users.filter(x => x.u.centerId === c.id) }; });

  return (
    <div>
      {/* Center filter chips */}
      <div className="filters">
        <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>Center:</span>
        <button className={"chip" + (centerFilter === "all" ? " is-accent" : "")} onClick={() => onCenterFilterChange("all")} style={{ cursor: "pointer", padding: "6px 12px" }}>
          All centers
          <span className="num" style={{ marginLeft: 4, fontWeight: 700 }}>{DATA.USERS.length}</span>
        </button>
        {DATA.CENTERS.map(c => (
          <button
            key={c.id}
            onClick={() => onCenterFilterChange(c.id)}
            className="chip"
            style={{
              cursor: "pointer", padding: "6px 12px",
              background: centerFilter === c.id ? c.color + "22" : "var(--surface-2)",
              color: centerFilter === c.id ? c.color : "var(--ink-2)",
              borderColor: centerFilter === c.id ? c.color + "55" : "var(--border)",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 999, background: c.color }} />
            {c.name}
            <span className="num" style={{ marginLeft: 4, fontWeight: 700 }}>{DATA.USERS.filter(u => u.centerId === c.id).length}</span>
          </button>
        ))}
      </div>

      <div className="card is-clean">
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <SortHeader k="name"      label="Employee"   sortBy={sortBy} onChange={onSortChange} />
                <SortHeader k="center"    label="Center"     sortBy={sortBy} onChange={onSortChange} />
                <th>Status</th>
                <SortHeader k="score"     label="Score"      sortBy={sortBy} onChange={onSortChange} right />
                <SortHeader k="hours"     label="Hours"      sortBy={sortBy} onChange={onSortChange} right />
                <SortHeader k="calls"     label="Calls"      sortBy={sortBy} onChange={onSortChange} right />
                <SortHeader k="emails"    label="Emails"     sortBy={sortBy} onChange={onSortChange} right />
                <SortHeader k="contracts" label="Contracts"  sortBy={sortBy} onChange={onSortChange} right />
                <SortHeader k="response"  label="Reply"      sortBy={sortBy} onChange={onSortChange} right />
                <SortHeader k="bonus"     label="Bonus MTD"  sortBy={sortBy} onChange={onSortChange} right />
              </tr>
            </thead>
            <tbody>
              {users.map(({ u, m }, i) => (
                <tr key={u.id} className="is-clickable" onClick={() => onOpenEmployee(u.id)}>
                  <td>
                    <div className="row">
                      <span className="mono muted" style={{ width: 24, fontSize: 11 }}>#{i + 1}</span>
                      <Avatar user={u} size="sm" />
                      <div>
                        <div style={{ fontWeight: 600 }}>{u.name}</div>
                        <div className="muted" style={{ fontSize: 11 }}>{DATA.ROLES[u.role].label}</div>
                      </div>
                    </div>
                  </td>
                  <td><CenterChip center={u.center} compact /></td>
                  <td><StatusPillSmall status={m.status} /></td>
                  <td className="num" style={{ textAlign: "right", fontWeight: 700 }}>{u.score || "—"}</td>
                  <td className="num muted" style={{ textAlign: "right" }}>{u.online > 0 ? fmt.hm(u.online) : "—"}</td>
                  <td className="num" style={{ textAlign: "right" }}>{u.calls}<span className="muted" style={{ fontSize: 10.5 }}>/{m.targets.calls}</span></td>
                  <td className="num" style={{ textAlign: "right" }}>{u.emails}<span className="muted" style={{ fontSize: 10.5 }}>/{m.targets.emails}</span></td>
                  <td className="num" style={{ textAlign: "right" }}>{u.contracts}{m.targets.contracts > 0 && <span className="muted" style={{ fontSize: 10.5 }}>/{m.targets.contracts}</span>}</td>
                  <td className="num muted" style={{ textAlign: "right" }}>{m.actuals.emailReplyMin > 0 ? m.actuals.emailReplyMin + "m" : "—"}</td>
                  <td className="num" style={{ textAlign: "right", fontWeight: 700, color: m.tier.color }}>${m.bonusMtd.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Grouped by center */}
      {centerFilter === "all" && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>Grouped by center</div>
          <div className="col" style={{ gap: 14 }}>
            {DATA.CENTERS.map(c => {
              const list = grouped[c.id].users;
              const totalBonus = list.reduce((s, x) => s + x.m.bonusMtd, 0);
              const avgScore = list.length ? Math.round(list.filter(x => x.u.score > 0).reduce((s, x) => s + x.u.score, 0) / Math.max(1, list.filter(x => x.u.score > 0).length)) : 0;
              return (
                <div key={c.id} className="card is-clean">
                  <div className="row" style={{ padding: "12px 18px", background: c.color + "11", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ width: 28, height: 28, borderRadius: 8, background: c.color, color: "white", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 11 }}>{c.short}</span>
                    <div style={{ fontWeight: 700 }}>{c.name}</div>
                    <span className="muted">·</span>
                    <span>{list.length} people</span>
                    <div className="spacer" />
                    <span className="num">Avg score <b>{avgScore || "—"}</b></span>
                    <span className="muted">·</span>
                    <span className="num" style={{ color: c.color, fontWeight: 700 }}>${totalBonus.toLocaleString()}</span>
                  </div>
                  <div>
                    {list.map((x, i) => (
                      <button
                        key={x.u.id}
                        onClick={() => onOpenEmployee(x.u.id)}
                        className="row"
                        style={{ width: "100%", padding: "10px 18px", borderTop: i === 0 ? "none" : "1px solid var(--border)", textAlign: "left" }}
                      >
                        <Avatar user={x.u} size="sm" />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{x.u.name}</div>
                          <div className="muted" style={{ fontSize: 11 }}>{DATA.ROLES[x.u.role].label}</div>
                        </div>
                        <StatusPillSmall status={x.m.status} />
                        <span className="num muted" style={{ fontSize: 11, minWidth: 60, textAlign: "right" }}>{x.u.calls}c · {x.u.emails}e</span>
                        <span className="num" style={{ fontWeight: 700, minWidth: 36, textAlign: "right" }}>{x.u.score || "—"}</span>
                        <span className="num" style={{ fontWeight: 700, color: x.m.tier.color, minWidth: 60, textAlign: "right" }}>${x.m.bonusMtd.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SortHeader({ k, label, sortBy, onChange, right }) {
  const active = sortBy === k;
  return (
    <th style={{ textAlign: right ? "right" : "left", cursor: "pointer", color: active ? "var(--ink)" : undefined }} onClick={() => onChange(k)}>
      {label}{active && " ↓"}
    </th>
  );
}

function StatusPillSmall({ status }) {
  const tone = status.tone;
  const cls = "chip is-" + (tone === "success" ? "success" : tone === "warning" ? "warning" : tone === "danger" ? "danger" : "");
  return <span className={cls} style={{ fontSize: 10.5, padding: "1px 6px" }}>{status.label}</span>;
}

/* ================================================================
   Center card — single branch summary
   ================================================================ */
function CenterCard({ c, ranked, onOpenEmployee }) {
  const rank = ranked.findIndex(x => x.id === c.id) + 1;
  const isWinner = rank === 1;
  return (
    <div className="card" style={{
      padding: 0, overflow: "hidden",
      borderColor: isWinner ? c.color : "var(--border)",
    }}>
      {/* Color stripe header */}
      <div style={{ padding: 16, background: `linear-gradient(135deg, ${c.color}18, ${c.color}30)`, borderBottom: "1px solid " + c.color + "33" }}>
        <div className="row" style={{ marginBottom: 4 }}>
          <span style={{
            width: 38, height: 38, borderRadius: 10,
            background: c.color, color: "white",
            display: "grid", placeItems: "center",
            fontWeight: 800, fontSize: 13,
          }}>{c.short}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{c.name}</div>
            <div className="muted" style={{ fontSize: 11.5 }}>{c.address} · {c.properties} properties</div>
          </div>
          {isWinner && <span className="chip" style={{ background: "var(--warning-soft)", color: "var(--warning-ink)", border: "none", fontWeight: 700 }}>🏆 #1</span>}
          {!isWinner && <span className="chip" style={{ background: "var(--surface-2)", color: "var(--muted)", border: "none" }}>#{rank}</span>}
        </div>
      </div>

      {/* Stats */}
      <div style={{ padding: 16 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Productivity</div>
            <div className="num" style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.02em" }}>{c.avgScore || "—"}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Bonus pool</div>
            <div className="num" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", color: c.color }}>${c.totalBonus.toLocaleString()}</div>
          </div>
        </div>

        <div style={{ height: 40 }}>
          <Sparkline values={c.trend} color={c.color} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: 12 }}>
          <StatCell icon="people"   v={c.activeCount + "/" + c.users.length} l="active" />
          <StatCell icon="phone"    v={c.totalCalls}     l="calls" />
          <StatCell icon="mail"     v={c.totalEmails}    l="emails" />
          <StatCell icon="contract" v={c.totalContracts} l="contracts" />
        </div>

        {/* MVP */}
        {c.mvp && (
          <button
            onClick={() => onOpenEmployee(c.mvp.id)}
            className="row"
            style={{ width: "100%", marginTop: 12, padding: "10px 12px", background: "var(--surface-2)", borderRadius: 10, textAlign: "left" }}
          >
            <Avatar user={c.mvp} size="sm" />
            <div style={{ flex: 1 }}>
              <div className="muted" style={{ fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Center MVP</div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{c.mvp.name}</div>
            </div>
            <div className="num" style={{ fontWeight: 800 }}>{c.mvp.score}</div>
            <Icon name="arrowR" style={{ color: "var(--muted)" }} />
          </button>
        )}

        {/* Team avatars */}
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>Team ({c.users.length})</div>
          <div style={{ display: "flex" }}>
            {c.users.map((u, i) => (
              <button key={u.id} onClick={() => onOpenEmployee(u.id)} title={u.name} style={{ marginLeft: i === 0 ? 0 : -6 }}>
                <Avatar user={u} size="sm" />
              </button>
            ))}
          </div>
        </div>

        {c.unusual > 0 && (
          <div className="row" style={{ marginTop: 12, padding: "8px 10px", background: "var(--warning-soft)", color: "var(--warning-ink)", borderRadius: 8, fontSize: 12 }}>
            <Icon name="warning" /><span>{c.unusual} {c.unusual === 1 ? "person needs" : "people need"} attention</span>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCell({ icon, v, l }) {
  return (
    <div style={{ textAlign: "left" }}>
      <div className="row" style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".03em" }}>
        <Icon name={icon} style={{ width: 10, height: 10 }} />{l}
      </div>
      <div className="num" style={{ fontWeight: 700, fontSize: 14 }}>{v}</div>
    </div>
  );
}

/* ================================================================
   Compare table — full side-by-side
   ================================================================ */
function CompareTable({ rows }) {
  const metrics = [
    { key: "users",         label: "Headcount",       fmt: r => r.users.length },
    { key: "activeCount",   label: "Active now",      fmt: r => r.activeCount + " / " + r.users.length, higher: true },
    { key: "avgScore",      label: "Avg productivity",fmt: r => r.avgScore || "—", higher: true },
    { key: "totalActions",  label: "Actions",         fmt: r => r.totalActions.toLocaleString(), higher: true },
    { key: "totalCalls",    label: "Calls",           fmt: r => r.totalCalls, higher: true },
    { key: "totalEmails",   label: "Emails",          fmt: r => r.totalEmails, higher: true },
    { key: "totalContracts",label: "Contracts",       fmt: r => r.totalContracts, higher: true },
    { key: "totalBonus",    label: "Bonus pool MTD",  fmt: r => "$" + r.totalBonus.toLocaleString(), higher: true },
    { key: "onTimeCount",   label: "On-time logins",  fmt: r => r.onTimeCount + " / " + r.users.length, higher: true },
    { key: "unusual",       label: "Needs attention", fmt: r => r.unusual, higher: false },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: `200px repeat(${rows.length}, minmax(140px, 1fr))`, minWidth: 540 }}>
      <div style={{ padding: 14, borderBottom: "1px solid var(--border)" }} />
      {rows.map(r => (
        <div key={r.id} style={{ padding: 14, borderBottom: "1px solid var(--border)", borderLeft: "1px solid var(--border)", background: "var(--surface-2)" }}>
          <div className="row">
            <span style={{ width: 8, height: 8, borderRadius: 999, background: r.color }} />
            <span style={{ fontWeight: 700, fontSize: 13 }}>{r.name}</span>
          </div>
        </div>
      ))}
      {metrics.map(metric => {
        const vals = rows.map(r => Number(r[metric.key]) || 0);
        const target = metric.higher ? Math.max(...vals) : Math.min(...vals);
        const allEqual = vals.every(v => v === vals[0]);
        return (
          <React.Fragment key={metric.key}>
            <div style={{ padding: "14px 14px", borderBottom: "1px solid var(--border)", color: "var(--muted)", fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 600, display: "flex", alignItems: "center" }}>
              {metric.label}
            </div>
            {rows.map(r => {
              const winner = !allEqual && Number(r[metric.key]) === target;
              return (
                <div key={r.id} style={{
                  padding: "14px",
                  borderBottom: "1px solid var(--border)",
                  borderLeft: "1px solid var(--border)",
                  background: winner ? "var(--success-soft)" : "transparent",
                  position: "relative",
                }}>
                  <div className="num" style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-.01em" }}>{metric.fmt(r)}</div>
                  {winner && <Icon name="check" style={{ position: "absolute", top: 12, right: 12, width: 12, height: 12, color: "var(--success-ink)" }} />}
                </div>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}
