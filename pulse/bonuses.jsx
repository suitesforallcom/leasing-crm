/* global React, Icon, DATA, Avatar, Trend, Sparkline, fmt, metricsFor, BONUS_TIERS, StatusPill, BonusBadge, TargetMeter, HelpHint, PageHelp */

/* ================================================================
   Bonuses page — who's earning what + tier rules + history
   ================================================================ */

window.BonusesPage = function BonusesPage({ onOpenEmployee }) {
  const [view, setView] = React.useState("cards"); /* cards | table */
  const [month, setMonth] = React.useState("May 2026");

  const users = DATA.USERS.map(u => ({ u, m: metricsFor(u) }))
    .sort((a, b) => b.m.bonusMtd - a.m.bonusMtd);

  const totalPool = users.reduce((s, x) => s + x.m.bonusMtd, 0);
  const earning   = users.filter(x => x.m.tier.id !== "none").length;
  const gold      = users.filter(x => x.m.tier.id === "gold" || x.m.tier.id === "platinum").length;
  const tierCounts = BONUS_TIERS.map(t => ({
    ...t,
    count: users.filter(x => x.m.tier.id === t.id).length,
  }));

  /* Month-over-month history (mocked) */
  const history = [
    { m: "Dec", v: 3200 }, { m: "Jan", v: 3800 }, { m: "Feb", v: 3400 },
    { m: "Mar", v: 4100 }, { m: "Apr", v: 3900 }, { m: "May", v: totalPool },
  ];

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1 className="title">Bonuses <PageHelp pageId="bonuses" /></h1>
          <div className="subtitle">
            <span><Icon name="star" style={{ color: "var(--warning-ink)", verticalAlign: "-2px" }} /> Performance bonuses earned this month — based on hitting role targets.</span>
          </div>
        </div>
        <div className="row">
          <div className="f-segment">
            {["Apr 2026", "May 2026"].map(mo => (
              <button key={mo} className={month === mo ? "is-active" : ""} onClick={() => setMonth(mo)}>{mo}</button>
            ))}
          </div>
          <button className="btn" onClick={() => window.toast("Bonus payroll exported as CSV — ready for QuickBooks", "success")}><Icon name="download" /> Export payroll</button>
        </div>
      </div>

      {/* Hero stats */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 18 }}>
        <KPI icon="star"    label="Bonus pool MTD" value={"$" + totalPool.toLocaleString()} sub={"vs $3,900 last month"} trend={<Trend now={totalPool} prev={3900} />} />
        <KPI icon="people"  label="People earning" value={earning + " / " + users.length} sub={Math.round(earning / users.length * 100) + "% of team"} />
        <KPI icon="zap"     label="Gold+ earners" value={gold} sub="hitting full targets" />
        <KPI icon="trendUp" label="Avg bonus / person" value={"$" + Math.round(totalPool / Math.max(1, earning)).toLocaleString()} sub="(only earners)" />
      </div>

      {/* Tier breakdown */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>How bonuses work</div>
          <HelpHint>Each role has daily targets for calls, emails, contracts and hours. We measure cumulative hit rate vs. monthly targets and assign a tier.</HelpHint>
          <div className="spacer" />
          <div className="muted" style={{ fontSize: 12 }}>Distribution this month</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${BONUS_TIERS.length}, 1fr)`, gap: 12 }} className="tiers">
          {BONUS_TIERS.map(t => {
            const count = tierCounts.find(x => x.id === t.id).count;
            const pct = Math.round(count / users.length * 100);
            return (
              <div
                key={t.id}
                style={{
                  borderRadius: 12,
                  padding: 14,
                  background: t.id === "none" ? "var(--surface-2)" : "white",
                  border: "1px solid " + (t.id === "none" ? "var(--border)" : t.color),
                  position: "relative", overflow: "hidden",
                }}
              >
                <div style={{ position: "absolute", inset: 0, background: t.id === "none" ? "transparent" : t.color, opacity: .06 }} />
                <div style={{ position: "relative" }}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    {t.id !== "none" && <span style={{ width: 10, height: 10, borderRadius: 999, background: t.color }} />}
                    <span style={{ fontWeight: 700, fontSize: 13, color: t.id === "none" ? "var(--muted)" : t.color }}>{t.label}</span>
                  </div>
                  <div className="num" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", color: t.id === "none" ? "var(--muted)" : "var(--ink)" }}>
                    {t.id === "none" ? "—" : "$" + t.amount}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
                    {t.id === "none" ? "Below 70% targets" : t.id === "bronze" ? "≥ 70% of targets" : t.id === "silver" ? "≥ 85% of targets" : t.id === "gold" ? "100% of targets" : "≥ 110% of targets"}
                  </div>
                  <div className="row" style={{ fontSize: 11, color: "var(--muted)" }}>
                    <span className="num" style={{ fontWeight: 700, color: "var(--ink)" }}>{count}</span>
                    <span>{count === 1 ? "person" : "people"}</span>
                    <span className="spacer" />
                    <span>{pct}%</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Leaderboard */}
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.015em" }}>Bonus leaderboard</h2>
        <span className="muted" style={{ fontSize: 12 }}>· {users.length} people</span>
        <div className="spacer" />
        <div className="f-segment">
          <button className={view === "cards" ? "is-active" : ""} onClick={() => setView("cards")}>Cards</button>
          <button className={view === "table" ? "is-active" : ""} onClick={() => setView("table")}>Table</button>
        </div>
      </div>

      {view === "cards" ? (
        <div className="people-grid">
          {users.map(({ u, m }, i) => (
            <BonusCard key={u.id} user={u} metrics={m} rank={i + 1} onOpen={onOpenEmployee} />
          ))}
        </div>
      ) : (
        <div className="card is-clean">
          <table className="table">
            <thead>
              <tr>
                <th>Rank</th><th>Employee</th><th>Tier</th><th>Bonus MTD</th>
                <th>Calls</th><th>Emails</th><th>Contracts</th><th>Days</th>
                <th>Next tier</th><th></th>
              </tr>
            </thead>
            <tbody>
              {users.map(({ u, m }, i) => (
                <tr key={u.id} className="is-clickable" onClick={() => onOpenEmployee(u.id)}>
                  <td className="mono" style={{ fontWeight: 700 }}>#{i + 1}</td>
                  <td><div className="row"><Avatar user={u} size="sm" /><div><div style={{ fontWeight: 600 }}>{u.name}</div><div className="muted" style={{ fontSize: 11 }}>{DATA.ROLES[u.role].label}</div></div></div></td>
                  <td><BonusBadge tier={m.tier} /></td>
                  <td className="num" style={{ fontWeight: 700, fontSize: 16 }}>${m.bonusMtd.toLocaleString()}</td>
                  <td className="num">{m.mtd.calls} <span className="muted" style={{ fontSize: 11 }}>/{m.monthTargets.calls}</span></td>
                  <td className="num">{m.mtd.emails} <span className="muted" style={{ fontSize: 11 }}>/{m.monthTargets.emails}</span></td>
                  <td className="num">{m.mtd.contracts}{m.targets.contracts > 0 && <span className="muted" style={{ fontSize: 11 }}> /{Math.round(m.monthTargets.contracts)}</span>}</td>
                  <td className="num">{m.mtd.daysWorked} <span className="muted" style={{ fontSize: 11 }}>/{m.mtd.daysExpected}</span></td>
                  <td>
                    {m.nextTier ? (
                      <div style={{ minWidth: 100 }}>
                        <div className="muted" style={{ fontSize: 10.5, marginBottom: 2 }}>to {m.nextTier.label}</div>
                        <div style={{ height: 6, background: "var(--surface-3)", borderRadius: 999 }}>
                          <span style={{ display: "block", height: "100%", width: Math.round(m.progressToNext * 100) + "%", background: m.nextTier.color, borderRadius: 999 }} />
                        </div>
                      </div>
                    ) : <span className="chip is-success">maxed</span>}
                  </td>
                  <td><Icon name="chevR" style={{ color: "var(--muted)" }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* History */}
      <div className="card" style={{ marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Monthly bonus history</div>
          <HelpHint>Total amount paid out each month, across the whole team.</HelpHint>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 160 }}>
          {history.map((h, i) => {
            const max = Math.max(...history.map(x => x.v));
            const isLast = i === history.length - 1;
            return (
              <div key={h.m} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div className="num" style={{ fontWeight: 700, fontSize: 13, color: isLast ? "var(--accent-ink)" : "var(--ink-2)" }}>${h.v.toLocaleString()}</div>
                <div style={{
                  width: "100%",
                  height: Math.max(8, (h.v / max) * 110) + "px",
                  background: isLast ? "var(--accent)" : "var(--surface-3)",
                  borderRadius: "6px 6px 2px 2px",
                  position: "relative",
                }} />
                <div className="muted" style={{ fontSize: 12 }}>{h.m}</div>
              </div>
            );
          })}
        </div>
      </div>

      <style>{`
        @media (max-width: 980px) {
          .tiers { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 640px) {
          .tiers { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
    </div>
  );
};

/* ================================================================
   Bonus card — per-person large card showing tier, amount, next tier
   ================================================================ */
function BonusCard({ user, metrics, rank, onOpen }) {
  const u = user, m = metrics;
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;
  return (
    <button className="person-card" onClick={() => onOpen(u.id)} style={{ textAlign: "left", borderColor: m.tier.id === "platinum" || m.tier.id === "gold" ? m.tier.color : "var(--border)" }}>
      <div className="row">
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 16, color: "var(--muted-2)", minWidth: 26 }}>
          {medal || "#" + rank}
        </span>
        <Avatar user={u} size="md" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{u.name}</div>
          <div className="role">{DATA.ROLES[u.role].label}</div>
        </div>
        <BonusBadge tier={m.tier} />
      </div>

      {/* Big bonus number */}
      <div style={{
        padding: "12px 14px",
        background: m.tier.id !== "none" ? "linear-gradient(135deg, " + m.tier.color + "11, " + m.tier.color + "22)" : "var(--surface-2)",
        borderRadius: 10,
        textAlign: "center",
      }}>
        <div className="num" style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.025em", color: m.tier.id !== "none" ? m.tier.color : "var(--muted)" }}>
          ${m.bonusMtd.toLocaleString()}
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
          {m.tier.id === "none" ? "No bonus yet" : `Earned this month · base $${m.tier.amount}${m.extraFromContracts > 0 ? " + $" + m.extraFromContracts + " per contract" : ""}`}
        </div>
      </div>

      {/* Targets progress (monthly) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <TargetMeter
          compact icon="phone" label="Calls"
          meter={{ value: m.mtd.calls, target: m.monthTargets.calls, pct: Math.round(m.mtd.calls / m.monthTargets.calls * 100), hit: m.mtd.calls >= m.monthTargets.calls, tone: m.mtd.calls >= m.monthTargets.calls ? "success" : m.mtd.calls >= m.monthTargets.calls * .7 ? "warning" : "danger" }}
        />
        <TargetMeter
          compact icon="mail" label="Emails"
          meter={{ value: m.mtd.emails, target: m.monthTargets.emails, pct: Math.round(m.mtd.emails / m.monthTargets.emails * 100), hit: m.mtd.emails >= m.monthTargets.emails, tone: m.mtd.emails >= m.monthTargets.emails ? "success" : m.mtd.emails >= m.monthTargets.emails * .7 ? "warning" : "danger" }}
        />
        {m.targets.contracts > 0 && (
          <TargetMeter
            compact icon="contract" label="Contracts"
            meter={{ value: m.mtd.contracts, target: Math.round(m.monthTargets.contracts), pct: Math.round(m.mtd.contracts / m.monthTargets.contracts * 100), hit: m.mtd.contracts >= m.monthTargets.contracts, tone: m.mtd.contracts >= m.monthTargets.contracts ? "success" : m.mtd.contracts >= m.monthTargets.contracts * .7 ? "warning" : "danger" }}
          />
        )}
        <TargetMeter
          compact icon="cal" label="Days worked"
          meter={{ value: m.mtd.daysWorked, target: m.mtd.daysExpected, pct: Math.round(m.mtd.daysWorked / m.mtd.daysExpected * 100), hit: m.mtd.daysWorked >= m.mtd.daysExpected, tone: m.mtd.daysWorked >= m.mtd.daysExpected ? "success" : m.mtd.daysWorked >= m.mtd.daysExpected * .85 ? "warning" : "danger" }}
        />
      </div>

      {/* Progress to next tier */}
      {m.nextTier && (
        <div>
          <div className="row" style={{ fontSize: 11.5, marginBottom: 4 }}>
            <span className="muted" style={{ whiteSpace: "nowrap" }}>To {m.nextTier.label}</span>
            <div className="spacer" />
            <span className="num" style={{ fontWeight: 700, color: m.nextTier.color, whiteSpace: "nowrap" }}>+${m.nextTier.amount - m.tier.amount}</span>
          </div>
          <div style={{ height: 6, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: Math.round(m.progressToNext * 100) + "%", background: m.nextTier.color, borderRadius: 999 }} />
          </div>
        </div>
      )}
    </button>
  );
}
