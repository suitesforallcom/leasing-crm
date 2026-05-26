/* global React, Icon, DATA, Avatar, HelpHint, PageHelp */

/* ================================================================
   Bonus Rules — admin page for configuring how bonuses work
   ================================================================
   Inspired by commercial-leasing commission structures used at
   coworking / serviced-office operators: per-action rewards +
   tiered monthly bonuses + team & wellness bonuses.
   ================================================================ */

const BONUS_RULES_SEED = [
  /* ===== Per-action rewards (the bread and butter) ===== */
  { id: "ctr_signed",   cat: "action", icon: "contract", name: "Contract signed",                        amount: 100, who: ["agent","manager"], short: "Per new lease signed by tenant", desc: "Triggered when a new tenant signs a fresh contract through Pulse/DocuSign. The agent who initiated the envelope receives the bonus.", monthCount: 38, active: true,  industry: "Common at Regus / WeWork-style operators — flat per-deal commission on top of base." },
  { id: "ctr_renewed",  cat: "action", icon: "refresh",  name: "Contract renewed",                       amount: 50,  who: ["agent","manager"], short: "Existing tenant renews lease", desc: "When a tenant signs a renewal of an existing contract before expiration. Smaller than new-sign bonus but encourages retention.", monthCount: 14, active: true,  industry: "Retention rewards are 50–70% of new-contract commission." },
  { id: "fb_review",    cat: "action", icon: "star",     name: "Facebook 5★ review",                     amount: 25,  who: ["agent","manager"], short: "Tenant posts 5★ review on Facebook", desc: "When a tenant posts a verified 5-star review mentioning the agent or center. Capped at 4 per agent per month to prevent gaming.", monthCount: 8,  active: true,  industry: "Customer-advocacy bonus — popular in hospitality + serviced offices." },
  { id: "google_review",cat: "action", icon: "globe",    name: "Google 5★ review",                       amount: 25,  who: ["agent","manager"], short: "Tenant posts 5★ Google review", desc: "Same as FB but for Google. Reviews must be linked to the agent who handled the deal.", monthCount: 6,  active: true,  industry: "Stacks with FB bonus — both can trigger for the same tenant." },
  { id: "referral",     cat: "action", icon: "people",   name: "Tenant referral signed",                 amount: 200, who: ["agent","manager"], short: "Referred lead becomes a tenant", desc: "When a current tenant refers a prospect that signs a contract, the referring tenant's account-manager gets a bonus.", monthCount: 3,  active: true,  industry: "Highest-paying per-action bonus — referrals close 3× faster." },
  { id: "multi_year",   cat: "action", icon: "cal",      name: "Multi-year contract (24m+)",             amount: 50,  who: ["agent","manager"], short: "Stacks with contract-signed bonus", desc: "Extra reward when the signed contract has a term ≥ 24 months. Rewards locking in long-term revenue.", monthCount: 11, active: true,  industry: "Term-length kickers are standard in commercial leasing." },
  { id: "fast_first",   cat: "action", icon: "zap",      name: "First-response under 5 min",             amount: 5,   who: ["agent"],            short: "Per inbound lead", desc: "When a fresh inbound lead is replied to within 5 minutes during work hours. Small but adds up — average 87 triggers per month across the team.", monthCount: 87, active: true,  industry: "Speed-to-lead is the single biggest conversion driver." },
  { id: "high_nps",     cat: "action", icon: "check",    name: "Tenant NPS 9–10",                        amount: 20,  who: ["agent","manager"], short: "Per quarterly survey result", desc: "When a tenant scores 9 or 10 on the quarterly NPS survey and credits the agent. Capped at 1 per tenant per quarter.", monthCount: 4,  active: false, industry: "Tying pay to satisfaction is the WeWork / Regus playbook." },
  { id: "tour_close",   cat: "action", icon: "trendUp",  name: "Tour-to-signature in 7 days",            amount: 30,  who: ["agent"],            short: "Fast conversion bonus", desc: "When a property tour converts to a signed contract within 7 days. Rewards moving deals through the pipeline.", monthCount: 9,  active: true,  industry: "Speed conversion bonus — common in flex-office." },

  /* ===== Streak rewards ===== */
  { id: "streak_5d",    cat: "streak", icon: "bolt",     name: "5-day target streak",                    amount: 50,  who: ["agent","manager","accountant"], short: "5 workdays of hitting all daily targets", desc: "Encourages consistency. Streak resets after one off-day. Pays out when the 5th day completes.", monthCount: 24, active: true,  industry: "Streaks compound: 3-month adherence is 70%+ at top operators." },
  { id: "gold_triple",  cat: "streak", icon: "sparkle",  name: "Gold tier ×3 in a row",                  amount: 300, who: ["agent","manager"], short: "3 consecutive Gold months", desc: "Super-bonus when the employee reaches Gold tier three months back-to-back. Big lump-sum on the 3rd payout.", monthCount: 2,  active: true,  industry: "Quarterly cumulative bonus — used to retain top performers." },

  /* ===== Team / center rewards ===== */
  { id: "center_goal",  cat: "team",   icon: "building", name: "Center hits monthly goal",               amount: 100, who: ["all-center"], short: "Per person at the winning center", desc: "When a whole center beats its monthly revenue target, every employee at that center earns this bonus (regardless of individual performance).", monthCount: 22, active: true,  industry: "Team bonuses build accountability and collaboration." },
  { id: "zero_missed",  cat: "team",   icon: "phone",    name: "Zero missed-callback week",              amount: 30,  who: ["all-center"], short: "Per person, weekly", desc: "If a center has zero missed callbacks for an entire workweek, everyone on the team gets paid this. Resets each Monday.", monthCount: 8,  active: false, industry: "Anti-leak bonus — punishes inattention without naming people." },

  /* ===== Wellness / culture ===== */
  { id: "pto_used",     cat: "wellness", icon: "cal",   name: "Quarterly PTO used",                      amount: 50,  who: ["all"],         short: "Per quarter, anyone who takes 3+ PTO days", desc: "Rewards taking time off. Anti-burnout signal. Pays at the end of each quarter.", monthCount: 6,  active: true,  industry: "Increasingly common at modern employers — reduces churn." },
  { id: "ontime_logoff",cat: "wellness", icon: "clock", name: "On-time logoff streak",                  amount: 25,  who: ["all"],         short: "80%+ of month logged off by 6 PM", desc: "Pays out when employee logs off by 6 PM at least 80% of workdays in a month. Encourages sustainable hours.", monthCount: 9,  active: true,  industry: "Pioneered at human-first workplaces." },
];

