/* global React, Icon */

/* ===================================================================
   Connections — unified integrations dashboard (Tony 2026-05-24)

   Single page for managing ALL external integrations:
     • HubSpot CRM       (contacts, deals, meetings)
     • Google Ads        (spend via Scripts hook)
     • Meta Ads (FB/IG)  (multi-account spend via Graph API)
     • TikTok Ads        (not yet connected)
     • Google Analytics 4 (not yet connected)

   Each section shows: connection status, last sync timestamp, accounts
   discovered (where applicable), inline settings, and action buttons
   (sync now, manage credentials docs, etc.).

   Reads:
     window._hsDataCache   — populated by data-shim (hubspotGetData)
     window._mkDataCache   — populated by data-shim (marketingGetData)

   Writes:
     hubspotSyncNow (CF)     — admin only, manual sync trigger
     metaAdsSyncNow (CF)     — admin only, manual sync trigger
     metaSettingsSet (CF)    — admin only, save per-account enable + notes
   =================================================================== */

window.ConnectionsPage = function ConnectionsPage() {
  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1 className="title">Connections</h1>
          <div className="subtitle">
            <span>All external integrations in one place. Add/manage CRM, ad platforms, and analytics.</span>
          </div>
        </div>
      </div>

      <HubSpotConnection />
      <GoogleAdsConnection />
      <MetaConnection />
      <TikTokConnection />
      <GA4Connection />
    </div>
  );
};

/* ===== Reusable card chrome ===== */
function ConnectionCard({ icon, name, color, status, statusLabel, hint, children, actions }) {
  const statusStyles = {
    'connected':     { bg: 'rgba(34,197,94,.12)', fg: '#166534', label: statusLabel || '🟢 Connected' },
    'stale':         { bg: 'rgba(245,158,11,.12)', fg: '#92400e', label: statusLabel || '🟡 Stale' },
    'pending':       { bg: 'rgba(245,158,11,.12)', fg: '#92400e', label: statusLabel || '🟡 Pending' },
    'not-connected': { bg: 'var(--surface-2)', fg: 'var(--muted)', label: statusLabel || '⚪ Not configured' },
    'error':         { bg: 'rgba(239,68,68,.12)', fg: '#991b1b', label: statusLabel || '🔴 Error' },
  };
  const s = statusStyles[status] || statusStyles['not-connected'];
  return (
    <div className="card is-clean" style={{ marginBottom: 16, padding: 0, overflow: 'hidden', borderLeft: `3px solid ${color || '#94a3b8'}` }}>
      <div style={{ padding: '14px 16px', borderBottom: children ? '1px solid var(--border)' : 'none' }}>
        <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 22 }}>{icon}</span>
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{name}</div>
            {hint && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{hint}</div>}
          </div>
          <span style={{
            padding: '4px 12px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
            background: s.bg, color: s.fg, whiteSpace: 'nowrap',
          }}>{s.label}</span>
          {actions && <div style={{ display: 'flex', gap: 6 }}>{actions}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

function ActionBtn({ children, onClick, primary, disabled, href, target }) {
  const style = {
    padding: '6px 12px', fontSize: 12, fontWeight: 600,
    border: primary ? 'none' : '1px solid var(--border)',
    borderRadius: 5, cursor: disabled ? 'wait' : 'pointer',
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? 'white' : 'var(--ink-2)',
    textDecoration: 'none', whiteSpace: 'nowrap',
    opacity: disabled ? 0.5 : 1,
    display: 'inline-flex', alignItems: 'center', gap: 4,
  };
  if (href) {
    return <a href={href} target={target || '_blank'} rel="noopener" style={style}>{children}</a>;
  }
  return <button onClick={onClick} disabled={disabled} style={style}>{children}</button>;
}

/* ===== Helpers ===== */
function formatAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const ago = Math.floor((Date.now() - d.getTime()) / 60000);
  if (ago < 1) return 'just now';
  if (ago < 60) return ago + 'm ago';
  if (ago < 1440) return Math.floor(ago / 60) + 'h ago';
  return Math.floor(ago / 1440) + 'd ago';
}
function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
async function _callAdmin(name, args, setMsg) {
  if (typeof window._pulseCallable !== 'function') {
    setMsg({ kind: 'err', text: 'Firebase bridge not ready' });
    return null;
  }
  try {
    const r = await window._pulseCallable(name, args || {});
    return r?.data;
  } catch (e) {
    const m = String(e?.message || e || '');
    if (/permission-denied|Root admin/.test(m)) {
      setMsg({ kind: 'err', text: `Permission denied. Open Floor map → console: await window.stripeCallable('${name}')(${JSON.stringify(args || {})})` });
    } else {
      setMsg({ kind: 'err', text: 'Failed: ' + m.slice(0, 200) });
    }
    return null;
  }
}

