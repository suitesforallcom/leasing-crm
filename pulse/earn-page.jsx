/* global React, Icon, DATA, Avatar, fmt, metricsFor, PageHelp */

/* ================================================================
   Earn More — employee-facing read-only view of bonus rules.
   Shows each rule as an *opportunity* with personal earnings,
   action shortcuts, and a "what's easiest next" recommendation.
   ================================================================ */

/* Same rule data as admin Bonus Rules page (active rules only).
   `mine` (earned this month per rule) и `nextStep` (suggestion text) до
   wiring реального tracking держим как `0` / placeholder — иначе hero на
   этой странице показывает фейковые $1,495 «earned», а Bonuses leaderboard
   правильно показывает $0 (см. metricsFor → bonusMtd). Расхождение пугало
   операторов. После того, как реальное per-rule отслеживание появится,
   читай counts из metricsFor(me) и подставляй сюда.
   Кэп: `mine: 0` — никаких фантомных earnings. */
const EMP_RULES = [
  { id: "ctr_signed",    cat: "action", icon: "contract",  name: "Sign a new contract",                amount: 100, mine: 0,  iconLabel: "Contracts",     howTo: "Get a tenant to sign a brand-new lease through DocuSign. The bonus triggers the moment the contract is fully countersigned.",                       cta: "Open contracts board", tip: "easy",   nextStep: "" },
  { id: "ctr_renewed",   cat: "action", icon: "refresh",   name: "Renew an existing tenant",           amount: 50,  mine: 0,  iconLabel: "Renewals",      howTo: "Get an existing tenant to renew their lease before expiration. Bonus pays per renewal contract signed.",                                          cta: "View leases expiring", tip: "easy",   nextStep: "" },
  { id: "fb_review",     cat: "action", icon: "star",      name: "Get a Facebook 5★ review",          amount: 25,  mine: 0,  iconLabel: "FB reviews",    howTo: "Ask a happy tenant to leave a 5-star review on Facebook mentioning you or your center. Limit 4 per month per agent.",                            cta: "Send review request",  tip: "easy",   nextStep: "" },
  { id: "google_review", cat: "action", icon: "globe",     name: "Get a Google 5★ review",            amount: 25,  mine: 0,  iconLabel: "Google reviews",howTo: "Same as Facebook but on Google Maps / Business profile. Stacks with FB bonus.",                                                                   cta: "Send review request",  tip: "easy",   nextStep: "" },
  { id: "referral",      cat: "action", icon: "people",    name: "Get a tenant referral",              amount: 200, mine: 0,  iconLabel: "Referrals",     howTo: "An existing tenant refers a prospect who later signs a lease. The bonus is paid to the agent who manages the referring account.",                  cta: "Ask for referral",     tip: "high",   nextStep: "" },
  { id: "multi_year",    cat: "action", icon: "cal",       name: "Sign a 24+ month contract",          amount: 50,  mine: 0,  iconLabel: "Long terms",    howTo: "When a signed contract is 24 months or longer. Stacks with the regular contract-signed bonus.",                                                   cta: "Edit contract terms",  tip: "easy",   nextStep: "" },
  { id: "fast_first",    cat: "action", icon: "zap",       name: "Reply to a lead in under 5 min",     amount: 5,   mine: 0,  iconLabel: "Fast replies", howTo: "Whenever a new inbound lead comes in during your work hours and you reply within 5 minutes. Small reward × many triggers = adds up.",                cta: "Enable mobile alerts", tip: "easy",   nextStep: "" },
  { id: "high_nps",      cat: "action", icon: "check",     name: "Earn an NPS 9–10 from a tenant",     amount: 20,  mine: 0,  iconLabel: "NPS",           howTo: "When a tenant scores you 9 or 10 on the quarterly survey. The agent named in the survey gets the bonus.",                                            cta: "View survey list",     tip: "medium", nextStep: "" },
  { id: "tour_close",    cat: "action", icon: "trendUp",   name: "Close a tour within 7 days",          amount: 30,  mine: 0,  iconLabel: "Fast closes",   howTo: "When a property tour converts to a signed contract within 7 days. Rewards moving deals through the pipeline quickly.",                              cta: "Schedule follow-up",   tip: "medium", nextStep: "" },

  { id: "streak_5d",     cat: "streak", icon: "bolt",      name: "Hit all daily targets 5 days in a row",amount: 50,  mine: 0,  iconLabel: "5-day streaks", howTo: "Five consecutive workdays of hitting all your daily call/email/hours targets. Streak resets after one off-day.",                                   cta: "View today's quests",  tip: "medium", nextStep: "" },
  { id: "gold_triple",   cat: "streak", icon: "sparkle",   name: "Hit Gold tier 3 months in a row",     amount: 300, mine: 0,  iconLabel: "Gold streaks",  howTo: "If you reach Gold tier three months back-to-back, a $300 super-bonus drops on the third payout.",                                                cta: "See bonus progress",   tip: "high",   nextStep: "" },

  { id: "center_goal",   cat: "team",   icon: "building",  name: "Center hits its monthly goal",        amount: 100, mine: 0,  iconLabel: "Team bonus",    howTo: "When the whole center exceeds its monthly revenue target, every employee at that center earns this bonus.",                                       cta: "View center progress", tip: "team",   nextStep: "" },
  { id: "zero_missed",   cat: "team",   icon: "phone",     name: "Zero missed callbacks for a week",    amount: 30,  mine: 0,  iconLabel: "Weekly team",   howTo: "If your center has zero open missed callbacks for an entire workweek, everyone on the team earns it.",                                            cta: "Check open callbacks", tip: "team",   nextStep: "" },

  { id: "pto_used",      cat: "wellness", icon: "cal",     name: "Take 3+ PTO days this quarter",       amount: 50,  mine: 0,  iconLabel: "PTO bonus",     howTo: "Anti-burnout bonus. Take at least 3 days off per quarter to qualify. Pays at quarter close.",                                                       cta: "Request PTO",          tip: "easy",   nextStep: "" },
  { id: "ontime_logoff", cat: "wellness", icon: "clock",   name: "Log off by 6 PM 80% of the month",    amount: 25,  mine: 0,  iconLabel: "Healthy hours", howTo: "Pays at end of month when you log off by 6 PM at least 80% of workdays. Encourages sustainable work hours.",                                       cta: "View log-off times",   tip: "easy",   nextStep: "" },
];

