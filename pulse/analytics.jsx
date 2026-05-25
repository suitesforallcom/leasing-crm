/* global React, Icon */

/* ================================================================
   Analytics — dedicated GA4 page.

   Pulls site analytics from Google Analytics Data API (via ga4Sync CF)
   and renders:
     - Summary KPI tiles
     - Source / Medium breakdown
     - Top landing pages
     - Events / conversions
     - Device + geo split
     - Daily timeseries chart

   Data source: window._mkDataCache.sources.ga4 (populated by data-shim
   from marketingGetData callable). All fields inflated server-side.
   ================================================================ */

window.AnalyticsPage = function AnalyticsPage() {
  const mk = window._mkDataCache;
  const ga = mk && mk.sources && mk.sources.ga4;

  const [syncing, setSyncing] = React.useState(false);
  const [msg, setMsg] = React.useState(null);

  async function syncNow() {
    setSyncing(true);
    setMsg(null);
    try {
      if (typeof window._pulseCallable !== 'function') {
        setMsg({ kind: 'err', text: 'Firebase bridge not ready' });
        return;
      }
      const r = await window._pulseCallable('ga4SyncNow', {});
      const d = r?.data || {};
      setMsg({ kind: 'ok', text: `Synced — ${d.counts?.sessions || 0} sessions, ${d.counts?.conversions || 0} conversions across ${d.counts?.daily || 0} days. Reload to see.` });
      try { localStorage.removeItem('sfa_marketing_data_v1'); } catch (e) {}
    } catch (e) {
      const code = e?.code || '';
      if (code === 'permission-denied') {
        setMsg({ kind: 'err', text: 'Permission denied. Open Floor map console: window.stripeCallable("ga4SyncNow")({})' });
      } else {
        setMsg({ kind: 'err', text: 'Sync failed: ' + (e?.message || String(e)) });
      }
    } finally {
      setSyncing(false);
    }
  }

  if (!ga) {
    return (
      <div className="page">
        <div className="page-h">
          <div>
            <h1 className="title">Analytics</h1>
            <div className="subtitle">Site behaviour from Google Analytics 4 · funnel + traffic source</div>
          </div>
          <div className="row">
            <button className="btn is-primary" onClick={syncNow} disabled={syncing}>
              {syncing ? 'Syncing…' : '↻ Sync now'}
            </button>
          </div>
        </div>
        <div className="card is-clean" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>📊 GA4 not configured yet</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 540, margin: '0 auto', lineHeight: 1.5 }}>
            To enable this page, set up a Google Service Account, grant it Viewer access to your GA4 property, and add the credentials as Firebase secrets <code>GA4_PROPERTY_ID</code> + <code>GA4_SERVICE_ACCOUNT_JSON</code>. Then click «Sync now».
          </div>
          <div style={{ marginTop: 14, fontSize: 12 }}>
            <a href="#" onClick={(e) => { e.preventDefault(); window.location.hash = 'connections'; if (window._navTo) window._navTo('connections'); }} style={{ color: 'var(--accent-ink)', textDecoration: 'underline' }}>
              Setup instructions → Connections page
            </a>
          </div>
          {msg && <SaveMsg msg={msg} />}
        </div>
      </div>
    );
  }

  const sum = ga.summary || {};
  const sourceMedium = Array.isArray(ga.sourceMedium) ? ga.sourceMedium : [];
  const landingPages = Array.isArray(ga.landingPages) ? ga.landingPages : [];
  const events = Array.isArray(ga.events) ? ga.events : [];
  const devices = Array.isArray(ga.devices) ? ga.devices : [];
  const geo = Array.isArray(ga.geo) ? ga.geo : [];
  const daily = Array.isArray(ga.daily) ? ga.daily : [];

  const conversionRate = sum.sessions > 0 ? (sum.conversions / sum.sessions) * 100 : 0;
  const engagementRate = sum.sessions > 0 ? (sum.engagedSessions / sum.sessions) * 100 : 0;
  const avgDuration = sum.averageSessionDuration || 0;
  const fmtDuration = (sec) => {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1 className="title">Analytics</h1>
          <div className="subtitle">
            <span>Google Analytics 4 · last {ga.daysBack || 90} days</span>
            <span>·</span>
            <span className="mono">Property {ga.propertyId}</span>
            <span>·</span>
            <span className="mono">Synced {formatAgo(ga.ingestedAt)}</span>
          </div>
        </div>
        <div className="row">
          <button className="btn is-primary" onClick={syncNow} disabled={syncing}>
            {syncing ? 'Syncing…' : '↻ Sync now'}
          </button>
        </div>
      </div>
      {msg && <div style={{ marginBottom: 12 }}><SaveMsg msg={msg} /></div>}

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
        <KpiTile label="Sessions" value={sum.sessions?.toLocaleString() || '—'} icon="trendUp" />
        <KpiTile label="Users" value={sum.totalUsers?.toLocaleString() || '—'} sub={`${sum.newUsers?.toLocaleString() || 0} new`} icon="people" />
        <KpiTile label="Page views" value={sum.screenPageViews?.toLocaleString() || '—'} sub={`${(sum.screenPageViews / (sum.sessions || 1)).toFixed(1)} pp/session`} icon="cal" />
        <KpiTile label="Conversions" value={sum.conversions?.toLocaleString() || '—'} sub={`${conversionRate.toFixed(2)}% rate`} icon="star" tone="success" />
        <KpiTile label="Avg session" value={fmtDuration(avgDuration)} sub={`${engagementRate.toFixed(0)}% engaged`} icon="clock" />
        <KpiTile label="Bounce rate" value={`${((sum.bounceRate || 0) * 100).toFixed(1)}%`} sub="lower = better" icon="warning" tone={sum.bounceRate < 0.5 ? "success" : sum.bounceRate < 0.7 ? "warning" : "danger"} />
      </div>

      {/* Source / Medium */}
      <Section title="Source / Medium" subtitle={`${sourceMedium.length} sources`}>
        <DataTable
          cols={[
            { key: 'sessionSource', label: 'Source', align: 'left' },
            { key: 'sessionMedium', label: 'Medium', align: 'left' },
            { key: 'sessions', label: 'Sessions', align: 'right', format: 'num' },
            { key: 'totalUsers', label: 'Users', align: 'right', format: 'num' },
            { key: 'engagedSessions', label: 'Engaged', align: 'right', format: 'num' },
            { key: 'conversions', label: 'Conv.', align: 'right', format: 'num', highlight: true },
            { key: 'convRate', label: 'CR %', align: 'right', compute: (r) => r.sessions > 0 ? ((r.conversions / r.sessions) * 100).toFixed(1) + '%' : '—' },
          ]}
          rows={sourceMedium}
        />
      </Section>

      {/* Top landing pages */}
      <Section title="Top landing pages" subtitle={`${landingPages.length} pages by sessions`}>
        <DataTable
          cols={[
            { key: 'landingPage', label: 'Landing page', align: 'left', truncate: 50 },
            { key: 'sessions', label: 'Sessions', align: 'right', format: 'num' },
            { key: 'totalUsers', label: 'Users', align: 'right', format: 'num' },
            { key: 'avgDuration', label: 'Avg duration', align: 'right', compute: (r) => fmtDuration(r.averageSessionDuration || 0) },
            { key: 'bounce', label: 'Bounce', align: 'right', compute: (r) => `${((r.bounceRate || 0) * 100).toFixed(0)}%` },
            { key: 'conversions', label: 'Conv.', align: 'right', format: 'num', highlight: true },
          ]}
          rows={landingPages}
        />
      </Section>

      {/* Events */}
      <Section title="Events" subtitle={`${events.length} unique events tracked`}>
        <DataTable
          cols={[
            { key: 'eventName', label: 'Event name', align: 'left' },
            { key: 'eventCount', label: 'Count', align: 'right', format: 'num' },
            { key: 'totalUsers', label: 'Users', align: 'right', format: 'num' },
            { key: 'eventCountPerUser', label: 'Per user', align: 'right', compute: (r) => (r.eventCountPerUser || 0).toFixed(2) },
          ]}
          rows={events}
        />
      </Section>

      {/* Device + Geo side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 18, marginBottom: 18 }}>
        <Section title="Device category" subtitle="">
          <DataTable
            cols={[
              { key: 'deviceCategory', label: 'Device', align: 'left' },
              { key: 'sessions', label: 'Sessions', align: 'right', format: 'num' },
              { key: 'totalUsers', label: 'Users', align: 'right', format: 'num' },
              { key: 'conversions', label: 'Conv.', align: 'right', format: 'num', highlight: true },
              { key: 'share', label: '%', align: 'right', compute: (r) => {
                const total = devices.reduce((s, d) => s + (d.sessions || 0), 0);
                return total > 0 ? ((r.sessions / total) * 100).toFixed(0) + '%' : '—';
              }},
            ]}
            rows={devices}
          />
        </Section>
        <Section title="Geography (country)" subtitle="">
          <DataTable
            cols={[
              { key: 'country', label: 'Country', align: 'left' },
              { key: 'sessions', label: 'Sessions', align: 'right', format: 'num' },
              { key: 'totalUsers', label: 'Users', align: 'right', format: 'num' },
              { key: 'conversions', label: 'Conv.', align: 'right', format: 'num', highlight: true },
            ]}
            rows={geo}
          />
        </Section>
      </div>

      {/* Daily timeseries — simple sparkline rendering */}
      <Section title="Daily traffic" subtitle={`Last ${daily.length} days · sessions / users / conversions`}>
        <DailyChart daily={daily} />
      </Section>

      {/* Notes / context */}
      <div className="card is-clean" style={{ padding: 14, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        <b>💡 How to read this page:</b>
        <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
          <li><b>Source/Medium</b> — where traffic comes from. Compare with Pulse Marketing CPL — if Google brings 50% of traffic but only 10% of conversions, landing page needs work.</li>
          <li><b>Top landing pages</b> — high bounce + low conv = either wrong audience or weak page. Bounce {'>'} 70% = problem.</li>
          <li><b>Events</b> — make sure form-submit / phone-click events are tracked. Without them GA4 «conversions» = 0.</li>
          <li><b>Device</b> — if mobile users have lower conv rate than desktop, your form/page is broken on mobile.</li>
        </ul>
      </div>
    </div>
  );
};

/* ===== Helpers ===== */
function KpiTile({ label, value, sub, icon, tone }) {
  const toneColors = {
    success: '#16a34a',
    warning: '#f59e0b',
    danger: '#dc2626',
  };
  return (
    <div className="card is-clean" style={{ padding: 14 }}>
      <div className="row" style={{ marginBottom: 4, fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {icon && <Icon name={icon} style={{ width: 12, height: 12 }} />}
        {label}
      </div>
      <div className="num" style={{ fontSize: 22, fontWeight: 800, color: toneColors[tone] || 'var(--ink)', lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div className="card is-clean" style={{ marginBottom: 18, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{subtitle}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function DataTable({ cols, rows }) {
  if (!rows || rows.length === 0) {
    return <div style={{ padding: 18, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>No data in window.</div>;
  }
  const gridCols = cols.map(c => c.align === 'left' ? '1fr' : '90px').join(' ');
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '8px 14px', background: 'var(--surface-2)', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {cols.map(c => <div key={c.key} style={{ textAlign: c.align }}>{c.label}</div>)}
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 12.5, alignItems: 'center' }}>
          {cols.map(c => {
            let v;
            if (typeof c.compute === 'function') v = c.compute(r);
            else if (c.format === 'num') v = (typeof r[c.key] === 'number' ? r[c.key].toLocaleString() : (r[c.key] || '—'));
            else v = r[c.key] != null ? String(r[c.key]) : '—';
            const truncated = c.truncate && typeof v === 'string' && v.length > c.truncate ? v.slice(0, c.truncate) + '…' : v;
            const numeric = c.align === 'right';
            const highlight = c.highlight && r[c.key] > 0;
            return (
              <div key={c.key} className={numeric ? 'mono' : ''} style={{
                textAlign: c.align,
                fontWeight: highlight ? 700 : (c.align === 'left' && c === cols[0] ? 600 : 400),
                color: highlight ? 'var(--success-ink)' : (c.align === 'left' ? 'var(--ink)' : 'var(--ink)'),
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={typeof v === 'string' ? v : ''}>
                {truncated}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DailyChart({ daily }) {
  if (!daily || daily.length === 0) {
    return <div style={{ padding: 24, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>No daily data.</div>;
  }
  const maxSessions = Math.max(...daily.map(d => d.sessions || 0), 1);
  const maxUsers = Math.max(...daily.map(d => d.users || 0), 1);
  const maxConversions = Math.max(...daily.map(d => d.conversions || 0), 1);
  const w = 100 / daily.length;
  return (
    <div style={{ padding: 14 }}>
      <div style={{ position: 'relative', height: 140, background: 'var(--surface-2)', borderRadius: 8, padding: 8, overflow: 'hidden' }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          {/* sessions bars */}
          {daily.map((d, i) => (
            <rect key={i} x={i * w + w * 0.1} y={100 - ((d.sessions || 0) / maxSessions) * 95} width={w * 0.8} height={((d.sessions || 0) / maxSessions) * 95} fill="var(--accent)" opacity="0.35" />
          ))}
          {/* conversions line */}
          {daily.length > 1 && (
            <polyline
              points={daily.map((d, i) => `${i * w + w / 2},${100 - ((d.conversions || 0) / maxConversions) * 95}`).join(' ')}
              fill="none" stroke="#16a34a" strokeWidth="0.7" vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10.5, color: 'var(--muted)' }}>
        <span>{daily[0]?.date || '—'}</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--accent)', opacity: 0.35, borderRadius: 2, verticalAlign: 'middle', marginRight: 4 }}/>Sessions (peak {maxSessions.toLocaleString()})</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 2, background: '#16a34a', verticalAlign: 'middle', marginRight: 4 }}/>Conversions (peak {maxConversions.toLocaleString()})</span>
        <span>{daily[daily.length - 1]?.date || '—'}</span>
      </div>
    </div>
  );
}

function SaveMsg({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ padding: '8px 12px', marginTop: 10, fontSize: 12, borderRadius: 6,
      background: msg.kind === 'ok' ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
      color: msg.kind === 'ok' ? '#166534' : '#991b1b' }}>
      {msg.text}
    </div>
  );
}

function formatAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