/* ============================================================
   HubSpot
   ============================================================ */
function HubSpotConnection() {
  const hs = window._hsDataCache;
  const counts = hs?.counts;
  const syncedAt = hs?.syncedAt;
  const ago = syncedAt ? Math.floor((Date.now() - new Date(syncedAt).getTime()) / 60000) : null;
  const status = !hs ? 'not-connected' : (ago < 90 ? 'connected' : 'stale');
  const [syncing, setSyncing] = React.useState(false);
  const [msg, setMsg] = React.useState(null);

  async function syncNow() {
    setSyncing(true);
    setMsg(null);
    const data = await _callAdmin('hubspotSyncNow', { fullSync: true }, setMsg);
    setSyncing(false);
    if (data) {
      setMsg({ kind: 'ok', text: 'Synced: ' + JSON.stringify(data.counts || {}) + '. Reload to see new data.' });
      try { localStorage.removeItem('sfa_hubspot_data_v1'); } catch (e) {}
    }
  }

  return (
    <ConnectionCard
      icon="🎯"
      color="#ff7a59"
      name="HubSpot CRM"
      hint="Contacts, deals, meetings, lead source attribution"
      status={status}
      actions={[
        <ActionBtn key="docs" href="https://developers.hubspot.com/docs/api/private-apps">Docs ↗</ActionBtn>,
        <ActionBtn key="sync" onClick={syncNow} disabled={syncing} primary>{syncing ? 'Syncing…' : 'Sync now'}</ActionBtn>,
      ]}
    >
      {hs && (
        <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14, fontSize: 12, background: 'var(--surface-2)' }}>
          <StatBlock label="Contacts" value={counts?.contacts?.toLocaleString() || '—'} />
          <StatBlock label="Deals" value={counts?.deals?.toLocaleString() || '—'} />
          <StatBlock label="Meetings" value={counts?.meetings?.toLocaleString() || '—'} />
          <StatBlock label="Owners" value={counts?.owners?.toLocaleString() || '—'} />
          <StatBlock label="Pipelines" value={counts?.pipelines?.toLocaleString() || '—'} />
          <StatBlock label="Last sync" value={formatAgo(syncedAt)} sub={formatDateTime(syncedAt)} />
        </div>
      )}
      {!hs && (
        <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--muted)' }}>
          No HubSpot data cached. If this persists, check that the HUBSPOT_TOKEN secret is set in Firebase Secret Manager and trigger «Sync now» (admin only).
        </div>
      )}
      <div style={{ padding: '10px 16px', fontSize: 11, color: 'var(--muted)', background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
        🔐 Token: Firebase Secret Manager (<code>HUBSPOT_TOKEN</code>) · Type: Service Key (Beta) · Expires: <strong>Never</strong>
      </div>
      {msg && <SaveMsg msg={msg} />}
    </ConnectionCard>
  );
}

/* ============================================================
   Google Ads
   ============================================================ */
