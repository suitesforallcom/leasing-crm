/* global DATA, fmt */

/* ================================================================
   Derived metrics — targets, hits, response times, status, bonuses
   Built from base user data so we don't duplicate state.
   ================================================================ */

/* Role-based daily targets — what a person is *expected* to do each workday */
const TARGETS_BY_ROLE = {
  agent:      { calls: 18, emails: 28, contracts: 2, hoursWorked: 8, emailReplyMin: 120, callPickupSec: 25, missedRatePct: 15 },
  manager:    { calls: 8,  emails: 20, contracts: 4, hoursWorked: 8, emailReplyMin: 90,  callPickupSec: 20, missedRatePct: 10 },
  accountant: { calls: 4,  emails: 12, contracts: 0, hoursWorked: 8, emailReplyMin: 180, callPickupSec: 60, missedRatePct: 20 },
  admin:      { calls: 2,  emails: 25, contracts: 0, hoursWorked: 8, emailReplyMin: 60,  callPickupSec: 30, missedRatePct: 10 },
};

/* Per-user response & call-quality "actuals" (mocked but realistic) */
const RESPONSE_ACTUALS = {
  u1:  { emailReplyMin: 47,  callPickupSec: 12, missedCalls: 1, callsExpected: 18 },
  u2:  { emailReplyMin: 62,  callPickupSec: 14, missedCalls: 0, callsExpected: 8  },
  u3:  { emailReplyMin: 28,  callPickupSec: 9,  missedCalls: 0, callsExpected: 18 },
  u4:  { emailReplyMin: 152, callPickupSec: 38, missedCalls: 0, callsExpected: 4  },
  u5:  { emailReplyMin: 84,  callPickupSec: 22, missedCalls: 1, callsExpected: 18 },
  u6:  { emailReplyMin: 71,  callPickupSec: 18, missedCalls: 0, callsExpected: 8  },
  u7:  { emailReplyMin: 0,   callPickupSec: 0,  missedCalls: 0, callsExpected: 18 },
  u8:  { emailReplyMin: 188, callPickupSec: 42, missedCalls: 3, callsExpected: 18 },
  u9:  { emailReplyMin: 38,  callPickupSec: 8,  missedCalls: 0, callsExpected: 2  },
  u10: { emailReplyMin: 124, callPickupSec: 51, missedCalls: 0, callsExpected: 4  },
  u11: { emailReplyMin: 54,  callPickupSec: 11, missedCalls: 0, callsExpected: 18 },
  u12: { emailReplyMin: 0,   callPickupSec: 0,  missedCalls: 0, callsExpected: 8  },
};

/* Month-to-date totals (used by bonus calc) */
const MTD = {
  u1:  { calls: 248, emails: 612, contracts: 38, daysWorked: 16, daysExpected: 17 },
  u2:  { calls: 134, emails: 388, contracts: 52, daysWorked: 17, daysExpected: 17 },
  u3:  { calls: 312, emails: 689, contracts: 41, daysWorked: 17, daysExpected: 17 },
  u4:  { calls: 21,  emails: 224, contracts: 0,  daysWorked: 15, daysExpected: 17 },
  u5:  { calls: 178, emails: 472, contracts: 24, daysWorked: 17, daysExpected: 17 },
  u6:  { calls: 88,  emails: 312, contracts: 47, daysWorked: 17, daysExpected: 17 },
  u7:  { calls: 198, emails: 504, contracts: 32, daysWorked: 14, daysExpected: 17 },
  u8:  { calls: 91,  emails: 198, contracts: 12, daysWorked: 16, daysExpected: 17 },
  u9:  { calls: 18,  emails: 588, contracts: 0,  daysWorked: 17, daysExpected: 17 },
  u10: { calls: 14,  emails: 184, contracts: 0,  daysWorked: 16, daysExpected: 17 },
  u11: { calls: 224, emails: 524, contracts: 36, daysWorked: 17, daysExpected: 17 },
  u12: { calls: 41,  emails: 142, contracts: 9,  daysWorked: 12, daysExpected: 17, atRisk: true },
};

