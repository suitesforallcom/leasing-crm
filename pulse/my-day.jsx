/* global React, Icon, DATA, Avatar, CatIcon, StatusPill, TargetMeter, BonusBadge, CenterChip, Trend, Sparkline, HourBars, GrowthTree, fmt, metricsFor, BONUS_TIERS */

/* ================================================================
   My Day — personal page for an employee (Maya by default).
   Designed to be motivating, not punishing. Self-comparison first,
   peer comparison second.
   ================================================================ */

window.MyDayPage = function MyDayPage({ meId = "u1", onOpenEmployee, onOpenQuickAction, onOpenJourney }) {
  const me = DATA.USERS.find(u => u.id === meId);
  const m = metricsFor(me);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  /* Streak — Atomic Habits "don't break the chain" */
  const streak = 14;

  /* Level + XP — mastery loop */
  const xp = 6320;
  const xpPerLevel = 1000;
  const level = Math.floor(xp / xpPerLevel);
  const xpIntoLevel = xp - level * xpPerLevel;

  /* Daily quests — small specific actionable wins */
  const quests = buildQuests(me, m);
  const completedQuests = quests.filter(q => q.done).length;

  /* Growth tree — month progress */
  const monthRatio = clamp01((m.mtd.calls / m.monthTargets.calls + m.mtd.emails / m.monthTargets.emails + m.mtd.daysWorked / m.mtd.daysExpected) / 3);

  /* Fruits — each type maps to a different bonus rule trigger */
  const fruits = {
    apple:  Math.min(8, m.mtd.contracts),  /* contracts signed */
    plum:   Math.min(4, Math.floor(m.mtd.contracts * .35)),  /* renewals */
    golden: Math.min(2, Math.floor(m.mtd.contracts * .15)),  /* multi-year */
    lemon:  3,  /* referrals signed this month (mock) */
    star:   6,  /* 5-star reviews (FB + Google) */
    gem:    2,  /* NPS 9-10 */
  };
  const totalFruits = Object.values(fruits).reduce((s, v) => s + v, 0);

  /* Decorations driven by metrics */
  const hasBird   = m.actuals.emailReplyMin > 0 && m.actuals.emailReplyMin < m.targets.emailReplyMin * .55;
  const hasCrown  = m.tier.id === "gold" || m.tier.id === "platinum";
  const weatherMode = m.status.id === "crushing" || m.status.id === "ontrack" ? "sunny" : m.status.id === "behind" || m.status.id === "low" ? "partly" : m.status.id === "alert" ? "cloudy" : "sunny";

  /* Tree attention signals — what's slipping today */
  const missedCalls    = m.actuals.missedCalls;
  const unansweredSms  = 2;
  const staleLeads     = 1;
  const totalIssues    = missedCalls + unansweredSms + staleLeads;

  /* Bonus info per fruit/decoration — for the click-to-explain UI */
  const FRUIT_INFO = {
    apple:  { icon: "contract", color: "oklch(60% 0.20 25)",  bg: "oklch(96% 0.04 25)",  name: "Contract signed",     amount: "$100", count: fruits.apple,  desc: "Triggers when a tenant signs a brand-new lease through Pulse/DocuSign. The agent who initiated the envelope earns the bonus.", tip: "Push the 2 contracts close to signing today." },
    plum:   { icon: "refresh",  color: "oklch(50% 0.18 305)", bg: "oklch(96% 0.04 305)", name: "Contract renewed",    amount: "$50",  count: fruits.plum,   desc: "Pays when an existing tenant signs a renewal of their lease before expiration. Retention is cheaper than acquisition.", tip: "3 leases expire in 45 days — start the renewal talk." },
    star:   { icon: "star",     color: "oklch(80% 0.18 85)",  bg: "oklch(97% 0.06 85)",  name: "5★ review (FB or Google)", amount: "$25",  count: fruits.star,   desc: "Pays per verified 5-star review on Facebook or Google linked to your work. Capped at 4 per agent per month.", tip: "Send Karen Liu the review link — she's enthusiastic." },
    lemon:  { icon: "people",   color: "oklch(75% 0.18 95)",  bg: "oklch(97% 0.06 95)",  name: "Tenant referral signed", amount: "$200", count: fruits.lemon,  desc: "When a current tenant refers a prospect who signs a contract. Highest-paying per-action bonus — referrals close 3× faster.", tip: "Ask 3 happy tenants this week for one warm intro each." },
    golden: { icon: "cal",      color: "oklch(75% 0.16 80)",  bg: "oklch(97% 0.07 80)",  name: "Multi-year contract (24m+)", amount: "+$50", count: fruits.golden, desc: "Extra reward when a signed contract is 24 months or longer. Stacks with the regular contract-signed bonus.", tip: "ABC Medical wants 36 months — lock that in." },
    gem:    { icon: "check",    color: "oklch(65% 0.16 230)", bg: "oklch(96% 0.04 230)", name: "Tenant NPS 9–10",     amount: "$20",  count: fruits.gem,    desc: "When a tenant scores you 9 or 10 on the quarterly survey. 1 per tenant per quarter.", tip: "Quarterly NPS goes out Friday — make sure tenants get it." },
    leaf:   { icon: "check",    color: "oklch(60% 0.15 145)", bg: "oklch(96% 0.04 145)", name: "Daily target hit",    amount: "tier basis", count: Math.round(TREE_LEAVES_COUNT * monthRatio), desc: "Each leaf represents a daily target met (calls + emails + reply time). Drives your monthly tier (Bronze → Platinum).", tip: "Crush today and grow more leaves." },
    bird:   { icon: "zap",      color: "oklch(35% 0.10 25)",  bg: "oklch(96% 0.03 25)",  name: "Top reply speed",    amount: "tier basis", count: hasBird ? 1 : 0, desc: "The bird appears when your average email reply is under 60% of the SLA. Boosts your monthly score weighting.", tip: "Keep responding under 70 min — bird stays." },
    crown:  { icon: "star",     color: "oklch(75% 0.16 80)",  bg: "oklch(97% 0.07 80)",  name: "Gold tier this month", amount: "$500 base", count: hasCrown ? 1 : 0, desc: "Crown appears when you reach Gold tier — 100% of monthly targets hit. Sits on top of all per-action bonuses.", tip: "Keep the streak — Gold base + per-actions stack." },
    lantern:{ icon: "bolt",     color: "oklch(85% 0.18 30)",  bg: "oklch(97% 0.06 30)",  name: "Daily target streak", amount: "$50 / 5 days", count: streak, desc: "Each lantern represents two streak days. Five consecutive workdays hitting all daily targets pays $50.", tip: "Don't break the chain — you're on day " + streak + "." },
    punctual:{icon: "login",    color: "oklch(60% 0.13 158)", bg: "oklch(96% 0.04 158)", name: "On-time arrival",    amount: "$25 / month", count: 14, desc: "Pays at end of month when you log in by start of shift on 95%+ workdays. Positive framing of punctuality — no penalty mechanism, no surveillance.", tip: "You've been on time 14/16 days — keep the rhythm." },
  };

  const [openInfo, setOpenInfo] = React.useState(null);

  /* This week vs last week */
  const weekStats = [
    { label: "Calls",     now: 62, prev: 51, icon: "phone" },
    { label: "Emails",    now: 148, prev: 132, icon: "mail" },
    { label: "Contracts", now: 7,  prev: 5,   icon: "contract" },
    { label: "Hours",     now: 38, prev: 36,  icon: "clock", suffix: "h" },
  ];

  /* Personal records */
  const records = [
    { icon: "phone",    label: "Most calls in a day",        value: 24, when: "May 8" },
    { icon: "mail",     label: "Most emails in a day",       value: 47, when: "May 12" },
    { icon: "contract", label: "Most contracts in a week",   value: 9,  when: "Last week", isNew: true },
    { icon: "bolt",     label: "Highest day score",          value: 96, when: "May 5" },
  ];

  /* Achievements */
  const achievements = [
    { id: "first-bonus", title: "First Bonus",     desc: "Earned your first monthly bonus",      icon: "star",      earned: true,  rarity: "common" },
    { id: "speedster",   title: "Speed Demon",     desc: "Email replies under 30m for a week",   icon: "zap",       earned: true,  rarity: "rare" },
    { id: "early-bird",  title: "Early Bird",      desc: "Logged in before 8 AM x10",            icon: "login",     earned: true,  rarity: "common" },
    { id: "contract-k",  title: "Contract King",   desc: "50 contracts in a single month",       icon: "contract",  earned: false, rarity: "epic",      progress: m.mtd.contracts, target: 50 },
    { id: "streaker",    title: "30-Day Streak",   desc: "Hit targets 30 days in a row",         icon: "bolt",      earned: false, rarity: "legendary", progress: streak, target: 30 },
    { id: "team-mvp",    title: "Team MVP",        desc: "Top of the leaderboard for a week",    icon: "star",      earned: false, rarity: "rare",      progress: 4, target: 7 },
  ];
  const earnedCount = achievements.filter(a => a.earned).length;

  /* Friendly leaderboard — show me + 2 above + 2 below in my center */
  const myCenter = me.center;
  const peers = DATA.USERS.filter(u => u.centerId === me.centerId && u.score > 0).sort((a, b) => b.score - a.score);
  const myIdx = peers.findIndex(u => u.id === me.id);
  const peerWindow = peers.slice(Math.max(0, myIdx - 2), Math.min(peers.length, myIdx + 3));

  return (
    <div className="page">
      {/* ============ Wellness signal — long hours warning ============ */}
      {me.online >= 9 * 60 && (
        <div className="card" style={{ padding: 14, marginBottom: 14, background: "var(--warning-soft)", borderColor: "transparent", display: "flex", alignItems: "center", gap: 12 }}>
          <span className="cat-icon" style={{ background: "var(--warning)" }}><Icon name="clock" /></span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--warning-ink)" }}>You've been working {fmt.hm(me.online)} today — time to wrap up.</div>
            <div style={{ fontSize: 12, color: "var(--warning-ink)", opacity: .85 }}>Long days hurt long-term performance. Your future self will thank you for closing out now.</div>
          </div>
          <button className="btn is-small" onClick={() => window.toast("Wrap-up checklist saved — see you tomorrow!", "success")}>Wrap-up</button>
        </div>
      )}

      {/* ============ Hero greeting ============ */}
      <div className="myday-hero">
        <div className="myday-greeting">
          <Avatar user={me} size="xl" />
          <div>
            <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.025em", margin: "4px 0 6px" }}>{greeting}, {me.first}</h1>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <StatusPill status={m.status} size="lg" />
              <span className="chip" style={{ background: "oklch(96% 0.05 30)", color: "oklch(50% 0.15 30)", borderColor: "transparent", fontWeight: 700 }}>
                <span style={{ fontSize: 14 }}>🔥</span> {streak}-day streak
              </span>
              <CenterChip center={myCenter} />
            </div>
          </div>
        </div>
        <div className="myday-actions">
          <button className="btn" onClick={onOpenQuickAction}><Icon name="plus" /> Quick log</button>
          <button className="btn" onClick={onOpenJourney}><Icon name="trendUp" /> My Journey</button>
          <button className="btn is-primary"><Icon name="cal" /> Plan today</button>
        </div>
      </div>

      {/* ============ One Big Thing + Coach's note (Grit + Drive) ============ */}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 14, marginBottom: 18 }} className="myday-obt-grid">
        <div className="card" style={{ padding: 16, background: "linear-gradient(135deg, oklch(96% 0.04 264), oklch(97% 0.04 280))", borderColor: "transparent" }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <Icon name="star" style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-ink)", letterSpacing: ".1em", textTransform: "uppercase" }}>Today's one big thing</span>
            <div className="spacer" />
            <button className="btn is-small is-ghost" onClick={() => window.toast("Edit your big thing")}><Icon name="edit" /></button>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-.015em" }}>Send the Greentree Yoga proposal to Andrea by 5 PM.</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>One outcome that makes today a win — Grit by Angela Duckworth.</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => window.toast("Marked done — well done!", "success")}><Icon name="check" /> Mark done</button>
            <button className="btn is-ghost is-small">Postpone</button>
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <Avatar user={DATA.USERS.find(u => u.id === "u2")} size="sm" />
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", letterSpacing: ".1em", textTransform: "uppercase" }}>From Daniel · your manager</span>
          </div>
          <div style={{ fontSize: 13.5, fontStyle: "italic", color: "var(--ink-2)", lineHeight: 1.5 }}>
            "Maya — fastest reply time on the team this week. Keep this up and Gold tier is locked in."
          </div>
          <button className="btn is-small" style={{ marginTop: 8 }} onClick={() => window.toast("Thanks sent to Daniel", "success")}><Icon name="check" /> Thank Daniel</button>
        </div>
      </div>

      {/* ============ Today's schedule strip + Calendar widget ============ */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 14, marginBottom: 18 }} className="myday-schedule-grid">
        <div className="card" style={{ padding: 18 }}>
          <div className="row" style={{ marginBottom: 14 }}>
            <Icon name="cal" style={{ color: "var(--muted)" }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>Today's schedule</div>
            <span className="chip" style={{ fontSize: 10.5 }}>{new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
            <span className="chip is-success" style={{ fontSize: 10.5 }}><Icon name="check" /> Google synced</span>
            <div className="spacer" />
            <button className="btn is-small is-ghost" onClick={() => window.toast("Block focus time — 25 min Pomodoro started", "success")}><Icon name="bolt" /> Start focus (25m)</button>
          </div>
          <ScheduleStrip events={typeof window.getCalendarEvents === "function" ? window.getCalendarEvents() : []} />
        </div>
        <window.CalendarTodayWidget
          connected={true}
          onConnect={() => window.toast("Connecting Google Calendar…", "success")}
          onBlockFocus={() => window.toast("Focus block added to calendar (25m)", "success")}
        />
      </div>


      {/* ============ Big top row: tree + level ============ */}
      <div className="myday-top-grid">
        {/* GROWTH TREE */}
        <div className="card" style={{ padding: 22, position: "relative", overflow: "hidden", background: "linear-gradient(180deg, oklch(98% 0.02 220), oklch(96% 0.04 110))" }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <Icon name="sparkle" style={{ color: "var(--success-ink)" }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>Your growth tree · May</div>
            <div className="spacer" />
            <span className="num muted" style={{ fontSize: 12 }}>{Math.round(monthRatio * 100)}% of monthly target</span>
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <GrowthTree
              leafProgress={monthRatio}
              fruits={fruits}
              missedCalls={missedCalls}
              unansweredSms={unansweredSms}
              staleLeads={staleLeads}
              streak={streak}
              achievements={4}
              hasBird={hasBird}
              hasCrown={hasCrown}
              weather={weatherMode}
            />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>Click any reward below for details</div>
              <div className="col" style={{ gap: 4, marginTop: 8 }}>
                <FruitButton info={FRUIT_INFO.leaf}    open={openInfo} setOpen={setOpenInfo} k="leaf" />
                <FruitButton info={FRUIT_INFO.apple}   open={openInfo} setOpen={setOpenInfo} k="apple" />
                <FruitButton info={FRUIT_INFO.plum}    open={openInfo} setOpen={setOpenInfo} k="plum" />
                <FruitButton info={FRUIT_INFO.star}    open={openInfo} setOpen={setOpenInfo} k="star" />
                <FruitButton info={FRUIT_INFO.lemon}   open={openInfo} setOpen={setOpenInfo} k="lemon" />
                <FruitButton info={FRUIT_INFO.golden}  open={openInfo} setOpen={setOpenInfo} k="golden" />
                <FruitButton info={FRUIT_INFO.gem}     open={openInfo} setOpen={setOpenInfo} k="gem" />
                {hasBird   && <FruitButton info={FRUIT_INFO.bird}    open={openInfo} setOpen={setOpenInfo} k="bird" />}
                {hasCrown  && <FruitButton info={FRUIT_INFO.crown}   open={openInfo} setOpen={setOpenInfo} k="crown" />}
                {streak > 0 && <FruitButton info={FRUIT_INFO.lantern} open={openInfo} setOpen={setOpenInfo} k="lantern" />}
                <FruitButton info={FRUIT_INFO.punctual} open={openInfo} setOpen={setOpenInfo} k="punctual" />
              </div>

              {/* Selected bonus detail panel */}
              {openInfo && FRUIT_INFO[openInfo] && (
                <BonusInfoPanel info={FRUIT_INFO[openInfo]} onClose={() => setOpenInfo(null)} />
              )}

              {/* Quick fixes — turn issues into actions */}
              {totalIssues > 0 ? (
                <div style={{ marginTop: 12, padding: 12, background: "rgba(255, 220, 200, .35)", borderRadius: 10, border: "1px solid oklch(85% 0.08 50)" }}>
                  <div className="muted" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6, color: "var(--warning-ink)" }}>Refresh your tree</div>
                  <div className="col" style={{ gap: 4 }}>
                    {missedCalls > 0 && (
                      <button className="row" onClick={() => window.toast(`Calling back ${missedCalls} missed contact${missedCalls === 1 ? "" : "s"}…`, "success")} style={{ padding: "6px 8px", borderRadius: 6, fontSize: 12, textAlign: "left", color: "var(--ink-2)" }}>
                        <Icon name="phoneMiss" style={{ color: "var(--danger-ink)" }} />
                        <span style={{ flex: 1 }}>Call back <b>{missedCalls}</b> missed</span>
                        <Icon name="arrowR" style={{ color: "var(--muted)" }} />
                      </button>
                    )}
                    {unansweredSms > 0 && (
                      <button className="row" onClick={() => window.toast(`Opening ${unansweredSms} pending SMS thread${unansweredSms === 1 ? "" : "s"}…`, "success")} style={{ padding: "6px 8px", borderRadius: 6, fontSize: 12, textAlign: "left", color: "var(--ink-2)" }}>
                        <Icon name="mobile" style={{ color: "var(--warning-ink)" }} />
                        <span style={{ flex: 1 }}>Reply to <b>{unansweredSms}</b> SMS thread{unansweredSms === 1 ? "" : "s"}</span>
                        <Icon name="arrowR" style={{ color: "var(--muted)" }} />
                      </button>
                    )}
                    {staleLeads > 0 && (
                      <button className="row" onClick={() => window.toast(`Opening ${staleLeads} stale lead${staleLeads === 1 ? "" : "s"}…`, "success")} style={{ padding: "6px 8px", borderRadius: 6, fontSize: 12, textAlign: "left", color: "var(--ink-2)" }}>
                        <Icon name="user" style={{ color: "var(--warning-ink)" }} />
                        <span style={{ flex: 1 }}>Refresh <b>{staleLeads}</b> stale lead{staleLeads === 1 ? "" : "s"}</span>
                        <Icon name="arrowR" style={{ color: "var(--muted)" }} />
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 12, padding: 12, background: "rgba(255,255,255,.6)", borderRadius: 10 }}>
                  <div className="muted" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>Next milestone</div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginTop: 2 }}>
                    {fruits.apple < 8 ? `${8 - fruits.apple} more contracts grows a new 🍎` : "Tree is fully grown — incredible month!"}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* LEVEL / XP / BONUS */}
        <div className="col" style={{ gap: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <Icon name="star" style={{ color: "var(--accent)" }} />
              <div style={{ fontWeight: 700, fontSize: 14 }}>Level {level} · {DATA.ROLES[me.role].label}</div>
            </div>
            <div className="num" style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.02em" }}>
              {xp.toLocaleString()} XP
            </div>
            <div className="row" style={{ fontSize: 11.5, marginTop: 8, marginBottom: 4 }}>
              <span className="muted">Level {level}</span>
              <div className="spacer" />
              <span className="num muted">{xpIntoLevel}/{xpPerLevel} to L{level + 1}</span>
            </div>
            <div style={{ height: 8, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: (xpIntoLevel / xpPerLevel * 100) + "%", background: "linear-gradient(90deg, var(--accent), oklch(58% 0.16 290))", borderRadius: 999 }} />
            </div>
          </div>
          <div className="card" style={{ padding: 16, background: `linear-gradient(135deg, ${m.tier.color}10, ${m.tier.color}24)`, borderColor: m.tier.color + "55" }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <Icon name="star" style={{ color: m.tier.color }} />
              <div style={{ fontWeight: 700, fontSize: 14 }}>This month's bonus</div>
            </div>
            <div className="num" style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.025em", color: m.tier.color }}>
              ${m.bonusMtd.toLocaleString()}
            </div>
            <div className="muted" style={{ fontSize: 11.5 }}>{m.tier.label} tier{m.nextTier && ` · ${Math.round((1 - m.progressToNext) * (m.nextTier.amount - m.tier.amount))} more for ${m.nextTier.label}`}</div>
            {m.nextTier && (
              <div style={{ height: 6, background: "var(--surface-3)", borderRadius: 999, marginTop: 8, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: Math.round(m.progressToNext * 100) + "%", background: m.nextTier.color, borderRadius: 999 }} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ============ Today's quests ============ */}
      <div style={{ marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <Icon name="check" style={{ color: "var(--success-ink)" }} />
          <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0, letterSpacing: "-.015em" }}>Today's quests</h2>
          <span className="muted" style={{ fontSize: 12 }}>{completedQuests} of {quests.length} done · keep your streak going</span>
        </div>
        <div className="quest-grid">
          {quests.map(q => <QuestCard key={q.id} q={q} />)}
        </div>
      </div>

      {/* ============ Records + Achievements row ============ */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 18, marginTop: 18 }} className="myday-records-grid">
        {/* Records */}
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <Icon name="trendUp" style={{ color: "var(--accent)" }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>Your records</div>
            <div className="spacer" />
            <span className="muted" style={{ fontSize: 11.5 }}>Personal bests · this month</span>
          </div>
          <div className="col" style={{ gap: 10 }}>
            {records.map(r => (
              <div key={r.label} className="row" style={{ padding: "10px 12px", background: "var(--surface-2)", borderRadius: 10 }}>
                <span className="cat-icon" style={{ background: r.isNew ? "var(--accent)" : "var(--ink-2)" }}><Icon name={r.icon} /></span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.label}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{r.when}</div>
                </div>
                <div className="num" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.02em" }}>{r.value}</div>
                {r.isNew && <span className="chip is-accent">New PR</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Achievements */}
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <Icon name="star" style={{ color: "var(--warning-ink)" }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>Achievements</div>
            <span className="chip is-accent">{earnedCount}/{achievements.length}</span>
            <div className="spacer" />
            <button className="btn is-small is-ghost">View all</button>
          </div>
          <div className="ach-grid">
            {achievements.map(a => <AchievementBadge key={a.id} a={a} />)}
          </div>
        </div>
      </div>

      {/* ============ This week ============ */}
      <div className="card" style={{ marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <Icon name="cal" style={{ color: "var(--muted)" }} />
          <div style={{ fontWeight: 700, fontSize: 14 }}>This week vs last week</div>
          <div className="spacer" />
          <span className="muted" style={{ fontSize: 11.5 }}>Mon–Sun</span>
        </div>
        <div className="week-grid">
          {weekStats.map(w => (
            <div key={w.label} style={{ padding: 14, background: "var(--surface-2)", borderRadius: 12 }}>
              <div className="kpi-head"><Icon name={w.icon} />{w.label}</div>
              <div className="num" style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-.02em" }}>{w.now}{w.suffix || ""}</div>
              <div className="row" style={{ marginTop: 4, fontSize: 11.5 }}>
                <Trend now={w.now} prev={w.prev} />
                <span className="muted">vs {w.prev}{w.suffix || ""}</span>
              </div>
              <div style={{ marginTop: 6 }}>
                <SimpleBars now={w.now} prev={w.prev} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ============ Friendly peer leaderboard ============ */}
      <div className="card is-clean" style={{ marginTop: 18 }}>
        <div className="card-h">
          <div className="row">
            <Icon name="people" style={{ color: "var(--accent)" }} />
            <div className="card-title">Where you stand in {myCenter.name}</div>
            <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent-ink)", border: "none" }}>You're #{myIdx + 1} of {peers.length}</span>
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>Friendly competition — keep climbing</div>
        </div>
        <div>
          {peerWindow.map((p, i) => {
            const rank = peers.indexOf(p) + 1;
            const isMe = p.id === me.id;
            return (
              <button
                key={p.id}
                className="row"
                onClick={() => !isMe && onOpenEmployee && onOpenEmployee(p.id)}
                style={{
                  width: "100%", padding: "12px 18px", textAlign: "left",
                  borderTop: i === 0 ? "none" : "1px solid var(--border)",
                  background: isMe ? "var(--accent-soft)" : "transparent",
                  cursor: isMe ? "default" : "pointer",
                }}
              >
                <span className="num" style={{ width: 32, fontWeight: 800, fontSize: 16, color: rank <= 3 ? "var(--warning-ink)" : "var(--muted-2)" }}>
                  {rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "#" + rank}
                </span>
                <Avatar user={p} size="md" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>{isMe ? "You" : p.first + " " + p.last[0] + "."}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{DATA.ROLES[p.role].label}</div>
                </div>
                <div className="num" style={{ fontSize: 18, fontWeight: 800 }}>{p.score}</div>
                {isMe && peers[myIdx - 1] && (
                  <span className="chip" style={{ background: "var(--accent)", color: "white", border: "none" }}>
                    +{peers[myIdx - 1].score - p.score} to overtake {peers[myIdx - 1].first}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <style>{`
        .myday-hero {
          display: flex; align-items: center; justify-content: space-between;
          gap: 24px; margin-bottom: 20px; flex-wrap: wrap;
        }
        .myday-greeting { display: flex; align-items: center; gap: 16px; }
        .myday-actions { display: flex; gap: 8px; }
        .myday-top-grid {
          display: grid; grid-template-columns: 1.6fr 1fr; gap: 18px;
        }
        .quest-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 12px;
        }
        .ach-grid {
          display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
        }
        .week-grid {
          display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
        }
        @media (max-width: 1100px) {
          .myday-top-grid { grid-template-columns: 1fr; }
          .myday-records-grid { grid-template-columns: 1fr !important; }
          .ach-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 640px) {
          .week-grid { grid-template-columns: repeat(2, 1fr); }
          .ach-grid { grid-template-columns: repeat(2, 1fr); }
          .myday-obt-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 980px) {
          .myday-obt-grid { grid-template-columns: 1fr !important; }
          .myday-schedule-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
};

/* ================================================================
   Quest card
   ================================================================ */
function QuestCard({ q }) {
  const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
  return (
    <div className="card" style={{ padding: 14, opacity: q.done ? .7 : 1, borderColor: q.done ? "var(--success)" : "var(--border)" }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="cat-icon" style={{ background: q.done ? "var(--success)" : q.tone === "warning" ? "var(--warning)" : "var(--accent)" }}>
          <Icon name={q.done ? "check" : q.icon} />
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13, textDecoration: q.done ? "line-through" : "none" }}>{q.title}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>{q.sub}</div>
        </div>
        {q.xp && <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent-ink)", border: "none", fontWeight: 700 }}>+{q.xp} XP</span>}
      </div>
      {!q.done && (
        <>
          <div className="row" style={{ fontSize: 11.5, marginBottom: 4 }}>
            <span className="num" style={{ fontWeight: 700 }}>{q.progress}<span className="muted" style={{ fontWeight: 500 }}>/{q.target}</span></span>
            <div className="spacer" />
            <span className="muted">{pct}%</span>
          </div>
          <div style={{ height: 6, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: pct + "%", background: q.tone === "warning" ? "var(--warning)" : "var(--accent)", borderRadius: 999 }} />
          </div>
        </>
      )}
      {q.done && <div className="row" style={{ fontSize: 12, color: "var(--success-ink)", fontWeight: 600 }}><Icon name="check" /> Done — nice work!</div>}
    </div>
  );
}

/* ================================================================
   Achievement badge
   ================================================================ */
function AchievementBadge({ a }) {
  const rarityColor = {
    common:    "oklch(70% 0.02 260)",
    rare:      "oklch(60% 0.16 230)",
    epic:      "oklch(58% 0.18 300)",
    legendary: "oklch(73% 0.15 78)",
  };
  const color = rarityColor[a.rarity] || rarityColor.common;
  const earned = a.earned;
  return (
    <div
      title={a.desc}
      style={{
        padding: 12,
        borderRadius: 12,
        background: earned ? `linear-gradient(135deg, ${color}15, ${color}30)` : "var(--surface-2)",
        border: earned ? `1px solid ${color}55` : "1px dashed var(--border-strong)",
        textAlign: "center",
        opacity: earned ? 1 : .55,
        position: "relative",
      }}
    >
      <div style={{
        width: 44, height: 44, borderRadius: 999,
        background: earned ? color : "var(--surface-3)",
        display: "grid", placeItems: "center",
        margin: "0 auto 6px",
        color: "white",
      }}>
        <Icon name={a.icon} style={{ width: 22, height: 22 }} />
      </div>
      <div style={{ fontWeight: 700, fontSize: 12.5, letterSpacing: "-.005em" }}>{a.title}</div>
      <div className="muted" style={{ fontSize: 10.5, marginTop: 2, lineHeight: 1.3, minHeight: 26 }}>{a.desc}</div>
      {!earned && a.progress != null && (
        <div style={{ marginTop: 6 }}>
          <div className="num muted" style={{ fontSize: 10.5, fontWeight: 700 }}>{a.progress}/{a.target}</div>
          <div style={{ height: 4, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden", marginTop: 2 }}>
            <span style={{ display: "block", height: "100%", width: Math.min(100, (a.progress / a.target * 100)) + "%", background: color, borderRadius: 999 }} />
          </div>
        </div>
      )}
      {earned && (
        <span style={{
          position: "absolute", top: 8, right: 8,
          width: 16, height: 16, borderRadius: 999,
          background: "var(--success)", display: "grid", placeItems: "center",
        }}>
          <Icon name="check" style={{ width: 10, height: 10, color: "white" }} />
        </span>
      )}
    </div>
  );
}

/* ================================================================
   Tiny bars — "now vs prev" mini visualization
   ================================================================ */
function SimpleBars({ now, prev }) {
  const max = Math.max(now, prev, 1);
  return (
    <div className="row" style={{ gap: 4, height: 20, alignItems: "flex-end" }}>
      <div title={"Last week: " + prev} style={{ flex: 1, height: (prev / max * 20) + "px", background: "var(--surface-3)", borderRadius: "3px 3px 0 0" }} />
      <div title={"This week: " + now} style={{ flex: 1, height: (now / max * 20) + "px", background: now >= prev ? "var(--success)" : "var(--warning)", borderRadius: "3px 3px 0 0" }} />
    </div>
  );
}

/* ================================================================
   Quest builder — derive specific actionable quests from metrics
   ================================================================ */
function buildQuests(user, m) {
  const out = [];
  if (m.targets.calls > 0) {
    const remaining = Math.max(0, m.targets.calls - user.calls);
    out.push({
      id: "calls", icon: "phone", title: `Make ${m.targets.calls} calls`,
      sub: remaining > 0 ? `${remaining} more to hit your daily target` : "Daily call target reached",
      progress: user.calls, target: m.targets.calls, done: user.calls >= m.targets.calls,
      tone: remaining > 4 ? "warning" : null, xp: 80,
    });
  }
  if (m.targets.emails > 0) {
    const remaining = Math.max(0, m.targets.emails - user.emails);
    out.push({
      id: "emails", icon: "mail", title: `Send ${m.targets.emails} emails`,
      sub: remaining > 0 ? `${remaining} to go` : "Inbox crushed for the day",
      progress: user.emails, target: m.targets.emails, done: user.emails >= m.targets.emails, xp: 60,
    });
  }
  if (m.targets.contracts > 0) {
    out.push({
      id: "contract", icon: "contract", title: "Send 1 contract",
      sub: "Move a deal forward today",
      progress: Math.min(user.contracts, 1), target: 1, done: user.contracts >= 1, xp: 150,
    });
  }
  if (m.actuals.missedCalls > 0) {
    out.push({
      id: "callback", icon: "phoneOut", title: `Return ${m.actuals.missedCalls} missed call`,
      sub: "Don't keep a tenant waiting",
      progress: 0, target: m.actuals.missedCalls, done: false, tone: "warning", xp: 50,
    });
  }
  out.push({
    id: "reply", icon: "clock", title: "Reply to all morning emails by noon",
    sub: "Keeps you under SLA",
    progress: 1, target: 1, done: true, xp: 40,
  });
  return out.slice(0, 5);
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

const TREE_LEAVES_COUNT = 36;

function FruitButton({ info, open, setOpen, k }) {
  const isOpen = open === k;
  return (
    <button
      onClick={() => setOpen(isOpen ? null : k)}
      className="row"
      style={{
        padding: "6px 8px", borderRadius: 8,
        fontSize: 12, textAlign: "left",
        background: isOpen ? info.bg : "transparent",
        border: isOpen ? "1px solid " + info.color + "55" : "1px solid transparent",
        cursor: "pointer", width: "100%",
      }}
    >
      <span style={{ width: 14, height: 14, borderRadius: k === "leaf" ? 4 : 999, background: info.color, flexShrink: 0 }} />
      <span style={{ flex: 1 }}>{info.name}</span>
      <span className="num" style={{ fontWeight: 700, color: info.color }}>{info.amount}</span>
      <span className="num" style={{ fontWeight: 700, marginLeft: 8, minWidth: 22, textAlign: "right" }}>×{info.count}</span>
    </button>
  );
}

function BonusInfoPanel({ info, onClose }) {
  return (
    <div style={{ marginTop: 12, padding: 14, background: info.bg, borderRadius: 10, border: "1px solid " + info.color + "55" }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="cat-icon" style={{ background: info.color }}><Icon name={info.icon} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: info.color }}>{info.name}</div>
          <div className="num" style={{ fontWeight: 800, fontSize: 18, color: info.color, lineHeight: 1 }}>{info.amount}</div>
        </div>
        <button className="btn is-small is-ghost" onClick={onClose} title="Close"><Icon name="close" /></button>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--ink-2)" }}>{info.desc}</div>
      <div className="row" style={{ marginTop: 8, padding: "6px 8px", background: "rgba(255,255,255,.65)", borderRadius: 6, fontSize: 11.5 }}>
        <Icon name="sparkle" style={{ width: 12, height: 12, color: info.color }} />
        <span style={{ flex: 1, fontWeight: 500 }}>{info.tip}</span>
      </div>
      <div className="row" style={{ marginTop: 6, fontSize: 11.5, color: "var(--muted)" }}>
        <span>You've earned this:</span>
        <span className="num" style={{ fontWeight: 700, color: "var(--ink)", marginLeft: 4 }}>{info.count}×</span>
        <span>this month</span>
      </div>
    </div>
  );
}

/* ================================================================
   Schedule strip — horizontal time blocks 7 AM – 7 PM
   ================================================================ */
function ScheduleStrip({ events }) {
  const startH = 7, endH = 19; /* 12 hour window */
  const span = endH - startH;
  const now = new Date();
  const nowH = now.getHours() + now.getMinutes() / 60;
  const nowPct = ((nowH - startH) / span) * 100;
  const showNow = nowH >= startH && nowH <= endH;

  const kindColor = {
    lead:     "oklch(62% 0.14 70)",
    contract: "oklch(62% 0.14 300)",
    call:     "oklch(62% 0.14 30)",
    email:    "oklch(62% 0.14 340)",
    invoice:  "oklch(62% 0.14 170)",
    task:     "oklch(62% 0.14 240)",
    break:    "oklch(70% 0.04 90)",
  };

  return (
    <div>
      {/* time ruler */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${span}, 1fr)`, marginBottom: 6 }}>
        {Array.from({ length: span }).map((_, i) => (
          <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)", paddingLeft: 2, borderLeft: "1px dashed var(--border)" }}>
            {((startH + i) % 12 || 12) + (startH + i < 12 ? "a" : "p")}
          </div>
        ))}
      </div>
      {/* lane */}
      <div style={{ position: "relative", height: 56, background: "var(--surface-2)", borderRadius: 10, overflow: "hidden" }}>
        {events.map((e, i) => {
          const left = ((e.start - startH) / span) * 100;
          const width = ((e.end - e.start) / span) * 100;
          const color = kindColor[e.kind] || "var(--muted-2)";
          return (
            <div
              key={i}
              title={`${e.label} · ${fmtHour(e.start)} – ${fmtHour(e.end)}`}
              style={{
                position: "absolute",
                top: 6, bottom: 6,
                left: left + "%",
                width: Math.max(2, width) + "%",
                background: e.done ? "var(--surface-3)" : e.current ? color : color + "33",
                border: e.current ? `2px solid ${color}` : "1px solid " + (e.done ? "var(--border)" : color + "55"),
                borderRadius: 6,
                padding: "4px 8px",
                fontSize: 11, fontWeight: 600,
                color: e.done ? "var(--muted)" : e.current ? "white" : color,
                overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
                display: "flex", alignItems: "center", gap: 4,
                textDecoration: e.done ? "line-through" : "none",
                opacity: e.done ? .6 : 1,
              }}
            >
              {e.done && <Icon name="check" style={{ width: 10, height: 10, flexShrink: 0 }} />}
              {e.label}
            </div>
          );
        })}
        {showNow && (
          <div style={{ position: "absolute", top: -2, bottom: -2, left: nowPct + "%", width: 2, background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }}>
            <div style={{ position: "absolute", top: -8, left: -22, padding: "1px 6px", background: "var(--accent)", color: "white", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700 }}>NOW</div>
          </div>
        )}
      </div>
      <div className="row" style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
        <span>{events.filter(e => e.done).length} done</span>
        <span>·</span>
        <span>{events.filter(e => !e.done).length} remaining</span>
      </div>
    </div>
  );
}

function fmtHour(h) {
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  const ampm = hr >= 12 ? "PM" : "AM";
  const disp = hr % 12 || 12;
  return `${disp}:${String(min).padStart(2, "0")} ${ampm}`;
}
