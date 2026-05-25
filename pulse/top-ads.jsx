/* global React, Icon */

/* ===================================================================
   Pulse — Top Ads page (Phase 2 marketing — cross-platform ad detail)

   Surfaces the heaviest-spending ads across TikTok, Meta, and Google in
   a sortable grid. Click any ad → detail modal with inline video preview,
   full creative text, daily spend chart, and a deep-link to the platform
   account where it lives.

   Data source — Firestore subcollection workspaces/default/marketing_ads,
   one doc per ad keyed by `<platform>_<externalId>`. Populated by per-
   platform ad-level Cloud Functions (see functions/marketing-ads-shared.js
   for the unified UnifiedAd shape).

   Reads via the marketingAdsList callable (sorted server-side by
   totals.spend desc, cursor-paginated). Detail reads via marketingAdGet.
   =================================================================== */

const PLATFORM_LABELS = {
  tiktok: 'TikTok',
  meta: 'Meta (FB / IG)',
  google: 'Google Ads',
};
const PLATFORM_TINT = {
  tiktok: '#ff0050',
  meta: '#1877f2',
  google: '#34a853',
};
const STATUS_TINT = {
  ACTIVE: 'green', ENABLED: 'green',
  PAUSED: 'amber',
  DISABLED: 'gray', REJECTED: 'red', DELETED: 'gray',
  PENDING_REVIEW: 'amber', PENDING: 'amber',
};

function fmtMoney(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}
function fmtPct(n) {
  return (Number(n) || 0).toFixed(2) + '%';
}
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) { return String(iso).slice(0, 10); }
}

// Tiny inline sparkline for the daily spend trend. Pure SVG, no deps.
function Sparkline({ daily, height = 32, color = '#6366f1' }) {
  const vals = (daily || []).map(d => Number(d.spend) || 0);
  if (vals.length < 2) return <div style={{ height, opacity: 0.4, fontSize: 10 }}>no trend</div>;
  const max = Math.max(...vals, 0.01);
  const w = 120;
  const stepX = w / (vals.length - 1);
  const pts = vals.map((v, i) => `${i * stepX},${height - (v / max) * height}`).join(' ');
  return (
    <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      <polygon points={`0,${height} ${pts} ${w},${height}`} fill={color} fillOpacity="0.12" />
    </svg>
  );
}

function StatusBadge({ status }) {
  const tint = STATUS_TINT[String(status || '').toUpperCase()] || 'gray';
  const map = {
    green: { bg: '#dcfce7', fg: '#166534' },
    amber: { bg: '#fef3c7', fg: '#92400e' },
    red:   { bg: '#fee2e2', fg: '#991b1b' },
    gray:  { bg: '#f1f5f9', fg: '#475569' },
  }[tint];
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
      background: map.bg, color: map.fg, textTransform: 'uppercase', letterSpacing: 0.2,
    }}>{status || 'UNKNOWN'}</span>
  );
}

function PlatformBadge({ platform }) {
  const label = PLATFORM_LABELS[platform] || platform;
  const tint = PLATFORM_TINT[platform] || '#64748b';
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
      background: tint + '15', color: tint, letterSpacing: 0.2,
    }}>{label}</span>
  );
}

// Thumbnail / poster — handles VIDEO posterUrl, IMAGE imageUrl, CAROUSEL
// first image, with a graceful fallback tile when nothing is available.
function CreativeThumb({ creative, height = 200 }) {
  const c = creative || {};
  const src = c.posterUrl || c.imageUrl || (Array.isArray(c.imageUrls) ? c.imageUrls[0] : null);
  const isVideo = c.type === 'VIDEO';
  if (!src) {
    return (
      <div style={{
        height, background: '#f1f5f9', display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: '#94a3b8', fontSize: 11, fontWeight: 700,
        letterSpacing: 0.5, textTransform: 'uppercase',
      }}>
        {c.type || 'NO CREATIVE'}
      </div>
    );
  }
  return (
    <div style={{
      position: 'relative', height, background: '#000',
      backgroundImage: `url("${src}")`, backgroundSize: 'cover',
      backgroundPosition: 'center', backgroundColor: '#0f172a',
    }}>
      {isVideo && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            background: 'rgba(0,0,0,0.55)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              width: 0, height: 0, marginLeft: 3,
              borderLeft: '14px solid white',
              borderTop: '9px solid transparent',
              borderBottom: '9px solid transparent',
            }} />
          </div>
        </div>
      )}
      {c.videoDurationSec ? (
        <div style={{
          position: 'absolute', bottom: 6, right: 6, background: 'rgba(0,0,0,0.65)',
          color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 3,
        }}>
          {Math.round(c.videoDurationSec)}s
        </div>
      ) : null}
    </div>
  );
}

