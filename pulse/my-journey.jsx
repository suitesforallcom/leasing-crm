/* global React, Icon, DATA, Avatar, StatusPill, BonusBadge, CenterChip, Trend, Sparkline, fmt, metricsFor */

/* ================================================================
   My Journey — long-term personal history & motivation page
   ================================================================
   Built on patterns from 10 motivation books — see notes below.
   ================================================================ */

window.MyJourneyPage = function MyJourneyPage({ meId = "u1", onBack }) {
  const me = DATA.USERS.find(u => u.id === meId);
  const m = metricsFor(me);

  /* Long-term goal hierarchy — Grit */
  const goals = {
    year:    { label: "Top 3 Leasing Agent in Texas region",        progress: 0.61, target: "Dec 2026", drives: "career growth" },
    quarter: { label: "Close 30 contracts in Q2",                   progress: 0.78, current: 38, target: 30,    unit: "contracts" },
    month:   { label: "Hit Gold tier in May",                       progress: 0.84, current: m.bonusMtd, target: 500, unit: "$ bonus" },
    today:   { label: "Send the Greentree Yoga proposal",           progress: 0.5,  due: "by 5 PM" },
  };

  /* Mood check-in */
  const [mood, setMood] = React.useState(null);

  /* Mock past-12-months data */
  const months = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May"];
  const monthlyData = months.map((mo, i) => {
    const seed = (i * 13 + 7) % 11;
    const factor = i === months.length - 1 ? .92 : 1; /* MTD so smaller */
    return {
      month: mo, current: i === months.length - 1,
      calls:     Math.round((280 + seed * 12 + i * 4) * factor),
      emails:    Math.round((520 + seed * 18 + i * 8) * factor),
      contracts: Math.max(28, Math.round((32 + seed - 2 + i * .5) * factor)),
      bonus:     Math.round((320 + seed * 28 + i * 18) * factor),
      score:     Math.min(99, 72 + seed + (i / 2 | 0)),
    };
  });
  /* mark new PRs */
  monthlyData.forEach((m, i) => {
    if (i > 0) {
      ["calls", "emails", "contracts", "bonus", "score"].forEach(k => {
        if (m[k] > Math.max(...monthlyData.slice(0, i).map(x => x[k]))) m[k + "PR"] = true;
      });
    }
  });

  /* Weekly history — last 12 weeks */
  const weeks = Array.from({ length: 12 }, (_, i) => {
    const seed = (i * 7 + 13) % 13;
    return {
      label: `W${i + 1}`,
      score: Math.min(99, 70 + seed + i),
      calls: 50 + seed + i,
      emails: 110 + seed * 3 + i * 2,
      contracts: 4 + (seed % 4),
      pr: i === 10 || i === 6,
    };
  });

  /* Year heatmap — 52 weeks × 7 days */
  const heatmap = buildHeatmap();

  /* Skill mastery — Peak / Drive */
  const skills = [
    { name: "Cold outreach",  level: 7, max: 10, xp: 720, color: "oklch(58% 0.16 30)" },
    { name: "Contract speed", level: 8, max: 10, xp: 856, color: "oklch(58% 0.16 264)" },
    { name: "Response time",  level: 9, max: 10, xp: 945, color: "oklch(58% 0.16 150)" },
    { name: "Deal closing",   level: 6, max: 10, xp: 612, color: "oklch(58% 0.16 300)" },
    { name: "Tenant care",    level: 8, max: 10, xp: 812, color: "oklch(58% 0.16 200)" },
  ];

  /* Records timeline */
  const records = [
    { date: "May 12",  icon: "phone",    label: "Most calls in a day",       value: 24, isNew: true },
    { date: "May 8",   icon: "mail",     label: "Most emails in a day",      value: 47 },
    { date: "May 5",   icon: "bolt",     label: "Highest day score",         value: 96 },
    { date: "Apr 28",  icon: "contract", label: "Most contracts in a week",  value: 9 },
    { date: "Apr 14",  icon: "clock",    label: "Fastest email reply",       value: "8m" },
    { date: "Mar 30",  icon: "star",     label: "First Gold tier bonus",     value: "$500" },
  ];

  /* Achievement timeline (earned) */
  const achievements = [
    { date: "May 14", title: "Speed Demon",     desc: "Replies under 30m for a week",   icon: "zap",       color: "oklch(58% 0.16 264)" },
    { date: "May 1",  title: "First Bonus",     desc: "Earned May's bronze tier",       icon: "star",      color: "oklch(60% 0.10 50)" },
    { date: "Apr 22", title: "Early Bird",      desc: "Logged in before 8 AM x10",      icon: "login",     color: "oklch(60% 0.14 200)" },
    { date: "Mar 28", title: "Closer",          desc: "Sent 30+ contracts in a month",  icon: "contract",  color: "oklch(58% 0.18 300)" },
    { date: "Feb 11", title: "Onboarded",       desc: "Completed Pulse training",       icon: "check",     color: "oklch(60% 0.13 158)" },
  ];

  /* Reflection journal — Mindset / Grit */
  const journal = [
    { date: "Yesterday",   prompt: "What's one thing I did well?",     entry: "Closed Bluestone renewal 6 days early." },
    { date: "May 14",      prompt: "Where can I grow this week?",       entry: "Cold call open-rate — only 38%, want 55%." },
    { date: "May 12",      prompt: "What surprised me today?",          entry: "ABC Medical wants 36-month, not 24." },
  ];

  return (
    <div className="page">
      {/* Header */}
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn is-ghost is-small" onClick={onBack}>
          <Icon name="chevL" /> Back to My Day
        </button>
      </div>

      <div className="page-h">
        <div>
          <h1 className="title">My Journey</h1>
          <div className="subtitle">
            <span>Your story so far — weeks, months, years of progress.</span>
          </div>
        </div>
        <div className="row">
          <div className="f-segment">
            <button className="is-active">Year</button>
            <button onClick={() => window.toast("Quarter view coming")}>Quarter</button>
            <button onClick={() => window.toast("All time view coming")}>All time</button>
          </div>
        </div>
      </div>

      {/* ============ Identity + mood check-in (Atomic Habits + Drive) ============ */}
      <div className="card" style={{ padding: 22, marginBottom: 18, background: "linear-gradient(135deg, oklch(96% 0.04 280), oklch(97% 0.03 220))" }}>
        <div className="row" style={{ gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <Avatar user={me} size="xl" />
          <div style={{ flex: 1, minWidth: 240 }}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase" }}>Your identity</div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em", marginTop: 2 }}>I'm a Leasing Pro · L{Math.floor(6320 / 1000)}</div>
            <div className="muted" style={{ fontSize: 13.5, marginTop: 2 }}>
              "Every contract you send is a vote for the agent you're becoming."
              <span style={{ display: "block", marginTop: 4 }}>— inspired by Atomic Habits</span>
            </div>
          </div>
          <div style={{ flex: "0 0 auto", minWidth: 220 }}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 6 }}>How are you today?</div>
            <div className="row" style={{ gap: 6 }}>
              {[
                { id: "great", label: "Great", emoji: "🚀" },
                { id: "good",  label: "Good",  emoji: "😊" },
                { id: "meh",   label: "Meh",   emoji: "😐" },
                { id: "rough", label: "Rough", emoji: "😓" },
              ].map(o => (
                <button
                  key={o.id}
                  onClick={() => { setMood(o.id); window.toast(`Logged "${o.label}" — thanks for checking in`); }}
                  style={{
                    padding: "6px 10px", borderRadius: 8,
                    background: mood === o.id ? "var(--accent)" : "white",
                    color: mood === o.id ? "white" : "var(--ink-2)",
                    border: "1px solid " + (mood === o.id ? "var(--accent)" : "var(--border)"),
                    fontSize: 12, fontWeight: 600,
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                    minWidth: 50,
                  }}
                >
                  <span style={{ fontSize: 16 }}>{o.emoji}</span>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ============ Long-term goal hierarchy (Grit) ============ */}
      <div className="card" style={{ marginBottom: 18, padding: 18 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <Icon name="trendUp" style={{ color: "var(--accent)" }} />
          <div style={{ fontWeight: 700, fontSize: 14 }}>Your goal stack</div>
          <span className="muted" style={{ fontSize: 11.5 }}>· Year → Quarter → Month → Today</span>
        </div>
        <div className="goal-grid">
          <GoalBox label="2026 goal"    title={goals.year.label}    progress={goals.year.progress}    sub={`Target: ${goals.year.target}`}                    tone="oklch(58% 0.18 300)" big />
          <GoalBox label="Q2 goal"      title={goals.quarter.label} progress={goals.quarter.progress} sub={`${goals.quarter.current} / ${goals.quarter.target} ${goals.quarter.unit}`} tone="oklch(58% 0.16 264)" />
          <GoalBox label="May goal"     title={goals.month.label}   progress={goals.month.progress}   sub={`$${goals.month.current.toLocaleString()} / $${goals.month.target}`}        tone="oklch(60% 0.13 158)" />
          <GoalBox label="Today"        title={goals.today.label}   progress={goals.today.progress}   sub={goals.today.due}                                   tone="oklch(73% 0.15 78)"   isToday />
        </div>
        <div className="row" style={{ marginTop: 14, padding: "8px 12px", background: "var(--accent-soft)", color: "var(--accent-ink)", borderRadius: 8, fontSize: 12.5 }}>
          <Icon name="sparkle" /><span><b>Yet language:</b> You haven't hit Gold tier <i>yet</i> — you're 84% of the way. Sixteen more days to grow.</span>
        </div>
      </div>

      {/* ============ Year consistency heatmap (Atomic Habits — don't break the chain) ============ */}
      <div className="card" style={{ marginBottom: 18, padding: 18 }}>
        <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <Icon name="cal" style={{ color: "var(--muted)" }} />
          <div style={{ fontWeight: 700, fontSize: 14 }}>Consistency · last 12 months</div>
          <span className="chip is-success">242 active days · 18 PRs</span>
          <div className="spacer" />
          <div className="row" style={{ fontSize: 11, color: "var(--muted)", gap: 4 }}>
            <span>Less</span>
            {[0, 1, 2, 3, 4].map(i => (
              <span key={i} style={{ width: 10, height: 10, borderRadius: 2, background: heatmapColor(i / 4), display: "inline-block" }} />
            ))}
            <span>More</span>
          </div>
        </div>
        <YearHeatmap data={heatmap} />
      </div>

      {/* ============ Monthly metrics (Grit + Peak — long-term progression) ============ */}
      <div className="card" style={{ marginBottom: 18, padding: 18 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <Icon name="bars" style={{ color: "var(--accent)" }} />
          <div style={{ fontWeight: 700, fontSize: 14 }}>Last 12 months</div>
          <span className="muted" style={{ fontSize: 11.5 }}>· effort compounds</span>
        </div>
        <div className="month-charts">
          <MonthChart label="Calls"     color="oklch(60% 0.16 30)"  data={monthlyData} valueKey="calls" prKey="callsPR" />
          <MonthChart label="Emails"    color="oklch(60% 0.16 264)" data={monthlyData} valueKey="emails" prKey="emailsPR" />
          <MonthChart label="Contracts" color="oklch(60% 0.16 300)" data={monthlyData} valueKey="contracts" prKey="contractsPR" />
          <MonthChart label="Bonus ($)" color="oklch(60% 0.16 150)" data={monthlyData} valueKey="bonus" prKey="bonusPR" prefix="$" />
        </div>
      </div>

      {/* ============ Skill tree (Drive — mastery + Peak — deliberate practice) ============ */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h">
          <div className="row">
            <Icon name="sparkle" style={{ color: "var(--accent)" }} />
            <div className="card-title">Your mastery tree</div>
          </div>
          <span className="muted" style={{ fontSize: 11.5 }}>Skill levels build with deliberate practice</span>
        </div>
        <div style={{ padding: 18 }}>
          <div className="col" style={{ gap: 14 }}>
            {skills.map(s => <SkillRow key={s.name} s={s} />)}
          </div>
          <div className="row" style={{ marginTop: 14, padding: "10px 12px", background: "var(--surface-2)", borderRadius: 8, fontSize: 12.5 }}>
            <Icon name="bolt" style={{ color: "var(--warning-ink)" }} />
            <span><b>Effort × Skill = Achievement</b> — Angela Duckworth. Your weakest skill is <b>Deal closing</b>. Practice it and your trajectory steepens.</span>
          </div>
        </div>
      </div>

      {/* ============ Weekly history + Records timeline (Atomic Habits + Peak) ============ */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 18 }} className="journey-2col">
        {/* Weekly history */}
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <Icon name="signal" style={{ color: "var(--muted)" }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>Last 12 weeks</div>
          </div>
          <table className="table" style={{ fontSize: 12.5 }}>
            <thead>
              <tr><th>Week</th><th>Score</th><th>Calls</th><th>Emails</th><th>Ctr</th><th></th></tr>
            </thead>
            <tbody>
              {weeks.slice().reverse().map(w => (
                <tr key={w.label}>
                  <td style={{ fontWeight: 600 }}>{w.label}</td>
                  <td className="num">{w.score}</td>
                  <td className="num">{w.calls}</td>
                  <td className="num">{w.emails}</td>
                  <td className="num">{w.contracts}</td>
                  <td>{w.pr && <span className="chip is-accent">PR</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Records & achievements timeline */}
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <Icon name="star" style={{ color: "var(--warning-ink)" }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>Records & achievements</div>
          </div>
          <div className="tl-history">
            {[...records.map(r => ({ ...r, kind: "record" })), ...achievements.map(a => ({ ...a, kind: "achievement" }))]
              .sort((a, b) => a.date < b.date ? 1 : -1)
              .slice(0, 8)
              .map((it, i) => (
                <div key={i} className="row" style={{ padding: "8px 0", borderBottom: i < 7 ? "1px dashed var(--border)" : "none", gap: 12 }}>
                  <div className="mono muted" style={{ fontSize: 11, width: 60 }}>{it.date}</div>
                  <span className="cat-icon sm" style={{ background: it.color || (it.kind === "record" ? "var(--accent)" : "var(--warning)") }}>
                    <Icon name={it.icon} />
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {it.kind === "record" ? it.label : it.title}
                      {it.isNew && <span className="chip is-accent" style={{ marginLeft: 6 }}>New</span>}
                    </div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {it.kind === "record" ? `${it.value}` : it.desc}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* ============ Social proof + Variable reward + Coach (Influence + Hooked + Drive) ============ */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, marginBottom: 18 }} className="journey-3col">
        <div className="card" style={{ padding: 16 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <Icon name="people" style={{ color: "var(--accent)" }} />
            <div style={{ fontWeight: 700, fontSize: 13 }}>Social proof</div>
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em" }}>You're in the <span style={{ color: "var(--success-ink)" }}>top 12%</span></div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>across all Leasing Agents in {me.center?.name}.</div>
          <div style={{ height: 8, background: "var(--surface-3)", borderRadius: 999, marginTop: 10, overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: "88%", background: "linear-gradient(90deg, var(--accent), oklch(58% 0.16 290))", borderRadius: 999 }} />
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Better than 88% of peers</div>
        </div>

        <div className="card" style={{ padding: 16, background: "linear-gradient(135deg, oklch(96% 0.05 30), oklch(95% 0.08 350))", borderColor: "transparent" }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <Icon name="star" style={{ color: "var(--warning-ink)" }} />
            <div style={{ fontWeight: 700, fontSize: 13 }}>Mystery reward</div>
          </div>
          <div style={{ fontSize: 30, textAlign: "center", margin: "8px 0" }}>🎁</div>
          <div style={{ fontSize: 13, textAlign: "center", fontWeight: 600 }}>Hit 3 more targets to unlock</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: "center" }}>Could be a $50 voucher, an extra PTO hour, or a shoutout — surprise.</div>
          <button className="btn is-small" style={{ width: "100%", marginTop: 10 }} onClick={() => window.toast("Mystery reward locked — keep working!")}>What's inside?</button>
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <Icon name="mail" style={{ color: "var(--success-ink)" }} />
            <div style={{ fontWeight: 700, fontSize: 13 }}>From your manager</div>
          </div>
          <div style={{ fontSize: 13.5, fontStyle: "italic", color: "var(--ink-2)", lineHeight: 1.5 }}>
            "Maya — your response time this week is fastest on the team. Keep this rhythm into June and Gold tier is locked in. 👏"
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>— Daniel P. · 2h ago</div>
        </div>
      </div>

      {/* ============ Reflection journal (Mindset + Grit) ============ */}
      <div className="card" style={{ marginBottom: 18, padding: 18 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <Icon name="edit" style={{ color: "var(--accent)" }} />
          <div style={{ fontWeight: 700, fontSize: 14 }}>Reflection journal</div>
          <span className="muted" style={{ fontSize: 11.5 }}>· build a growth mindset by writing one line a day</span>
          <div className="spacer" />
          <button className="btn is-small" onClick={() => window.toast("Today's prompt: What's one thing you did well?")}>Today's prompt</button>
        </div>
        <div className="col" style={{ gap: 10 }}>
          {journal.map((j, i) => (
            <div key={i} style={{ padding: 12, borderRadius: 10, background: "var(--surface-2)" }}>
              <div className="row" style={{ marginBottom: 4, fontSize: 11.5, color: "var(--muted)" }}>
                <span style={{ fontWeight: 600 }}>{j.date}</span>
                <span>·</span>
                <span>{j.prompt}</span>
              </div>
              <div style={{ fontSize: 13.5, color: "var(--ink-2)", fontStyle: "italic" }}>"{j.entry}"</div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .goal-grid {
          display: grid; grid-template-columns: 1.6fr 1fr 1fr 1fr; gap: 12px;
        }
        .month-charts {
          display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px;
        }
        @media (max-width: 1100px) {
          .goal-grid { grid-template-columns: repeat(2, 1fr); }
          .month-charts { grid-template-columns: 1fr; }
          .journey-2col { grid-template-columns: 1fr !important; }
          .journey-3col { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 640px) {
          .goal-grid { grid-template-columns: 1fr; }
        }
        .tl-history { display: flex; flex-direction: column; }
      `}</style>
    </div>
  );
};

/* ================================================================
   Sub-components
   ================================================================ */

function GoalBox({ label, title, progress, sub, tone, big, isToday }) {
  return (
    <div style={{
      padding: 14,
      borderRadius: 12,
      background: isToday ? `linear-gradient(135deg, ${tone}18, ${tone}30)` : "var(--surface-2)",
      border: isToday ? `1px solid ${tone}55` : "1px solid transparent",
    }}>
      <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: big ? 15 : 13, lineHeight: 1.3, marginTop: 4, minHeight: big ? 40 : 36 }}>{title}</div>
      <div className="row" style={{ marginTop: 8, alignItems: "baseline" }}>
        <div className="num" style={{ fontWeight: 800, fontSize: 20, color: tone, letterSpacing: "-.02em" }}>{Math.round(progress * 100)}%</div>
        <div className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>{sub}</div>
      </div>
      <div style={{ height: 6, background: "var(--surface-3)", borderRadius: 999, marginTop: 6, overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: (progress * 100) + "%", background: tone, borderRadius: 999 }} />
      </div>
    </div>
  );
}

function SkillRow({ s }) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 4 }}>
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{s.name}</span>
        <span className="chip" style={{ background: s.color + "22", color: s.color, border: "none", fontWeight: 700 }}>Lv {s.level}</span>
        <div className="spacer" />
        <span className="num muted" style={{ fontSize: 11.5 }}>{s.xp} XP</span>
      </div>
      <div className="row" style={{ gap: 4 }}>
        {Array.from({ length: s.max }).map((_, i) => (
          <span key={i} style={{
            flex: 1, height: 8, borderRadius: 4,
            background: i < s.level ? s.color : "var(--surface-3)",
            opacity: i < s.level ? 1 : 1,
          }} />
        ))}
      </div>
    </div>
  );
}

/* ============ Year heatmap ============ */
function buildHeatmap() {
  const weeks = 52;
  const days = 7;
  const cells = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < days; d++) {
      const noise = ((w * 7 + d) * 13 % 17) / 17;
      const month = Math.floor(w / 4.3);
      /* Higher activity in recent months */
      const recency = (w / weeks) * .8;
      let v = (noise * .35) + recency * .5;
      if (d === 0 || d === 6) v *= .35; /* weekends lighter */
      if (Math.random() < .05) v = 0;   /* random days off */
      cells.push({ w, d, v: Math.min(1, v) });
    }
  }
  return cells;
}

function heatmapColor(v) {
  if (v === 0) return "var(--surface-3)";
  if (v < .25) return "oklch(85% 0.06 145)";
  if (v < .5)  return "oklch(75% 0.10 145)";
  if (v < .75) return "oklch(65% 0.13 145)";
  return "oklch(55% 0.15 145)";
}

function YearHeatmap({ data }) {
  const weeks = 52, days = 7;
  const cell = 11, gap = 2;
  const w = weeks * (cell + gap);
  const h = days * (cell + gap);
  const monthLabels = ["Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar","Apr","May"];
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${w + 24} ${h + 24}`} style={{ width: "100%", minWidth: 600, height: "auto" }}>
        {monthLabels.map((m, i) => (
          <text key={i} x={i * (w / 12) + 24} y="10" fontSize="10" fill="var(--muted)" fontFamily="var(--font-mono)">{m}</text>
        ))}
        {["M", "W", "F"].map((d, i) => (
          <text key={d} x="0" y={(i * 2 + 1) * (cell + gap) + 20} fontSize="10" fill="var(--muted)" fontFamily="var(--font-mono)">{d}</text>
        ))}
        {data.map(c => (
          <rect
            key={c.w + "-" + c.d}
            x={c.w * (cell + gap) + 24}
            y={c.d * (cell + gap) + 16}
            width={cell}
            height={cell}
            rx={2}
            fill={heatmapColor(c.v)}
          >
            <title>Week {c.w + 1}, day {c.d + 1}: {Math.round(c.v * 100)}% intensity</title>
          </rect>
        ))}
      </svg>
    </div>
  );
}

/* ============ Month bar chart ============ */
function MonthChart({ label, color, data, valueKey, prKey, prefix = "" }) {
  const max = Math.max(...data.map(d => d[valueKey]));
  return (
    <div>
      <div className="row" style={{ marginBottom: 6, fontSize: 12.5 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
        <span style={{ fontWeight: 600 }}>{label}</span>
        <div className="spacer" />
        <span className="num muted" style={{ fontSize: 11 }}>peak {prefix}{Math.max(...data.map(d => d[valueKey])).toLocaleString()}</span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 100 }}>
        {data.map((d, i) => (
          <div key={d.month} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, minWidth: 0 }}>
            <div style={{ height: 84, width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", position: "relative" }}>
              {d[prKey] && <span style={{ position: "absolute", top: -4, left: "50%", transform: "translateX(-50%)", fontSize: 10 }}>⭐</span>}
              <div
                title={`${d.month}: ${prefix}${d[valueKey].toLocaleString()}${d[prKey] ? " — PR!" : ""}`}
                style={{
                  width: "100%",
                  height: Math.max(3, (d[valueKey] / max) * 80) + "px",
                  background: d.current ? color : color,
                  opacity: d.current ? 1 : .55,
                  borderRadius: "4px 4px 1px 1px",
                  border: d[prKey] ? `2px solid ${color}` : "none",
                }}
              />
            </div>
            <div className="mono muted" style={{ fontSize: 10 }}>{d.month}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