/* Compute one target progress: returns {value, target, pct, hit, tone, label} */
function meter(value, target, label, opts = {}) {
  const pct = target === 0 ? 100 : Math.round((value / target) * 100);
  const hit = pct >= 100;
  let tone;
  if (opts.lowerBetter) {
    if (value === 0 && target > 0) tone = "muted";
    else if (value <= target) tone = "success";
    else if (value <= target * 1.5) tone = "warning";
    else tone = "danger";
  } else {
    if (target === 0) tone = "muted";
    else if (pct >= 100) tone = "success";
    else if (pct >= 60) tone = "warning";
    else tone = "danger";
  }
  return { value, target, pct: Math.min(pct, 999), hit, tone, label };
}

/* Bonus tiers */
const BONUS_TIERS = [
  { id: "platinum", label: "Platinum", min: 1.10, amount: 800, color: "oklch(58% 0.14 280)" },
  { id: "gold",     label: "Gold",     min: 1.00, amount: 500, color: "oklch(75% 0.15 78)"  },
  { id: "silver",   label: "Silver",   min: 0.85, amount: 300, color: "oklch(70% 0.02 260)" },
  { id: "bronze",   label: "Bronze",   min: 0.70, amount: 150, color: "oklch(60% 0.10 50)"  },
  { id: "none",     label: "Not yet",  min: 0,    amount: 0,   color: "var(--muted-2)"      },
];

