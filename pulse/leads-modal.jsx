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
    // Делегируем единой публичной функции в data-shim, чтобы tag
    // mapping (settings → Source rules) применился и здесь. Fallback
    // на локальную auto-classify только если по какой-то причине
    // data-shim не загрузился.
    if (typeof window._classifyContactChannel === 'function') {
      return window._classifyContactChannel(c);
    }
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

  function BonusManagerPicker({ lease, employees, onSetBonusOverride }) {
    // Текущее значение — е-mail recipient (override или auto). Селект
    // показывает employees + опцию "— auto —" (clear). При onChange
    // вызываем onSetBonusOverride(leaseKey, email|null).
    const currentEmail = (lease.bonusManagerEmail || '').toLowerCase();
    const isOverridden = !!lease.bonusOverridden;
    const handleChange = (v) => {
      onSetBonusOverride(lease.leaseKey, v || null);
    };
    return (
      <select
        value={isOverridden ? currentEmail : ''}
        onChange={e => handleChange(e.target.value)}
        title={isOverridden
          ? 'Admin override — auto-detected was: ' + (lease.bonusAutoEmail || '(none)')
          : 'Auto-detected from envelope sender / PDF uploader. Pick a name to override.'}
        style={{
          padding: '4px 6px', fontSize: 11, borderRadius: 4,
          border: '1px solid ' + (isOverridden ? 'var(--accent-ink)' : 'var(--border)'),
          background: isOverridden ? 'var(--accent-soft, #eef2ff)' : 'var(--surface)',
          color: 'var(--ink)', cursor: 'pointer',
          width: '100%',
          fontWeight: isOverridden ? 700 : 400,
        }}
      >
        <option value="">— auto —{lease.bonusManager && !isOverridden ? ' (' + lease.bonusManager + ')' : ''}</option>
        {employees.map(e => (
          <option key={e.email} value={e.email}>{e.fullName || e.email}</option>
        ))}
      </select>
    );
  }

  function ContractRow({ lease, currentKey, overrideKey, onSetOverride, employees, onSetBonusOverride }) {
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
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1.3fr 85px 70px 140px 130px',
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
        <div>
          <BonusManagerPicker
            lease={lease}
            employees={employees}
            onSetBonusOverride={onSetBonusOverride}
          />
          {lease.bonusOverridden && (
            <div style={{ fontSize: 9.5, color: 'var(--accent-ink)', marginTop: 2 }}>
              admin-assigned
            </div>
          )}
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
      window.addEventListener('pulseBonusOverridesChanged', onChange);
      window.addEventListener('pulseTagMappingsChanged', onChange);
      return () => {
        window.removeEventListener('pulseSourceOverridesChanged', onChange);
        window.removeEventListener('pulseBonusOverridesChanged', onChange);
        window.removeEventListener('pulseTagMappingsChanged', onChange);
      };
    }, []);

    // Employees list для picker — читаем напрямую из sfa_v5_state,
    // чтобы не зависеть от DATA.USERS (последний может скрывать людей
    // у которых trackInPulse=false, а для bonus reassignment админу
    // нужен полный список). Sorted by fullName для UX.
    const employeesForPicker = React.useMemo(() => {
      try {
        const raw = localStorage.getItem('sfa_v5_state');
        if (!raw) return [];
        const st = JSON.parse(raw);
        const list = Array.isArray(st && st.employees) ? st.employees : [];
        return list
          .filter(e => e && e.email)
          .map(e => ({ email: String(e.email).toLowerCase().trim(), fullName: e.fullName || e.email }))
          .sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
      } catch (e) { return []; }
    }, [open]);

    function setBonusOverride(leaseKey, employeeEmail) {
      if (typeof window.setPulseBonusOverride !== 'function') return;
      window.setPulseBonusOverride(leaseKey, employeeEmail);
      if (window.toast) {
        if (employeeEmail) {
          const emp = employeesForPicker.find(e => e.email === String(employeeEmail).toLowerCase());
          const lbl = emp ? (emp.fullName || emp.email) : employeeEmail;
          window.toast('Bonus → ' + lbl, 'success');
        } else {
          window.toast('Bonus reset to auto-detect', 'success');
        }
      }
    }
    function clearAllBonusOverrides() {
      if (typeof window.clearAllPulseBonusOverrides !== 'function') return;
      window.clearAllPulseBonusOverrides();
      if (window.toast) window.toast('All bonus overrides cleared', 'success');
    }
    const bonusOverrides = (typeof window.getPulseBonusOverrides === 'function')
      ? window.getPulseBonusOverrides() : {};
    const bonusOverrideCount = Object.keys(bonusOverrides).length;

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
    // 2026-05-27 — основной источник contactById (включает no-email лидов
    // из SOCIAL/Messenger); fallback на contactByEmail для cached docs
    // со старой схемой v2. Email достаём из c.e (новое поле).
    const hsCache = window._hsDataCache || {};
    const contactMap = hsCache.contactById || hsCache.contactByEmail || {};
    const leadEntries = Object.values(contactMap).map(c => ({
      email: c.e || '', c, key: _channelKeyForContact(c),
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
          {(overrideCount > 0 || bonusOverrideCount > 0) && (
            <span
              style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center', display: 'inline-flex', gap: 10 }}
              title="Operator-assigned overrides apply per-browser. Persist across reloads."
            >
              {overrideCount > 0 && (
                <span title="Source overrides — pick «— auto —» on a row to clear.">
                  {overrideCount} source override{overrideCount === 1 ? '' : 's'}
                </span>
              )}
              {bonusOverrideCount > 0 && (
                <span style={{ color: 'var(--accent-ink)' }} title="Bonus manager overrides — manage in footer panel.">
                  {bonusOverrideCount} bonus override{bonusOverrideCount === 1 ? '' : 's'}
                </span>
              )}
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
            display: 'grid', gridTemplateColumns: '1.3fr 85px 70px 140px 130px',
            gap: 10, padding: '8px 14px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
            fontSize: 10.5, fontWeight: 700, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.04em',
          }}>
            <div>Tenant · Suite · Sender</div>
            <div>MRR</div>
            <div>Activated</div>
            <div title="Operator who receives the contract-signed bonus. Auto = envelope sender (per pulse/bonus-rules.jsx ctr_signed) → signed-PDF uploader fallback. Admin can pick a name to override.">Bonus mgr</div>
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
                  employees={employeesForPicker}
                  onSetBonusOverride={setBonusOverride}
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

        {/* Manage bonus assignments — отдельная панель для админа.
            Показываем когда есть хоть один override + кнопка clear-all.
            Каждый override — строка с lease/employee + remove-button.
            Сюда «вынесены» bonus settings per Tony 2026-05-26. */}
        {tab === 'contracts' && bonusOverrideCount > 0 && (
          <BonusOverridesPanel
            overrides={bonusOverrides}
            allLeases={allLeases}
            employees={employeesForPicker}
            onClear={(leaseKey) => setBonusOverride(leaseKey, null)}
            onClearAll={clearAllBonusOverrides}
          />
        )}

        {/* Help footer */}
        <div style={{
          padding: '10px 14px', fontSize: 11, color: 'var(--muted)',
          background: 'var(--surface-2)', borderTop: '1px solid var(--border)',
        }}>
          <b>How edits work:</b> picking a source overrides HubSpot's attribution for that
          email. Picking a Bonus mgr overrides the auto-detected envelope-sender for that
          contract (per <code>pulse/bonus-rules.jsx</code> <code>ctr_signed</code>).
          Overrides persist per-browser and instantly re-bucket the Marketing
          table + contracts + Bonuses leaderboard. Pick «— auto —» on a row to revert,
          or use the panel above to clear all bonus overrides at once.
        </div>
      </FormDrawer>
    );
  };

  // ----------------------------------------------------------------------
  // BonusOverridesPanel — collapsible list всех active bonus overrides
  // с remove-кнопкой на каждой строке и "Clear all" в шапке.
  // Рендерится только когда есть хоть один override (sentinel в App).
  // ----------------------------------------------------------------------
  function BonusOverridesPanel({ overrides, allLeases, employees, onClear, onClearAll }) {
    const [collapsed, setCollapsed] = React.useState(false);
    const leaseByKey = React.useMemo(() => {
      const m = new Map();
      for (const l of (allLeases || [])) {
        if (l && l.leaseKey) m.set(l.leaseKey, l);
      }
      return m;
    }, [allLeases]);
    const empByEmail = React.useMemo(() => {
      const m = new Map();
      for (const e of (employees || [])) m.set(e.email, e);
      return m;
    }, [employees]);
    const rows = Object.entries(overrides).map(([leaseKey, email]) => {
      const lease = leaseByKey.get(leaseKey);
      const emp = empByEmail.get(String(email || '').toLowerCase());
      return {
        leaseKey,
        email: String(email || '').toLowerCase(),
        empName: emp ? (emp.fullName || emp.email) : email,
        tenant: lease ? lease.tenant : '(lease not in current MTD window)',
        unitId: lease ? lease.unitId : leaseKey.split(':')[1] || '',
        autoEmail: lease ? lease.bonusAutoEmail : '',
        inWindow: !!lease,
      };
    }).sort((a, b) => (a.tenant || '').localeCompare(b.tenant || ''));

    return (
      <div style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--accent-soft, #eef2ff)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px',
          borderBottom: collapsed ? 'none' : '1px solid var(--border)',
          background: 'rgba(99, 102, 241, .08)',
        }}>
          <button
            onClick={() => setCollapsed(c => !c)}
            style={{
              cursor: 'pointer', padding: '2px 8px', borderRadius: 4,
              border: '1px solid var(--border)', background: 'var(--surface)',
              fontSize: 11, color: 'var(--ink)',
            }}
            title={collapsed ? 'Expand panel' : 'Collapse panel'}
          >{collapsed ? '▸' : '▾'}</button>
          <b style={{ fontSize: 11.5, color: 'var(--ink)' }}>
            Manage bonus assignments
          </b>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            · {rows.length} active override{rows.length === 1 ? '' : 's'}
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClearAll}
            style={{
              cursor: 'pointer', padding: '3px 10px', borderRadius: 4,
              border: '1px solid var(--danger-border, #fca5a5)',
              background: 'var(--danger-soft, #fef2f2)',
              fontSize: 11, fontWeight: 600, color: 'var(--danger-ink, #b91c1c)',
            }}
            title="Reset every contract back to auto-detected envelope sender."
          >Clear all</button>
        </div>
        {!collapsed && (
          <div>
            <div style={{
              display: 'grid', gridTemplateColumns: '1.4fr 1.3fr 1fr 70px',
              gap: 8, padding: '6px 14px',
              borderBottom: '1px solid var(--border)',
              fontSize: 10, fontWeight: 700, color: 'var(--muted)',
              textTransform: 'uppercase', letterSpacing: '.04em',
              background: 'var(--surface-2)',
            }}>
              <div>Contract</div>
              <div>Assigned to</div>
              <div>Was (auto)</div>
              <div></div>
            </div>
            {rows.map(r => (
              <div key={r.leaseKey} style={{
                display: 'grid', gridTemplateColumns: '1.4fr 1.3fr 1fr 70px',
                gap: 8, padding: '7px 14px',
                borderBottom: '1px solid var(--border)',
                alignItems: 'center', fontSize: 12,
              }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: 600 }}>{r.tenant}</span>
                  <span style={{ color: 'var(--muted)', marginLeft: 6 }}>· Suite {r.unitId}</span>
                  {!r.inWindow && (
                    <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--muted-2)', fontStyle: 'italic' }}>
                      (outside current window)
                    </span>
                  )}
                </div>
                <div style={{ fontWeight: 600, color: 'var(--accent-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.empName}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.autoEmail || <span style={{ fontStyle: 'italic' }}>(none)</span>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <button
                    onClick={() => onClear(r.leaseKey)}
                    style={{
                      cursor: 'pointer', padding: '3px 8px', borderRadius: 4,
                      border: '1px solid var(--border)', background: 'var(--surface)',
                      fontSize: 11, color: 'var(--muted)',
                    }}
                    title="Reset this contract back to auto-detected envelope sender."
                  >Reset</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
})();
