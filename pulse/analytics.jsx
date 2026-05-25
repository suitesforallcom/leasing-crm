/* global React, Icon */

/* ================================================================
   Analytics — redesigned 2026-05-25 (Tony).

   Single-page comprehensive GA4 dashboard. Period selector at top
   (default Today), comparison vs previous period (default ON),
   hourly/daily auto-detect chart, sections for all data plus
   one-click «Copy for AI» export to clipboard.

   Data source: ga4SyncRange callable — on-demand fetch per period,
   no localStorage caching (fresh on every selection click). Each
   period change triggers a new CF call (~5-10s response).
   ================================================================ */

const _PERIODS = [
  { id: 'today',     label: 'Today',       short: 'Today' },
  { id: 'yesterday', label: 'Yesterday',   short: 'Yesterday' },
  { id: '7d',        label: 'Last 7 days', short: '7d' },
  { id: '30d',       label: 'Last 30 days',short: '30d' },
  { id: 'mtd',       label: 'Month to date', short: 'MTD' },
  { id: 'lastMonth', label: 'Last month',  short: 'Last mo.' },
  { id: '90d',       label: 'Last 90 days',short: '90d' },
  { id: 'all',       label: 'All time',    short: 'All' },
  { id: 'custom',    label: 'Custom range',short: 'Custom' },
];

const _COMPARE_TO = [
  { id: 'previous', label: 'Previous period' },
  { id: 'lastYear', label: 'Same period last year' },
  { id: 'none',     label: 'No comparison' },
];

