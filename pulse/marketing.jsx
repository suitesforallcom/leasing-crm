/* global React, Icon */

/* ===================================================================
   Pulse — Marketing page (Phase 1: channel mix from HubSpot data)

   Lead-source attribution dashboard. Phase 1 reads existing HubSpot
   sync data (no new integrations needed) to bucket every contact by:
     • Acquisition channel (Google Ads / Meta / TikTok / Organic / etc.)
     • Lifecycle stage (lead → MQL → SQL → opportunity → customer)

   Phase 2 (later) — adds real ad spend via direct API integrations:
     • googleAdsSync  CF — Google Ads API (Customer ID 215-096-1449)
     • metaAdsSync    CF — Meta Marketing API
     • tiktokAdsSync  CF — TikTok Business API
     • ga4Sync        CF — Google Analytics Data API
   to compute CPL / CPT / CAC / ROAS per channel.

   Until those land, the «Integrations» strip at the bottom shows status
   chips (connected / pending / not configured) — operator clicks to
   begin setup.
   =================================================================== */

// HubSpot lifecycle-stage hierarchy. A customer was once a lead, so a
// stage-X contact counts CUMULATIVELY toward every stage from 0 up to X.
// That's the standard funnel-analytics convention.
const STAGE_LEVELS = {
  subscriber: 0,
  lead: 1,
  marketingqualifiedlead: 2,
  salesqualifiedlead: 3,
  opportunity: 4,
  customer: 5,
  evangelist: 6,
};
function stageLevel(stage) {
  if (!stage) return 1;
  const key = String(stage).toLowerCase();
  return STAGE_LEVELS[key] !== undefined ? STAGE_LEVELS[key] : 1;
}

// Map HubSpot's hs_analytics_source + hs_analytics_source_data_1 into a
// human-friendly channel label. Falls through to «Other / Unknown» so
// every contact bucket gets surfaced (no silent drops).
function classifyChannel(srcCategory, srcPlatform) {
  if (!srcCategory) return { label: 'Unknown', group: 'unknown' };
  const cat = String(srcCategory).toUpperCase();
  const platform = String(srcPlatform || '').toLowerCase();
  if (cat === 'PAID_SEARCH') {
    if (platform.includes('google')) return { label: 'Google Ads', group: 'paid-search' };
    if (platform.includes('bing') || platform.includes('microsoft')) return { label: 'Microsoft Ads', group: 'paid-search' };
    return { label: 'Paid Search (other)', group: 'paid-search' };
  }
  if (cat === 'PAID_SOCIAL') {
    if (platform.includes('facebook') || platform.includes('instagram') || platform.includes('meta')) return { label: 'Meta Ads (FB / IG)', group: 'paid-social' };
    if (platform.includes('tiktok')) return { label: 'TikTok Ads', group: 'paid-social' };
    if (platform.includes('linkedin')) return { label: 'LinkedIn Ads', group: 'paid-social' };
    if (platform.includes('twitter') || platform.includes('x ads')) return { label: 'X (Twitter) Ads', group: 'paid-social' };
    return { label: 'Paid Social (other)', group: 'paid-social' };
  }
  if (cat === 'ORGANIC_SEARCH') return { label: 'Organic Search', group: 'organic' };
  if (cat === 'SOCIAL_MEDIA')   return { label: 'Organic Social', group: 'organic' };
  if (cat === 'DIRECT_TRAFFIC') return { label: 'Direct', group: 'direct' };
  if (cat === 'REFERRALS')      return { label: platform ? `Referral · ${platform}` : 'Referral', group: 'referral' };
  if (cat === 'EMAIL_MARKETING')return { label: 'Email Marketing', group: 'email' };
  if (cat === 'OFFLINE')        return { label: 'Offline', group: 'offline' };
  if (cat === 'OTHER_CAMPAIGNS' || cat === 'OTHER') return { label: 'Other Campaign', group: 'other' };
  return { label: cat, group: 'other' };
}

// Channel ordering for stable sort + visual grouping. Paid channels
// first (most attention-worthy), then organic / direct / other.
const GROUP_ORDER = {
  'paid-search': 1,
  'paid-social': 2,
  'organic':     3,
  'direct':      4,
  'referral':    5,
  'email':       6,
  'offline':     7,
  'other':       8,
  'unknown':     9,
};