// ---------- One ad card ----------
function AdCard({ ad, onOpen }) {
  const totals = ad.totals || {};
  const platform = ad.platform;
  const platformTint = PLATFORM_TINT[platform] || '#64748b';
  return (
    <button
      onClick={() => onOpen(ad)}
      className="card is-clean"
      style={{
        textAlign: 'left', padding: 0, overflow: 'hidden',
        cursor: 'pointer', display: 'flex', flexDirection: 'column',
        border: '1px solid var(--line)', borderRadius: 10,
      }}
    >
      <CreativeThumb creative={ad.creative} height={180} />
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <PlatformBadge platform={platform} />
          <StatusBadge status={ad.ad?.status} />
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3, color: 'var(--ink)' }}>
          {ad.ad?.name || '(unnamed ad)'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
          {ad.campaign?.name || '—'}
          <span style={{ opacity: 0.5 }}> · </span>
          {ad.adgroup?.name || '—'}
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 6, fontSize: 11, marginTop: 4,
        }}>
          <div>
            <div style={{ color: 'var(--muted)', fontSize: 10 }}>Spend</div>
            <div style={{ fontWeight: 700 }}>{fmtMoney(totals.spend)}</div>
          </div>
          <div>
            <div style={{ color: 'var(--muted)', fontSize: 10 }}>Impr.</div>
            <div style={{ fontWeight: 700 }}>{fmtInt(totals.impressions)}</div>
          </div>
          <div>
            <div style={{ color: 'var(--muted)', fontSize: 10 }}>Clicks</div>
            <div style={{ fontWeight: 700 }}>{fmtInt(totals.clicks)}</div>
          </div>
          <div>
            <div style={{ color: 'var(--muted)', fontSize: 10 }}>CTR</div>
            <div style={{ fontWeight: 700 }}>{fmtPct(totals.ctr)}</div>
          </div>
          {totals.videoViews > 0 && (
            <>
              <div>
                <div style={{ color: 'var(--muted)', fontSize: 10 }}>Views</div>
                <div style={{ fontWeight: 700 }}>{fmtInt(totals.videoViews)}</div>
              </div>
              <div>
                <div style={{ color: 'var(--muted)', fontSize: 10 }}>Avg play</div>
                <div style={{ fontWeight: 700 }}>
                  {totals.avgVideoPlaySec ? totals.avgVideoPlaySec.toFixed(1) + 's' : '—'}
                </div>
              </div>
            </>
          )}
        </div>
        <div style={{ marginTop: 'auto', paddingTop: 8 }}>
          <Sparkline daily={ad.daily} color={platformTint} />
        </div>
      </div>
    </button>
  );
}

