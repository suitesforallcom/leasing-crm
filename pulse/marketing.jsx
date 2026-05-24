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

      {/* Integration status strip — placeholder for Phase 2 ad-platform syncs */}
      <IntegrationsStatus />
    </div>
  );
};

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
  // Status reads window._marketingIntegrations (populated later by Phase 2
  // CFs writing to /workspaces/{wid}/data/marketing). For now, all
  // platforms show «not connected» / «pending» placeholders so operator
  // sees what's coming.
  const integrations = [
    {
      key: 'googleAds',
      name: 'Google Ads',
      icon: '🟦',
      status: 'pending',
      hint: 'Developer Token application submitted to Google · 1-3 business days for approval',
      docsUrl: 'https://developers.google.com/google-ads/api/docs/first-call/dev-token',
    },
    {
      key: 'metaAds',
      name: 'Meta Ads (FB / IG)',
      icon: '🟪',
      status: 'not-connected',
      hint: 'Long-lived access token from Meta Business Manager required',
      docsUrl: 'https://developers.facebook.com/docs/marketing-api/get-started',
    },
    {
      key: 'tiktokAds',
      name: 'TikTok Ads',
      icon: '⬛',
      status: 'not-connected',
      hint: 'OAuth token from TikTok Business Center required',
      docsUrl: 'https://business-api.tiktok.com/portal/docs',
    },
    {
      key: 'ga4',
      name: 'Google Analytics 4',
      icon: '🟧',
      status: 'not-connected',
      hint: 'Service account JSON + GA4 Property ID required (optional — for site-side funnel)',
      docsUrl: 'https://developers.google.com/analytics/devguides/reporting/data/v1',
    },
  ];
  const badgeStyle = {
    'connected':     { bg: 'rgba(34,197,94,.12)',  fg: '#166534', label: '🟢 Connected' },
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