window.AnalyticsPage = function AnalyticsPage() {
  const [periodId, setPeriodId] = React.useState(() => {
    try { return localStorage.getItem('pulse_ga4_period') || 'today'; } catch (e) { return 'today'; }
  });
  const [compareTo, setCompareTo] = React.useState(() => {
    try { return localStorage.getItem('pulse_ga4_compareTo') || 'previous'; } catch (e) { return 'previous'; }
  });
  const _today = new Date();
  const _twoWksAgo = new Date(_today.getTime() - 14 * 86400000);
  const [customStart, setCustomStart] = React.useState(() => _fmtYmd(_twoWksAgo));
  const [customEnd, setCustomEnd] = React.useState(() => _fmtYmd(_today));
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [copyMsg, setCopyMsg] = React.useState(null);

  React.useEffect(() => { try { localStorage.setItem('pulse_ga4_period', periodId); } catch (e) {} }, [periodId]);
  React.useEffect(() => { try { localStorage.setItem('pulse_ga4_compareTo', compareTo); } catch (e) {} }, [compareTo]);

  // Fetch on period/compareTo/customRange change
  const fetchSig = periodId === 'custom' ? `${periodId}|${customStart}|${customEnd}|${compareTo}` : `${periodId}|${compareTo}`;
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setErr(null);
      try {
        if (typeof window._pulseCallable !== 'function') {
          throw new Error('Firebase bridge not loaded yet — reload');
        }
        const args = { period: periodId, compareTo };
        if (periodId === 'custom') args.custom = { start: customStart, end: customEnd };
        const r = await window._pulseCallable('ga4SyncRange', args);
        if (!cancelled) setData(r?.data || null);
      } catch (e) {
        if (!cancelled) setErr(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [fetchSig]);

  function copyForAI() {
    if (!data) return;
    const markdown = _buildMarkdownSummary(data);
    const payload = '## GA4 Analytics — ' + (data.currentRange?.label || data.period) + '\n\n' + markdown + '\n\n```json\n' + JSON.stringify(data, null, 2).slice(0, 50000) + '\n```\n';
    try {
      navigator.clipboard.writeText(payload).then(() => {
        setCopyMsg({ kind: 'ok', text: 'Copied! Paste to Claude/ChatGPT (markdown + JSON) — ' + payload.length.toLocaleString() + ' chars' });
        setTimeout(() => setCopyMsg(null), 5000);
      }).catch(e => {
        setCopyMsg({ kind: 'err', text: 'Clipboard failed: ' + e.message });
      });
    } catch (e) {
      setCopyMsg({ kind: 'err', text: 'Clipboard unavailable in this browser' });
    }
  }

  function exportCsv() {
    if (!data) return;
    const csv = _buildCsv(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ga4-' + periodId + '-' + (data.currentRange?.start || '') + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    setCopyMsg({ kind: 'ok', text: 'CSV downloaded' });
    setTimeout(() => setCopyMsg(null), 3000);
  }

  function onSyncAndReload() {
    setData(null);
    setPeriodId(p => p); // trigger refetch via state churn
    // Force refetch by changing a hidden state — simplest: re-set periodId same val won't trigger useEffect. Workaround: bump compareTo back.
    setCompareTo(c => c === 'previous' ? 'previous' : c);
    // Direct refetch:
    (async () => {
      setLoading(true); setErr(null);
      try {
        const args = { period: periodId, compareTo };
        if (periodId === 'custom') args.custom = { start: customStart, end: customEnd };
        const r = await window._pulseCallable('ga4SyncRange', args);
        setData(r?.data || null);
      } catch (e) {
        setErr(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }

  const cur = data?.summary?.current || {};
  const prev = data?.summary?.previous;
  const deltas = data?.summary?.deltas || {};
  const hasComparison = !!data?.previousRange;

  return (
    <div className="page">
      {/* Header */}
      <div className="page-h" style={{ flexWrap: 'wrap' }}>
        <div>
          <h1 className="title">Analytics</h1>
          <div className="subtitle">
            <span>Site behaviour from GA4 · Property {data?.propertyId || '494945826'}</span>
            {data?.fetchedAt && <span> · Loaded {_fmtAgo(data.fetchedAt)}</span>}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn is-small" onClick={onSyncAndReload} disabled={loading}>
            {loading ? '⏳ Loading…' : '↻ Refresh'}
          </button>
          <button className="btn is-small" onClick={exportCsv} disabled={!data}>⤓ CSV</button>
          <button className="btn is-small is-primary" onClick={copyForAI} disabled={!data}>🤖 Copy for AI</button>
        </div>
      </div>

      {/* Period selector — 2026-05-25 Tony: «при прокрутки эта таблица
          зависала сверху». Sticky-top: остаётся видимой при скролле
          страницы, чтобы можно было переключить period без скролла
          обратно наверх. z-index 30 чтобы быть над KPI плитками
          и таблицами. Боковой sidebar Pulse'а имеет z-index ~50 — не
          перекрываем его. */}
      <div className="card is-clean" style={{
        padding: 12, marginBottom: 14,
        position: 'sticky', top: 0, zIndex: 30,
        background: 'var(--surface)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
      }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginRight: 4 }}>Period:</span>
          {_PERIODS.map(p => (
            <button key={p.id}
                    className={'chip' + (periodId === p.id ? ' is-accent' : '')}
                    style={{ cursor: 'pointer', padding: '5px 10px', fontSize: 12 }}
                    onClick={() => setPeriodId(p.id)}>
              {p.short}
            </button>
          ))}
          {periodId === 'custom' && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8, fontSize: 12 }}>
              <input type="date" value={customStart} max={customEnd} onChange={e => setCustomStart(e.target.value)}
                     style={{ padding: '4px 8px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 4 }} />
              <span style={{ color: 'var(--muted)' }}>→</span>
              <input type="date" value={customEnd} min={customStart} max={_fmtYmd(new Date())} onChange={e => setCustomEnd(e.target.value)}
                     style={{ padding: '4px 8px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 4 }} />
            </span>
          )}
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginRight: 4 }}>Compare:</span>
          {_COMPARE_TO.map(c => (
            <button key={c.id}
                    className={'chip' + (compareTo === c.id ? ' is-accent' : '')}
                    style={{ cursor: 'pointer', padding: '4px 9px', fontSize: 11.5 }}
                    onClick={() => setCompareTo(c.id)}>
              {c.label}
            </button>
          ))}
          {data && (
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>
              <b style={{ color: 'var(--ink)' }}>{data.currentRange?.label}</b>
              {data.previousRange && <span> vs {data.previousRange.label} ({data.previousRange.start} → {data.previousRange.end})</span>}
              {' · '}{data.granularity === 'hourly' ? 'hourly' : 'daily'} granularity
            </span>
          )}
        </div>
      </div>

      {/* Status messages */}
      {copyMsg && (
        <div style={{ padding: '10px 14px', marginBottom: 12, borderRadius: 8, fontSize: 12.5,
          background: copyMsg.kind === 'ok' ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
          color: copyMsg.kind === 'ok' ? '#166534' : '#991b1b' }}>
          {copyMsg.text}
        </div>
      )}
      {err && (
        <div className="card is-clean" style={{ padding: 14, fontSize: 13, color: '#991b1b', background: 'rgba(239,68,68,.06)' }}>
          ⚠ Load failed: {err}
        </div>
      )}
      {loading && !data && (
        <div className="card is-clean" style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
          ⏳ Fetching GA4 data for {data?.currentRange?.label || periodId}…
        </div>
      )}

      {/* Body */}
      {data && (
        <>
          {/* KPI tiles row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
            <KpiTile label="Sessions" value={cur.sessions} prev={hasComparison ? prev?.sessions : null} delta={deltas.sessions} format="num" />
            <KpiTile label="Users" value={cur.totalUsers} prev={hasComparison ? prev?.totalUsers : null} delta={deltas.totalUsers} sub={cur.newUsers ? cur.newUsers.toLocaleString() + ' new' : null} format="num" />
            <KpiTile label="Conversions" value={cur.conversions} prev={hasComparison ? prev?.conversions : null} delta={deltas.conversions} format="num" tone="success"
                     sub={cur.sessions > 0 ? ((cur.conversions / cur.sessions) * 100).toFixed(1) + '% rate' : null} />
            <KpiTile label="Page views" value={cur.screenPageViews} prev={hasComparison ? prev?.screenPageViews : null} delta={deltas.screenPageViews} format="num"
                     sub={cur.sessions > 0 ? (cur.screenPageViews / cur.sessions).toFixed(1) + ' pp/sess' : null} />
            <KpiTile label="Avg session" value={cur.averageSessionDuration} prev={hasComparison ? prev?.averageSessionDuration : null} delta={deltas.averageSessionDuration} format="duration"
                     sub={cur.sessions > 0 ? Math.round(cur.engagedSessions / cur.sessions * 100) + '% engaged' : null} />
            <KpiTile label="Bounce rate" value={cur.bounceRate * 100} prev={hasComparison ? prev?.bounceRate * 100 : null} delta={deltas.bounceRate} format="pct" invert />
          </div>

          {/* Timeseries chart */}
          <Section title={data.granularity === 'hourly' ? 'Hourly traffic' : 'Daily traffic'}
                   subtitle={(data.timeseries?.length || 0) + ' points · sessions overlay'}>
            <TimeseriesChart series={data.timeseries || []} granularity={data.granularity} hasComparison={hasComparison} />
          </Section>

          {/* Source/Medium */}
          <Section title="Source / Medium" subtitle={(data.sourceMedium?.length || 0) + ' sources'}>
            <SourceTable rows={data.sourceMedium || []} hasComparison={hasComparison} totalSessions={cur.sessions} />
          </Section>

          {/* Top landing pages */}
          <Section title="Top landing pages" subtitle={(data.landingPages?.length || 0) + ' pages by sessions'}>
            <LandingTable rows={data.landingPages || []} hasComparison={hasComparison} />
          </Section>

          {/* Funnel + Devices + Geo */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 14 }}>
            <FunnelCard cur={cur} prev={prev} />
            <DimCard title="Devices" rows={data.devices || []} dimKey="deviceCategory" hasComparison={hasComparison} />
            <DimCard title="Geography (country)" rows={data.geo || []} dimKey="country" limit={10} hasComparison={hasComparison} />
          </div>

          {/* Events */}
          <Section title="Events" subtitle={(data.events?.length || 0) + ' types tracked'}>
            <EventsTable rows={data.events || []} hasComparison={hasComparison} />
          </Section>

          <div className="card is-clean" style={{ padding: 14, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            💡 <b>How to use «🤖 Copy for AI»:</b> Click the button — page state copies to clipboard as markdown summary + full JSON. Paste into Claude/ChatGPT and ask: "Analyze this site behavior — find anomalies, suggest landing page improvements, identify wasted ad spend." The AI gets ALL data structured, not just numbers.
          </div>
        </>
      )}
    </div>
  );
};

/* ===== Components ===== */
function KpiTile({ label, value, prev, delta, format, sub, tone, invert }) {
  const v = _fmtMetric(value, format);
  const hasDelta = delta !== null && delta !== undefined;
  const deltaPct = hasDelta ? Math.round(delta * 1000) / 10 : null;
  // For invert metrics (bounce rate), lower is better
  const positiveDirection = invert ? deltaPct < 0 : deltaPct > 0;
  const deltaColor = !hasDelta ? 'var(--muted)' : (deltaPct === 0 ? 'var(--muted)' : (positiveDirection ? '#16a34a' : '#dc2626'));
  const deltaArrow = !hasDelta ? '' : (deltaPct === 0 ? '·' : (deltaPct > 0 ? '▲' : '▼'));
  const toneColor = tone === 'success' ? '#166534' : 'var(--ink)';
  return (
    <div className="card is-clean" style={{ padding: 12 }}>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 800, color: toneColor, lineHeight: 1.1, marginTop: 2 }}>{v}</div>
      {sub && <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>{sub}</div>}
      {hasDelta ? (
        <div style={{ fontSize: 10.5, marginTop: 4, color: deltaColor, fontWeight: 600 }} title={'Previous: ' + _fmtMetric(prev, format)}>
          {deltaArrow} {Math.abs(deltaPct).toFixed(1)}% vs prev ({_fmtMetric(prev, format)})
        </div>
      ) : prev === null && value > 0 ? (
        <div style={{ fontSize: 10.5, marginTop: 4, color: 'var(--muted)' }}>no baseline</div>
      ) : null}
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div className="card is-clean" style={{ marginBottom: 14, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{subtitle}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function FunnelCard({ cur, prev }) {
  const sessions = cur.sessions || 0;
  const engaged = cur.engagedSessions || 0;
  const conversions = cur.conversions || 0;
  const engagedPct = sessions > 0 ? (engaged / sessions * 100) : 0;
  const convPct = sessions > 0 ? (conversions / sessions * 100) : 0;
  return (
    <div className="card is-clean" style={{ padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Conversion funnel</div>
      <FunnelBar label="Sessions" value={sessions} max={sessions} color="#3b82f6" />
      <FunnelBar label={`Engaged (${engagedPct.toFixed(0)}%)`} value={engaged} max={sessions} color="#a855f7" />
      <FunnelBar label={`Conversions (${convPct.toFixed(1)}%)`} value={conversions} max={sessions} color="#16a34a" />
    </div>
  );
}

function FunnelBar({ label, value, max, color }) {
  const pct = max > 0 ? (value / max * 100) : 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 2 }}>
        <span style={{ color: 'var(--muted)' }}>{label}</span>
        <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{value.toLocaleString()}</span>
      </div>
      <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: pct + '%', background: color, transition: 'width .2s' }} />
      </div>
    </div>
  );
}

function DimCard({ title, rows, dimKey, limit = 5, hasComparison }) {
  const top = rows.slice(0, limit);
  const total = rows.reduce((s, r) => s + (r.current.sessions || 0), 0);
  return (
    <div className="card is-clean" style={{ padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>{title}</div>
      {top.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>No data.</div>}
      {top.map((r, i) => {
        const sess = r.current.sessions || 0;
        const pct = total > 0 ? (sess / total * 100) : 0;
        const prevSess = r.previous ? (r.previous.sessions || 0) : null;
        const delta = prevSess !== null && prevSess > 0 ? (sess - prevSess) / prevSess : null;
        const label = r.dims[dimKey] || '(unknown)';
        return (
          <div key={label + i} style={{ marginBottom: 7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 2 }}>
              <span style={{ fontWeight: 500 }}>{label}</span>
              <span className="num" style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{sess.toLocaleString()}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--muted)' }}>
              <div style={{ flex: 1, height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: pct + '%', background: 'var(--accent)' }} />
              </div>
              <span style={{ minWidth: 40, textAlign: 'right' }}>{pct.toFixed(1)}%</span>
              {hasComparison && delta !== null && (
                <span style={{ minWidth: 36, textAlign: 'right', color: delta >= 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                  {delta >= 0 ? '+' : ''}{Math.round(delta * 100)}%
                </span>
              )}
            </div>
          </div>
        );
      })}
      {rows.length > limit && (
        <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>+{rows.length - limit} more</div>
      )}
    </div>
  );
}

/* ================================================================
   SortableTable — общий компонент таблицы с:
     • Per-column tooltip ('?' icon в шапке, hover/click → объяснение)
     • Click header to sort (asc ↔ desc toggle)
     • Drag-to-reorder columns (HTML5 drag&drop)
     • Persisted sort + column order в localStorage по storageKey

   Props:
     cols:     [{ key, label, tooltip, align, gridWidth, getValue, render, defaultSort?: 'desc'|'asc' }]
     rows:     [{ ...rawData }]
     storageKey: 'pulse_ga4_source' и пр.
     emptyText: 'No data.'

   getValue(row): возвращает значение для сортировки (number или string)
   render(row, ctx): возвращает JSX ячейки (ctx содержит rowIndex + totalSessions etc)
   ================================================================ */
function SortableTable({ cols, rows, storageKey, emptyText, ctx }) {
  // Default sort: first col with defaultSort, or first numeric (right-aligned), or first col
  const defaultCol = cols.find(c => c.defaultSort) || cols.find(c => c.align === 'right') || cols[0];
  const defaultDir = defaultCol?.defaultSort || 'desc';

  const [sort, setSort] = React.useState(() => {
    try {
      const v = localStorage.getItem(storageKey + '_sort');
      const p = v ? JSON.parse(v) : null;
      return p && p.key ? p : { key: defaultCol.key, dir: defaultDir };
    } catch (e) { return { key: defaultCol.key, dir: defaultDir }; }
  });
  const [order, setOrder] = React.useState(() => {
    try {
      const v = localStorage.getItem(storageKey + '_order');
      const arr = v ? JSON.parse(v) : null;
      // Validate: all keys must still exist in cols
      if (Array.isArray(arr) && arr.every(k => cols.some(c => c.key === k)) && arr.length === cols.length) {
        return arr;
      }
    } catch (e) {}
    return cols.map(c => c.key);
  });
  const [openTooltip, setOpenTooltip] = React.useState(null);
  const [dragKey, setDragKey] = React.useState(null);

  React.useEffect(() => { try { localStorage.setItem(storageKey + '_sort', JSON.stringify(sort)); } catch (e) {} }, [sort, storageKey]);
  React.useEffect(() => { try { localStorage.setItem(storageKey + '_order', JSON.stringify(order)); } catch (e) {} }, [order, storageKey]);

  // Sync order if cols add/remove (e.g. comparison toggle changes columns)
  React.useEffect(() => {
    const valid = order.filter(k => cols.some(c => c.key === k));
    const missing = cols.map(c => c.key).filter(k => !valid.includes(k));
    if (valid.length !== order.length || missing.length > 0) {
      setOrder([...valid, ...missing]);
    }
  }, [cols.length]);

  const orderedCols = order.map(k => cols.find(c => c.key === k)).filter(Boolean);
  const sortCol = cols.find(c => c.key === sort.key) || cols[0];

  // Sort rows
  const sortedRows = React.useMemo(() => {
    if (!rows || rows.length === 0) return [];
    const arr = rows.slice();
    arr.sort((a, b) => {
      const va = sortCol.getValue ? sortCol.getValue(a) : '';
      const vb = sortCol.getValue ? sortCol.getValue(b) : '';
      let cmp = 0;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [rows, sort, sortCol]);

  function onHeaderClick(c, e) {
    // If user clicked the tooltip icon — don't sort
    if (e.target.closest('[data-tooltip-icon]')) return;
    setSort(s => s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'desc' });
  }
  function onTooltipClick(c, e) {
    e.stopPropagation();
    setOpenTooltip(openTooltip === c.key ? null : c.key);
  }
  function onDragStart(c, e) {
    setDragKey(c.key);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', c.key); } catch (err) {}
  }
  function onDragOver(c, e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
  function onDrop(c, e) {
    e.preventDefault();
    if (!dragKey || dragKey === c.key) { setDragKey(null); return; }
    setOrder(prev => {
      const next = prev.slice();
      const fromIdx = next.indexOf(dragKey);
      const toIdx = next.indexOf(c.key);
      if (fromIdx < 0 || toIdx < 0) return prev;
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, dragKey);
      return next;
    });
    setDragKey(null);
  }
  function onDragEnd() { setDragKey(null); }

  // Close tooltip when clicking outside
  React.useEffect(() => {
    if (!openTooltip) return;
    const h = () => setOpenTooltip(null);
    setTimeout(() => document.addEventListener('click', h, { once: true }), 0);
    return () => document.removeEventListener('click', h);
  }, [openTooltip]);

  if (!rows || rows.length === 0) {
    return <div style={{ padding: 18, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>{emptyText || 'No data.'}</div>;
  }

  const gridCols = orderedCols.map(c => c.gridWidth || (c.align === 'left' ? '1fr' : '80px')).join(' ');

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '8px 14px', background: 'var(--surface-2)', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {orderedCols.map(c => {
          const isSort = sort.key === c.key;
          const dragging = dragKey === c.key;
          return (
            <div
              key={c.key}
              draggable
              onDragStart={(e) => onDragStart(c, e)}
              onDragOver={(e) => onDragOver(c, e)}
              onDrop={(e) => onDrop(c, e)}
              onDragEnd={onDragEnd}
              onClick={(e) => onHeaderClick(c, e)}
              style={{
                textAlign: c.align,
                cursor: 'pointer',
                userSelect: 'none',
                opacity: dragging ? 0.4 : 1,
                display: 'flex', alignItems: 'center',
                justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start',
                gap: 4,
                position: 'relative',
              }}
              title={isSort ? 'Click to flip sort' : 'Click to sort · Drag to reorder'}
            >
              <span style={{ cursor: 'grab' }}>≡</span>
              <span>{c.label}</span>
              {c.tooltip && (
                <span
                  data-tooltip-icon
                  onClick={(e) => onTooltipClick(c, e)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 13, height: 13, borderRadius: '50%',
                    border: '1px solid currentColor',
                    fontSize: 9, fontWeight: 700,
                    cursor: 'help',
                    background: openTooltip === c.key ? 'var(--muted-2)' : 'transparent',
                    color: openTooltip === c.key ? 'white' : 'inherit',
                  }}
                >?</span>
              )}
              {isSort && (
                <span style={{ fontSize: 8, color: 'var(--accent)', marginLeft: 1 }}>
                  {sort.dir === 'asc' ? '▲' : '▼'}
                </span>
              )}
              {openTooltip === c.key && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute', top: 'calc(100% + 6px)',
                    [c.align === 'right' ? 'right' : 'left']: 0,
                    zIndex: 100,
                    background: '#1f2937', color: '#f9fafb',
                    padding: '8px 11px', borderRadius: 6,
                    fontSize: 11.5, fontWeight: 500,
                    letterSpacing: 'normal', textTransform: 'none',
                    lineHeight: 1.4, width: 280,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
                    whiteSpace: 'normal', textAlign: 'left',
                  }}>
                  {c.tooltip}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {sortedRows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '7px 14px', borderTop: '1px solid var(--border)', alignItems: 'center', fontSize: 12 }}>
          {orderedCols.map(c => (
            <div key={c.key} style={{ textAlign: c.align, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.render ? c.render(r, { ...ctx, rowIndex: i }) : (c.getValue ? c.getValue(r) : '—')}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SourceTable({ rows, hasComparison, totalSessions }) {
  const cols = [
    { key: 'source', label: 'Source', align: 'left', gridWidth: '1.4fr',
      tooltip: 'Откуда пришла сессия (hs_analytics_source-like). Примеры: google, tiktok.com, (direct), facebook, reddit. «(direct)» = пользователь вбил URL руками или пришёл из закладки, или GA4 не смогла определить источник.',
      getValue: r => (r.dims.sessionSource || '').toLowerCase(),
      render: r => <span style={{ fontWeight: 600 }}>{r.dims.sessionSource || '(unset)'}</span> },
    { key: 'medium', label: 'Medium', align: 'left', gridWidth: '1fr',
      tooltip: 'Канал внутри source. Типичные значения: cpc (paid ads), referral (по ссылке с другого сайта), organic (поисковая выдача), paid (Facebook Lead Ads), social (Instagram/FB organic posts), email, (none) = direct.',
      getValue: r => (r.dims.sessionMedium || '').toLowerCase(),
      render: r => <span style={{ color: 'var(--muted)' }}>{r.dims.sessionMedium || '(none)'}</span> },
    { key: 'sessions', label: 'Sessions', align: 'right', gridWidth: '80px',
      tooltip: 'Число сессий — посещений сайта от этого source/medium за период. Сессия начинается когда пользователь зашёл, заканчивается после 30 минут неактивности.',
      getValue: r => r.current.sessions || 0,
      render: r => <span className="mono">{(r.current.sessions || 0).toLocaleString()}</span>,
      defaultSort: 'desc' },
    { key: 'users', label: 'Users', align: 'right', gridWidth: '80px',
      tooltip: 'Уникальные пользователи с этого канала. Один пользователь может сделать несколько сессий (вернулся через день).',
      getValue: r => r.current.totalUsers || 0,
      render: r => <span className="mono" style={{ color: 'var(--muted)' }}>{(r.current.totalUsers || 0).toLocaleString()}</span> },
    { key: 'conv', label: 'Conv.', align: 'right', gridWidth: '80px',
      tooltip: 'Количество conversions — целевых действий (form submit, phone click, lead). Настраивается в GA4 → Configure → Events → Mark as conversion.',
      getValue: r => r.current.conversions || 0,
      render: r => {
        const conv = r.current.conversions || 0;
        return <span className="mono" style={{ fontWeight: conv > 0 ? 700 : 400, color: conv > 0 ? '#166534' : 'var(--muted)' }}>{conv}</span>;
      } },
    { key: 'cr', label: 'CR %', align: 'right', gridWidth: '70px',
      tooltip: 'Conversion Rate = Conversions ÷ Sessions × 100. Показывает какой % посетителей с этого канала совершает целевое действие. >5% = отличный канал; 1-5% — норма; <1% — стоит пересмотреть.',
      getValue: r => { const s = r.current.sessions || 0; return s > 0 ? (r.current.conversions || 0) / s : 0; },
      render: r => {
        const s = r.current.sessions || 0;
        const cr = s > 0 ? (r.current.conversions || 0) / s * 100 : 0;
        return <span className="mono" style={{ color: cr >= 5 ? '#16a34a' : cr >= 1 ? 'var(--ink)' : 'var(--muted)', fontWeight: 700 }}>{cr.toFixed(1)}%</span>;
      } },
    ...(hasComparison ? [{ key: 'delta', label: 'Δ Sessions', align: 'right', gridWidth: '80px',
      tooltip: 'Δ Sessions — процент изменения числа сессий к предыдущему периоду. +50% = выросло в 1.5 раза, -30% = упало на треть. «—» означает что в предыдущем периоде было 0 (нельзя вычислить процент).',
      getValue: r => {
        const cur = r.current.sessions || 0;
        const prev = r.previous ? (r.previous.sessions || 0) : 0;
        if (prev === 0) return cur > 0 ? Infinity : -Infinity;
        return (cur - prev) / prev;
      },
      render: r => {
        const cur = r.current.sessions || 0;
        const prev = r.previous ? (r.previous.sessions || 0) : null;
        const delta = prev !== null && prev > 0 ? (cur - prev) / prev : null;
        return <span className="mono" style={{ color: delta === null ? 'var(--muted-2)' : delta >= 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
          {delta === null ? '—' : (delta >= 0 ? '+' : '') + Math.round(delta * 100) + '%'}
        </span>;
      } }] : []),
    { key: 'pct', label: '% of total', align: 'right', gridWidth: '90px',
      tooltip: 'Доля сессий этого канала от ОБЩЕГО числа сессий за период. Показывает насколько канал важен в общей картине трафика.',
      getValue: r => { const s = r.current.sessions || 0; return totalSessions > 0 ? s / totalSessions : 0; },
      render: r => {
        const s = r.current.sessions || 0;
        const pct = totalSessions > 0 ? s / totalSessions * 100 : 0;
        return <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          <span style={{ display: 'inline-block', width: 30, height: 4, background: 'var(--surface)', borderRadius: 2, overflow: 'hidden', verticalAlign: 'middle', marginRight: 4 }}>
            <span style={{ display: 'block', height: '100%', width: pct + '%', background: 'var(--accent)' }} />
          </span>
          {pct.toFixed(1)}%
        </span>;
      } },
  ];
  return <SortableTable cols={cols} rows={rows} storageKey="pulse_ga4_source" />;
}

function LandingTable({ rows, hasComparison }) {
  const cols = [
    { key: 'page', label: 'Landing page', align: 'left', gridWidth: '2fr',
      tooltip: 'URL первой страницы сессии — та куда user приземлился из поиска / ad click / referral. /=главная, /product/...=конкретное объявление. По landing page видно какие страницы привлекают больше всего трафика.',
      getValue: r => (r.dims.landingPage || '').toLowerCase(),
      render: r => <span title={r.dims.landingPage || '(unset)'} style={{ fontWeight: 500 }}>{r.dims.landingPage || '(unset)'}</span> },
    { key: 'sessions', label: 'Sessions', align: 'right', gridWidth: '80px',
      tooltip: 'Сколько сессий начались с этой страницы. Высокий показатель = страница хорошо ранжируется в поиске или активно используется как landing для рекламы.',
      getValue: r => r.current.sessions || 0,
      render: r => <span className="mono" style={{ fontWeight: 700 }}>{(r.current.sessions || 0).toLocaleString()}</span>,
      defaultSort: 'desc' },
    { key: 'users', label: 'Users', align: 'right', gridWidth: '80px',
      tooltip: 'Уникальные пользователи которые приземлились на эту страницу.',
      getValue: r => r.current.totalUsers || 0,
      render: r => <span className="mono" style={{ color: 'var(--muted)' }}>{(r.current.totalUsers || 0).toLocaleString()}</span> },
    { key: 'conv', label: 'Conv.', align: 'right', gridWidth: '70px',
      tooltip: 'Конверсии на сессиях которые начались с этой страницы. Высокий conv + sessions = золотая страница, дублируй её формат для других объявлений.',
      getValue: r => r.current.conversions || 0,
      render: r => {
        const c = r.current.conversions || 0;
        return <span className="mono" style={{ fontWeight: c > 0 ? 700 : 400, color: c > 0 ? '#166534' : 'var(--muted)' }}>{c}</span>;
      } },
    { key: 'avg', label: 'Avg time', align: 'right', gridWidth: '70px',
      tooltip: 'Средняя длительность сессии на этой странице. >2 минут = пользователи реально читают; <30 сек = либо мисс-таргет, либо страница не зацепила.',
      getValue: r => r.current.averageSessionDuration || 0,
      render: r => <span className="mono" style={{ color: 'var(--muted)' }}>{_fmtDuration(r.current.averageSessionDuration || 0)}</span> },
    { key: 'bounce', label: 'Bounce', align: 'right', gridWidth: '70px',
      tooltip: 'Bounce rate — % сессий которые ушли с этой страницы НЕ совершив ни одного действия (не кликнули, не проскроллили далеко). <50% = норма (зелёный); 50-70% = средне (жёлтый); >70% = плохо (красный).',
      getValue: r => r.current.bounceRate || 0,
      render: r => {
        const b = r.current.bounceRate || 0;
        return <span className="mono" style={{ color: b > 0.7 ? '#dc2626' : b > 0.5 ? '#f59e0b' : '#16a34a' }}>{(b * 100).toFixed(0)}%</span>;
      } },
    ...(hasComparison ? [{ key: 'delta', label: 'Δ Sess', align: 'right', gridWidth: '80px',
      tooltip: 'Изменение числа сессий относительно предыдущего периода. Помогает увидеть растущие vs падающие страницы.',
      getValue: r => {
        const cur = r.current.sessions || 0;
        const prev = r.previous ? (r.previous.sessions || 0) : 0;
        if (prev === 0) return cur > 0 ? Infinity : -Infinity;
        return (cur - prev) / prev;
      },
      render: r => {
        const cur = r.current.sessions || 0;
        const prev = r.previous ? (r.previous.sessions || 0) : null;
        const delta = prev !== null && prev > 0 ? (cur - prev) / prev : null;
        return <span className="mono" style={{ color: delta === null ? 'var(--muted-2)' : delta >= 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
          {delta === null ? '—' : (delta >= 0 ? '+' : '') + Math.round(delta * 100) + '%'}
        </span>;
      } }] : []),
  ];
  return <SortableTable cols={cols} rows={rows} storageKey="pulse_ga4_landing" emptyText="No landing pages tracked." />;
}

function EventsTable({ rows, hasComparison }) {
  const cols = [
    { key: 'event', label: 'Event name', align: 'left', gridWidth: '2fr',
      tooltip: 'Имя события в GA4. Стандартные: page_view, session_start, scroll, click, form_submit. Кастомные настраиваются через GTM или gtag код на сайте. Чем больше уникальных events — тем лучше можно anlysir по funnel.',
      getValue: r => (r.dims.eventName || '').toLowerCase(),
      render: r => <span style={{ fontWeight: 500 }}>{r.dims.eventName || '(unset)'}</span> },
    { key: 'count', label: 'Count', align: 'right', gridWidth: '100px',
      tooltip: 'Сколько раз это событие сработало за период. Например page_view = общее число просмотров страниц, form_submit = число отправленных форм.',
      getValue: r => r.current.eventCount || 0,
      render: r => <span className="mono" style={{ fontWeight: 700 }}>{(r.current.eventCount || 0).toLocaleString()}</span>,
      defaultSort: 'desc' },
    { key: 'users', label: 'Users', align: 'right', gridWidth: '100px',
      tooltip: 'Сколько уникальных пользователей сделали хотя бы один такой event.',
      getValue: r => r.current.totalUsers || 0,
      render: r => <span className="mono" style={{ color: 'var(--muted)' }}>{(r.current.totalUsers || 0).toLocaleString()}</span> },
    ...(hasComparison ? [{ key: 'delta', label: 'Δ vs prev', align: 'right', gridWidth: '100px',
      tooltip: 'Изменение числа событий относительно предыдущего периода.',
      getValue: r => {
        const cur = r.current.eventCount || 0;
        const prev = r.previous ? (r.previous.eventCount || 0) : 0;
        if (prev === 0) return cur > 0 ? Infinity : -Infinity;
        return (cur - prev) / prev;
      },
      render: r => {
        const cur = r.current.eventCount || 0;
        const prev = r.previous ? (r.previous.eventCount || 0) : null;
        const delta = prev !== null && prev > 0 ? (cur - prev) / prev : null;
        return <span className="mono" style={{ color: delta === null ? 'var(--muted-2)' : delta >= 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
          {delta === null ? '—' : (delta >= 0 ? '+' : '') + Math.round(delta * 100) + '%'}
        </span>;
      } }] : []),
  ];
  return <SortableTable cols={cols} rows={rows} storageKey="pulse_ga4_events" emptyText="No events tracked." />;
}

function TimeseriesChart({ series, granularity, hasComparison }) {
  if (!series || series.length === 0) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>No data points.</div>;
  }
  const max = Math.max(...series.map(s => Math.max(s.current?.sessions || 0, s.previous?.sessions || 0)), 1);
  const maxConv = Math.max(...series.map(s => s.current?.conversions || 0), 1);
  const w = 100 / series.length;
  return (
    <div style={{ padding: 14 }}>
      <div style={{ position: 'relative', height: 160, background: 'var(--surface-2)', borderRadius: 8, padding: 8, overflow: 'hidden' }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          {/* Current sessions bars */}
          {series.map((s, i) => (
            <rect key={'c' + i} x={i * w + w * 0.1} y={100 - ((s.current?.sessions || 0) / max) * 95}
                  width={w * 0.4} height={((s.current?.sessions || 0) / max) * 95}
                  fill="var(--accent)" opacity="0.7" />
          ))}
          {/* Previous sessions bars (lighter) */}
          {hasComparison && series.map((s, i) => (
            <rect key={'p' + i} x={i * w + w * 0.5} y={100 - ((s.previous?.sessions || 0) / max) * 95}
                  width={w * 0.4} height={((s.previous?.sessions || 0) / max) * 95}
                  fill="#94a3b8" opacity="0.4" />
          ))}
          {/* Conversions line on current */}
          {series.length > 1 && (
            <polyline points={series.map((s, i) => (i * w + w / 2) + ',' + (100 - ((s.current?.conversions || 0) / maxConv) * 95)).join(' ')}
                      fill="none" stroke="#16a34a" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10.5, color: 'var(--muted)', flexWrap: 'wrap', gap: 6 }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--accent)', opacity: 0.7, borderRadius: 2, verticalAlign: 'middle', marginRight: 4 }}/>Current sessions (peak {max.toLocaleString()})</span>
        {hasComparison && <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#94a3b8', opacity: 0.4, borderRadius: 2, verticalAlign: 'middle', marginRight: 4 }}/>Previous sessions</span>}
        <span><span style={{ display: 'inline-block', width: 10, height: 2, background: '#16a34a', verticalAlign: 'middle', marginRight: 4 }}/>Conversions (peak {maxConv})</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: 'var(--muted-2)' }}>
        <span>{series[0]?.key}</span><span>{series[series.length - 1]?.key}</span>
      </div>
    </div>
  );
}

/* ===== Helpers ===== */
function _fmtYmd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _fmtAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h + 'h ago';
}
function _fmtDuration(sec) {
  if (!sec || sec < 1) return '0s';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? m + 'm ' + s + 's' : s + 's';
}
function _fmtMetric(v, format) {
  if (v === null || v === undefined) return '—';
  if (format === 'num') return Math.round(v).toLocaleString();
  if (format === 'duration') return _fmtDuration(v);
  if (format === 'pct') return v.toFixed(1) + '%';
  return String(v);
}

// Build markdown summary for AI export (concise + structured)
function _buildMarkdownSummary(data) {
  const cur = data.summary?.current || {};
  const prev = data.summary?.previous;
  const d = data.summary?.deltas || {};
  const fmtPct = (delta) => delta === null || delta === undefined ? 'N/A' : (delta >= 0 ? '+' : '') + (delta * 100).toFixed(1) + '%';
  let md = '';
  md += `**Period:** ${data.currentRange?.label} (${data.currentRange?.start} → ${data.currentRange?.end})\n`;
  if (data.previousRange) md += `**Comparison:** ${data.previousRange.label} (${data.previousRange.start} → ${data.previousRange.end})\n`;
  md += '\n### Summary KPIs\n\n';
  md += '| Metric | Current | Previous | Δ |\n|---|---:|---:|---:|\n';
  const metrics = [
    ['Sessions', 'sessions', 'num'],
    ['Users', 'totalUsers', 'num'],
    ['New Users', 'newUsers', 'num'],
    ['Engaged Sessions', 'engagedSessions', 'num'],
    ['Page Views', 'screenPageViews', 'num'],
    ['Event Count', 'eventCount', 'num'],
    ['Conversions', 'conversions', 'num'],
    ['Avg Session Duration', 'averageSessionDuration', 'duration'],
    ['Bounce Rate', 'bounceRate', 'pct'],
  ];
  for (const [label, key, fmt] of metrics) {
    md += `| ${label} | ${_fmtMetric(cur[key], fmt)} | ${prev ? _fmtMetric(prev[key], fmt) : '—'} | ${fmtPct(d[key])} |\n`;
  }
  md += '\n### Top Sources\n\n';
  md += '| Source | Medium | Sessions | Conv. | CR% |\n|---|---|---:|---:|---:|\n';
  for (const r of (data.sourceMedium || []).slice(0, 10)) {
    const cr = r.current.sessions > 0 ? (r.current.conversions / r.current.sessions * 100).toFixed(1) : '0';
    md += `| ${r.dims.sessionSource} | ${r.dims.sessionMedium} | ${r.current.sessions} | ${r.current.conversions} | ${cr}% |\n`;
  }
  md += '\n### Top Landing Pages\n\n';
  md += '| Page | Sessions | Conv. | Bounce |\n|---|---:|---:|---:|\n';
  for (const r of (data.landingPages || []).slice(0, 10)) {
    md += `| ${r.dims.landingPage} | ${r.current.sessions} | ${r.current.conversions} | ${(r.current.bounceRate * 100).toFixed(0)}% |\n`;
  }
  md += '\n### Devices\n\n';
  for (const r of (data.devices || [])) {
    md += `- ${r.dims.deviceCategory}: ${r.current.sessions} sessions, ${r.current.conversions} conversions\n`;
  }
  md += '\n### Top Events\n\n';
  for (const r of (data.events || []).slice(0, 10)) {
    md += `- ${r.dims.eventName}: ${r.current.eventCount} (${r.current.totalUsers} users)\n`;
  }
  return md;
}

function _buildCsv(data) {
  const lines = [];
  lines.push('# GA4 Analytics Export — ' + (data.currentRange?.label || data.period));
  lines.push('# Period: ' + data.currentRange?.start + ' to ' + data.currentRange?.end);
  if (data.previousRange) lines.push('# Compared to: ' + data.previousRange.start + ' to ' + data.previousRange.end);
  lines.push('');
  // Summary
  lines.push('Summary,Current,Previous');
  const cur = data.summary?.current || {};
  const prev = data.summary?.previous || {};
  for (const key of Object.keys(cur)) {
    lines.push(`"${key}",${cur[key]},${prev[key] || ''}`);
  }
  lines.push('');
  // Source/Medium
  lines.push('Source/Medium');
  lines.push('Source,Medium,Sessions,Users,Conversions,Engaged');
  for (const r of (data.sourceMedium || [])) {
    lines.push(`"${r.dims.sessionSource}","${r.dims.sessionMedium}",${r.current.sessions || 0},${r.current.totalUsers || 0},${r.current.conversions || 0},${r.current.engagedSessions || 0}`);
  }
  lines.push('');
  // Landing pages
  lines.push('Landing Pages');
  lines.push('Page,Sessions,Users,Conversions,AvgDuration,BounceRate');
  for (const r of (data.landingPages || [])) {
    lines.push(`"${r.dims.landingPage}",${r.current.sessions || 0},${r.current.totalUsers || 0},${r.current.conversions || 0},${(r.current.averageSessionDuration || 0).toFixed(1)},${(r.current.bounceRate || 0).toFixed(3)}`);
  }
  lines.push('');
  // Events
  lines.push('Events');
  lines.push('EventName,Count,Users');
  for (const r of (data.events || [])) {
    lines.push(`"${r.dims.eventName}",${r.current.eventCount || 0},${r.current.totalUsers || 0}`);
  }
  return lines.join('\n');
}
