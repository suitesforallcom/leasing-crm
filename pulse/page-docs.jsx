/* global React */

/* ================================================================
   PageHelp — переиспользуемый «?»-tooltip рядом с заголовком
   страницы. Tony 2026-05-26: «Сделай сначала краткое ниже подробное
   описание при нажатии на ?» + раскат на все текущие и будущие.

   Convention:
     • Каждая Pulse-страница ОБЯЗАНА иметь запись в PAGE_DOCS ниже.
     • Каждая Pulse-страница ОБЯЗАНА рендерить <PageHelp pageId="..." />
       рядом с <h1 className="title">…</h1>.
     • subtitle под заголовком — короткая динамическая подпись (метрика,
       контекст окна). PageHelp — статичное reference-описание: что
       показывает страница, откуда данные, как читать, что делать.
     • Если добавляешь новую страницу — добавь PAGE_DOCS-запись в этот
       файл (parse-check проверит синтаксис).
   ================================================================ */

window.PAGE_DOCS = {

  /* ====================  MY WORKSPACE  ==================== */

  myday: {
    title: "My Day",
    detail: (
      <>
        <p><b>What this is.</b> Your personal daily dashboard — what you did today, what's planned, what needs your attention right now.</p>
        <p><b>Sections.</b> Greeting + day score · today's calls / emails / meetings · tasks · quick actions (log call, create task, request bonus).</p>
        <p><b>Data sources.</b> Pulse activity stream (auto-captured from Aircall, Gmail sync, calendar) + manual logs you create here.</p>
        <p><b>How to use.</b> Open first thing in the morning to see priorities; come back at end-of-day to verify activity was captured.</p>
      </>
    ),
  },

  myjourney: {
    title: "My Journey",
    detail: (
      <>
        <p><b>What this is.</b> Long-term view of your personal performance — month-over-month trend on activity, bonuses earned, contracts signed.</p>
        <p><b>Data sources.</b> Same activity stream as My Day, aggregated by month, plus the bonus payouts ledger.</p>
        <p><b>How to use.</b> See if you're trending up; spot the months that earned the most bonus and replicate the behavior.</p>
      </>
    ),
  },

  earn: {
    title: "How to earn",
    detail: (
      <>
        <p><b>What this is.</b> Reference page: every bonus rule + how it pays out, every behavior that contributes to your activity score.</p>
        <p><b>Data sources.</b> Bonus-rules config (set by Owner in «Bonus rules» admin page).</p>
        <p><b>How to use.</b> Read once to understand the comp plan; come back when you want to figure out the highest-paying activity for the day.</p>
      </>
    ),
  },

  /* ====================  OWNER · ADMIN  ==================== */

  overview: {
    title: "Activity Center",
    detail: (
      <>
        <p><b>What this is.</b> Real-time admin overview — who's active right now, today's leaderboard, live event stream from every employee.</p>
        <p><b>Data sources.</b> Activity events stream (Aircall calls + Gmail sync + manual logs + meeting events).</p>
        <p><b>How to read it.</b> Online-now count · today's top 3 by activity score · live event feed (newest first). Use the center filter (topbar) to scope to one location.</p>
        <p><b>How to use.</b> Morning check-in: is everyone online and active. Mid-day pulse: who's converting calls into tours. End-of-day: top-performer recognition.</p>
      </>
    ),
  },

  people: {
    title: "People",
    detail: (
      <>
        <p><b>What this is.</b> Full employee roster — name, role, center, today's activity score, status (online / offline / away), last action.</p>
        <p><b>Data sources.</b> Workspace members (Firebase Auth + invites) joined with today's activity aggregates.</p>
        <p><b>How to use.</b> Click any name to drill into their per-employee dashboard (full activity history, bonuses, calls, contracts). Sort or filter by center, role, or score to find outliers.</p>
      </>
    ),
  },

  centers: {
    title: "Centers",
    detail: (
      <>
        <p><b>What this is.</b> Per-location dashboard — every building (center) with headcount, today's activity, contracts MTD, occupancy.</p>
        <p><b>Data sources.</b> Floor-map state (centers + units) + activity events (filtered by employee→center mapping) + active leases.</p>
        <p><b>How to use.</b> Compare centers side-by-side; identify which location is leading on conversions vs. which is lagging on activity. Click a center for its team + units.</p>
      </>
    ),
  },

  compare: {
    title: "Compare employees",
    detail: (
      <>
        <p><b>What this is.</b> Side-by-side activity comparison — pick 2+ employees and see their metrics on the same chart and table.</p>
        <p><b>Data sources.</b> Per-employee activity aggregates (calls, emails, meetings, contracts, bonuses).</p>
        <p><b>How to use.</b> Coaching conversations («here's why X is on track and Y is behind»); performance reviews; identifying who to model.</p>
      </>
    ),
  },

  bonuses: {
    title: "Bonuses",
    detail: (
      <>
        <p><b>What this is.</b> Ledger of all bonus payouts — who earned what, when, for which rule, what was the underlying event.</p>
        <p><b>Data sources.</b> Bonus events (auto-fired when a tracked behavior happens — call answered, tour booked, lease signed) + manual bonus grants from Owner.</p>
        <p><b>How to use.</b> Payroll prep at month-end; audit a specific employee's bonus run; spot rules that fire too often or never.</p>
      </>
    ),
  },

  bonusrules: {
    title: "Bonus rules",
    detail: (
      <>
        <p><b>What this is.</b> Config page — every bonus rule (name, trigger event, amount, scope) editable from one place.</p>
        <p><b>How to use.</b> Tweak amounts when the comp plan changes; disable a rule that's getting gamed; add a new rule for a behavior you want to encourage.</p>
        <p><b>Safety.</b> Changes apply to FUTURE events only — the historical bonus ledger is immutable. Test with one employee before broadcasting.</p>
      </>
    ),
  },

  alerts: {
    title: "Unusual activity",
    detail: (
      <>
        <p><b>What this is.</b> Anomaly detector — events flagged as out-of-pattern: unusually long call gaps, sudden activity drops, irregular log-in times.</p>
        <p><b>Data sources.</b> Same activity stream, scored against per-employee baselines (rolling 30-day average).</p>
        <p><b>How to use.</b> Daily glance — anything red here gets a manager check-in. Most flags are benign (sick day, vacation); the ones that aren't are worth catching early.</p>
      </>
    ),
  },

  /* ====================  MARKETING GROUP  ==================== */

  hubspot: {
    title: "HubSpot",
    detail: (
      <>
        <p><b>What this is.</b> Direct view into HubSpot CRM — contacts list, lifecycle stage breakdown, source attribution, sync status.</p>
        <p><b>Data sources.</b> HubSpot API (cron sync every hour + manual «Sync now» button).</p>
        <p><b>How to read it.</b> KPI strip = totals (contacts, MQL+, customers). Lifecycle funnel = conversion rate at each stage. Source table = where contacts came from. Sync card = last fetch time + error log.</p>
        <p><b>How to use.</b> Single source of truth for «how many leads do we have right now». For attribution + spend join → see Channel mix.</p>
      </>
    ),
  },

  marketing: {
    title: "Channel mix",
    detail: (
      <>
        <p><b>What this page shows.</b> Single source of truth for marketing performance: how much each acquisition channel costs, how many leads it brings, and how many of those convert into signed leases.</p>
        <p><b>Where the data comes from.</b></p>
        <ul>
          <li><b>HubSpot CRM</b> — every contact's lifecycle stage (lead → MQL → SQL → opportunity → customer) and the original UTM source/medium that brought them in.</li>
          <li><b>Google Ads API</b> — daily spend, clicks, impressions, conversions per campaign (pulled by the Apps Script every hour).</li>
          <li><b>Meta Ads API</b> — same metrics for Facebook + Instagram accounts.</li>
          <li><b>TikTok Ads API</b> — same for TikTok ad accounts.</li>
          <li><b>Floor-map state</b> — actually signed leases attributed back to the channel that sourced the tenant. Drives the «Contracts» column + MRR uplift.</li>
        </ul>
        <p><b>How to read it.</b></p>
        <ul>
          <li><b>Pipeline funnel</b> (top) — HubSpot funnel: leads → qualified → opportunity → customer for the selected window.</li>
          <li><b>Channel mix table</b> (middle) — leads per channel grouped by group: paid search / paid social / organic / direct / offline.</li>
          <li><b>Ad spend × HubSpot conversions</b> (bottom) — joined view: spend + clicks from ad platforms, leads + contracts from HubSpot + floor-map. CPL = cost ÷ qualified leads; CAC = cost ÷ signed leases.</li>
        </ul>
        <p><b>Toggles.</b> Date window (Today / Yesterday / 7d / 30d / 90d / MTD / Custom) + Quality leads only (MQL+) filter (strips Facebook Lead Ad junk).</p>
        <p><b>What to do.</b> Find the channel with the lowest CAC + highest contract count → that's your next budget bump. High spend + zero qualified leads → pause or audit creative.</p>
      </>
    ),
  },

  topads: {
    title: "Top Ads",
    detail: (
      <>
        <p><b>What this is.</b> Cross-platform creative leaderboard — your best-performing ads from Google Ads, Meta Ads, and TikTok Ads in one ranked list.</p>
        <p><b>Data sources.</b> Per-ad spend + clicks + conversions ingested daily by the three ad-platform bridges (see Connections → Google Ads / Meta / TikTok).</p>
        <p><b>How to read it.</b> Rank by spend, CPL, conversions, or ROAS using the column sort. Filter to one platform if you want apples-to-apples.</p>
        <p><b>How to use.</b> Identify creative winners to scale; identify losers to pause. The cross-platform view lets you see if a creative format (e.g. UGC video) works across networks or only on one.</p>
      </>
    ),
  },

  keywords: {
    title: "Keywords",
    detail: (
      <>
        <p><b>What this is.</b> Google Ads keyword-level performance — every active keyword you bid on, its match type, status, and conversion economics.</p>
        <p><b>Data sources.</b> Google Ads API via the Apps Script (see <code>scripts/google-ads-script.js</code>) — pulls <code>keyword_view</code> daily, writes to the <code>marketing_keywords</code> subcollection.</p>
        <p><b>How to read it.</b> Spend / Impr / Clicks / CTR / CPC / Conv / CPA per keyword. Trend sparkline shows last-30-days direction.</p>
        <p><b>How to use.</b> Pause high-spend zero-conversion keywords; bump bids on low-spend high-conversion ones; spot new exact-match opportunities. For new keyword ideas you haven't bid on yet → see Search Terms.</p>
      </>
    ),
  },

  searchterms: {
    title: "Search Terms",
    detail: (
      <>
        <p><b>What this is.</b> Actual user queries that triggered your Google Ads — different from Keywords (which are what you bid on). This shows what people really typed.</p>
        <p><b>Data sources.</b> Google Ads <code>search_term_view</code> via the Apps Script. <b>Note:</b> currently capped at 2000 rows per sync — long-tail beyond that isn't ingested yet.</p>
        <p><b>How to read it.</b> Same metric columns as Keywords. Status column shows if the term is added / excluded / none. Filter by «none» to find untracked queries worth adding.</p>
        <p><b>How to use.</b> Find high-converting queries you should add as exact-match keywords. Find irrelevant queries that ate budget — add them as negative keywords.</p>
      </>
    ),
  },

  geo: {
    title: "Geography",
    detail: (
      <>
        <p><b>What this is.</b> Google Ads performance by country (and where available, region or city).</p>
        <p><b>Data sources.</b> Google Ads <code>geographic_view</code> via the Apps Script + <code>geo_target_constant</code> for name resolution.</p>
        <p><b>How to read it.</b> Spend + conversions per location. Cost-per-acquisition tells you which markets convert cheapest.</p>
        <p><b>How to use.</b> Exclude geographies where spend leaks with no conversions; increase bid modifiers in high-converting regions.</p>
      </>
    ),
  },

  devices: {
    title: "Devices",
    detail: (
      <>
        <p><b>What this is.</b> Google Ads performance split by device type (mobile / desktop / tablet / connected TV).</p>
        <p><b>Data sources.</b> Google Ads <code>campaign + segments.device</code> via the Apps Script.</p>
        <p><b>How to use.</b> Apply device bid modifiers — e.g. bid down on tablet if it never converts; bid up on mobile if it converts cheapest.</p>
      </>
    ),
  },

  analytics: {
    title: "Google Analytics (GA4)",
    detail: (
      <>
        <p><b>What this is.</b> Dedicated GA4 dashboard — website traffic, source/medium, landing pages, events, devices + geo, daily timeseries.</p>
        <p><b>Data sources.</b> Google Analytics Data API (GA4 property → analyticsSync cron).</p>
        <p><b>How to read it.</b> Top KPIs (sessions / users / engagement / events). Tables for source/medium + landing pages. Charts for trends + device + geo splits.</p>
        <p><b>How to use.</b> Site-traffic side of the funnel — Marketing covers ad spend → leads; GA4 covers ad clicks → sessions → engagement on the site. Use together to find where the funnel leaks (high traffic + low form submits = landing-page problem).</p>
      </>
    ),
  },

  connections: {
    title: "Connections",
    detail: (
      <>
        <p><b>What this is.</b> Unified Settings page for all marketing data integrations — HubSpot, Google Ads, Meta, TikTok, GA4.</p>
        <p><b>What you can do here.</b> View connection status per integration, see last sync time, enable / disable accounts, add notes per account, force manual «Sync now».</p>
        <p><b>How to use.</b> First stop when a metric looks wrong («why is Meta spend zero this morning?»). Sync errors + auth re-prompts appear here.</p>
      </>
    ),
  },
};

/* ========================================================
   PageHelp component — circular «?» button next to the page
   title. Click toggles a detail panel rendered immediately
   after the button. State NOT persisted (reference panel,
   open-read-close pattern).
   ======================================================== */
window.PageHelp = function PageHelp({ pageId }) {
  const [open, setOpen] = React.useState(false);
  const doc = window.PAGE_DOCS && window.PAGE_DOCS[pageId];
  if (!doc) return null;

  const buttonStyle = {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 20, height: 20, borderRadius: 999,
    background: open ? "var(--accent)" : "var(--bg-2, #f1f5f9)",
    color: open ? "#fff" : "var(--ink-2, #475569)",
    border: "1px solid " + (open ? "var(--accent)" : "var(--border, #e2e8f0)"),
    fontSize: 11.5, fontWeight: 700, lineHeight: 1,
    cursor: "pointer", verticalAlign: "middle",
    marginLeft: 8,
    transition: "background 120ms, color 120ms, transform 120ms",
    fontFamily: "inherit",
  };

  return (
    <>
      <button
        type="button"
        title={open ? "Hide description" : "Show page description"}
        aria-expanded={open}
        aria-label={"Help for " + (doc.title || pageId)}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        style={buttonStyle}
      >
        ?
      </button>
      {open && (
        <div
          className="page-help-panel"
          style={{
            display: "block",
            marginTop: 12, marginBottom: 4,
            padding: "14px 16px",
            background: "var(--bg-2, #f8fafc)",
            border: "1px solid var(--border, #e2e8f0)",
            borderLeft: "3px solid var(--accent, #6366f1)",
            borderRadius: 8,
            fontSize: 13, lineHeight: 1.55,
            color: "var(--ink-2, #475569)",
            maxWidth: 880,
          }}
        >
          <style>{`
            .page-help-panel p { margin: 0 0 8px; }
            .page-help-panel p:last-child { margin-bottom: 0; }
            .page-help-panel ul { margin: 0 0 10px; padding-left: 20px; }
            .page-help-panel ul:last-child { margin-bottom: 0; }
            .page-help-panel li { margin-bottom: 4px; }
            .page-help-panel b { color: var(--ink-1, #18181b); font-weight: 700; }
            .page-help-panel code {
              background: rgba(99,102,241,0.08);
              padding: 1px 5px; border-radius: 3px;
              font-family: 'JetBrains Mono', monospace;
              font-size: 11.5px;
              color: var(--ink-1, #18181b);
            }
          `}</style>
          {doc.detail}
          <div style={{
            marginTop: 12, paddingTop: 10,
            borderTop: "1px dashed var(--border, #e2e8f0)",
            display: "flex", justifyContent: "flex-end",
          }}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                fontSize: 11.5, fontWeight: 600,
                color: "var(--muted, #94a3b8)",
                background: "transparent", border: "none", cursor: "pointer",
                padding: "2px 6px",
              }}
            >
              Close ×
            </button>
          </div>
        </div>
      )}
    </>
  );
};