function GoogleAdsConnection() {
  const mk = window._mkDataCache;
  const src = mk?.sources?.['google-ads'];
  const ago = src?.ingestedAt ? Math.floor((Date.now() - new Date(src.ingestedAt).getTime()) / 60000) : null;
  const status = !src ? 'not-connected' : (ago < 120 ? 'connected' : 'stale');
  return (
    <ConnectionCard
      icon="🟦"
      color="#4285f4"
      name="Google Ads"
      hint="Spend / clicks / impressions via Google Ads Scripts (server-side, hourly)"
      status={status}
      actions={[
        <ActionBtn key="scripts" href="https://ads.google.com/aw/bulk/scripts">Open Ads Scripts ↗</ActionBtn>,
      ]}
    >
      {src && (
        <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14, fontSize: 12, background: 'var(--surface-2)' }}>
          <StatBlock label="Account ID" value={src.accountId || '—'} mono />
          <StatBlock label="Campaigns" value={src.campaignCount?.toLocaleString() || '—'} />
          <StatBlock label="Daily rows" value={src.dailyRowCount?.toLocaleString() || '—'} />
          <StatBlock label="Total spend (90d)" value={'$' + (src.totals?.cost?.toFixed(0) || 0)} />
          <StatBlock label="Last sync" value={formatAgo(src.ingestedAt)} sub={formatDateTime(src.ingestedAt)} />
        </div>
      )}
      {!src && (
        <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--muted)' }}>
          Google Ads not connected yet. Paste <code>scripts/google-ads-script.js</code> into your Google Ads account → Tools → Scripts → set hourly schedule. See repo for full instructions.
        </div>
      )}
      <div style={{ padding: '10px 16px', fontSize: 11, color: 'var(--muted)', background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
        🔐 Auth: Shared secret in script + Firebase Secret Manager (<code>MARKETING_INGEST_SECRET</code>) · Per-script auth in Google Ads UI (read-only campaign reports) · No Developer Token required.
        <div style={{ marginTop: 4 }}>
          📥 Endpoint: <code>https://us-central1-suitesforall.cloudfunctions.net/marketingIngest</code> (POST, X-Shared-Secret header)
        </div>
      </div>
    </ConnectionCard>
  );
}

/* ============================================================
   Meta Ads (FB/IG) — multi-account with per-account toggle + notes
   ============================================================ */
function MetaConnection() {
  const mk = window._mkDataCache;
  const src = mk?.sources?.meta;
  const discovered = mk?.metaDiscoveredAccounts || [];
  const settings = mk?.settings || {};
  const ago = src?.ingestedAt ? Math.floor((Date.now() - new Date(src.ingestedAt).getTime()) / 60000) : null;
  const status = !src ? 'not-connected' : (ago < 120 ? 'connected' : 'stale');
  const [syncing, setSyncing] = React.useState(false);
  const [msg, setMsg] = React.useState(null);

  async function syncNow() {
    setSyncing(true);
    setMsg(null);
    const data = await _callAdmin('metaAdsSyncNow', {}, setMsg);
    setSyncing(false);
    if (data) {
      setMsg({ kind: 'ok', text: `Synced ${data.counts?.accounts} accounts, $${(data.counts?.totalCost || 0).toFixed(2)} spend, ${data.counts?.dailyRows} daily rows. Reload to see.` });
      try { localStorage.removeItem('sfa_marketing_data_v1'); } catch (e) {}
    }
  }

  return (
    <ConnectionCard
      icon="🟪"
      color="#7c3aed"
      name="Meta Ads (FB / IG)"
      hint="Multi-account Marketing API · spend per account · auto-discovers all ad accounts under your Business"
      status={status}
      statusLabel={status === 'connected' ? `🟢 Connected · ${src?.accountCount || 0} accounts` : null}
      actions={[
        <ActionBtn key="bm" href="https://business.facebook.com/settings">Business Manager ↗</ActionBtn>,
        <ActionBtn key="sync" onClick={syncNow} disabled={syncing} primary>{syncing ? 'Syncing…' : 'Sync now'}</ActionBtn>,
      ]}
    >
      {src && (
        <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14, fontSize: 12, background: 'var(--surface-2)' }}>
          <StatBlock label="Discovered" value={discovered.length} />
          <StatBlock label="Enabled" value={src.accountCount || discovered.length} />
          <StatBlock label="Daily rows" value={src.dailyRowCount?.toLocaleString() || '—'} />
          <StatBlock label="Total spend (90d)" value={'$' + (src.totals?.cost?.toFixed(0) || 0)} />
          <StatBlock label="Total clicks" value={src.totals?.clicks?.toLocaleString() || '—'} />
          <StatBlock label="Last sync" value={formatAgo(src.ingestedAt)} sub={formatDateTime(src.ingestedAt)} />
        </div>
      )}
      {!src && (
        <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--muted)' }}>
          Meta not yet synced. Set <code>META_ACCESS_TOKEN</code> in Firebase Secret Manager, then trigger «Sync now». Token instructions: <a href="https://developers.facebook.com/tools/explorer" target="_blank" rel="noopener" style={{ color: 'var(--accent-ink)' }}>Graph API Explorer ↗</a>
        </div>
      )}
      {discovered.length > 0 && (
        <MetaAccountList
          discovered={discovered}
          initialEnabled={Array.isArray(settings.metaAdAccountIds) ? new Set(settings.metaAdAccountIds.map(String)) : null}
          initialNotes={settings.metaAccountNotes || {}}
        />
      )}
      <div style={{ padding: '10px 16px', fontSize: 11, color: 'var(--muted)', background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
        🔐 Token: Firebase Secret Manager (<code>META_ACCESS_TOKEN</code>) · Type: User Access Token · Scopes: ads_read, business_management
      </div>
      {msg && <SaveMsg msg={msg} />}
    </ConnectionCard>
  );
}