/* Compute everything for a user */
function computeMetricsFor(user) {
  // Defensive fallback for unknown roles (real users may carry role
  // strings that classifyRole didn't normalize, or future role types).
  // Without this, OverviewPage map throws on the first unknown role.
  const t = TARGETS_BY_ROLE[user.role] || TARGETS_BY_ROLE.agent;
  // Phase 10 — real numbers override the hardcoded RESPONSE_ACTUALS / MTD mocks
  // when user has real Gmail-tracked activity (emailReplyMinAvg > 0 or
  // emailsSent > 0 = data-shim populated us). Falls back to mocks for the
  // u1..u12 seed records so the prototype page still demoes.
  const rMock = RESPONSE_ACTUALS[user.id] || { emailReplyMin: 0, callPickupSec: 0, missedCalls: 0, callsExpected: 0 };
  const hasRealEmailStats = (user.emailsSent || 0) > 0 || (user.emailsReceived || 0) > 0 || (user.emailsReplies || 0) > 0;
  const r = hasRealEmailStats
    ? {
        emailReplyMin: user.emailReplyMinAvg || rMock.emailReplyMin,
        callPickupSec: rMock.callPickupSec,
        missedCalls: rMock.missedCalls,
        callsExpected: rMock.callsExpected,
      }
    : rMock;
  const mtdMock = MTD[user.id] || { calls: 0, emails: 0, contracts: 0, daysWorked: 0, daysExpected: 1 };
  const mtd = hasRealEmailStats
    ? { ...mtdMock, emails: user.emailsSent || mtdMock.emails }
    : mtdMock;

  const hoursToday = user.online / 60;
  const offline = user.status === "offline";

  /* Today's target meters */
  const today = {
    calls:    meter(user.calls,     t.calls,        "Calls"),
    emails:   meter(user.emails,    t.emails,       "Emails"),
    contracts:meter(user.contracts, t.contracts,    "Contracts"),
    hours:    meter(Math.round(hoursToday * 10) / 10, t.hoursWorked, "Hours"),
    reply:    meter(r.emailReplyMin, t.emailReplyMin, "Email reply", { lowerBetter: true }),
    pickup:   meter(r.callPickupSec, t.callPickupSec, "Call pickup", { lowerBetter: true }),
    missed:   { value: r.missedCalls, target: 1, hit: r.missedCalls <= 1, tone: r.missedCalls === 0 ? "success" : r.missedCalls > 2 ? "danger" : "warning" },
  };

  /* How many of today's targets did they hit (out of 5) */
  const todayPrimary = [today.calls, today.emails, today.hours, today.reply, today.pickup];
  const hits = todayPrimary.filter(m => m.hit).length;
  const expected = todayPrimary.filter(m => m.target > 0).length;

  /* Plain-English status */
  let status;
  if (offline && user.away) status = { id: "off", label: "Off today", icon: "minus", tone: "muted", sub: user.away };
  else if (offline)         status = { id: "off", label: "Offline", icon: "minus", tone: "muted" };
  else if (user.unusual)    status = { id: "alert", label: "Needs attention", icon: "warning", tone: "danger" };
  else if (hits >= 5)       status = { id: "crushing", label: "Crushing it", icon: "zap", tone: "success" };
  else if (hits >= 3)       status = { id: "ontrack", label: "On track", icon: "check", tone: "success" };
  else if (hits >= 2)       status = { id: "behind", label: "Behind pace", icon: "clock", tone: "warning" };
  else                      status = { id: "low", label: "Slow start", icon: "signal", tone: "warning" };

  /* Bonus calculation — based on MTD hit rate vs scaled monthly targets */
  const monthCallsTarget    = t.calls * mtd.daysExpected;
  const monthEmailsTarget   = t.emails * mtd.daysExpected;
  const monthContractsTarget= Math.max(1, t.contracts * mtd.daysExpected);
  const monthHoursTarget    = t.hoursWorked * mtd.daysExpected;

  const callRatio     = mtd.calls / monthCallsTarget;
  const emailRatio    = mtd.emails / monthEmailsTarget;
  const contractRatio = t.contracts === 0 ? 1 : mtd.contracts / monthContractsTarget;
  const presenceRatio = mtd.daysWorked / mtd.daysExpected;

  /* Composite — weighted by role */
  const weights = user.role === "agent" ? { c: .3, e: .2, k: .3, p: .2 }
                : user.role === "manager" ? { c: .15, e: .25, k: .4, p: .2 }
                : user.role === "accountant" ? { c: .1, e: .3, k: 0, p: .6 }
                : { c: .1, e: .4, k: 0, p: .5 };

  const score = callRatio * weights.c + emailRatio * weights.e + contractRatio * weights.k + presenceRatio * weights.p;

  /* Map to tier */
  let tier = BONUS_TIERS[BONUS_TIERS.length - 1];
  for (const tt of BONUS_TIERS) { if (score >= tt.min) { tier = tt; break; } }

  /* Per-contract earn for agents = $50, etc — add to base tier */
  const perContract = user.role === "agent" ? 50 : user.role === "manager" ? 35 : 0;
  const extraFromContracts = mtd.contracts * perContract;
  const bonusMtd = tier.amount + extraFromContracts;

  /* Progress to next tier */
  const tierIdx = BONUS_TIERS.findIndex(t => t.id === tier.id);
  const nextTier = tierIdx > 0 ? BONUS_TIERS[tierIdx - 1] : null;
  const progressToNext = nextTier ? Math.min(1, (score - tier.min) / (nextTier.min - tier.min)) : 1;

  return {
    today, hits, expected, status,
    mtd, monthTargets: {
      calls: monthCallsTarget, emails: monthEmailsTarget,
      contracts: monthContractsTarget, hours: monthHoursTarget,
    },
    score, tier, nextTier, progressToNext, bonusMtd, extraFromContracts,
    targets: t, actuals: r,
    hoursToday: Math.round(hoursToday * 10) / 10,
  };
}

/* Cached metrics per user */
const METRICS_CACHE = {};
window.metricsFor = function(user) {
  if (!METRICS_CACHE[user.id]) METRICS_CACHE[user.id] = computeMetricsFor(user);
  return METRICS_CACHE[user.id];
};
window.BONUS_TIERS = BONUS_TIERS;
window.TARGETS_BY_ROLE = TARGETS_BY_ROLE;

/* Status label map (also used in other-views) */
window.STATUS_TONES = {
  success: { bg: "var(--success-soft)", fg: "var(--success-ink)" },
  warning: { bg: "var(--warning-soft)", fg: "var(--warning-ink)" },
  danger:  { bg: "var(--danger-soft)",  fg: "var(--danger-ink)"  },
  muted:   { bg: "var(--surface-2)",    fg: "var(--muted)"       },
};
