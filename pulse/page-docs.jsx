/* global React */

/* ================================================================
   PageHelp — переиспользуемый «?»-tooltip рядом с заголовком
   страницы. Tony 2026-05-26:
     • первоначально: «Сделай сначала краткое ниже подробное
       описание при нажатии на ?» + раскат на все текущие и будущие.
     • уточнение: «сделай мне возможность редактировать этот текст»
       + «Редактирование должно быть доступно только администратор».

   Convention:
     • Каждая Pulse-страница ОБЯЗАНА иметь запись в PAGE_DOCS ниже.
     • Каждая запись содержит `title` + `mdSource` (markdown-строка).
     • Каждая Pulse-страница ОБЯЗАНА рендерить <PageHelp pageId="..." />
       рядом с <h1 className="title">…</h1>.
     • subtitle под заголовком — короткая динамическая подпись (метрика,
       контекст окна). PageHelp — статичное reference-описание: что
       показывает страница, откуда данные, как читать, что делать.
     • Если добавляешь новую страницу — добавь PAGE_DOCS-запись в этот
       файл (parse-check проверит синтаксис).

   Editability:
     • Кнопка «Edit» видна ТОЛЬКО когда window.__pulseRole === 'owner'
       (admin/owner-view). app.jsx зеркалит свой `role` state в
       window.__pulseRole через useEffect.
     • Сохранение — в localStorage ключ `pulse-page-doc-<pageId>`.
       Per-browser (НЕ синхронится между админами / между девайсами).
       Если нужен team-wide sync — нужна Cloud Function + Firestore
       rule, отдельная итерация (Tony approval).
     • «Reset to default» — удаляет override, возвращает текст из
       mdSource этого файла.
   ================================================================ */

/* Markdown subset:
     blank line  — separates blocks
     **bold**    — <b>
     `inline`    — <code>
     - bullet    — <li> (block where every line starts with "- ")
   Anything else = paragraph. Newlines inside a paragraph are joined
   with a space (intentional — keeps source readable without forcing
   hard breaks). */
