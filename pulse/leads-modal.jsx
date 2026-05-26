/* global React, FormDrawer */

/* ===================================================================
   Pulse — Leads / Contracts modal (Tony 2026-05-26)

   Single drawer-based modal with two tabs:
     • Leads     — HubSpot contacts (window._hsDataCache.contactByEmail)
     • Contracts — signed leases (window._floorMapLeases.all)

   Common UX:
     • Filter dropdown by source channel (Google Ads / Meta / TikTok /
       Direct / Organic / Email / Referral / Offline / Other-Unknown)
     • Search box
     • Per-row source picker — writes to window.setPulseSourceOverride
       (data-shim mutates HubSpot cache in-memory + persists to
       localStorage; downstream classifyChannel / _attributeChannel
       pick up new value automatically without code changes).

   Mounted from marketing.jsx SpendSection. Cells in the Leads/Contracts
   table become clickable — opens this modal pre-filtered by source.

   Single source of truth for editing: для contract source attribution
   правим source у HubSpot-контакта по email тенанта. Если email пустой
   или нет контакта — overrides всё равно сохраняются по email (на
   случай если контакт появится позже, sync применит override). Для
   contracts без email в HubSpot канал остаётся 'other'.
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

  // Mirrors classifyChannel in marketing.jsx + _attributeChannel in
  // data-shim but returns the override-vocabulary key (not the human
  // label). Used to decide which option is currently "active" for a
  // contact row so the SourcePicker shows it as selected.
  function _channelKeyForContact(c) {
    if (!c) return 'other';
    const cat = String(c.src || '').toUpperCase();
    const platform = String(c.srcD || '').toLowerCase();
    if (cat === 'PAID_SEARCH') return 'google-ads';
    if (cat === 'PAID_SOCIAL') {
      if (platform.includes('facebook') || platform.includes('instagram') || platform.includes('meta')) return 'meta';
      if (platform.includes('tiktok')) return 'tiktok';
      return 'other';
    }
    if (cat === 'ORGANIC_SEARCH' || cat === 'SOCIAL_MEDIA') return 'organic';
    if (cat === 'DIRECT_TRAFFIC') return 'direct';
    if (cat === 'REFERRALS') return 'referral';
    if (cat === 'EMAIL_MARKETING') return 'email';
    if (cat === 'OFFLINE') return 'offline';
    return 'other';
  }

  function _humanLabel(key) {
    const o = SOURCE_OPTIONS.find(x => x.key === key);
    return o ? o.label : 'Other / Unknown';
  }

  function SourcePicker({ value, onChange, disabled }) {
    return (
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value || null)}
        disabled={disabled}
        style={{
          padding: '4px 6px', fontSize: 11, borderRadius: 4,
          border: '1px solid var(--border)', background: 'var(--surface)',
          color: 'var(--ink)', cursor: disabled ? 'not-allowed' : 'pointer',
          width: '100%',
        }}
      >
        <option value="">— auto —</option>
        {SOURCE_OPTIONS.map(o => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
    );
  }

  function LeadRow({ email, contact, currentKey, overrideKey, onSetOverride }) {
    const dt = contact && contact.c
      ? new Date(contact.c + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    const stage = (contact && contact.s) || 'lead';
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.5fr 110px 110px 150px',
        gap: 10, padding: '8px 14px',
        borderBottom: '1px solid var(--border)',
        alignItems: 'center', fontSize: 12.5,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {(contact && contact.n) || '(no name)'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {email}
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{stage}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{dt}</div>
        <div>
          <SourcePicker
            value={overrideKey || currentKey}
            onChange={(v) => onSetOverride(email, v)}
          />
          {overrideKey && (
            <div style={{ fontSize: 9.5, color: 'var(--accent-ink)', marginTop: 2 }}>
              overridden · was «{_humanLabel(_channelKeyForOriginal(contact))}»
            </div>
          )}
        </div>
      </div>
    );
  }

  function _channelKeyForOriginal(c) {
    if (!c || c._origSrc === undefined) return _channelKeyForContact(c);
    return _channelKeyForContact({ src: c._origSrc, srcD: c._origSrcD });
  }

  function ContractRow({ lease, currentKey, overrideKey, onSetOverride }) {
    const dt = lease.activatedMs
      ? new Date(lease.activatedMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '—';
    const monthlyLabel = (lease.monthly > 0)
      ? '$' + Number(lease.monthly).toLocaleString() + '/mo'
      : '—';
    const actorChunks = [];
    if (lease.sentBy)     actorChunks.push('sent by ' + lease.sentBy);
    if (lease.uploadedBy) actorChunks.push('uploaded by ' + lease.uploadedBy);
    const actorLine = actorChunks.join(' · ');
    const hasEmail = !!(lease.email && lease.email.trim());
    // Bonus mgr = recipient of `ctr_signed` bonus per pulse/bonus-rules.jsx —
    // «The agent who initiated the envelope receives the bonus». Имя
    // приходит из data-shim._resolveBonusManager (state.employees lookup).
    const bonusName = lease.bonusManager || '';
    const bonusTooltip = lease.bonusManagerEmail
      ? 'Bonus recipient · ' + lease.bonusManagerEmail + (lease.sentBy ? ' (via DocuSign sender)' : (lease.uploadedBy ? ' (via signed-PDF upload)' : ''))
      : 'No envelope sender / uploader stamped — no bonus attribution yet';
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.4fr 90px 80px 110px 130px',
        gap: 10, padding: '8px 14px',
        borderBottom: '1px solid var(--border)',
        alignItems: 'center', fontSize: 12.5,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {lease.tenant}
            <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>
              · Suite {lease.unitId}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {lease.email || <span style={{ color: 'var(--muted-2)', fontStyle: 'italic' }}>(no email)</span>}
            {actorLine && <span style={{ marginLeft: 6 }}>· {actorLine}</span>}
          </div>
        </div>
        <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: lease.monthly > 0 ? 'var(--success-ink)' : 'var(--muted)' }}>
          {monthlyLabel}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{dt}</div>
        <div
          title={bonusTooltip}
          style={{
            fontSize: 11.5,
            color: bonusName ? 'var(--ink-2)' : 'var(--muted-2)',
            fontStyle: bonusName ? 'normal' : 'italic',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {bonusName || '—'}
        </div>
        <div>
          <SourcePicker
            value={overrideKey || currentKey}
            onChange={(v) => onSetOverride(lease.email, v)}
            disabled={!hasEmail}
          />
          {!hasEmail && (
            <div style={{ fontSize: 9.5, color: 'var(--muted-2)', marginTop: 2 }}>
              no email — cannot attribute
            </div>
          )}
        </div>
      </div>
    );
  }

  // Helper — formatYmd & windowRange зеркалят логику marketing.jsx чтобы
  // окно дат в модалке совпадало с основной таблицей. Diverged copy is
  // intentional — модалка может быть открыта без SpendSection в DOM.
  function _fmtYmd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function _windowRange(kind, customStart, customEnd) {
    const today = new Date();
    const todayYmd = _fmtYmd(today);
    if (kind === 'custom') return { start: customStart, end: customEnd };
    if (kind === 'today')  return { start: todayYmd, end: todayYmd };
    if (kind === 'yesterday') {
      const y = new Date(today.getTime() - 86400 * 1000);
      const yYmd = _fmtYmd(y);
      return { start: yYmd, end: yYmd };
    }
    if (kind === 'mtd') {
      return {
        start: today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-01',
        end: todayYmd,
      };
    }
    const days = kind === '7d' ? 7 : kind === '90d' ? 90 : 30;
    const back = new Date(today.getTime() - (days - 1) * 86400 * 1000);
    return { start: _fmtYmd(back), end: todayYmd };
  }

  window.LeadsContractsModal = function LeadsContractsModal({
    open, onClose,
    initialTab, initialChannel,
    initialWindowKind, initialCustomStart, initialCustomEnd,
  }) {
    const [tab, setTab] = React.useState(initialTab || 'leads');
    const [filter, setFilter] = React.useState(initialChannel || 'all');
    const [query, setQuery] = React.useState('');
    // Window state — синхронизируется с пропсами от SpendSection при
    // КАЖДОМ открытии модалки. Внутри модалки оператор может крутить
    // окно независимо от основной таблицы — это локальная навигация
    // в выборке, не глобальная (модалка закрывается → состояние сброс).
    const _todayD = new Date();
    const _twoWksAgoD = new Date(_todayD.getTime() - 14 * 86400 * 1000);
    const [windowKind, setWindowKind] = React.useState(initialWindowKind || 'today');
    const [customStart, setCustomStart] = React.useState(initialCustomStart || _fmtYmd(_twoWksAgoD));
    const [customEnd, setCustomEnd] = React.useState(initialCustomEnd || _fmtYmd(_todayD));
    // tick — forces re-render when overrides change (HubSpot cache is
    // mutated in-place by data-shim, so React doesn't auto-detect).
    const [, setTick] = React.useState(0);

    React.useEffect(() => {
      if (open) {
        setTab(initialTab || 'leads');
        setFilter(initialChannel || 'all');
        setQuery('');
        setWindowKind(initialWindowKind || 'today');
        if (initialCustomStart) setCustomStart(initialCustomStart);
        if (initialCustomEnd)   setCustomEnd(initialCustomEnd);
      }
    }, [open, initialTab, initialChannel, initialWindowKind, initialCustomStart, initialCustomEnd]);

    React.useEffect(() => {
      function onChange() { setTick(t => t + 1); }
      window.addEventListener('pulseSourceOverridesChanged', onChange);
      return () => window.removeEventListener('pulseSourceOverridesChanged', onChange);
    }, []);

    const { start: windowStart, end: windowEnd } = _windowRange(windowKind, customStart, customEnd);
    const windowStartMs = new Date(windowStart + 'T00:00:00').getTime();
    const windowEndMs   = new Date(windowEnd   + 'T23:59:59').getTime();
    const windowLabel = windowKind === 'today' ? 'Today'
                      : windowKind === 'yesterday' ? 'Yesterday'
                      : windowKind === '7d' ? 'Last 7 days'
                      : windowKind === '30d' ? 'Last 30 days'
                      : windowKind === '90d' ? 'Last 90 days'
                      : windowKind === 'mtd' ? 'Month to date'
                      : 'Custom';

    const overrides = (typeof window.getPulseSourceOverrides === 'function')
      ? window.getPulseSourceOverrides() : {};

    function setOverride(email, channelKey) {
      if (typeof window.setPulseSourceOverride !== 'function') return;
      window.setPulseSourceOverride(email, channelKey);
      if (window.toast) {
        const lbl = channelKey ? _humanLabel(channelKey) : 'auto (cleared override)';
        window.toast('Source for ' + email + ' → ' + lbl, 'success');
      }
    }

    // ---------- Leads dataset ----------
    // c.c — это строка YYYY-MM-DD (HubSpot createDate). Сравниваем
    // строковым lexicographic compare с windowStart/End — это работает
    // потому что ISO даты сортируются лексикографически.
    const contactByEmail = (window._hsDataCache && window._hsDataCache.contactByEmail) || {};
    const leadEntries = Object.entries(contactByEmail).map(([email, c]) => ({
      email, c, key: _channelKeyForContact(c),
    }));
    const windowedLeadEntries = leadEntries.filter(e => {
      const created = (e.c && e.c.c) || '';
      if (!created) return false;
      return created >= windowStart && created <= windowEnd;
    });

    // ---------- Contracts dataset ----------
    // _floorMapLeases.all — MTD-scoped (или 7d на 1-е числа). Любой
    // window уже narrower MTD дополнительно фильтрует, wider window
    // (30d/90d) показывает ту же MTD-выборку. Это совпадает с
    // поведением marketing.jsx Spend table — у которой _floorMapLeases
    // тоже не пересчитывается под wide window.
    const allLeases = (window._floorMapLeases && window._floorMapLeases.all) || [];
    const windowedContracts = allLeases.filter(l => {
      const ts = l.activatedMs || 0;
      return ts >= windowStartMs && ts <= windowEndMs;
    });
    // Hint когда оператор выбрал окно wider чем MTD — _floorMapLeases.all
    // строится только под MTD, поэтому contracts > MTD physically нет.
    const _mtdStartMs = new Date(_todayD.getFullYear(), _todayD.getMonth(), 1, 0, 0, 0, 0).getTime();
    const showWindowHint = tab === 'contracts'
      && (windowKind === '30d' || windowKind === '90d' ||
          (windowKind === 'custom' && windowStartMs < _mtdStartMs));

    function passesFilter(key) {
      if (filter === 'all') return true;
      return key === filter;
    }
    function passesQuery(...fields) {
      if (!query) return true;
      const q = query.toLowerCase();
      return fields.some(f => f && String(f).toLowerCase().includes(q));
    }

    const filteredLeads = windowedLeadEntries
      .filter(e => passesFilter(e.key))
      .filter(e => passesQuery(e.email, e.c && e.c.n))
      .sort((a, b) => String((b.c && b.c.c) || '').localeCompare(String((a.c && a.c.c) || '')));

    const filteredContracts = windowedContracts
      .filter(l => passesFilter(l.channel || 'other'))
      .filter(l => passesQuery(l.email, l.tenant, l.unitId))
      .sort((a, b) => (b.activatedMs || 0) - (a.activatedMs || 0));

    const overrideCount = Object.keys(overrides).length;
    const tabLabel = tab === 'leads'
      ? `Leads (${filteredLeads.length}` + (filter === 'all' ? ')' : ` of ${windowedLeadEntries.length})`)
      : `Contracts (${filteredContracts.length}` + (filter === 'all' ? ')' : ` of ${windowedContracts.length})`);

    // Cap to avoid mounting 5k+ <select> nodes for huge HubSpot caches
    const LEAD_CAP = 300;
    const visibleLeads = filteredLeads.slice(0, LEAD_CAP);

    return (
      <FormDrawer
        open={open}
        onClose={onClose}
        title={tabLabel}
        width={760}
      >
        {/* Tabs */}
        <div style={{
          display: 'flex', gap: 6, padding: '8px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-2)',
        }}>
          <button
            onClick={() => setTab('leads')}
            style={{
              cursor: 'pointer', padding: '6px 14px', borderRadius: 4,
              border: '1px solid ' + (tab === 'leads' ? 'var(--accent-ink)' : 'transparent'),
              background: tab === 'leads' ? 'var(--surface)' : 'transparent',
              color: tab === 'leads' ? 'var(--ink)' : 'var(--muted)',
              fontSize: 12, fontWeight: tab === 'leads' ? 700 : 500,
            }}
          >
            Leads · {windowedLeadEntries.length}
          </button>
          <button
            onClick={() => setTab('contracts')}
            style={{
              cursor: 'pointer', padding: '6px 14px', borderRadius: 4,
              border: '1px solid ' + (tab === 'contracts' ? 'var(--accent-ink)' : 'transparent'),
              background: tab === 'contracts' ? 'var(--surface)' : 'transparent',
              color: tab === 'contracts' ? 'var(--ink)' : 'var(--muted)',
              fontSize: 12, fontWeight: tab === 'contracts' ? 700 : 500,
            }}
          >
            Contracts · {windowedContracts.length}
          </button>
          <div style={{ flex: 1 }} />
          {overrideCount > 0 && (
            <span
              style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}
              title="Operator-assigned source overrides apply per-browser. Persist across reloads. Pick «— auto —» on a row to clear."
            >
              {overrideCount} override{overrideCount === 1 ? '' : 's'} active
            </span>
          )}
        </div>

        {/* Date window — точно такой же набор как в marketing.jsx SpendSection
            (Today / Yesterday / 7d / 30d / 90d / MTD / Custom). При открытии
            модалки берёт initialWindowKind от родителя. */}
        <div style={{
          display: 'flex', gap: 6, padding: '8px 14px',
          borderBottom: '1px solid var(--border)',
          alignItems: 'center', background: 'var(--surface)',
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontSize: 11, fontWeight: 700, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.04em',
            marginRight: 4,
          }}>Window</span>
          {[['today','Today'],['yesterday','Yesterday'],['7d','7d'],['30d','30d'],['90d','90d'],['mtd','MTD'],['custom','Custom']].map(([k,l]) => (
            <button
              key={k}
              onClick={() => setWindowKind(k)}
              style={{
                cursor: 'pointer', padding: '4px 10px', borderRadius: 4,
                border: '1px solid ' + (windowKind === k ? 'var(--accent-ink)' : 'var(--border)'),
                background: windowKind === k ? 'var(--surface-2)' : 'var(--surface)',
                color: windowKind === k ? 'var(--ink)' : 'var(--muted)',
                fontSize: 11.5, fontWeight: windowKind === k ? 700 : 500,
              }}
            >{l}</button>
          ))}
          {windowKind === 'custom' && (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 4 }}>
              <input
                type="date"
                value={customStart}
                max={customEnd}
                onChange={e => setCustomStart(e.target.value)}
                style={{ padding: '3px 6px', fontSize: 11, borderRadius: 4, border: '1px solid var(--border)' }}
              />
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>→</span>
              <input
                type="date"
                value={customEnd}
                min={customStart}
                onChange={e => setCustomEnd(e.target.value)}
                style={{ padding: '3px 6px', fontSize: 11, borderRadius: 4, border: '1px solid var(--border)' }}
              />
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--muted-2)' }} title={`${windowStart} → ${windowEnd}`}>
            {windowLabel}
          </span>
        </div>

        {showWindowHint && (
          <div style={{
            padding: '6px 14px', fontSize: 11, color: '#854d0e',
            background: 'rgba(250, 204, 21, .12)',
            borderBottom: '1px solid rgba(250, 204, 21, .35)',
          }}>
            ⚠ Contracts snapshot is MTD-only — wider windows show the same set. Activations before <b>{new Date(_mtdStartMs).toISOString().slice(0, 10)}</b> aren't in this view.
          </div>
        )}

        {/* Filter + search */}
        <div style={{
          display: 'flex', gap: 8, padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          alignItems: 'center', background: 'var(--surface)',
        }}>
          <span style={{
            fontSize: 11, fontWeight: 700, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.04em',
          }}>Source</span>
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{
              padding: '5px 8px', fontSize: 12, borderRadius: 4,
              border: '1px solid var(--border)', background: 'var(--surface)',
              cursor: 'pointer', minWidth: 170,
            }}
          >
            <option value="all">All sources ({tab === 'leads' ? windowedLeadEntries.length : windowedContracts.length})</option>
            {SOURCE_OPTIONS.map(o => {
              const n = (tab === 'leads' ? windowedLeadEntries : windowedContracts)
                .filter(x => (x.key || x.channel || 'other') === o.key).length;
              return (
                <option key={o.key} value={o.key} disabled={n === 0}>
                  {o.label} ({n})
                </option>
              );
            })}
          </select>
          <input
            placeholder={tab === 'leads' ? 'Search email or name…' : 'Search tenant, email or suite…'}
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{
              flex: 1, padding: '5px 8px', fontSize: 12, borderRadius: 4,
              border: '1px solid var(--border)', background: 'var(--surface)',
            }}
          />
        </div>

        {/* Column header */}
        {tab === 'leads' ? (
          <div style={{
            display: 'grid', gridTemplateColumns: '1.5fr 110px 110px 150px',
            gap: 10, padding: '8px 14px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
            fontSize: 10.5, fontWeight: 700, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.04em',
          }}>
            <div>Contact</div>
            <div>Stage</div>
            <div>Created</div>
            <div>Source</div>
          </div>
        ) : (
          <div style={{
            display: 'grid', gridTemplateColumns: '1.4fr 90px 80px 110px 130px',
            gap: 10, padding: '8px 14px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
            fontSize: 10.5, fontWeight: 700, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.04em',
          }}>
            <div>Tenant · Suite · Sender</div>
            <div>MRR</div>
            <div>Activated</div>
            <div title="Operator who receives the contract-signed bonus (envelope sender per pulse/bonus-rules.jsx ctr_signed). Fallback = signed-PDF uploader.">Bonus mgr</div>
            <div>Source</div>
          </div>
        )}

        {/* Body */}
        <div>
          {tab === 'leads' ? (
            visibleLeads.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                No leads match the current filter.
              </div>
            ) : (
              visibleLeads.map(e => (
                <LeadRow
                  key={e.email}
                  email={e.email}
                  contact={e.c}
                  currentKey={e.key}
                  overrideKey={overrides[e.email]}
                  onSetOverride={setOverride}
                />
              ))
            )
          ) : (
            filteredContracts.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                No contracts match the current filter.
              </div>
            ) : (
              filteredContracts.map((l, i) => (
                <ContractRow
                  key={(l.buildingId || 'b') + ':' + l.unitId + ':' + i}
                  lease={l}
                  currentKey={l.channel || 'other'}
                  overrideKey={overrides[(l.email || '').toLowerCase().trim()]}
                  onSetOverride={setOverride}
                />
              ))
            )
          )}
        </div>

        {tab === 'leads' && filteredLeads.length > LEAD_CAP && (
          <div style={{
            padding: '8px 14px', textAlign: 'center', fontSize: 11,
            color: 'var(--muted)', borderTop: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            Showing first {LEAD_CAP} of {filteredLeads.length} — use search or filter to narrow.
          </div>
        )}

        {/* Help footer */}
        <div style={{
          padding: '10px 14px', fontSize: 11, color: 'var(--muted)',
          background: 'var(--surface-2)', borderTop: '1px solid var(--border)',
        }}>
          <b>How edits work:</b> picking a source overrides HubSpot's attribution for that
          email. Override persists per-browser and instantly re-buckets the Marketing
          table + contracts. Pick «— auto —» to revert. Contracts without an email
          can't be re-attributed — add an email to the tenant on the floor map first.
        </div>
      </FormDrawer>
    );
  };
})();