function MetaAccountList({ discovered, initialEnabled, initialNotes }) {
  const [enabled, setEnabled] = React.useState(initialEnabled);
  const [notes, setNotes] = React.useState(initialNotes);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState(null);

  // 2026-05-24 — per-account synced-spend lookup. The CF stores
  // accountsJson[].totals.cost per account; if the row is missing or
  // cost==0, that's the diagnostic signal for «sync didn't pull this
  // account» (most common cause: restricted-status accounts, where the
  // OLD pre-2026-05-24 sync skipped the insights call entirely).
  const mk = window._mkDataCache;
  const syncedAccounts = (mk?.sources?.meta?.accounts) || [];
  const syncedById = {};
  for (const a of syncedAccounts) syncedById[String(a.id)] = a;

  function isEnabled(id) {
    if (!enabled) return true; // null = all enabled by default
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
    setSaving(true);
    setMsg(null);
    const ids = enabled ? Array.from(enabled) : discovered.map(a => String(a.id));
    const data = await _callAdmin('metaSettingsSet', { metaAdAccountIds: ids, metaAccountNotes: notes }, setMsg);
    setSaving(false);
    if (data) {
      setMsg({ kind: 'ok', text: 'Saved · ' + ids.length + ' accounts enabled. Next hourly sync (or click Sync now) will use new filter.' });
    }
  }

  return (
    <div style={{ padding: '12px 16px', background: 'white' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
        Ad accounts ({discovered.length} discovered)
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '30px 1.4fr 70px 100px 90px 1.5fr', gap: 8, padding: '8px 10px', background: 'var(--surface-2)', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
          <div></div>
          <div>Account</div>
          <div>Currency</div>
          <div>Status</div>
          <div title="Spend pulled from the last sync (90-day window). $0 means the sync couldn't read insights — usually because the account is restricted and Cloud Functions need redeploy.">Synced 90d</div>
          <div>Note (your label — e.g. «Tampa office · Sallyann»)</div>
        </div>
        {discovered.map(a => {
          const on = isEnabled(a.id);
          const synced = syncedById[String(a.id)];
          const syncedCost = synced?.totals?.cost || 0;
          const syncedRows = (synced?.daily || []).length;
          const syncErr = synced?.error;
          return (
            <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '30px 1.4fr 70px 100px 90px 1.5fr', gap: 8, padding: '8px 10px', borderTop: '1px solid var(--border)', alignItems: 'center', fontSize: 12, background: on ? 'white' : 'var(--surface-2)', opacity: on ? 1 : 0.65 }}>
              <input type="checkbox" checked={on} onChange={() => toggle(a.id)} style={{ cursor: 'pointer' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{a.name}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                  {a.id}
                  {a.businessName && <span style={{ marginLeft: 6 }}>· {a.businessName}</span>}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{a.currency}</div>
              <div>
                <span style={{
                  padding: '2px 7px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                  background: a.isRestricted ? 'rgba(239,68,68,.10)' : 'rgba(34,197,94,.10)',
                  color: a.isRestricted ? '#9a3412' : '#166534',
                }} title={a.disableReason || ''}>
                  {a.isRestricted ? '⚠ ' + a.statusDesc : '🟢 ' + a.statusDesc}
                </span>
              </div>
              <div title={syncErr ? ('Sync error: ' + syncErr) : (syncedRows + ' daily rows pulled')} style={{ fontSize: 11.5, fontWeight: 600, color: syncedCost > 0 ? '#166534' : (syncErr ? '#dc2626' : 'var(--muted)') }}>
                {syncedCost > 0 ? '$' + syncedCost.toFixed(2) : (syncErr ? '⚠ error' : '$0')}
                {syncedRows === 0 && !syncErr && (
                  <span style={{ display: 'block', fontSize: 9, fontWeight: 400, color: '#9a3412' }} title="No daily rows pulled — CF may need redeploy">no rows</span>
                )}
              </div>
              <input
                type="text"
                placeholder="add note (which manager / which office)"
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
      {/* Diagnostic banner — if EVERY discovered account shows $0 synced
          spend, Cloud Functions is running the old code that skipped
          restricted accounts (fix committed 2026-05-24, needs functions
          redeploy). Shows total expected vs total synced if any mismatch. */}
      {(() => {
        const totalSynced = syncedAccounts.reduce((s, a) => s + (a.totals?.cost || 0), 0);
        const accountsWithData = syncedAccounts.filter(a => (a.totals?.cost || 0) > 0).length;
        const hasZeroAll = syncedAccounts.length > 0 && accountsWithData === 0;
        const hasPartial = syncedAccounts.length > 0 && accountsWithData < syncedAccounts.length;
        if (hasZeroAll || hasPartial) {
          return (
            <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.3)', borderRadius: 6, fontSize: 11.5, color: '#92400e' }}>
              ⚠ <b>Sync gap detected:</b> {accountsWithData}/{syncedAccounts.length} accounts returned data ($&nbsp;{totalSynced.toFixed(2)} total).
              {hasZeroAll && <> All accounts show $0 — the deployed Cloud Function may still be the pre-2026-05-24 version that skipped restricted accounts. The fix is committed but Cloud Functions need a redeploy (requires Tony's approval per CLAUDE.md).</>}
              {hasPartial && !hasZeroAll && <> Accounts showing $0 are either restricted (token can't read insights) or simply have no spend in the last 90 days.</>}
            </div>
          );
        }
        return null;
      })()}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <ActionBtn onClick={save} disabled={saving} primary>{saving ? 'Saving…' : 'Save account settings'}</ActionBtn>
        <ActionBtn onClick={() => { setEnabled(null); }}>Enable all</ActionBtn>
        {msg && <SaveMsg msg={msg} inline />}
      </div>
    </div>
  );
}

/* ============================================================
   TikTok Ads (placeholder)
   ============================================================ */
function TikTokConnection() {
  return (
    <ConnectionCard
      icon="⬛"
      color="#000000"
      name="TikTok Ads"
      hint="TikTok Business API · spend + lead-form conversions"
      status="not-connected"
      actions={[
        <ActionBtn key="docs" href="https://business-api.tiktok.com/portal/docs">Docs ↗</ActionBtn>,
      ]}
    >
      <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--muted)' }}>
        Not yet integrated. Architecture ready — pattern matches Meta (OAuth token + scheduled CF + per-account discovery). Same <code>/marketingIngest</code> endpoint with <code>source: "tiktok"</code>. Ping engineering when you want this added.
      </div>
    </ConnectionCard>
  );
}

/* ============================================================
   Google Analytics 4 (placeholder)
   ============================================================ */
function GA4Connection() {
  return (
    <ConnectionCard
      icon="🟧"
      color="#f97316"
      name="Google Analytics 4"
      hint="Site analytics for suitesforall.com · page views, form submissions, source/medium"
      status="not-connected"
      actions={[
        <ActionBtn key="docs" href="https://developers.google.com/analytics/devguides/reporting/data/v1">Docs ↗</ActionBtn>,
      ]}
    >
      <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--muted)' }}>
        Not yet integrated. Requires GA4 Property ID + Service Account JSON. Optional — complements Meta/Google Ads with site-side funnel data (form fill rate, bounce, etc.).
      </div>
    </ConnectionCard>
  );
}

/* ===== Reusable atoms ===== */
function StatBlock({ label, value, sub, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: mono ? 'var(--font-mono)' : 'inherit' }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}
function SaveMsg({ msg, inline }) {
  const color = msg.kind === 'ok' ? 'var(--success-ink)' : 'var(--danger-ink)';
  if (inline) {
    return <span style={{ fontSize: 11.5, color }}>{msg.text}</span>;
  }
  return (
    <div style={{ padding: '8px 16px', fontSize: 11.5, color, background: msg.kind === 'ok' ? 'rgba(34,197,94,.06)' : 'rgba(239,68,68,.06)', borderTop: '1px solid var(--border)' }}>
      {msg.text}
    </div>
  );
}