function renderInlineMd(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<b key={"b" + (k++)}>{m[1]}</b>);
    else if (m[2]) out.push(<code key={"c" + (k++)}>{m[2]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMd(src) {
  if (!src || !src.trim()) return null;
  const blocks = src.trim().split(/\n\s*\n/);
  return blocks.map((block, i) => {
    const lines = block.split("\n");
    if (lines.length > 0 && lines.every(l => /^\s*-\s+/.test(l))) {
      return (
        <ul key={i}>
          {lines.map((l, j) => (
            <li key={j}>{renderInlineMd(l.replace(/^\s*-\s+/, ""))}</li>
          ))}
        </ul>
      );
    }
    return <p key={i}>{renderInlineMd(block.replace(/\n/g, " "))}</p>;
  });
}

/* ================================================================
   PAGE_DOCS — source of truth for every page's description.
   Each entry: { title: string, mdSource: string (markdown) }.
   ================================================================ */
window.PAGE_DOCS = {

  /* ====================  MY WORKSPACE  ==================== */

  myday: {
    title: "My Day",
    mdSource:
`**What this is.** Your personal daily dashboard — what you did today, what's planned, what needs your attention right now.

**Sections.** Greeting + day score · today's calls / emails / meetings · tasks · quick actions (log call, create task, request bonus).

**Data sources.** Pulse activity stream (auto-captured from Aircall, Gmail sync, calendar) + manual logs you create here.

**How to use.** Open first thing in the morning to see priorities; come back at end-of-day to verify activity was captured.`,
  },

  myjourney: {
    title: "My Journey",
    mdSource:
`**What this is.** Long-term view of your personal performance — month-over-month trend on activity, bonuses earned, contracts signed.

**Data sources.** Same activity stream as My Day, aggregated by month, plus the bonus payouts ledger.

**How to use.** See if you're trending up; spot the months that earned the most bonus and replicate the behavior.`,
  },

  earn: {
    title: "How to earn",
    mdSource:
`**What this is.** Reference page: every bonus rule + how it pays out, every behavior that contributes to your activity score.

**Data sources.** Bonus-rules config (set by Owner in «Bonus rules» admin page).

**How to use.** Read once to understand the comp plan; come back when you want to figure out the highest-paying activity for the day.`,
  },

  /* ====================  OWNER · ADMIN  ==================== */

  overview: {
    title: "Activity Center",
    mdSource:
`**What this is.** Real-time admin overview — who's active right now, today's leaderboard, live event stream from every employee.

**Data sources.** Activity events stream (Aircall calls + Gmail sync + manual logs + meeting events).

**How to read it.** Online-now count · today's top 3 by activity score · live event feed (newest first). Use the center filter (topbar) to scope to one location.

**How to use.** Morning check-in: is everyone online and active. Mid-day pulse: who's converting calls into tours. End-of-day: top-performer recognition.`,
  },

  people: {
    title: "People",
    mdSource:
`**What this is.** Full employee roster — name, role, center, today's activity score, status (online / offline / away), last action.

**Data sources.** Workspace members (Firebase Auth + invites) joined with today's activity aggregates.

**How to use.** Click any name to drill into their per-employee dashboard (full activity history, bonuses, calls, contracts). Sort or filter by center, role, or score to find outliers.`,
  },

  centers: {
    title: "Centers",
    mdSource:
`**What this is.** Per-location dashboard — every building (center) with headcount, today's activity, contracts MTD, occupancy.

**Data sources.** Floor-map state (centers + units) + activity events (filtered by employee→center mapping) + active leases.

**How to use.** Compare centers side-by-side; identify which location is leading on conversions vs. which is lagging on activity. Click a center for its team + units.`,
  },

  compare: {
    title: "Compare employees",
    mdSource:
`**What this is.** Side-by-side activity comparison — pick 2+ employees and see their metrics on the same chart and table.

**Data sources.** Per-employee activity aggregates (calls, emails, meetings, contracts, bonuses).

**How to use.** Coaching conversations («here's why X is on track and Y is behind»); performance reviews; identifying who to model.`,
  },

  bonuses: {
    title: "Bonuses",
    mdSource:
`**What this is.** Ledger of all bonus payouts — who earned what, when, for which rule, what was the underlying event.

**Data sources.** Bonus events (auto-fired when a tracked behavior happens — call answered, tour booked, lease signed) + manual bonus grants from Owner.

**How to use.** Payroll prep at month-end; audit a specific employee's bonus run; spot rules that fire too often or never.`,
  },

  bonusrules: {
    title: "Bonus rules",
    mdSource:
`**What this is.** Config page — every bonus rule (name, trigger event, amount, scope) editable from one place.

**How to use.** Tweak amounts when the comp plan changes; disable a rule that's getting gamed; add a new rule for a behavior you want to encourage.

**Safety.** Changes apply to FUTURE events only — the historical bonus ledger is immutable. Test with one employee before broadcasting.`,
  },

  alerts: {
    title: "Unusual activity",
    mdSource:
`**What this is.** Anomaly detector — events flagged as out-of-pattern: unusually long call gaps, sudden activity drops, irregular log-in times.

**Data sources.** Same activity stream, scored against per-employee baselines (rolling 30-day average).

**How to use.** Daily glance — anything red here gets a manager check-in. Most flags are benign (sick day, vacation); the ones that aren't are worth catching early.`,
  },

  /* ====================  MARKETING GROUP  ==================== */

  hubspot: {
    title: "HubSpot",
    mdSource:
`**What this is.** Direct view into HubSpot CRM — contacts list, lifecycle stage breakdown, source attribution, sync status.

**Data sources.** HubSpot API (cron sync every hour + manual «Sync now» button).

**How to read it.** KPI strip = totals (contacts, MQL+, customers). Lifecycle funnel = conversion rate at each stage. Source table = where contacts came from. Sync card = last fetch time + error log.

**How to use.** Single source of truth for «how many leads do we have right now». For attribution + spend join → see Channel mix.`,
  },

  marketing: {
    title: "Channel mix",
    mdSource:
`**What this page shows.** Single source of truth for marketing performance: how much each acquisition channel costs, how many leads it brings, and how many of those convert into signed leases.

**Where the data comes from.**

- **HubSpot CRM** — every contact's lifecycle stage (lead → MQL → SQL → opportunity → customer) and the original UTM source/medium that brought them in.
- **Google Ads API** — daily spend, clicks, impressions, conversions per campaign (pulled by the Apps Script every hour).
- **Meta Ads API** — same metrics for Facebook + Instagram accounts.
- **TikTok Ads API** — same for TikTok ad accounts.
- **Floor-map state** — actually signed leases attributed back to the channel that sourced the tenant. Drives the «Contracts» column + MRR uplift.

**How to read it.**

- **Pipeline funnel** (top) — HubSpot funnel: leads → qualified → opportunity → customer for the selected window.
- **Channel mix table** (middle) — leads per channel grouped by group: paid search / paid social / organic / direct / offline.
- **Ad spend × HubSpot conversions** (bottom) — joined view: spend + clicks from ad platforms, leads + contracts from HubSpot + floor-map. CPL = cost ÷ qualified leads; CAC = cost ÷ signed leases.

**Toggles.** Date window (Today / Yesterday / 7d / 30d / 90d / MTD / Custom) + Quality leads only (MQL+) filter (strips Facebook Lead Ad junk).

**What to do.** Find the channel with the lowest CAC + highest contract count → that's your next budget bump. High spend + zero qualified leads → pause or audit creative.`,
  },

  topads: {
    title: "Top Ads",
    mdSource:
`**What this is.** Cross-platform creative leaderboard — your best-performing ads from Google Ads, Meta Ads, and TikTok Ads in one ranked list.

**Data sources.** Per-ad spend + clicks + conversions ingested daily by the three ad-platform bridges (see Connections → Google Ads / Meta / TikTok).

**How to read it.** Rank by spend, CPL, conversions, or ROAS using the column sort. Filter to one platform if you want apples-to-apples.

**How to use.** Identify creative winners to scale; identify losers to pause. The cross-platform view lets you see if a creative format (e.g. UGC video) works across networks or only on one.`,
  },

  keywords: {
    title: "Keywords",
    mdSource:
`**What this is.** Google Ads keyword-level performance — every active keyword you bid on, its match type, status, and conversion economics.

**Data sources.** Google Ads API via the Apps Script (see \`scripts/google-ads-script.js\`) — pulls \`keyword_view\` daily, writes to the \`marketing_keywords\` subcollection.

**How to read it.** Spend / Impr / Clicks / CTR / CPC / Conv / CPA per keyword. Trend sparkline shows last-30-days direction.

**How to use.** Pause high-spend zero-conversion keywords; bump bids on low-spend high-conversion ones; spot new exact-match opportunities. For new keyword ideas you haven't bid on yet → see Search Terms.`,
  },

  searchterms: {
    title: "Search Terms",
    mdSource:
`**What this is.** Actual user queries that triggered your Google Ads — different from Keywords (which are what you bid on). This shows what people really typed.

**Data sources.** Google Ads \`search_term_view\` via the Apps Script. **Note:** currently capped at 2000 rows per sync — long-tail beyond that isn't ingested yet.

**How to read it.** Same metric columns as Keywords. Status column shows if the term is added / excluded / none. Filter by «none» to find untracked queries worth adding.

**How to use.** Find high-converting queries you should add as exact-match keywords. Find irrelevant queries that ate budget — add them as negative keywords.`,
  },

  geo: {
    title: "Geography",
    mdSource:
`**What this is.** Google Ads performance by country (and where available, region or city).

**Data sources.** Google Ads \`geographic_view\` via the Apps Script + \`geo_target_constant\` for name resolution.

**How to read it.** Spend + conversions per location. Cost-per-acquisition tells you which markets convert cheapest.

**How to use.** Exclude geographies where spend leaks with no conversions; increase bid modifiers in high-converting regions.`,
  },

  devices: {
    title: "Devices",
    mdSource:
`**What this is.** Google Ads performance split by device type (mobile / desktop / tablet / connected TV).

**Data sources.** Google Ads \`campaign + segments.device\` via the Apps Script.

**How to use.** Apply device bid modifiers — e.g. bid down on tablet if it never converts; bid up on mobile if it converts cheapest.`,
  },

  analytics: {
    title: "Google Analytics (GA4)",
    mdSource:
`**What this is.** Dedicated GA4 dashboard — website traffic, source/medium, landing pages, events, devices + geo, daily timeseries.

**Data sources.** Google Analytics Data API (GA4 property → analyticsSync cron).

**How to read it.** Top KPIs (sessions / users / engagement / events). Tables for source/medium + landing pages. Charts for trends + device + geo splits.

**How to use.** Site-traffic side of the funnel — Marketing covers ad spend → leads; GA4 covers ad clicks → sessions → engagement on the site. Use together to find where the funnel leaks (high traffic + low form submits = landing-page problem).`,
  },

  connections: {
    title: "Connections",
    mdSource:
`**What this is.** Unified Settings page for all marketing data integrations — HubSpot, Google Ads, Meta, TikTok, GA4.

**What you can do here.** View connection status per integration, see last sync time, enable / disable accounts, add notes per account, force manual «Sync now».

**How to use.** First stop when a metric looks wrong («why is Meta spend zero this morning?»). Sync errors + auth re-prompts appear here.`,
  },
};

/* ================================================================
   localStorage helpers — per-browser override of mdSource.
   Key: `pulse-page-doc-<pageId>`. Value: markdown string.
   ================================================================ */
function loadOverride(pageId) {
  try { return localStorage.getItem("pulse-page-doc-" + pageId); }
  catch (e) { return null; }
}
function saveOverride(pageId, md) {
  try { localStorage.setItem("pulse-page-doc-" + pageId, md); }
  catch (e) {}
}
function clearOverride(pageId) {
  try { localStorage.removeItem("pulse-page-doc-" + pageId); }
  catch (e) {}
}

/* Owner-only edit gate. window.__pulseRole is set by app.jsx
   useEffect, mirroring its `role` state. Default false on undefined. */
function isAdminViewer() {
  return window.__pulseRole === "owner";
}

/* ================================================================
   PageHelp — circular «?» button next to the page title. Click
   toggles a detail panel rendered immediately after the button.
   Admin sees «Edit» which opens textarea + Save/Cancel/Reset.
   Override + open/edit state are NOT persisted across mounts —
   the override itself is in localStorage; the panel reopens fresh.
   ================================================================ */
window.PageHelp = function PageHelp({ pageId }) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [override, setOverride] = React.useState(false);
  const [src, setSrc] = React.useState("");

  const doc = window.PAGE_DOCS && window.PAGE_DOCS[pageId];
  if (!doc) return null;

  function refreshSrc() {
    const o = loadOverride(pageId);
    setOverride(!!o);
    setSrc(o || doc.mdSource || "");
  }

  function openPanel() {
    refreshSrc();
    setEditing(false);
    setOpen(true);
  }

  function closePanel() {
    setOpen(false);
    setEditing(false);
  }

  function startEdit() {
    const o = loadOverride(pageId);
    setDraft(o || doc.mdSource || "");
    setEditing(true);
  }

  function saveEdit() {
    const trimmed = (draft || "").trim();
    const def = (doc.mdSource || "").trim();
    if (!trimmed || trimmed === def) {
      // empty or identical to default → drop override
      clearOverride(pageId);
    } else {
      saveOverride(pageId, trimmed);
    }
    refreshSrc();
    setEditing(false);
  }

  function cancelEdit() {
    setEditing(false);
  }

  function resetToDefault() {
    clearOverride(pageId);
    refreshSrc();
    setDraft(doc.mdSource || "");
  }

  const admin = isAdminViewer();

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

  const linkBtn = {
    fontSize: 11.5, fontWeight: 600,
    background: "transparent", border: "none", cursor: "pointer",
    padding: "2px 8px",
    fontFamily: "inherit",
  };

  const primaryBtn = {
    ...linkBtn,
    background: "var(--accent, #6366f1)",
    color: "#fff",
    borderRadius: 5,
    padding: "4px 12px",
  };

  return (
    <>
      <button
        type="button"
        title={open ? "Hide description" : "Show page description"}
        aria-expanded={open}
        aria-label={"Help for " + (doc.title || pageId)}
        onClick={(e) => { e.stopPropagation(); if (open) closePanel(); else openPanel(); }}
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
            .page-help-panel textarea {
              width: 100%; min-height: 220px;
              padding: 10px 12px;
              border: 1px solid var(--border, #e2e8f0);
              border-radius: 6px;
              font-family: 'JetBrains Mono', monospace;
              font-size: 12px; line-height: 1.5;
              color: var(--ink-1, #18181b);
              background: #fff;
              resize: vertical;
              box-sizing: border-box;
            }
            .page-help-edit-tip {
              font-size: 11px; color: var(--muted, #94a3b8);
              margin: 6px 0 0;
            }
            .page-help-edit-tip code { font-size: 10.5px; }
          `}</style>

          {override && !editing && (
            <div style={{
              display: "inline-block",
              marginBottom: 8,
              fontSize: 10.5, fontWeight: 700,
              letterSpacing: 0.4, textTransform: "uppercase",
              color: "var(--accent-ink, #4338ca)",
              background: "rgba(99,102,241,0.10)",
              padding: "2px 7px", borderRadius: 4,
            }}>
              Customized · local
            </div>
          )}

          {!editing && renderMd(src)}

          {editing && (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={true}
                autoFocus
              />
              <p className="page-help-edit-tip">
                Markdown subset: <code>**bold**</code> · <code>`code`</code> · paragraphs separated by blank lines · bullet lines start with <code>- </code>.
                Saved locally in this browser only (not synced to teammates).
              </p>
            </>
          )}

          <div style={{
            marginTop: 12, paddingTop: 10,
            borderTop: "1px dashed var(--border, #e2e8f0)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            gap: 8,
          }}>
            <div style={{ display: "flex", gap: 4 }}>
              {admin && !editing && (
                <button
                  type="button"
                  onClick={startEdit}
                  style={{ ...linkBtn, color: "var(--accent-ink, #4338ca)" }}
                  title="Edit this description (admin only)"
                >
                  ✎ Edit
                </button>
              )}
              {admin && override && !editing && (
                <button
                  type="button"
                  onClick={resetToDefault}
                  style={{ ...linkBtn, color: "var(--muted, #94a3b8)" }}
                  title="Discard local edits, restore default"
                >
                  Reset to default
                </button>
              )}
            </div>

            <div style={{ display: "flex", gap: 4 }}>
              {editing ? (
                <>
                  <button type="button" onClick={cancelEdit} style={{ ...linkBtn, color: "var(--muted, #94a3b8)" }}>
                    Cancel
                  </button>
                  <button type="button" onClick={saveEdit} style={primaryBtn}>
                    Save
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={closePanel}
                  style={{ ...linkBtn, color: "var(--muted, #94a3b8)" }}
                >
                  Close ×
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