// ---------- Detail modal ----------
function AdDetailModal({ ad, onClose }) {
  if (!ad) return null;
  const t = ad.totals || {};
  const c = ad.creative || {};
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.65)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white', borderRadius: 12, maxWidth: 920, width: '100%',
          maxHeight: '92vh', overflow: 'auto', display: 'grid',
          gridTemplateColumns: '380px 1fr',
        }}
      >
        {/* LEFT: video / image preview */}
        <div style={{ background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          {c.type === 'VIDEO' && c.videoUrl ? (
            <video
              src={c.videoUrl}
              poster={c.posterUrl}
              controls
              autoPlay
              loop
              muted
              playsInline
              style={{
                maxWidth: '100%', maxHeight: '60vh',
                aspectRatio: c.videoAspectRatio === '9:16' ? '9 / 16'
                          : c.videoAspectRatio === '1:1'  ? '1 / 1'
                          : '16 / 9',
                background: 'black', borderRadius: 6,
              }}
            />
          ) : c.imageUrl || (Array.isArray(c.imageUrls) && c.imageUrls[0]) ? (
            <img
              src={c.imageUrl || c.imageUrls[0]}
              style={{ maxWidth: '100%', maxHeight: '60vh', borderRadius: 6 }}
              alt={ad.ad?.name || ''}
            />
          ) : (
            <div style={{ color: '#94a3b8', fontSize: 13 }}>No preview available</div>
          )}
        </div>

        {/* RIGHT: meta + stats */}
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <PlatformBadge platform={ad.platform} />
            <StatusBadge status={ad.ad?.status} />
            <span style={{ flex: 1 }} />
            <button onClick={onClose} className="btn is-ghost" style={{ padding: '4px 10px', fontSize: 12 }}>Close</button>
          </div>

          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, lineHeight: 1.3 }}>
              {ad.ad?.name || '(unnamed ad)'}
            </h2>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
              {ad.account?.name} <span style={{ opacity: 0.5 }}>›</span>{' '}
              {ad.campaign?.name} <span style={{ opacity: 0.5 }}>›</span>{' '}
              {ad.adgroup?.name}
            </div>
          </div>

          {c.primaryText && (
            <div style={{
              padding: 10, background: '#f8fafc', borderRadius: 6,
              fontSize: 12, lineHeight: 1.5, color: 'var(--ink)',
              maxHeight: 100, overflow: 'auto',
            }}>
              {c.primaryText}
            </div>
          )}

          {Array.isArray(c.headlines) && c.headlines.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Headlines</div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                {c.headlines.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            </div>
          )}

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10,
            padding: '10px 0', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)',
          }}>
            <Stat label="Spend"        value={fmtMoney(t.spend)} />
            <Stat label="Impressions"  value={fmtInt(t.impressions)} />
            <Stat label="Clicks"       value={fmtInt(t.clicks)} />
            <Stat label="Conversions"  value={fmtInt(t.conversions)} />
            <Stat label="CTR"          value={fmtPct(t.ctr)} />
            <Stat label="CPC"          value={fmtMoney(t.cpc)} />
            <Stat label="CPM"          value={fmtMoney(t.cpm)} />
            <Stat label="CPA"          value={fmtMoney(t.cpa)} />
          </div>

          {t.videoViews > 0 && (
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10,
              padding: '4px 0',
            }}>
              <Stat label="Video views" value={fmtInt(t.videoViews)} />
              <Stat label="25%" value={fmtInt(t.videoViewsP25)} />
              <Stat label="50%" value={fmtInt(t.videoViewsP50)} />
              <Stat label="75%" value={fmtInt(t.videoViewsP75)} />
              <Stat label="100%" value={fmtInt(t.videoViewsP100)} />
              <Stat label="Avg play" value={t.avgVideoPlaySec ? t.avgVideoPlaySec.toFixed(1) + 's' : '—'} />
              {t.engagement?.likes != null && <Stat label="Likes" value={fmtInt(t.engagement.likes)} />}
              {t.engagement?.shares != null && <Stat label="Shares" value={fmtInt(t.engagement.shares)} />}
            </div>
          )}

          <div>
            <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>
              Daily spend ({(ad.daily || []).length} days)
            </div>
            <Sparkline daily={ad.daily} height={56} color={PLATFORM_TINT[ad.platform] || '#6366f1'} />
          </div>

          <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', gap: 14, flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <span>Created: <b style={{ color: 'var(--ink)' }}>{fmtDate(ad.ad?.createdAt)}</b></span>
            <span>Last synced: <b style={{ color: 'var(--ink)' }}>{fmtDate(ad.ingestedAt)}</b></span>
            {c.landingUrl && (
              <a href={c.landingUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                Landing page ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{value}</div>
    </div>
  );
}

// ---------- Page root ----------
window.TopAdsPage = function TopAdsPage() {
  const [platform, setPlatform] = React.useState('all');  // 'all'|'tiktok'|'meta'|'google'
  const [ads, setAds] = React.useState([]);
  const [nextCursor, setNextCursor] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [openAd, setOpenAd] = React.useState(null);

  const loadPage = React.useCallback(async (reset = false) => {
    if (typeof window._pulseCallable !== 'function') {
      setError('Firebase bridge not ready');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const args = {
        platform: platform === 'all' ? null : platform,
        limit: 24,
        cursor: reset ? null : nextCursor,
      };
      const r = await window._pulseCallable('marketingAdsList', args);
      const data = r?.data || {};
      const newAds = Array.isArray(data.ads) ? data.ads : [];
      setAds(prev => reset ? newAds : [...prev, ...newAds]);
      setNextCursor(data.nextCursor || null);
    } catch (e) {
      const m = String(e?.message || e || '');
      if (/permission-denied|Root admin/.test(m)) {
        setError('Permission denied — admin only.');
      } else if (/not-found|UNAVAILABLE|deadline/.test(m)) {
        setError('Backend not deployed yet. The Top Ads sync runs once the TikTok token has Ads + Creative scopes.');
      } else {
        setError('Failed to load ads: ' + m.slice(0, 240));
      }
    } finally {
      setLoading(false);
    }
  }, [platform, nextCursor]);

  // Initial load + reload on platform filter change.
  React.useEffect(() => {
    setNextCursor(null);
    loadPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  return (
    <div className="page">
      <div className="page-h" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="title">Top Ads</h1>
          <div className="subtitle">
            Cross-platform creative leaderboard — sorted by spend across the last 90 days
          </div>
        </div>
        <div className="f-segment">
          {['all', 'tiktok', 'meta', 'google'].map(p => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={platform === p ? 'is-active' : ''}
            >
              {p === 'all' ? 'All platforms' : PLATFORM_LABELS[p] || p}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="card is-clean" style={{
          padding: 14, marginBottom: 14, borderLeft: '3px solid #ef4444',
          color: '#991b1b', fontSize: 13, lineHeight: 1.5,
        }}>
          {error}
        </div>
      )}

      {!error && !loading && ads.length === 0 && (
        <div className="card is-clean" style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No ads loaded yet</div>
          <div style={{ fontSize: 12 }}>
            Once the per-platform ad-level Cloud Function (e.g. <code>tiktokAdsAdLevelSyncNow</code>) has run, ads will populate here automatically.
          </div>
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 14,
      }}>
        {ads.map(ad => (
          <AdCard key={ad.id} ad={ad} onOpen={setOpenAd} />
        ))}
      </div>

      {(nextCursor || loading) && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '18px 0' }}>
          <button
            onClick={() => loadPage(false)}
            disabled={loading}
            className="btn"
            style={{ padding: '8px 18px', fontSize: 13 }}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      {openAd && <AdDetailModal ad={openAd} onClose={() => setOpenAd(null)} />}
    </div>
  );
};
