/* global React, FormDrawer */

/* ===================================================================
   Pulse — Source Rules drawer (Tony 2026-05-26 — second iteration)

   Контекст:
     HubSpot отдаёт два поля для каждого контакта — Original Traffic
     Source Drill-Down 1 (`c.src`) и Drill-Down 2 (`c.srcD`). Нативная
     attribution Pulse поддерживает только канонические значения
     (PAID_SEARCH, PAID_SOCIAL + facebook/tiktok/meta). Реальный
     HubSpot шлёт ещё гору тегов:
       • INTEGRATION + "TikTok Lead Syncing"  — TikTok Lead Gen Forms
       • EXTENSION   + "Ann Noel"             — manual entry by sales
       • Auto-tagged PPC + "Unknown keywords" — Google Ads ad-block
       • search_office_segment + "small office for lease" — Google Ads
       • OFFLINE_SOURCES + "Manually added"   — manual leads
       • etc.

     Всё что не матчится canonical → fall to 'other' → не атрибутится
     ни к одному платному каналу → CPL / leads count для TikTok = 0
     даже когда лиды по факту приходят.

   Решение:
     Открываемая из Marketing table настройка со списком ВСЕХ
     уникальных пар (src, srcD), которые встречаются в HubSpot кэше,
     и picker на каждую — к какому каналу её относить. Mapping живёт
     в localStorage (sfa_pulse_tag_mappings_v1) и применяется в
     data-shim._classifyContactChannel — без правки call-сайтов.

   Mount:
     <window.SourceRulesDrawer open={open} onClose={onClose} />
     Открывается из marketing.jsx SpendSection header (кнопка
     "Source rules") и реагирует на pulseTagMappingsChanged event.
   =================================================================== */