const CAT_META = {
  action:   { label: "Per-action rewards",  icon: "zap",      color: "var(--accent)",        desc: "Triggered by specific completed actions. Best for shaping behavior day-to-day." },
  streak:   { label: "Streak rewards",      icon: "sparkle",  color: "oklch(58% 0.18 300)",  desc: "Triggered by consecutive achievements. Builds consistency." },
  team:     { label: "Team & center",       icon: "building", color: "oklch(60% 0.13 158)",  desc: "Triggered by whole-center performance. Everyone on the team gets paid equally." },
  wellness: { label: "Wellness & culture",  icon: "clock",    color: "oklch(73% 0.15 78)",   desc: "Triggered by healthy work patterns. Anti-burnout and culture-building." },
};

window.BonusRulesPage = function BonusRulesPage({ onOpenEmployee }) {
  const [rules, setRules] = React.useState(BONUS_RULES_SEED);
  const [editing, setEditing] = React.useState(null);

  /* aggregates */
  const active = rules.filter(r => r.active);
  const monthlyTotal = active.reduce((s, r) => s + r.amount * r.monthCount, 0);
  const lastMonthTotal = Math.round(monthlyTotal * 0.91);
  const byCat = ["action", "streak", "team", "wellness"].map(c => ({
    cat: c,
    rules: rules.filter(r => r.cat === c),
    total: rules.filter(r => r.cat === c && r.active).reduce((s, r) => s + r.amount * r.monthCount, 0),
  }));

  function toggle(id) {
    setRules(rs => rs.map(r => r.id === id ? { ...r, active: !r.active } : r));
    window.toast("Rule toggled — changes will apply from next month");
  }
  function saveEdit(updated) {
    setRules(rs => rs.map(r => r.id === updated.id ? updated : r));
    setEditing(null);
    window.toast("Rule updated", "success");
  }

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1 className="title">Bonus rules <PageHelp pageId="bonusrules" /></h1>
          <div className="subtitle">
            <span>Configure how employees earn bonuses — per action, by streak, by team, by wellness.</span>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => window.toast("Rules exported as CSV", "success")}><Icon name="download" /> Export rules</button>
          <button className="btn is-primary" onClick={() => window.toast("New rule wizard — coming soon")}><Icon name="plus" /> Add rule</button>
        </div>
      </div>

      {/* Summary strip */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 18 }}>
        <KPILite icon="zap"     label="Active rules"     value={active.length + " / " + rules.length}            sub="enabled" />
        <KPILite icon="star"    label="Est. monthly cost" value={"$" + monthlyTotal.toLocaleString()}              sub={"vs $" + lastMonthTotal.toLocaleString() + " last month"} />
        <KPILite icon="people"  label="Eligible employees" value={DATA.USERS.length}                              sub="all roles supported" />
        <KPILite icon="trendUp" label="Avg per employee"  value={"$" + Math.round(monthlyTotal / DATA.USERS.length).toLocaleString()} sub="per month" />
      </div>

      {/* Explainer banner */}
      <div className="card" style={{ marginBottom: 18, padding: 16, background: "linear-gradient(135deg, oklch(97% 0.03 264), oklch(98% 0.02 290))", borderColor: "transparent" }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <Icon name="sparkle" style={{ color: "var(--accent)" }} />
          <div style={{ fontWeight: 700, fontSize: 14 }}>How bonus rules work</div>
        </div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.55, maxWidth: 720 }}>
          Every rule is a <b>trigger</b> + <b>amount</b> + <b>who's eligible</b>. When the trigger fires (a contract is signed, a 5-star review is posted, a streak is hit, a center crushes its goal), Pulse credits the bonus to the right person. Bonuses stack — a single signed contract can fire <i>contract signed</i> + <i>multi-year kicker</i> + <i>tour-to-close</i> all at once. Inactive rules don't trigger but stay configurable.
        </div>
        <div className="row" style={{ marginTop: 10, gap: 16, fontSize: 12, color: "var(--muted)" }}>
          <span><b style={{ color: "var(--ink-2)" }}>Reviewed nightly.</b> Bonuses recalculate every night at 2 AM.</span>
          <span>·</span>
          <span><b style={{ color: "var(--ink-2)" }}>Capped per rule.</b> Caps prevent gaming (e.g. max 4 review bonuses / month).</span>
          <span>·</span>
          <span><b style={{ color: "var(--ink-2)" }}>Audit-logged.</b> Every trigger creates an entry on the recipient's profile.</span>
        </div>
      </div>

      {/* Categories */}
      <div className="col" style={{ gap: 22 }}>
        {byCat.map(b => {
          const meta = CAT_META[b.cat];
          return (
            <section key={b.cat}>
              <div className="row" style={{ marginBottom: 12 }}>
                <span className="cat-icon lg" style={{ background: meta.color }}><Icon name={meta.icon} /></span>
                <div>
                  <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, letterSpacing: "-.01em" }}>{meta.label}</h2>
                  <div className="muted" style={{ fontSize: 12 }}>{meta.desc}</div>
                </div>
                <div className="spacer" />
                <span className="muted" style={{ fontSize: 11.5 }}>{b.rules.filter(r => r.active).length}/{b.rules.length} active</span>
                <span className="num" style={{ fontWeight: 700, fontSize: 14, color: meta.color }}>${b.total.toLocaleString()}/mo</span>
              </div>
              <div className="rule-grid">
                {b.rules.map(r => (
                  <RuleCard key={r.id} r={r} onToggle={toggle} onEdit={setEditing} />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {/* Industry comparison + best practices */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 22 }} className="rules-bottom">
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <Icon name="building" style={{ color: "var(--muted)" }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>How peers in flex-office structure this</div>
          </div>
          <div className="col" style={{ gap: 10, fontSize: 13 }}>
            <BenchmarkRow what="New contract commission" you="$100 flat" peers="$50–250 / 0.5–2 mo rent" tip="Yours is conservative — fine if you also pay tiered monthly bonus on top." />
            <BenchmarkRow what="Renewal bonus"             you="$50 flat"  peers="50–70% of new-deal amount" tip="Roughly aligned with industry — retention is cheaper than acquisition." />
            <BenchmarkRow what="Review bonuses"            you="$25 each"  peers="$10–30 each, capped" tip="Right in the middle. Cap prevents gaming." />
            <BenchmarkRow what="Referral bonus"            you="$200"      peers="$150–500" tip="Healthy — referrals close 3× faster than cold leads." />
            <BenchmarkRow what="Team bonuses"              you="$100/pp"   peers="Mixed — many skip team bonuses" tip="Team bonus builds collaboration — keep it." />
          </div>
        </div>
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <Icon name="check" style={{ color: "var(--success-ink)" }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>Design principles to keep in mind</div>
          </div>
          <div className="col" style={{ gap: 10, fontSize: 13 }}>
            <Principle title="Reward the action, not the metric." text="A bonus for 'send 20 emails' encourages quantity over quality. Pay for the outcome (signed contract, happy review)." />
            <Principle title="Stack instead of replace." text="Per-action + monthly tiers + streak + team = each rule pulls a different behaviour. Skipping any reduces the whole." />
            <Principle title="Cap every rule." text="No bonus rule should be open-ended. Caps prevent gaming and keep payroll predictable." />
            <Principle title="Pay quickly." text="The Hooked / variable-reward research is clear: shorter loops reinforce harder. Aim to pay within 14 days." />
            <Principle title="Make rules public." text="Hidden formulas breed mistrust. The Bonus rules page is for employees to read, not just for owners to configure." />
          </div>
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <RuleEditModal rule={editing} onClose={() => setEditing(null)} onSave={saveEdit} />
      )}

      <style>{`
        .rule-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 12px;
        }
        @media (max-width: 900px) {
          .rules-bottom { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
};

/* ============ Single rule card ============ */
function RuleCard({ r, onToggle, onEdit }) {
  const meta = CAT_META[r.cat];
  const total = r.amount * r.monthCount;
  return (
    <div className="card" style={{ padding: 14, opacity: r.active ? 1 : .6, borderColor: r.active ? meta.color + "33" : "var(--border)" }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="cat-icon" style={{ background: r.active ? meta.color : "var(--muted-2)" }}><Icon name={r.icon} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{r.name}</span>
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>{r.short}</div>
        </div>
        <button
          className="btn is-small is-ghost"
          onClick={() => onEdit(r)}
          title="Edit rule"
        ><Icon name="edit" /></button>
        <button
          onClick={() => onToggle(r.id)}
          style={{
            width: 36, height: 20, borderRadius: 999,
            background: r.active ? meta.color : "var(--surface-3)",
            position: "relative", cursor: "pointer", transition: ".15s",
            border: "none",
          }}
          title={r.active ? "Disable rule" : "Enable rule"}
        >
          <span style={{
            position: "absolute", top: 2, left: r.active ? 18 : 2,
            width: 16, height: 16, borderRadius: 999, background: "white",
            transition: ".15s", boxShadow: "0 1px 3px rgba(0,0,0,.15)",
          }} />
        </button>
      </div>

      <div className="row" style={{ alignItems: "baseline", gap: 6, marginBottom: 8 }}>
        <div className="num" style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", color: r.active ? meta.color : "var(--muted)" }}>${r.amount}</div>
        <span className="muted" style={{ fontSize: 11.5 }}>per trigger · {r.who.length === 1 ? r.who[0] + "s only" : r.who.join(", ")}</span>
      </div>

      <div className="row" style={{ padding: "8px 10px", background: "var(--surface-2)", borderRadius: 8, fontSize: 12 }}>
        <span className="muted">This month:</span>
        <span className="num" style={{ fontWeight: 700 }}>{r.monthCount} triggers</span>
        <div className="spacer" />
        <span className="num" style={{ fontWeight: 700, color: r.active ? meta.color : "var(--muted)" }}>${total.toLocaleString()}</span>
      </div>

      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 11.5, color: "var(--muted)", cursor: "pointer", listStyle: "none", fontWeight: 600 }}>How it works ▾</summary>
        <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>{r.desc}</div>
        {r.industry && (
          <div style={{ marginTop: 6, padding: 8, background: "var(--surface-2)", borderRadius: 6, fontSize: 11.5, color: "var(--muted-2)", fontStyle: "italic" }}>
            <Icon name="building" style={{ width: 11, height: 11, verticalAlign: "-2px" }} /> {r.industry}
          </div>
        )}
      </details>
    </div>
  );
}

/* ============ Edit modal ============ */
function RuleEditModal({ rule, onClose, onSave }) {
  const [draft, setDraft] = React.useState(rule);
  return (
    <>
      <div className="scrim is-open" onClick={onClose} />
      <div className="drawer is-open" style={{ width: 460 }}>
        <div className="drawer-h">
          <Icon name="edit" />
          <div className="title">Edit rule · {rule.name}</div>
          <button className="x" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="drawer-b">
          <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>Bonus amount</div>
            <div className="form-input" style={{ padding: "10px 14px" }}>
              <span style={{ fontWeight: 800, fontSize: 18, color: "var(--muted-2)" }}>$</span>
              <input
                type="number"
                value={draft.amount}
                onChange={e => setDraft({ ...draft, amount: Number(e.target.value) })}
                style={{ fontSize: 18, fontWeight: 700 }}
              />
              <span className="muted" style={{ fontSize: 12 }}>per trigger</span>
            </div>
          </div>
          <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>Who's eligible</div>
            <div className="chip-group">
              {["agent", "manager", "accountant", "admin"].map(role => {
                const sel = draft.who.includes(role);
                return (
                  <button
                    key={role}
                    className={"chip" + (sel ? " is-accent" : "")}
                    onClick={() => setDraft({ ...draft, who: sel ? draft.who.filter(x => x !== role) : [...draft.who, role] })}
                    style={{ cursor: "pointer", padding: "6px 12px" }}
                  >{role}</button>
                );
              })}
            </div>
          </div>
          <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>Short description (shown on card)</div>
            <div className="form-input">
              <input value={draft.short} onChange={e => setDraft({ ...draft, short: e.target.value })} />
            </div>
          </div>
          <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>How it works</div>
            <textarea className="form-textarea" rows={4} value={draft.desc} onChange={e => setDraft({ ...draft, desc: e.target.value })} />
          </div>
          <div style={{ padding: "12px 0" }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>Forecast</div>
            <div className="row" style={{ padding: 10, background: "var(--accent-soft)", borderRadius: 8, fontSize: 13 }}>
              <Icon name="trendUp" style={{ color: "var(--accent-ink)" }} />
              <span>At <b className="num">${draft.amount}</b> × <b className="num">{rule.monthCount}</b> triggers, this rule will cost <b className="num" style={{ color: "var(--accent-ink)" }}>${(draft.amount * rule.monthCount).toLocaleString()}</b> per month.</span>
            </div>
          </div>
        </div>
        <div style={{ padding: 14, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn is-primary" onClick={() => onSave(draft)}>Save rule</button>
        </div>
      </div>
    </>
  );
}

/* ============ KPI / Benchmark / Principle helpers ============ */
function KPILite({ icon, label, value, sub }) {
  return (
    <div className="kpi">
      <div className="kpi-head"><Icon name={icon} />{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-foot"><span>{sub}</span></div>
    </div>
  );
}

function BenchmarkRow({ what, you, peers, tip }) {
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px dashed var(--border)" }}>
      <div className="row" style={{ marginBottom: 2 }}>
        <span style={{ fontWeight: 600 }}>{what}</span>
        <div className="spacer" />
        <span className="num" style={{ fontSize: 12, fontWeight: 700 }}>{you}</span>
      </div>
      <div className="row muted" style={{ fontSize: 11.5 }}>
        <span style={{ flex: 1 }}>Industry: {peers}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--accent-ink)", marginTop: 4 }}>↳ {tip}</div>
    </div>
  );
}

function Principle({ title, text }) {
  return (
    <div className="row" style={{ alignItems: "flex-start", padding: "6px 0", gap: 10 }}>
      <Icon name="check" style={{ color: "var(--success-ink)", marginTop: 2, flexShrink: 0 }} />
      <div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 1, lineHeight: 1.45 }}>{text}</div>
      </div>
    </div>
  );
}
