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

// Tooltip helper — shows ⓘ icon, hovering reveals the explanation.
// Native HTML title attribute (works everywhere, no extra CSS / JS).
function HeaderTip({ label, hint }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "help" }} title={hint}>
      {label}
      <span style={{ fontSize: 9, color: "var(--muted-2)", border: "1px solid var(--muted-2)", borderRadius: "50%", width: 11, height: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>?</span>
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
  const [windowKind, setWindowKind] = React.useState("30d");  // '7d' / '30d' / '90d' / 'mtd'
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

  // Date-range cutoff for daily aggregation. Returns YYYY-MM-DD start
  // string. End is always today (we don't filter future).
  function windowStartDate(kind) {
    const d = new Date();
    if (kind === "mtd") return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01";
    const days = kind === "7d" ? 7 : kind === "90d" ? 90 : 30;
    const back = new Date(d.getTime() - (days - 1) * 86400 * 1000);
    return back.getFullYear() + "-" + String(back.getMonth() + 1).padStart(2, "0") + "-" + String(back.getDate()).padStart(2, "0");
  }
  const windowStart = windowStartDate(windowKind);
  const windowLabel = windowKind === "7d" ? "Last 7 days"
                    : windowKind === "30d" ? "Last 30 days"
                    : windowKind === "90d" ? "Last 90 days"
                    : "Month to date";

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
    // Aggregate daily → window totals. Falls back to src.totals if
    // daily breakdown isn't present (legacy v1 ingest format).
    let cost = 0, clicks = 0, impressions = 0, conversions = 0;
    let dailyRowsInWindow = 0;
    const daily = Array.isArray(src.daily) ? src.daily : null;
    if (daily && daily.length > 0) {
      for (const d of daily) {
        if (d.date >= windowStart) {
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
      hasDaily: !!daily,
      dailyRowsInWindow,
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
            Window: {windowLabel} · ${totalSpend.toFixed(2)} spend · {totalClicks.toLocaleString()} clicks
          </span>
        </div>
        {/* Date-range selector + Site-leads-only toggle */}
        <div className="row" style={{ marginTop: 8, gap: 10, flexWrap: "wrap" }}>
          <div className="f-segment">
            {[["7d", "7d"], ["30d", "30d"], ["90d", "90d"], ["mtd", "MTD"]].map(([k, l]) => (
              <button key={k} className={windowKind === k ? "is-active" : ""} onClick={() => setWindowKind(k)}>{l}</button>
            ))}
          </div>
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
      {spendRows.map(r => {
        const tsLabel = fmtIngestTs(r.ingestedAt);
        const tsTooltip = r.ingestedAt
          ? `Exact: ${new Date(r.ingestedAt).toLocaleString()}\nData window per script: last ${(spendRows[0]?.dateRange?.start || "?")} → ${(spendRows[0]?.dateRange?.end || "?")}`
          : "";
        return (
          <div key={r.sourceKey} style={{ display: "grid", gridTemplateColumns: "1.4fr 90px 90px 90px 90px 90px 90px 140px", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", alignItems: "center", fontSize: 12.5 }}>
            <div>
              <div style={{ fontWeight: 700 }}>{r.label}</div>
              <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                {r.campaignCount} campaigns · acct {r.accountId || "—"}
                {r.hasDaily && r.dailyRowsInWindow > 0 && (
                  <span style={{ marginLeft: 6 }} title="Number of daily rows pulled in the selected window">· {r.dailyRowsInWindow} daily rows</span>
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
        );
      })}
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
          <div key={it.key} style={{
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
        );
      })}
      <div style={{ padding: '10px 14px', fontSize: 11, color: 'var(--muted)', background: 'var(--surface-2)' }}>
        Integration credentials live in Firebase Secret Manager (not visible in this UI). To set up: ping engineering with «Marketing setup &lt;platform&gt;» — operator gets a guided checklist.
      </div>
    </div>
  );
}