const TIP_META = {
  easy:   { label: "Easy win",  color: "var(--success)",      fg: "var(--success-ink)"  },
  medium: { label: "Medium",    color: "var(--warning)",      fg: "var(--warning-ink)"  },
  high:   { label: "High value",color: "oklch(58% 0.18 300)", fg: "oklch(40% 0.18 300)" },
  team:   { label: "Team",      color: "oklch(60% 0.13 158)", fg: "oklch(40% 0.13 158)" },
};
const CAT_META = {
  action:   { label: "Per-action rewards",  icon: "zap",      color: "var(--accent)" },
  streak:   { label: "Streaks",             icon: "sparkle",  color: "oklch(58% 0.18 300)" },
  team:     { label: "Team bonuses",        icon: "building", color: "oklch(60% 0.13 158)" },
  wellness: { label: "Wellness",            icon: "clock",    color: "oklch(73% 0.15 78)" },
};

window.EarnPage = function EarnPage({ meId = "u1", onBack }) {
  const me = DATA.USERS.find(u => u && u.id === meId);
  if (!me) {
    return (
      <div className="page" style={{ padding: 40, textAlign: "center" }}>
        <div className="muted" style={{ fontSize: 14 }}>No employee linked yet.</div>
      </div>
    );
  }
  const m  = metricsFor(me);
  const [sortBy, setSortBy] = React.useState("amount");

  /* Totals earned this month from per-action triggers (mock) */
  const earnedMtd = EMP_RULES.reduce((s, r) => s + r.amount * r.mine, 0);
  const totalRules = EMP_RULES.length;

  /* Sort rules */
  const sorted = [...EMP_RULES].sort((a, b) => {
    if (sortBy === "amount") return b.amount - a.amount;
    if (sortBy === "earned") return b.amount * b.mine - a.amount * a.mine;
    if (sortBy === "easy")   return (a.tip === "easy" ? 0 : 1) - (b.tip === "easy" ? 0 : 1);
    return 0;
  });

  /* Easiest next to earn */
  const easiest = EMP_RULES.filter(r => r.tip === "easy" && r.mine < 5).slice(0, 3);

  /* Group by category */
  const grouped = ["action", "streak", "team", "wellness"].map(c => ({
    cat: c,
    rules: sorted.filter(r => r.cat === c),
    earned: EMP_RULES.filter(r => r.cat === c).reduce((s, r) => s + r.amount * r.mine, 0),
  }));

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 8 }}>
        {onBack && <button className="btn is-ghost is-small" onClick={onBack}><Icon name="chevL" /> Back</button>}
      </div>

      {/* Header */}
      <div className="page-h">
        <div>
          <h1 className="title">How to earn more <PageHelp pageId="earn" /></h1>
          <div className="subtitle">
            <span>Every bonus rule active in May — what triggers them, how much they pay, and what to do next.</span>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => window.toast("Bonus history exported", "success")}><Icon name="download" /> My history</button>
        </div>
      </div>

      {/* Hero — your earnings so far */}
      <div className="card" style={{ padding: 22, marginBottom: 18, background: `linear-gradient(135deg, ${m.tier.color}10, ${m.tier.color}24)`, borderColor: m.tier.color + "55" }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 24 }}>
          <div style={{ flex: "1 1 240px" }}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 4 }}>You've earned this month</div>
            {/* Hero показывает m.bonusMtd — то же значение, что Bonuses
                leaderboard. earnedMtd выше построен на placeholder `mine: 0`
                в EMP_RULES; пока per-rule tracking не подключён, единый
                источник истины — bonusMtd (tier base + extraFromContracts). */}
            <div className="num" style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-.025em", color: m.tier.color }}>${(m.bonusMtd || 0).toLocaleString()}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              <b style={{ color: "var(--ink-2)" }}>${m.tier.amount.toLocaleString()}</b> {m.tier.label} tier base{(m.extraFromContracts || 0) > 0 ? <> + <b style={{ color: "var(--ink-2)" }}>${(m.extraFromContracts || 0).toLocaleString()}</b> from {m.mtd.contracts} contracts</> : null}
            </div>
          </div>
          <div style={{ flex: "1 1 200px", padding: 14, background: "rgba(255,255,255,.65)", borderRadius: 12 }}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 6 }}>What to do next</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.5, fontWeight: 500, marginBottom: 10 }}>
              {m.nextTier ? <>Hit <b style={{ color: m.nextTier.color }}>{m.nextTier.label}</b> tier for an extra <b className="num" style={{ color: m.nextTier.color }}>${m.nextTier.amount - m.tier.amount}</b></> : "Top tier reached — keep stacking per-action rewards"}
            </div>
            <div style={{ height: 8, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: Math.round(m.progressToNext * 100) + "%", background: m.nextTier?.color || "var(--success)", borderRadius: 999 }} />
            </div>
          </div>
        </div>
      </div>

      {/* Easiest next wins */}
      <div className="card" style={{ marginBottom: 18, padding: 16, background: "linear-gradient(135deg, oklch(97% 0.04 145), oklch(98% 0.02 110))", borderColor: "transparent" }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <Icon name="sparkle" style={{ color: "var(--success-ink)" }} />
          <div style={{ fontWeight: 700, fontSize: 14 }}>3 easiest wins for you right now</div>
          <span className="muted" style={{ fontSize: 11.5 }}>· based on your current state</span>
        </div>
        <div className="easy-grid">
          {easiest.map(r => (
            <div key={r.id} style={{ padding: 14, background: "white", borderRadius: 12, border: "1px solid var(--border)" }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="cat-icon" style={{ background: "var(--success)" }}><Icon name={r.icon} /></span>
                <div className="num" style={{ marginLeft: "auto", fontWeight: 800, fontSize: 18, color: "var(--success-ink)" }}>+${r.amount}</div>
              </div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{r.name}</div>
              {/* nextStep сейчас placeholder — пока tracking не подключён, показываем howTo как описание правила. */}
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.4 }}>{r.nextStep || r.howTo}</div>
              <button className="btn is-small" style={{ marginTop: 10, width: "100%" }} onClick={() => window.toast(r.cta + " — opening…")}>
                {r.cta} <Icon name="arrowR" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Toolbar */}
      <div className="filters">
        <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>Sort by:</span>
        {[["amount", "Highest pay"], ["earned", "Most earned"], ["easy", "Easiest first"]].map(([k, l]) => (
          <button key={k} className={"chip" + (sortBy === k ? " is-accent" : "")} onClick={() => setSortBy(k)} style={{ cursor: "pointer", padding: "6px 12px" }}>{l}</button>
        ))}
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>{totalRules} active rules</span>
      </div>

      {/* Rules by category */}
      <div className="col" style={{ gap: 22 }}>
        {grouped.map(g => {
          const meta = CAT_META[g.cat];
          return (
            <section key={g.cat}>
              <div className="row" style={{ marginBottom: 10 }}>
                <span className="cat-icon" style={{ background: meta.color }}><Icon name={meta.icon} /></span>
                <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, letterSpacing: "-.01em" }}>{meta.label}</h2>
                <div className="spacer" />
                {/* Прячем «+$0 earned» когда per-rule tracking ещё не подключён —
                    иначе четыре блока заголовков один к другому повторяют $0. */}
                {g.earned > 0 ? (
                  <span className="num" style={{ fontWeight: 700, color: meta.color }}>+${g.earned.toLocaleString()} earned</span>
                ) : null}
              </div>
              <div className="earn-grid">
                {g.rules.map(r => <EarnRuleCard key={r.id} r={r} />)}
              </div>
            </section>
          );
        })}
      </div>

      <style>{`
        .easy-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
        }
        .earn-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 12px;
        }
        @media (max-width: 900px) { .easy-grid { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
};

function EarnRuleCard({ r }) {
  const tip = TIP_META[r.tip] || TIP_META.easy;
  const earned = r.amount * r.mine;
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="cat-icon" style={{ background: tip.color }}><Icon name={r.icon} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 }}>{r.name}</div>
        </div>
        <span className="chip" style={{ background: tip.color + "22", color: tip.fg, border: "none", fontWeight: 700, fontSize: 10.5 }}>{tip.label}</span>
      </div>

      <div className="row" style={{ alignItems: "baseline", gap: 6, marginBottom: 8 }}>
        <div className="num" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", color: tip.fg }}>+${r.amount}</div>
        <span className="muted" style={{ fontSize: 11.5 }}>per trigger</span>
      </div>

      {/* Скрываем «You earned» строку когда per-rule tracking даёт 0 —
          иначе оператор видит 15 одинаковых «0× · $0 this month» карточек
          и думает, что страница сломана. */}
      {r.mine > 0 && (
        <div className="row" style={{ padding: "8px 10px", background: "var(--surface-2)", borderRadius: 8, fontSize: 12 }}>
          <span className="muted">You earned:</span>
          <span className="num" style={{ fontWeight: 700 }}>{r.mine}× <span className="muted">·</span> ${earned.toLocaleString()}</span>
          <div className="spacer" />
          <span style={{ fontSize: 10.5, color: "var(--muted)" }}>this month</span>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.45 }}>{r.howTo}</div>

      {/* nextStep — placeholder, скрываем когда пусто (см. EMP_RULES). */}
      {r.nextStep ? (
        <div className="row" style={{ marginTop: 10, padding: "8px 10px", background: "var(--accent-soft)", borderRadius: 8, fontSize: 12, color: "var(--accent-ink)" }}>
          <Icon name="sparkle" style={{ width: 12, height: 12, flexShrink: 0 }} />
          <span style={{ flex: 1, fontWeight: 500 }}>{r.nextStep}</span>
        </div>
      ) : null}

      <button className="btn is-small" style={{ marginTop: 8, width: "100%" }} onClick={() => window.toast(r.cta + " — opening…")}>
        {r.cta} <Icon name="arrowR" />
      </button>
    </div>
  );
}