window.MarketingPage = function MarketingPage() {
  const hs = window._hsDataCache;
  const [windowKind, setWindowKind] = React.useState('all'); // 'all' / 'mtd' / '30d' / '90d'

  if (!hs || !hs.contactByEmail) {
    return (
      <div className="page">
        <div className="page-h">
          <div>
            <h1 className="title">Marketing</h1>
            <div className="subtitle">Lead-source attribution from HubSpot CRM</div>
          </div>
        </div>
        <div className="card is-clean" style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>
          Loading HubSpot data… (no contactByEmail cache yet). Use the «Sync now» button on the HubSpot page if this persists.
        </div>
      </div>
    );
  }

  // Filter contacts by window
  const now = Date.now();
  const cutoffMs = windowKind === 'mtd'  ? new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
                : windowKind === '30d'  ? (now - 30 * 86400 * 1000)
                : windowKind === '90d'  ? (now - 90 * 86400 * 1000)
                : 0;
  const allContacts = Object.entries(hs.contactByEmail);
  const contacts = cutoffMs > 0
    ? allContacts.filter(([_, c]) => c.c && new Date(c.c).getTime() >= cutoffMs)
    : allContacts;

  // Bucket by channel + lifecycle stage
  // For each channel: cumulative count at each stage level (0..6).
  const buckets = new Map(); // channel label → { group, leads, qualified, opportunity, customer }
  function getBucket(label, group) {
    if (!buckets.has(label)) {
      buckets.set(label, { label, group, leads: 0, qualified: 0, opportunity: 0, customer: 0 });
    }
    return buckets.get(label);
  }
  for (const [, c] of contacts) {
    const ch = classifyChannel(c.src, c.srcD);
    const lvl = stageLevel(c.s);
    const b = getBucket(ch.label, ch.group);
    b.leads++;                       // every contact = a lead
    if (lvl >= 2) b.qualified++;     // MQL or higher
    if (lvl >= 4) b.opportunity++;   // opportunity or higher
    if (lvl >= 5) b.customer++;      // customer / evangelist
  }
  // Sort by group order, then leads desc within group
  const rows = Array.from(buckets.values()).sort((a, b) => {
    const ga = GROUP_ORDER[a.group] || 99;
    const gb = GROUP_ORDER[b.group] || 99;
    if (ga !== gb) return ga - gb;
    return b.leads - a.leads;
  });

  // Totals row
  const totals = rows.reduce((t, r) => ({
    leads: t.leads + r.leads,
    qualified: t.qualified + r.qualified,
    opportunity: t.opportunity + r.opportunity,
    customer: t.customer + r.customer,
  }), { leads: 0, qualified: 0, opportunity: 0, customer: 0 });

  const windowLabels = { all: 'All time', mtd: 'Month-to-date', '30d': 'Last 30 days', '90d': 'Last 90 days' };

  return (
    <div className="page">
      {/* Header */}
      <div className="page-h">
        <div>
          <h1 className="title">Marketing</h1>
          <div className="subtitle">
            <span>Lead-source attribution from HubSpot CRM</span>
            <span>·</span>
            <span className="mono">{totals.leads.toLocaleString()} contacts in window</span>
          </div>
        </div>
        <div className="row">
          <div className="f-segment">
            {[['all', 'All'], ['mtd', 'MTD'], ['30d', '30d'], ['90d', '90d']].map(([k, l]) => (
              <button key={k} className={windowKind === k ? 'is-active' : ''} onClick={() => setWindowKind(k)}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI strip — totals */}
      <div className="card is-clean" style={{ marginBottom: 18, padding: 14 }}>
        <div className="row" style={{ marginBottom: 10, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Pipeline · {windowLabels[windowKind]}
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 32 }}>
          <FunnelStat icon="people"  label="Leads"        value={totals.leads}        denominator={null}              tone="muted" />
          <FunnelStat icon="zap"     label="Qualified"    value={totals.qualified}    denominator={totals.leads}     tone="info" />
          <FunnelStat icon="trendUp" label="Opportunity"  value={totals.opportunity}  denominator={totals.leads}     tone="warning" />
          <FunnelStat icon="star"    label="Customer"     value={totals.customer}     denominator={totals.leads}     tone="success" />
        </div>
      </div>

      {/* Channel mix table */}
      <div className="card is-clean" style={{ marginBottom: 18, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 700 }}>
          Channel mix · {windowLabels[windowKind]}
          <span className="muted" style={{ marginLeft: 8, fontSize: 11, fontWeight: 500 }}>
            {rows.length} channels · grouped by paid → organic → direct
          </span>
        </div>
        <ChannelHeader />
        {rows.length === 0 && (
          <div style={{ padding: 18, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
            No contacts with source data in this window.
          </div>
        )}
        {rows.map((r) => (
          <ChannelRow key={r.label} row={r} totalLeads={totals.leads} />
        ))}
      </div>

      {/* Ad spend section — pulls from window._mkDataCache populated by the
          marketingIngest CF endpoint. Empty until Google Ads Script /
          Meta / TikTok bridges start posting. */}
      <SpendSection rows={rows} totals={totals} />

      {/* Integration status strip — placeholder for Phase 2 ad-platform syncs */}
      <IntegrationsStatus />
    </div>
  );
};

// Custom React tooltip — shows instantly on hover (native title attribute
// has a 1-2s delay and renders inconsistently). Positioned absolute below
// the trigger, dark background, fades in. Wraps the label + ? icon.
function HeaderTip({ label, hint }) {
  const [open, setOpen] = React.useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 3, cursor: "help" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {label}
      <span style={{
        fontSize: 9, color: "var(--muted-2)",
        border: "1px solid var(--muted-2)", borderRadius: "50%",
        width: 12, height: 12,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontWeight: 700,
        background: open ? "var(--muted-2)" : "transparent",
        color: open ? "white" : "var(--muted-2)",
      }}>?</span>
      {open && (
        <span
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 50,
            background: "#1f2937",
            color: "#f9fafb",
            padding: "8px 11px",
            borderRadius: 6,
            fontSize: 11.5,
            fontWeight: 500,
            letterSpacing: "normal",
            textTransform: "none",
            lineHeight: 1.4,
            width: 280,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            pointerEvents: "none",
            whiteSpace: "normal",
            textAlign: "left",
          }}
        >
          {hint}
          {/* Little arrow pointing up */}
          <span style={{
            position: "absolute", top: -5, right: 14,
            width: 0, height: 0,
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderBottom: "5px solid #1f2937",
          }} />
        </span>
      )}
    </span>
  );
}

function SpendSection({ rows, totals }) {
  const mk = window._mkDataCache;
  const sources = (mk && mk.sources) || {};
  const sourceKeys = Object.keys(sources);

  // Date-range selector — applies to the daily-granular spend data
  // (Google Ads Script pulls 90d; older incoming sources still work
  // on aggregate fallback). State scoped to this section.
  // windowKind: '7d' / '30d' / '90d' / 'mtd' / 'custom'
  const [windowKind, setWindowKind] = React.useState("30d");
  // Custom range — only used when windowKind === 'custom'. Defaults
  // to last 14 days so the inputs aren't empty when first opened.
  const _today = new Date();
  const _twoWksAgo = new Date(_today.getTime() - 14 * 86400 * 1000);
  function fmtYmd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  const [customStart, setCustomStart] = React.useState(fmtYmd(_twoWksAgo));
  const [customEnd, setCustomEnd] = React.useState(fmtYmd(_today));
  // «Site leads only» — exclude OFFLINE + INTEGRATION sources from the
  // leads count used in CPL. Tony: «учитывать только заявки через сайт».
  // PAID_SEARCH already implies web (ad click → landing page), so we
  // count all HubSpot contacts from that channel that aren't tagged
  // OFFLINE. Toggle persists in localStorage.
  const [siteLeadsOnly, setSiteLeadsOnly] = React.useState(() => {
    try { return localStorage.getItem("pulse_marketing_site_leads_only") !== "false"; }
    catch (e) { return true; }
  });
  React.useEffect(() => {
    try { localStorage.setItem("pulse_marketing_site_leads_only", siteLeadsOnly ? "true" : "false"); } catch (e) {}
  }, [siteLeadsOnly]);

  if (sourceKeys.length === 0) {
    return (
      <div className="card is-clean" style={{ marginBottom: 18, padding: 14, borderLeft: "3px dashed #d4d4d8" }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Ad spend · pending</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
          No spend data has been ingested yet. Once a platform bridge (Google Ads Script / Meta API / TikTok API) starts posting, you'll see CPL / CPT / CAC / ROAS per channel here.
        </div>
      </div>
    );
  }

  // Date-range cutoffs for daily aggregation. Returns {start,end} YYYY-MM-DD
  // strings (end inclusive). 'custom' uses the user-picked dates.
  function windowRange(kind) {
    const today = new Date();
    const todayYmd = fmtYmd(today);
    if (kind === "custom") {
      return { start: customStart, end: customEnd };
    }
    if (kind === "mtd") {
      return { start: today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-01", end: todayYmd };
    }
    const days = kind === "7d" ? 7 : kind === "90d" ? 90 : 30;
    const back = new Date(today.getTime() - (days - 1) * 86400 * 1000);
    return { start: fmtYmd(back), end: todayYmd };
  }
  const { start: windowStart, end: windowEnd } = windowRange(windowKind);
  const windowLabel = windowKind === "7d" ? "Last 7 days"
                    : windowKind === "30d" ? "Last 30 days"
                    : windowKind === "90d" ? "Last 90 days"
                    : windowKind === "mtd" ? "Month to date"
                    : "Custom range";

  // Map our channel groups → ingest source keys. PAID_SEARCH + google →
  // 'google-ads' bucket; PAID_SOCIAL + facebook/instagram → 'meta'; etc.
  // For each ingested source, compute cost / leads (joined from HubSpot
  // channel-mix table) and surface CPL.
  function findChannelRow(group, namePrefix) {
    return rows.find(r => r.group === group && r.label.startsWith(namePrefix));
  }
  function makeJoinedRow(sourceKey, friendlyLabel, channelMatcher) {
    const src = sources[sourceKey];
    if (!src) return null;
    // Aggregate daily → window totals. Three shapes supported:
    //   1. Google Ads — src.daily = [{id, date, cost, ...}] (flat array)
    //   2. Meta Ads  — src.accounts = [{id, name, daily: [...]}] (nested per acct)
    //   3. Legacy v1 — src.totals only (no breakdown), show as-is
    let cost = 0, clicks = 0, impressions = 0, conversions = 0;
    let dailyRowsInWindow = 0;
    let accountBreakdown = null; // for Meta drilldown
    const daily = Array.isArray(src.daily) ? src.daily : null;
    const accounts = Array.isArray(src.accounts) ? src.accounts : null;
    if (accounts && accounts.length > 0) {
      // Multi-account (Meta). Sum across all accounts' daily rows in window.
      accountBreakdown = [];
      for (const a of accounts) {
        let aCost = 0, aClicks = 0, aImpr = 0, aConv = 0, aRows = 0;
        if (Array.isArray(a.daily)) {
          for (const d of a.daily) {
            if (d.date >= windowStart && d.date <= windowEnd) {
              aCost += d.cost || 0;
              aClicks += d.clicks || 0;
              aImpr += d.impressions || 0;
              aConv += d.conversions || 0;
              aRows++;
            }
          }
        }
        accountBreakdown.push({
          id: a.id, name: a.name, currency: a.currency,
          statusDesc: a.statusDesc, isRestricted: a.isRestricted,
          cost: aCost, clicks: aClicks, impressions: aImpr, conversions: aConv,
          dailyRowsInWindow: aRows, error: a.error || null,
        });
        cost += aCost; clicks += aClicks; impressions += aImpr; conversions += aConv;
        dailyRowsInWindow += aRows;
      }
    } else if (daily && daily.length > 0) {
      // Flat daily (Google Ads). Inclusive on both bounds.
      for (const d of daily) {
        if (d.date >= windowStart && d.date <= windowEnd) {
          cost += d.cost || 0;
          clicks += d.clicks || 0;
          impressions += d.impressions || 0;
          conversions += d.conversions || 0;
          dailyRowsInWindow++;
        }
      }
    } else if (src.totals) {
      // No daily granularity — show aggregate as-is regardless of window
      cost = Number(src.totals.cost) || 0;
      clicks = Number(src.totals.clicks) || 0;
      impressions = Number(src.totals.impressions) || 0;
      conversions = Number(src.totals.conversions) || 0;
    }
    const matchedChannel = channelMatcher();
    // Leads counted toward CPL. When siteLeadsOnly is ON we exclude
    // OFFLINE-group contacts (phone calls, walk-ins) since they didn't
    // come through the website ad funnel — only website form submissions
    // count. PAID_SEARCH and PAID_SOCIAL contacts are always website-
    // driven (ad click → landing page → form fill), so this is a no-op
    // for them. But it matters when channel labels span sub-categories
    // — e.g. «Other Campaign» that may include both online + offline.
    let leads = matchedChannel ? matchedChannel.leads : 0;
    if (siteLeadsOnly && matchedChannel && matchedChannel.group === "offline") {
      leads = 0;
    }
    const tours = matchedChannel ? matchedChannel.opportunity : 0;
    const customers = matchedChannel ? matchedChannel.customer : 0;
    const cpl = leads > 0 ? cost / leads : 0;
    const cpt = tours > 0 ? cost / tours : 0;
    const cac = customers > 0 ? cost / customers : 0;
    const cpc = clicks > 0 ? cost / clicks : 0;
    return {
      sourceKey,
      label: friendlyLabel,
      campaigns: src.campaigns || [],
      campaignCount: src.campaignCount || (src.campaigns || []).length,
      hasDaily: !!daily || !!accounts,
      dailyRowsInWindow,
      accountBreakdown,                 // Meta only: per-account totals
      accountCount: accounts ? accounts.length : null,
      discoveredAccountCount: src.discoveredAccountCount || null,
      cost,
      clicks,
      impressions,
      conversions,
      leads,
      tours,
      customers,
      cpl,
      cpt,
      cac,
      cpc,
      accountId: src.accountId,
      fetchedAt: src.fetchedAt,
      ingestedAt: src.ingestedAt,
      dateRange: src.dateRange,
    };
  }

  const spendRows = [
    makeJoinedRow('google-ads', 'Google Ads', () => findChannelRow('paid-search', 'Google Ads') || findChannelRow('paid-search', 'Paid Search')),
    makeJoinedRow('meta',       'Meta Ads',   () => findChannelRow('paid-social', 'Meta')),
    makeJoinedRow('tiktok',     'TikTok Ads', () => findChannelRow('paid-social', 'TikTok')),
  ].filter(Boolean);

  const totalSpend = spendRows.reduce((s, r) => s + r.cost, 0);
  const totalClicks = spendRows.reduce((s, r) => s + r.clicks, 0);
  const sourceCount = sourceKeys.length;

  // Format ingestedAt as concrete date + time (May 24, 2:21 PM) instead
  // of relative «4m ago». Tony's request — better for audit clarity.
  function fmtIngestTs(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return date + " · " + time;
  }

  return (
    <div className="card is-clean" style={{ marginBottom: 18, padding: 0, overflow: "hidden", borderLeft: "3px solid #16a34a" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Ad spend × HubSpot conversions</div>
          <span className="chip is-success" style={{ height: 18 }}>
            <span className="dot" style={{ background: "var(--success)" }} /> {sourceCount} {sourceCount === 1 ? "source" : "sources"} live
          </span>
          <div className="spacer" />
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            Window: {windowLabel}
            {windowKind === "custom" && ` (${windowStart} → ${windowEnd})`}
            {` · $${totalSpend.toFixed(2)} spend · ${totalClicks.toLocaleString()} clicks`}
          </span>
        </div>
        {/* Date-range selector + Site-leads-only toggle */}
        <div className="row" style={{ marginTop: 8, gap: 10, flexWrap: "wrap" }}>
          <div className="f-segment">
            {[["7d", "7d"], ["30d", "30d"], ["90d", "90d"], ["mtd", "MTD"], ["custom", "Custom"]].map(([k, l]) => (
              <button key={k} className={windowKind === k ? "is-active" : ""} onClick={() => setWindowKind(k)}>{l}</button>
            ))}
          </div>
          {windowKind === "custom" && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="date"
                value={customStart}
                max={customEnd}
                onChange={e => setCustomStart(e.target.value)}
                style={{
                  padding: "5px 8px", fontSize: 12,
                  border: "1px solid var(--border)", borderRadius: 4,
                  background: "var(--surface)", color: "var(--ink)",
                }}
                title="Start date (inclusive)"
              />
              <span style={{ color: "var(--muted)" }}>→</span>
              <input
                type="date"
                value={customEnd}
                min={customStart}
                max={fmtYmd(new Date())}
                onChange={e => setCustomEnd(e.target.value)}
                style={{
                  padding: "5px 8px", fontSize: 12,
                  border: "1px solid var(--border)", borderRadius: 4,
                  background: "var(--surface)", color: "var(--ink)",
                }}
                title="End date (inclusive)"
              />
            </div>
          )}
          <label
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--muted)", cursor: "pointer" }}
            title="When ON: leads count includes only HubSpot contacts attributed to this ad channel that came through the website (i.e. paid-search/paid-social form fills on suitesforall.com). Offline-tracked calls and walk-ins are excluded. When OFF: all HubSpot contacts from this channel."
          >
            <input
              type="checkbox"
              checked={siteLeadsOnly}
              onChange={e => setSiteLeadsOnly(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            Site leads only (exclude offline/phone-only)
          </label>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 90px 90px 90px 90px 90px 90px 140px", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", background: "var(--surface-2)", fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>
        <div>Source</div>
        <div style={{ textAlign: "right" }}>
          <HeaderTip label="Spend" hint={`Total ad spend over the selected window (${windowLabel}). Pulled from the ad platform's reported cost (Google Ads: metrics.cost_micros / 1M).`} />
        </div>
        <div style={{ textAlign: "right" }}>
          <HeaderTip label="Clicks" hint={`Total clicks on ads over ${windowLabel}. From the ad platform.`} />
        </div>
        <div style={{ textAlign: "right" }}>
          <HeaderTip label="Leads" hint={`HubSpot contacts attributed to this acquisition channel (paid-search/paid-social) with createDate in the global page window (top-right selector). ${siteLeadsOnly ? "Site-only mode: excludes OFFLINE source." : "All-source mode: includes phone-only / walk-in leads tagged to the channel."}`} />
        </div>
        <div style={{ textAlign: "right" }}>
          <HeaderTip label="CPL" hint="Cost Per Lead = Spend ÷ Leads. Lower is better. The leads count depends on the 'Site leads only' toggle." />
        </div>
        <div style={{ textAlign: "right" }}>
          <HeaderTip label="CPC" hint="Cost Per Click = Spend ÷ Clicks. Channel-level average over the window. Useful for benchmarking ad-platform efficiency before funnel quality matters." />
        </div>
        <div style={{ textAlign: "right" }}>
          <HeaderTip label="CAC" hint="Customer Acquisition Cost = Spend ÷ Customers. Customer = HubSpot contact at lifecycle stage 'customer' or higher. '—' when no customer-stage contacts in window (your pipeline doesn't currently mark stage = customer)." />
        </div>
        <div style={{ textAlign: "right" }}>
          <HeaderTip label="Last sync" hint="When the spend data was last ingested. Google Ads Script runs hourly and POSTs to /marketingIngest. Fresh data appears here ~1 minute after the script run." />
        </div>
      </div>
      {spendRows.map(r => (
        <SpendRow key={r.sourceKey} r={r} windowLabel={windowLabel} fmtIngestTs={fmtIngestTs} />
      ))}
      {/* Per-campaign drilldown — collapsible */}
      {spendRows.some(r => r.campaigns.length > 0) && (
        <details style={{ padding: "10px 14px", fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>
            🔎 Top campaigns by spend
          </summary>
          <div style={{ marginTop: 10 }}>
            {spendRows.flatMap(r => r.campaigns.map(c => ({ ...c, sourceKey: r.sourceKey, sourceLabel: r.label })))
              .sort((a, b) => b.cost - a.cost)
              .slice(0, 15)
              .map((c, i) => (
                <div key={c.sourceKey + ":" + c.id} style={{ display: "grid", gridTemplateColumns: "16px 1fr 80px 80px 80px 80px", gap: 8, padding: "6px 0", borderTop: i > 0 ? "1px solid var(--border)" : "none", alignItems: "center", fontSize: 12 }}>
                  <span style={{ color: "var(--muted)" }}>{i + 1}</span>
                  <div>
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{c.sourceLabel} · {c.status}</div>
                  </div>
                  <div className="mono" style={{ textAlign: "right", fontWeight: 700 }}>${c.cost.toFixed(0)}</div>
                  <div className="mono" style={{ textAlign: "right", color: "var(--muted)" }}>{c.clicks.toLocaleString()}</div>
                  <div className="mono" style={{ textAlign: "right", color: "var(--muted)" }}>{c.impressions.toLocaleString()}</div>
                  <div className="mono" style={{ textAlign: "right", color: c.conversions > 0 ? "var(--success-ink)" : "var(--muted)" }}>{c.conversions}</div>
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}

function FunnelStat({ icon, label, value, denominator, tone }) {
  const colors = {
    muted:   'var(--ink)',
    info:    'var(--accent-ink)',
    warning: '#a16207',
    success: 'var(--success-ink)',
  };
  const pct = denominator && denominator > 0 ? Math.round((value / denominator) * 100) : null;
  return (
    <div style={{ minWidth: 120 }}>
      <div className="row" style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>
        <Icon name={icon} style={{ width: 12, height: 12 }} /> {label}
      </div>
      <div className="num" style={{ fontSize: 24, fontWeight: 800, color: colors[tone] || 'var(--ink)' }}>
        {value.toLocaleString()}
      </div>
      {pct !== null && (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{pct}% of leads</div>
      )}
    </div>
  );
}

function ChannelHeader() {
  const cols = ['Source', 'Leads', 'Qualified', 'Opportunity', 'Customer', 'Conv % L→C'];
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '2fr 80px 100px 110px 90px 110px',
      gap: 8, padding: '10px 14px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--surface-2)',
      fontSize: 11, fontWeight: 700, color: 'var(--muted)',
      textTransform: 'uppercase', letterSpacing: '.04em',
    }}>
      {cols.map((c, i) => (
        <div key={i} style={{ textAlign: i === 0 ? 'left' : 'right' }}>{c}</div>
      ))}
    </div>
  );
}

function ChannelRow({ row, totalLeads }) {
  const conv = row.leads > 0 ? (row.customer / row.leads) * 100 : 0;
  const widthPct = totalLeads > 0 ? Math.max(1, Math.round((row.leads / totalLeads) * 100)) : 0;
  // Group → chip color
  const groupColors = {
    'paid-search': { bg: '#dbeafe', fg: '#1e40af' },
    'paid-social': { bg: '#fce7f3', fg: '#9d174d' },
    'organic':     { bg: '#dcfce7', fg: '#166534' },
    'direct':      { bg: '#fef3c7', fg: '#92400e' },
    'referral':    { bg: '#ede9fe', fg: '#5b21b6' },
    'email':       { bg: '#cffafe', fg: '#0e7490' },
    'offline':     { bg: '#f1f5f9', fg: '#475569' },
    'other':       { bg: '#f1f5f9', fg: '#475569' },
    'unknown':     { bg: '#f1f5f9', fg: '#94a3b8' },
  };
  const gc = groupColors[row.group] || groupColors.other;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '2fr 80px 100px 110px 90px 110px',
      gap: 8, padding: '10px 14px',
      borderBottom: '1px solid var(--border)',
      alignItems: 'center', fontSize: 12.5,
    }}>
      {/* Source label + bar */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{
            padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
            background: gc.bg, color: gc.fg, whiteSpace: 'nowrap',
          }}>{row.label}</span>
        </div>
        <div style={{ background: 'var(--surface-2)', borderRadius: 3, height: 4, overflow: 'hidden' }}>
          <div style={{ background: gc.fg, width: widthPct + '%', height: '100%', opacity: 0.6 }} />
        </div>
      </div>
      <div className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{row.leads.toLocaleString()}</div>
      <div className="mono" style={{ textAlign: 'right' }}>{row.qualified.toLocaleString()}</div>
      <div className="mono" style={{ textAlign: 'right' }}>{row.opportunity.toLocaleString()}</div>
      <div className="mono" style={{ textAlign: 'right', fontWeight: 700, color: row.customer > 0 ? 'var(--success-ink)' : 'var(--muted)' }}>
        {row.customer.toLocaleString()}
      </div>
      <div className="mono" style={{ textAlign: 'right', color: conv >= 3 ? 'var(--success-ink)' : conv >= 1 ? 'var(--warning-ink)' : 'var(--muted)', fontWeight: 700 }}>
        {row.leads > 0 ? conv.toFixed(1) + '%' : '—'}
      </div>
    </div>
  );
}

// One source row in SpendSection. For Meta (multi-account), supports
// click-to-expand per-account breakdown.
function SpendRow({ r, windowLabel, fmtIngestTs }) {
  const [expanded, setExpanded] = React.useState(false);
  const tsLabel = fmtIngestTs(r.ingestedAt);
  const tsTooltip = r.ingestedAt
    ? `Exact: ${new Date(r.ingestedAt).toLocaleString()}\nData window per script: last ${(r.dateRange?.start || "?")} → ${(r.dateRange?.end || "?")}`
    : "";
  const hasAccounts = Array.isArray(r.accountBreakdown) && r.accountBreakdown.length > 0;
  return (
    <>
      <div
        style={{
          display: "grid", gridTemplateColumns: "1.4fr 90px 90px 90px 90px 90px 90px 140px",
          gap: 8, padding: "10px 14px", borderBottom: hasAccounts && expanded ? "none" : "1px solid var(--border)",
          alignItems: "center", fontSize: 12.5,
          cursor: hasAccounts ? "pointer" : "default",
          background: hasAccounts && expanded ? "var(--surface-2)" : "transparent",
        }}
        onClick={() => hasAccounts && setExpanded(e => !e)}
        title={hasAccounts ? "Click to expand per-account breakdown" : ""}
      >
        <div>
          <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
            {hasAccounts && (
              <span style={{ fontSize: 10, color: "var(--muted)", width: 10 }}>
                {expanded ? "▾" : "▸"}
              </span>
            )}
            {r.label}
          </div>
          <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
            {hasAccounts ? (
              <>
                {r.accountCount} {r.accountCount === 1 ? "account" : "accounts"}
                {r.discoveredAccountCount && r.discoveredAccountCount !== r.accountCount && (
                  <span title="Total accounts discovered vs accounts enabled in Settings"> of {r.discoveredAccountCount}</span>
                )}
              </>
            ) : (
              <>{r.campaignCount} campaigns · acct {r.accountId || "—"}</>
            )}
            {r.hasDaily && r.dailyRowsInWindow > 0 && (
              <span style={{ marginLeft: 6 }} title="Number of daily rows in the selected window">· {r.dailyRowsInWindow} daily rows</span>
            )}
          </div>
        </div>
        <div className="mono" style={{ textAlign: "right", fontWeight: 700 }} title={r.cost > 0 ? `$${r.cost.toFixed(2)} over ${windowLabel}` : "No spend in window"}>${r.cost.toFixed(0)}</div>
        <div className="mono" style={{ textAlign: "right" }}>{r.clicks.toLocaleString()}</div>
        <div className="mono" style={{ textAlign: "right", color: r.leads > 0 ? "var(--ink)" : "var(--muted)" }}>{r.leads.toLocaleString()}</div>
        <div className="mono" style={{ textAlign: "right", fontWeight: 700, color: r.cpl > 0 ? "var(--ink)" : "var(--muted)" }} title={r.cpl > 0 ? `$${r.cost.toFixed(2)} ÷ ${r.leads} leads = $${r.cpl.toFixed(2)} per lead` : ""}>{r.cpl > 0 ? "$" + r.cpl.toFixed(0) : "—"}</div>
        <div className="mono" style={{ textAlign: "right", color: "var(--muted)" }}>{r.cpc > 0 ? "$" + r.cpc.toFixed(2) : "—"}</div>
        <div className="mono" style={{ textAlign: "right", fontWeight: 700, color: r.cac > 0 ? "var(--success-ink)" : "var(--muted)" }}>{r.cac > 0 ? "$" + r.cac.toFixed(0) : "—"}</div>
        <div style={{ textAlign: "right", fontSize: 11, color: "var(--muted)" }} title={tsTooltip}>
          {tsLabel}
        </div>
      </div>
      {/* Per-account drilldown when Meta row is expanded */}
      {hasAccounts && expanded && (
        <div style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)", padding: "0 14px 10px 28px" }}>
          <div style={{ fontSize: 10.5, color: "var(--muted)", padding: "0 0 6px 0", textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>
            Per-account breakdown · sorted by spend
          </div>
          {[...r.accountBreakdown].sort((a, b) => b.cost - a.cost).map(a => (
            <div key={a.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 90px 90px 90px 90px 90px 90px 140px", gap: 8, padding: "6px 0", fontSize: 12, color: a.isRestricted ? "var(--muted)" : "var(--ink)", alignItems: "center", borderTop: "1px dashed var(--border)" }}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {a.name}
                  {a.isRestricted && (
                    <span style={{ marginLeft: 6, fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "rgba(239,68,68,.10)", color: "#9a3412", fontWeight: 600 }} title={"Status: " + (a.statusDesc || "Restricted")}>
                      Restricted
                    </span>
                  )}
                  {a.error && !a.isRestricted && (
                    <span style={{ marginLeft: 6, fontSize: 10, color: "var(--danger-ink)" }} title={a.error}>⚠ error</span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                  {a.id}{a.currency && a.currency !== "USD" ? ` · ${a.currency}` : ""}{a.dailyRowsInWindow > 0 ? ` · ${a.dailyRowsInWindow} daily rows` : ""}
                </div>
              </div>
              <div className="mono" style={{ textAlign: "right", fontWeight: 600 }}>${a.cost.toFixed(0)}</div>
              <div className="mono" style={{ textAlign: "right" }}>{a.clicks.toLocaleString()}</div>
              <div className="mono" style={{ textAlign: "right", color: "var(--muted)" }}>—</div>
              <div className="mono" style={{ textAlign: "right", color: "var(--muted)" }}>—</div>
              <div className="mono" style={{ textAlign: "right", color: "var(--muted)" }}>{a.clicks > 0 ? "$" + (a.cost / a.clicks).toFixed(2) : "—"}</div>
              <div className="mono" style={{ textAlign: "right", color: "var(--muted)" }}>—</div>
              <div className="mono" style={{ textAlign: "right", fontSize: 10.5, color: "var(--muted)" }}>{a.conversions > 0 ? a.conversions + " conv" : ""}</div>
            </div>
          ))}
          <div style={{ fontSize: 10.5, color: "var(--muted)", paddingTop: 8, fontStyle: "italic" }}>
            «—» in CPL/CAC means leads aren't attributable per-account (HubSpot doesn't split PAID_SOCIAL by ad account). Toggle which accounts to include in <button onClick={(e) => { e.stopPropagation(); /* hook into settings */ }} style={{ background: "transparent", border: "none", color: "var(--accent-ink)", cursor: "pointer", textDecoration: "underline", padding: 0, font: "inherit" }}>Marketing Settings</button>.
          </div>
        </div>
      )}
    </>
  );
}

function IntegrationsStatus() {
  // Live status — derive from window._mkDataCache. Any source that has
  // POSTed within the last 2h shows «🟢 Connected». Stale > 2h shows
  // «🟡 Stale». No data ever → «⚪ Not configured» (or specific
  // hint for Google Ads since the script is the official path).
  const mk = window._mkDataCache;
  const sources = (mk && mk.sources) || {};
  function statusFor(key) {
    const s = sources[key];
    if (!s || !s.ingestedAt) return null;
    const ageMin = Math.round((Date.now() - new Date(s.ingestedAt).getTime()) / 60000);
    return { ageMin, accountId: s.accountId, campaignCount: s.campaignCount };
  }
  const googleAdsStatus = statusFor('google-ads');
  const metaStatus = statusFor('meta');
  const tiktokStatus = statusFor('tiktok');
  const ga4Status = statusFor('ga4');
  function makeIntegration(key, name, icon, liveStatus, defaultHint, docsUrl) {
    if (!liveStatus) return { key, name, icon, status: 'not-connected', hint: defaultHint, docsUrl };
    const fresh = liveStatus.ageMin < 120;
    return {
      key, name, icon,
      status: fresh ? 'connected' : 'stale',
      hint: 'acct ' + (liveStatus.accountId || '—') + ' · ' + (liveStatus.campaignCount || 0) + ' campaigns · last sync ' +
            (liveStatus.ageMin < 60 ? liveStatus.ageMin + 'm ago' : Math.round(liveStatus.ageMin / 60) + 'h ago'),
      docsUrl,
    };
  }
  const integrations = [
    makeIntegration('google-ads', 'Google Ads', '🟦', googleAdsStatus,
      'Paste the Google Ads Script (scripts/google-ads-script.js in repo) into Ads → Tools → Scripts, set hourly schedule. No Developer Token required.',
      'https://developers.google.com/google-ads/scripts/docs/reference/adsapp/adsapp'),
    makeIntegration('meta', 'Meta Ads (FB / IG)', '🟪', metaStatus,
      'Long-lived access token from Meta Business Manager required. Same /marketingIngest endpoint with source:"meta".',
      'https://developers.facebook.com/docs/marketing-api/get-started'),
    makeIntegration('tiktok', 'TikTok Ads', '⬛', tiktokStatus,
      'OAuth token from TikTok Business Center required. Same /marketingIngest endpoint with source:"tiktok".',
      'https://business-api.tiktok.com/portal/docs'),
    makeIntegration('ga4', 'Google Analytics 4', '🟧', ga4Status,
      'Service account JSON + GA4 Property ID required (optional — for site-side funnel)',
      'https://developers.google.com/analytics/devguides/reporting/data/v1'),
  ];
  const badgeStyle = {
    'connected':     { bg: 'rgba(34,197,94,.12)',  fg: '#166534', label: '🟢 Connected' },
    'stale':         { bg: 'rgba(245,158,11,.12)', fg: '#92400e', label: '🟡 Stale (>2h)' },
    'pending':       { bg: 'rgba(245,158,11,.12)', fg: '#92400e', label: '🟡 Pending approval' },
    'not-connected': { bg: 'var(--surface-2)',     fg: 'var(--muted)', label: '⚪ Not configured' },
    'error':         { bg: 'rgba(239,68,68,.12)',  fg: '#991b1b', label: '🔴 Error' },
  };
  return (
    <div className="card is-clean" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Ad platform integrations</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          Once connected, spend / impressions / clicks join the channel-mix table above to compute CPL / CPT / CAC / ROAS.
        </div>
      </div>
      {integrations.map(it => {
        const s = badgeStyle[it.status] || badgeStyle['not-connected'];
        return (
          <React.Fragment key={it.key}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1.5fr 1fr 2fr auto', gap: 12,
              padding: '12px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18 }}>{it.icon}</span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{it.name}</span>
              </div>
              <div>
                <span style={{
                  padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                  background: s.bg, color: s.fg, whiteSpace: 'nowrap',
                }}>{s.label}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{it.hint}</div>
              <a href={it.docsUrl} target="_blank" rel="noopener" className="btn is-small is-ghost" style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}>
                Docs ↗
              </a>
            </div>
            {/* Meta: inline Settings panel for per-account toggle */}
            {it.key === 'meta' && <MetaAccountSettings />}
          </React.Fragment>
        );
      })}
      <div style={{ padding: '10px 14px', fontSize: 11, color: 'var(--muted)', background: 'var(--surface-2)' }}>
        Integration credentials live in Firebase Secret Manager (not visible in this UI). To set up: ping engineering with «Marketing setup &lt;platform&gt;» — operator gets a guided checklist.
      </div>
    </div>
  );
}

/* ===================================================================
   MetaAccountSettings — inline panel under the Meta integration row.
   Renders the list of all DISCOVERED Meta ad accounts (auto-fetched
   by meta-ads-sync CF) with checkboxes to enable/disable each, plus
   a per-account text note (e.g. «Tampa office», «Sallyann's account»).
   Saves via metaSettingsSet callable.

   Visible only if discovery has run at least once (window._mkDataCache
   has metaDiscoveredAccounts populated). Otherwise shows a hint to
   wait for the next hourly sync OR trigger a manual sync.
   =================================================================== */
function MetaAccountSettings() {
  const mk = window._mkDataCache;
  const discovered = mk?.metaDiscoveredAccounts || [];
  const settings = mk?.settings || {};
  const initialEnabled = Array.isArray(settings.metaAdAccountIds)
    ? new Set(settings.metaAdAccountIds.map(s => String(s)))
    : null; // null = «all discovered enabled» default
  const initialNotes = settings.metaAccountNotes || {};

  const [open, setOpen] = React.useState(false);
  const [enabled, setEnabled] = React.useState(initialEnabled);
  const [notes, setNotes] = React.useState(initialNotes);
  const [saving, setSaving] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState(null);

  function isEnabled(id) {
    if (!enabled) return true; // null = all enabled
    return enabled.has(String(id));
  }
  function toggle(id) {
    setEnabled(prev => {
      const next = new Set(prev || discovered.map(a => String(a.id)));
      const s = String(id);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }

  async function save() {
    if (typeof window._pulseCallable !== 'function') {
      setSaveMsg({ kind: 'err', text: 'Firebase bridge not ready' });
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const ids = enabled ? Array.from(enabled) : discovered.map(a => String(a.id));
      const res = await window._pulseCallable('metaSettingsSet', {
        metaAdAccountIds: ids,
        metaAccountNotes: notes,
      });
      setSaveMsg({ kind: 'ok', text: 'Saved · ' + (res?.data?.count || ids.length) + ' accounts enabled. Next sync within 1 hour.' });
    } catch (e) {
      const msg = String(e?.message || e || '');
      setSaveMsg({ kind: 'err', text: /permission-denied|Root admin/.test(msg)
        ? 'Permission denied — Pulse bridge runs anonymously. Open Floor map → console: window.stripeCallable(\'metaSettingsSet\')({...})'
        : 'Save failed: ' + msg.slice(0, 200) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: '8px 14px 14px 38px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ink-2)', fontSize: 11.5, fontWeight: 600,
          padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        Ad account settings · {discovered.length} discovered
        {settings.metaAdAccountIds && (
          <span style={{ color: 'var(--muted)', fontWeight: 500 }}>
            · {settings.metaAdAccountIds.length} enabled
          </span>
        )}
      </button>
      {open && discovered.length === 0 && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--muted)' }}>
          No Meta ad accounts discovered yet. Wait for the next hourly sync OR trigger a manual sync (Floor map console:{' '}
          <code style={{ background: 'var(--surface)', padding: '2px 5px', borderRadius: 3 }}>
            await window.stripeCallable('metaAdsSyncNow')({})
          </code>
          ). Required: <code>META_ACCESS_TOKEN</code> secret set in Firebase.
        </div>
      )}
      {open && discovered.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
            Toggle which accounts to include in marketing analytics. Notes are visible only here (per-account labels for which manager runs them, which office they advertise, etc.).
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '30px 1fr 100px 90px 1.5fr', gap: 8, padding: '8px 10px', background: 'var(--surface)', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
              <div></div>
              <div>Account</div>
              <div>Currency</div>
              <div>Status</div>
              <div>Note (your label)</div>
            </div>
            {discovered.map(a => {
              const on = isEnabled(a.id);
              return (
                <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '30px 1fr 100px 90px 1.5fr', gap: 8, padding: '8px 10px', borderTop: '1px solid var(--border)', alignItems: 'center', fontSize: 12, background: on ? 'var(--surface)' : 'transparent', opacity: on ? 1 : 0.65 }}>
                  <input type="checkbox" checked={on} onChange={() => toggle(a.id)} style={{ cursor: 'pointer' }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{a.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{a.id}</div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{a.currency}</div>
                  <div>
                    <span style={{
                      padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                      background: a.isRestricted ? 'rgba(239,68,68,.10)' : 'rgba(34,197,94,.10)',
                      color: a.isRestricted ? '#9a3412' : '#166534',
                    }} title={a.disableReason || ''}>
                      {a.isRestricted ? '⚠ ' + a.statusDesc : '🟢 ' + a.statusDesc}
                    </span>
                  </div>
                  <input
                    type="text"
                    placeholder="e.g. Tampa office · Ann"
                    value={notes[a.id] || ''}
                    onChange={e => setNotes(n => ({ ...n, [a.id]: e.target.value }))}
                    style={{
                      padding: '4px 8px', fontSize: 11.5,
                      border: '1px solid var(--border)', borderRadius: 4,
                      background: 'var(--surface)', color: 'var(--ink)', width: '100%',
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <button
              onClick={save}
              disabled={saving}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 600,
                border: 'none', borderRadius: 5, cursor: saving ? 'wait' : 'pointer',
                background: 'var(--accent)', color: 'white',
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            <button
              onClick={() => { setEnabled(null); setNotes(initialNotes); }}
              style={{ padding: '6px 14px', fontSize: 12, fontWeight: 500, border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer', background: 'transparent', color: 'var(--ink-2)' }}
            >
              Enable all
            </button>
            {saveMsg && (
              <span style={{ fontSize: 11.5, color: saveMsg.kind === 'ok' ? 'var(--success-ink)' : 'var(--danger-ink)' }}>
                {saveMsg.text}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
