/* global React, Icon */

/* ===================================================================
   Pulse — Google Ads dimensions (Keywords / Search Terms / Geo / Devices)

   Each of the 4 page components is a thin wrapper around DimensionTable
   that supplies a `kind` (matches the Cloud Function's KIND_TO_COLLECTION
   map) plus a per-dimension column config. Data is read via the
   marketingDimensionList callable, sorted server-side by totals.spend
   desc and cursor-paginated (50 rows per page).

   Storage path (Firestore):
     keyword     → workspaces/default/marketing_keywords
     searchTerm  → workspaces/default/marketing_search_terms
     geo         → workspaces/default/marketing_geo
     device      → workspaces/default/marketing_devices

   Populated by the Google Ads Apps Script — see scripts/google-ads-script.js
   functions _runKeywordIngest / _runSearchTermIngest / _runGeoIngest /
   _runDeviceIngest — which POST per-dimension rows to the
   marketingDimensionIngest endpoint.

   Auth: root-admin only (tony@al-en.com).
   =================================================================== */

// --- formatters ---
function _dimMoney(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _dimInt(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}
function _dimPct(n) {
  return (Number(n) || 0).toFixed(2) + '%';
}
function _dimText(x) {
  if (x == null) return '—';
  const s = String(x);
  return s.length === 0 ? '—' : s;
}
function _dimDig(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

// Inline mini-sparkline для daily spend.
function DimSparkline({ daily, height = 24, color = '#6366f1', width = 80 }) {
  const vals = (daily || []).map(d => Number(d.spend) || 0);
  if (vals.length < 2) {
    return <div style={{ height, width, opacity: 0.35, fontSize: 9, color: 'var(--muted)' }}>—</div>;
  }
  const max = Math.max(...vals, 0.01);
  const stepX = width / (vals.length - 1);
  const pts = vals.map((v, i) => `${i * stepX},${height - (v / max) * height}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Status pill.
function _DimStatus({ status }) {
  const s = String(status || '').toUpperCase();
  if (!s || s === 'UNSPECIFIED' || s === 'UNKNOWN') {
    return <span style={{ color: '#94a3b8', fontSize: 10 }}>—</span>;
  }
  let color = '#64748b';
  let bg = '#f1f5f9';
  if (s === 'ENABLED' || s === 'ACTIVE') { color = '#047857'; bg = '#d1fae5'; }
  else if (s === 'PAUSED') { color = '#b45309'; bg = '#fef3c7'; }
  else if (s === 'REMOVED' || s === 'DISABLED') { color = '#991b1b'; bg = '#fee2e2'; }
  return (
    <span style={{
      fontSize: 9.5, fontWeight: 700, color, background: bg,
      padding: '2px 6px', borderRadius: 4, letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
    }}>
      {s}
    </span>
  );
}

const _dimThStyle = {
  padding: '8px 10px', fontSize: 10.5, fontWeight: 700,
  color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em',
  textAlign: 'left', borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap', background: 'var(--surface)',
};
const _dimTdStyle = {
  padding: '8px 10px', fontSize: 12, verticalAlign: 'middle',
  borderBottom: '1px solid var(--border-soft, #f1f5f9)',
};

/* ============== DimensionTable — reusable across all 4 pages ============== */

function DimensionTable({ kind, title, subtitle, columns, helpText }) {
  const [rows, setRows] = React.useState([]);
  const [cursor, setCursor] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [search, setSearch] = React.useState('');

  const loadPage = React.useCallback(async (reset, cursorOverride) => {
    if (typeof window._pulseCallable !== 'function') {
      setError('Firebase bridge not ready');
      return;
    }
    setLoading(true);
    if (reset) setError(null);
    try {
      const r = await window._pulseCallable('marketingDimensionList', {
        kind: kind,
        limit: 50,
        cursor: reset ? null : (cursorOverride ?? null),
      });
      const data = r?.data || {};
      const newRows = Array.isArray(data.rows) ? data.rows : [];
      setRows(prev => reset ? newRows : [...prev, ...newRows]);
      setCursor(data.nextCursor || null);
      if (reset) setError(null);
    } catch (e) {
      const m = String(e?.message || e || '');
      if (/permission-denied|Root admin/.test(m)) {
        setError('Permission denied — admin only.');
      } else if (/not-found|UNAVAILABLE|deadline|FAILED_PRECONDITION/.test(m)) {
        setError('No data yet. Once the Google Ads Apps Script has run with the new dimension ingest, rows populate here automatically.');
      } else {
        setError('Failed to load: ' + m.slice(0, 240));
      }
    } finally {
      setLoading(false);
    }
  }, [kind]);

  React.useEffect(() => {
    setRows([]); setCursor(null); setError(null);
    loadPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  // Client-side text filter (server sorts by spend; local search supplements).
  const filtered = React.useMemo(() => {
    if (!search) return rows;
    const needle = search.trim().toLowerCase();
    return rows.filter(r => {
      const hay = [
        r?.label, r?.id,
        r?.campaign?.name, r?.adgroup?.name,
        r?.keyword?.text, r?.searchTerm?.text,
        r?.geo?.country, r?.geo?.region, r?.geo?.city,
        r?.device?.type,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(needle) >= 0;
    });
  }, [rows, search]);

  // Aggregate visible totals so operator sees the slice rollup.
  const visibleTotals = React.useMemo(() => {
    const acc = { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
    for (const r of filtered) {
      acc.spend += Number(r?.totals?.spend) || 0;
      acc.impressions += Number(r?.totals?.impressions) || 0;
      acc.clicks += Number(r?.totals?.clicks) || 0;
      acc.conversions += Number(r?.totals?.conversions) || 0;
    }
    acc.ctr = acc.impressions > 0 ? (acc.clicks / acc.impressions) * 100 : 0;
    acc.cpc = acc.clicks > 0 ? acc.spend / acc.clicks : 0;
    acc.cpa = acc.conversions > 0 ? acc.spend / acc.conversions : 0;
    return acc;
  }, [filtered]);

  return (
    <div className="page">
      <div className="page-h" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
        <div>
          <h1 className="title">{title}</h1>
          <div className="subtitle">{subtitle}</div>
        </div>
        <button
          className="btn"
          onClick={() => loadPage(true)}
          disabled={loading}
          title="Re-fetch the first page"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* KPI strip — operator sees aggregate before drilling. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 10, marginBottom: 12,
      }}>
        <DimKpi label="Spend"   value={_dimMoney(visibleTotals.spend)} />
        <DimKpi label="Impr."   value={_dimInt(visibleTotals.impressions)} />
        <DimKpi label="Clicks"  value={_dimInt(visibleTotals.clicks)} />
        <DimKpi label="CTR"     value={_dimPct(visibleTotals.ctr)} />
        <DimKpi label="CPC"     value={_dimMoney(visibleTotals.cpc)} />
        <DimKpi label="Conv."   value={_dimInt(visibleTotals.conversions)} />
        <DimKpi label="CPA"     value={visibleTotals.cpa ? _dimMoney(visibleTotals.cpa) : '—'} />
      </div>

      {/* Sticky search + result count */}
      <div style={{
        position: 'sticky', top: 0, background: 'var(--bg, #fafaf9)',
        padding: '8px 0', zIndex: 5, marginBottom: 8,
        display: 'flex', gap: 10, alignItems: 'center',
      }}>
        <input
          type="text"
          placeholder="Search by text / campaign / ad group / location…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1, padding: '6px 12px',
            border: '1px solid var(--border)', borderRadius: 8,
            fontSize: 13, background: 'var(--surface)',
            outline: 'none',
          }}
        />
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {filtered.length} {filtered.length === 1 ? 'row' : 'rows'}
          {cursor ? ' (more available)' : ''}
        </div>
      </div>

      {helpText && (
        <div className="card is-clean" style={{
          padding: 10, marginBottom: 10, fontSize: 11.5,
          color: 'var(--muted)', lineHeight: 1.5,
        }}>
          {helpText}
        </div>
      )}

      {error && (
        <div className="card is-clean" style={{
          padding: 12, marginBottom: 14, borderLeft: '3px solid #ef4444',
          color: '#991b1b', fontSize: 12, lineHeight: 1.5,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={() => loadPage(true)}
            className="btn is-ghost" style={{ padding: '3px 8px', fontSize: 11 }}>
            Retry
          </button>
          <button onClick={() => setError(null)}
            className="btn is-ghost" style={{ padding: '3px 8px', fontSize: 11 }}>
            Dismiss
          </button>
        </div>
      )}

      {!error && !loading && filtered.length === 0 && (
        <div className="card is-clean" style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {rows.length > 0 ? 'No rows match the current search' : 'No data yet'}
          </div>
          <div style={{ fontSize: 12 }}>
            {rows.length > 0
              ? <>Clear the search box to see all rows.</>
              : <>Once the Google Ads Apps Script runs the new dimension ingest (Keywords / Search Terms / Geo / Devices), rows populate here automatically. The script runs hourly when scheduled.</>}
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="card is-clean" style={{ padding: 0, overflow: 'auto', maxHeight: '70vh' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
              <tr>
                {columns.map(col => (
                  <th key={col.key} style={{ ..._dimThStyle, textAlign: col.align || 'left' }}>
                    {col.label}
                  </th>
                ))}
                <th style={{ ..._dimThStyle, width: 90 }}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => (
                <tr key={row.id || i}>
                  {columns.map(col => (
                    <td key={col.key} style={{ ..._dimTdStyle, textAlign: col.align || 'left' }}>
                      {col.render ? col.render(row) : _dimText(_dimDig(row, col.key))}
                    </td>
                  ))}
                  <td style={_dimTdStyle}>
                    <DimSparkline daily={row.daily} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
          <button
            onClick={() => loadPage(false, cursor)}
            disabled={loading}
            className="btn"
            style={{ padding: '8px 18px', fontSize: 13 }}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

function DimKpi({ label, value }) {
  return (
    <div className="card is-clean" style={{ padding: '10px 12px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2, color: 'var(--ink)' }}>
        {value}
      </div>
    </div>
  );
}

/* ============== Page components ============== */

window.KeywordsPage = function KeywordsPage() {
  const columns = [
    { key: 'keyword.text', label: 'Keyword', render: (r) => (
      <div>
        <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{_dimText(r?.keyword?.text || r?.label)}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
          {r?.keyword?.matchType ? r.keyword.matchType.toLowerCase() : '—'}
          {r?.keyword?.qualityScore ? ' · QS ' + r.keyword.qualityScore : ''}
        </div>
      </div>
    )},
    { key: 'campaign.name', label: 'Campaign / ad group', render: (r) => (
      <div style={{ fontSize: 11, maxWidth: 220 }}>
        <div style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {_dimText(r?.campaign?.name)}
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r?.adgroup?.name || ''}
        </div>
      </div>
    )},
    { key: 'keyword.status', label: 'Status', render: (r) => <_DimStatus status={r?.keyword?.status} /> },
    { key: 'totals.spend',       label: 'Spend',  align: 'right', render: (r) => _dimMoney(r?.totals?.spend) },
    { key: 'totals.impressions', label: 'Impr.',  align: 'right', render: (r) => _dimInt(r?.totals?.impressions) },
    { key: 'totals.clicks',      label: 'Clicks', align: 'right', render: (r) => _dimInt(r?.totals?.clicks) },
    { key: 'totals.ctr',         label: 'CTR',    align: 'right', render: (r) => _dimPct(r?.totals?.ctr) },
    { key: 'totals.cpc',         label: 'CPC',    align: 'right', render: (r) => _dimMoney(r?.totals?.cpc) },
    { key: 'totals.conversions', label: 'Conv.',  align: 'right', render: (r) => _dimInt(r?.totals?.conversions) },
    { key: 'totals.cpa',         label: 'CPA',    align: 'right', render: (r) => r?.totals?.cpa ? _dimMoney(r.totals.cpa) : '—' },
  ];
  return (
    <DimensionTable
      kind="keyword"
      title="Keywords"
      subtitle="What you're bidding on — sorted by spend across the last 90 days"
      helpText="Active keywords from your Google Ads account that drove paid traffic. Includes match type (exact / phrase / broad) and Google's Quality Score where available."
      columns={columns}
    />
  );
};

window.SearchTermsPage = function SearchTermsPage() {
  const columns = [
    { key: 'searchTerm.text', label: 'Search term', render: (r) => (
      <div>
        <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{_dimText(r?.searchTerm?.text || r?.label)}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
          match: {r?.searchTerm?.matchType ? r.searchTerm.matchType.toLowerCase().replace(/_/g, ' ') : '—'}
        </div>
      </div>
    )},
    { key: 'campaign.name', label: 'Campaign / ad group', render: (r) => (
      <div style={{ fontSize: 11, maxWidth: 220 }}>
        <div style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {_dimText(r?.campaign?.name)}
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r?.adgroup?.name || ''}
        </div>
      </div>
    )},
    { key: 'searchTerm.status', label: 'Status', render: (r) => <_DimStatus status={r?.searchTerm?.status} /> },
    { key: 'totals.spend',       label: 'Spend',  align: 'right', render: (r) => _dimMoney(r?.totals?.spend) },
    { key: 'totals.impressions', label: 'Impr.',  align: 'right', render: (r) => _dimInt(r?.totals?.impressions) },
    { key: 'totals.clicks',      label: 'Clicks', align: 'right', render: (r) => _dimInt(r?.totals?.clicks) },
    { key: 'totals.ctr',         label: 'CTR',    align: 'right', render: (r) => _dimPct(r?.totals?.ctr) },
    { key: 'totals.cpc',         label: 'CPC',    align: 'right', render: (r) => _dimMoney(r?.totals?.cpc) },
    { key: 'totals.conversions', label: 'Conv.',  align: 'right', render: (r) => _dimInt(r?.totals?.conversions) },
  ];
  return (
    <DimensionTable
      kind="searchTerm"
      title="Search Terms"
      subtitle="The actual user queries that triggered your ads"
      helpText="Real searches typed by users that matched one of your keywords. Useful for finding negative-keyword candidates and discovering new keyword ideas."
      columns={columns}
    />
  );
};

window.GeoPage = function GeoPage() {
  const columns = [
    { key: 'label', label: 'Location', render: (r) => (
      <div>
        <div style={{ fontWeight: 600, color: 'var(--ink)' }}>
          {_dimText(r?.geo?.country || r?.label || r?.geo?.locationId)}
        </div>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
          {r?.geo?.resolution ? r.geo.resolution.toLowerCase().replace(/_/g, ' ') : ''}
          {r?.geo?.locationId ? ' · #' + r.geo.locationId : ''}
        </div>
      </div>
    )},
    { key: 'totals.spend',       label: 'Spend',  align: 'right', render: (r) => _dimMoney(r?.totals?.spend) },
    { key: 'totals.impressions', label: 'Impr.',  align: 'right', render: (r) => _dimInt(r?.totals?.impressions) },
    { key: 'totals.clicks',      label: 'Clicks', align: 'right', render: (r) => _dimInt(r?.totals?.clicks) },
    { key: 'totals.ctr',         label: 'CTR',    align: 'right', render: (r) => _dimPct(r?.totals?.ctr) },
    { key: 'totals.cpc',         label: 'CPC',    align: 'right', render: (r) => _dimMoney(r?.totals?.cpc) },
    { key: 'totals.conversions', label: 'Conv.',  align: 'right', render: (r) => _dimInt(r?.totals?.conversions) },
    { key: 'totals.cpa',         label: 'CPA',    align: 'right', render: (r) => r?.totals?.cpa ? _dimMoney(r.totals.cpa) : '—' },
  ];
  return (
    <DimensionTable
      kind="geo"
      title="Geography"
      subtitle="Where your impressions and clicks come from — by user location"
      helpText="Country breakdown of users who saw your ads. «Location of presence» = where the user actually was; «area of interest» = location they were researching about."
      columns={columns}
    />
  );
};

window.DevicesPage = function DevicesPage() {
  const columns = [
    { key: 'device.type', label: 'Device', render: (r) => (
      <div style={{ fontWeight: 600, color: 'var(--ink)' }}>
        {_dimText(r?.device?.type || r?.label)}
      </div>
    )},
    { key: 'totals.spend',       label: 'Spend',  align: 'right', render: (r) => _dimMoney(r?.totals?.spend) },
    { key: 'totals.impressions', label: 'Impr.',  align: 'right', render: (r) => _dimInt(r?.totals?.impressions) },
    { key: 'totals.clicks',      label: 'Clicks', align: 'right', render: (r) => _dimInt(r?.totals?.clicks) },
    { key: 'totals.ctr',         label: 'CTR',    align: 'right', render: (r) => _dimPct(r?.totals?.ctr) },
    { key: 'totals.cpc',         label: 'CPC',    align: 'right', render: (r) => _dimMoney(r?.totals?.cpc) },
    { key: 'totals.conversions', label: 'Conv.',  align: 'right', render: (r) => _dimInt(r?.totals?.conversions) },
    { key: 'totals.cpa',         label: 'CPA',    align: 'right', render: (r) => r?.totals?.cpa ? _dimMoney(r.totals.cpa) : '—' },
  ];
  return (
    <DimensionTable
      kind="device"
      title="Devices"
      subtitle="Performance split by device type — desktop / mobile / tablet"
      helpText="Where users were when they saw your ads. Use this to tune device bid adjustments in Google Ads (e.g. cut mobile if it converts poorly)."
      columns={columns}
    />
  );
};