(function () {
  'use strict';

  const SOURCE_OPTIONS = [
    { key: 'google-ads', label: 'Google Ads' },
    { key: 'meta',       label: 'Meta (FB / IG)' },
    { key: 'tiktok',     label: 'TikTok' },
    { key: 'direct',     label: 'Direct' },
    { key: 'organic',    label: 'Organic' },
    { key: 'email',      label: 'Email' },
    { key: 'referral',   label: 'Referral' },
    { key: 'offline',    label: 'Offline' },
    { key: 'other',      label: 'Other / Unknown' },
  ];

  function _humanLabel(key) {
    const o = SOURCE_OPTIONS.find(x => x.key === key);
    return o ? o.label : 'Other / Unknown';
  }

  function ChannelPicker({ value, fallbackHint, onChange }) {
    return (
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value || null)}
        style={{
          padding: '4px 6px', fontSize: 11.5, borderRadius: 4,
          border: '1px solid ' + (value ? 'var(--accent-ink)' : 'var(--border)'),
          background: value ? 'var(--accent-soft, #eef2ff)' : 'var(--surface)',
          color: 'var(--ink)', cursor: 'pointer', width: '100%',
          fontWeight: value ? 700 : 400,
        }}
        title={value
          ? 'Manual mapping — overrides auto-classify for every contact with this tag pair'
          : 'Falls through to auto-classify: ' + fallbackHint}
      >
        <option value="">— auto ({fallbackHint}) —</option>
        {SOURCE_OPTIONS.map(o => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
    );
  }

  function TagRow({ row, onSet }) {
    const src  = row.src  || '(empty)';
    const srcD = row.srcD || '(empty)';
    const isOverridden = !!row.mappedChannel;
    const effective = row.mappedChannel || row.autoChannel;
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.1fr 1.4fr 70px 170px 130px',
        gap: 10, padding: '7px 14px',
        borderBottom: '1px solid var(--border)',
        alignItems: 'center', fontSize: 12.5,
        background: isOverridden ? 'rgba(99, 102, 241, .06)' : 'transparent',
      }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}
             title={String(row.src || '(empty)')}>
          {src}
        </div>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}
             title={String(row.srcD || '(empty)')}>
          {srcD}
        </div>
        <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'right' }}>
          {row.count.toLocaleString()}
        </div>
        <div>
          <ChannelPicker
            value={row.mappedChannel}
            fallbackHint={_humanLabel(row.autoChannel)}
            onChange={(v) => onSet(row.srcKey, v)}
          />
        </div>
        <div style={{ fontSize: 11.5, fontWeight: isOverridden ? 700 : 500, color: isOverridden ? 'var(--accent-ink)' : 'var(--muted)' }}>
          → {_humanLabel(effective)}
          {isOverridden && (
            <div style={{ fontSize: 9.5, fontWeight: 500, color: 'var(--muted-2)', marginTop: 1 }}>
              auto was: {_humanLabel(row.autoChannel)}
            </div>
          )}
        </div>
      </div>
    );
  }

  window.SourceRulesDrawer = function SourceRulesDrawer({ open, onClose }) {
    const [query, setQuery] = React.useState('');
    const [scope, setScope] = React.useState('all'); // 'all' | 'unmapped' | 'auto-other' | 'mapped'
    const [, setTick] = React.useState(0);

    React.useEffect(() => {
      if (open) { setQuery(''); setScope('all'); }
    }, [open]);

    React.useEffect(() => {
      function onChange() { setTick(t => t + 1); }
      window.addEventListener('pulseTagMappingsChanged', onChange);
      return () => window.removeEventListener('pulseTagMappingsChanged', onChange);
    }, []);

    const rows = (typeof window.getPulseHubspotSourceTags === 'function')
      ? window.getPulseHubspotSourceTags() : [];

    function setMapping(srcKey, channelKey) {
      if (typeof window.setPulseTagMapping !== 'function') return;
      window.setPulseTagMapping(srcKey, channelKey);
      if (window.toast) {
        if (channelKey) window.toast('Tag → ' + _humanLabel(channelKey), 'success');
        else window.toast('Mapping cleared — reverts to auto', 'success');
      }
    }
    function clearAll() {
      if (typeof window.clearAllPulseTagMappings !== 'function') return;
      window.clearAllPulseTagMappings();
      if (window.toast) window.toast('All tag mappings cleared', 'success');
    }

    const mappedCount = rows.filter(r => !!r.mappedChannel).length;
    const autoOtherCount = rows.filter(r => r.autoChannel === 'other' && !r.mappedChannel).length;

    const scoped = rows.filter(r => {
      if (scope === 'mapped')      return !!r.mappedChannel;
      if (scope === 'unmapped')    return !r.mappedChannel;
      if (scope === 'auto-other')  return r.autoChannel === 'other' && !r.mappedChannel;
      return true;
    });
    const filtered = !query ? scoped : scoped.filter(r => {
      const q = query.toLowerCase();
      return (r.src || '').toLowerCase().includes(q)
          || (r.srcD || '').toLowerCase().includes(q);
    });

    return (
      <FormDrawer
        open={open}
        onClose={onClose}
        title={`Source rules · ${rows.length} unique tag${rows.length === 1 ? '' : 's'}`}
        width={840}
      >
        {/* Stats + Clear all */}
        <div style={{
          display: 'flex', gap: 10, padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-2)', alignItems: 'center',
          flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            <b style={{ color: 'var(--ink)' }}>{rows.length}</b> unique HubSpot source tags ·
            <span style={{ marginLeft: 6, color: mappedCount > 0 ? 'var(--accent-ink)' : 'var(--muted)', fontWeight: mappedCount > 0 ? 700 : 400 }}>
              {mappedCount} mapped
            </span> ·
            <span style={{ marginLeft: 6, color: autoOtherCount > 0 ? '#b45309' : 'var(--muted)' }}>
              {autoOtherCount} auto→Other
            </span>
          </div>
          <span style={{ flex: 1 }} />
          {mappedCount > 0 && (
            <button
              onClick={clearAll}
              style={{
                cursor: 'pointer', padding: '4px 10px', borderRadius: 4,
                border: '1px solid var(--danger-border, #fca5a5)',
                background: 'var(--danger-soft, #fef2f2)',
                fontSize: 11, fontWeight: 600, color: 'var(--danger-ink, #b91c1c)',
              }}
              title="Reset every tag back to auto-classify."
            >Clear all mappings</button>
          )}
        </div>

        {/* Filter chips */}
        <div style={{
          display: 'flex', gap: 6, padding: '8px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)', alignItems: 'center', flexWrap: 'wrap',
        }}>
          <span style={{
            fontSize: 11, fontWeight: 700, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.04em',
            marginRight: 4,
          }}>Show</span>
          {[
            ['all',        `All (${rows.length})`],
            ['auto-other', `Needs attention — auto→Other (${autoOtherCount})`],
            ['unmapped',   `Unmapped (${rows.length - mappedCount})`],
            ['mapped',     `Mapped (${mappedCount})`],
          ].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setScope(k)}
              style={{
                cursor: 'pointer', padding: '4px 10px', borderRadius: 4,
                border: '1px solid ' + (scope === k ? 'var(--accent-ink)' : 'var(--border)'),
                background: scope === k ? 'var(--surface-2)' : 'var(--surface)',
                color: scope === k ? 'var(--ink)' : 'var(--muted)',
                fontSize: 11.5, fontWeight: scope === k ? 700 : 500,
              }}
            >{l}</button>
          ))}
          <span style={{ flex: 1 }} />
          <input
            placeholder="Search tag…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{
              padding: '5px 8px', fontSize: 12, borderRadius: 4,
              border: '1px solid var(--border)', background: 'var(--surface)',
              minWidth: 220,
            }}
          />
        </div>

        {/* Column header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1.1fr 1.4fr 70px 170px 130px',
          gap: 10, padding: '8px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-2)',
          fontSize: 10.5, fontWeight: 700, color: 'var(--muted)',
          textTransform: 'uppercase', letterSpacing: '.04em',
        }}>
          <div title="HubSpot Original Traffic Source Drill-Down 1 (category code)">Drill-Down 1 (src)</div>
          <div title="HubSpot Original Traffic Source Drill-Down 2 (platform / detail)">Drill-Down 2 (detail)</div>
          <div style={{ textAlign: 'right' }}>Count</div>
          <div>Map to channel</div>
          <div>Effective</div>
        </div>

        {/* Body */}
        <div>
          {filtered.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              {rows.length === 0
                ? 'No HubSpot contacts in cache yet — ingest a sync first.'
                : 'No tags match the current scope / search.'}
            </div>
          ) : (
            filtered.map(r => (
              <TagRow key={r.srcKey} row={r} onSet={setMapping} />
            ))
          )}
        </div>

        {/* Help footer */}
        <div style={{
          padding: '10px 14px', fontSize: 11, color: 'var(--muted)',
          background: 'var(--surface-2)', borderTop: '1px solid var(--border)',
        }}>
          <b>How this works:</b> HubSpot stamps each contact with two
          attribution tags (Drill-Down 1 = category, Drill-Down 2 = platform).
          Auto-classify covers canonical values (PAID_SEARCH → Google Ads,
          PAID_SOCIAL + tiktok → TikTok, …). For everything else — e.g.
          <code> INTEGRATION + TikTok Lead Syncing</code> — pick a channel
          here and every existing & future contact with that tag pair will
          re-bucket into that channel across the Marketing table, Channel
          mix, Pipeline, and bonus attribution. Pick «— auto —» to revert.
          Mappings persist per-browser.
        </div>
      </FormDrawer>
    );
  };
})();
