/* global React, Icon */

/* ===================================================================
   Pulse — Top Ads page (Phase 2 marketing — cross-platform ad detail)

   Surfaces the heaviest-spending ads across TikTok, Meta, and Google.
   Three view modes (Grid / List / Compact) + sticky compact filter bar
   (platform · status · sort · view) sitting above the results.

   Data source — Firestore subcollection workspaces/default/marketing_ads,
   one doc per ad keyed by `<platform>_<externalId>`. Populated by per-
   platform ad-level Cloud Functions (see functions/marketing-ads-shared.js
   for the unified UnifiedAd shape).

   Reads via the marketingAdsList callable (sorted server-side by
   totals.spend desc, cursor-paginated). Detail reads via marketingAdGet.

   Defensive rendering — Google Ads RSA headlines/descriptions may arrive
   as either plain strings OR as objects {asset, text, pinned_field}
   depending on which version of google-ads-script.js wrote them. Always
   pipe through `_toText()` before showing to user (legacy Firestore docs
   may contain "[object Object]" string literals from the very first
   ingest pass — those are skipped via the `_isObjStr()` check).
   =================================================================== */

const PLATFORM_LABELS = {
  tiktok: 'TikTok',
  meta: 'Meta (FB/IG)',
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

// --- formatters ---
function fmtMoney(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtMoneyShort(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
  return '$' + v.toFixed(2);
}
function fmtInt(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}
function fmtIntShort(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
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

// --- defensive text helpers ---
// Извлекает текст из любого варианта: string, {text}, {asset}, {value}.
// Возвращает пустую строку для null/undefined/objects без полей.
function _toText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    return String(x.text || x.asset || x.value || x.label || '');
  }
  return String(x);
}

// Пропускает строки «[object Object]» — это мусор от ранних версий
// _buildGoogleUnifiedAd, которые делали .map(String) поверх объектов.
function _isObjStr(s) {
  return typeof s === 'string' && s.indexOf('[object Object]') >= 0;
}

function _cleanList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(_toText).filter(s => s && !_isObjStr(s));
}

// Composite display name — для Google RSA ad.name часто пустой; падаем на
// campaign/adgroup. Legacy-данные могут содержать литерал «(unnamed ad)»
// из старой версии сервера — трактуем его как пустую строку, чтобы
// fallback работал и на старых документах.
function _adTitle(ad) {
  const a = ad?.ad?.name;
  const aTrim = a ? String(a).trim() : '';
  if (aTrim && aTrim !== '(unnamed ad)' && aTrim !== '(untitled ad)') return aTrim;
  const c = ad?.campaign?.name;
  const g = ad?.adgroup?.name;
  if (c && g) return `${c} · ${g}`;
  if (c) return c;
  if (g) return g;
  return '(untitled ad)';
}

// --- inline sparkline ---
function Sparkline({ daily, height = 32, color = '#6366f1', width = 120 }) {
  const vals = (daily || []).map(d => Number(d.spend) || 0);
  if (vals.length < 2) return <div style={{ height, opacity: 0.4, fontSize: 10 }}>no trend</div>;
  const max = Math.max(...vals, 0.01);
  const stepX = width / (vals.length - 1);
  const pts = vals.map((v, i) => `${i * stepX},${height - (v / max) * height}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={color} fillOpacity="0.12" />
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

function PlatformBadge({ platform, size = 'sm' }) {
  const label = PLATFORM_LABELS[platform] || platform;
  const tint = PLATFORM_TINT[platform] || '#64748b';
  const padY = size === 'xs' ? 1 : 2;
  const padX = size === 'xs' ? 5 : 6;
  const fs = size === 'xs' ? 9 : 10;
  return (
    <span style={{
      padding: `${padY}px ${padX}px`, borderRadius: 4, fontSize: fs, fontWeight: 700,
      background: tint + '15', color: tint, letterSpacing: 0.2, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

/* ===========================================================
   CreativeThumb — renders the best preview we can build:
     • VIDEO  → poster image + play overlay
     • IMAGE  → first image url
     • RSA    → Google-style search-ad mockup (headline + desc)
     • else   → typed placeholder ("RSA", "VIDEO", etc.)
   =========================================================== */
function CreativeThumb({ creative, ad, height = 200, compact = false }) {
  const c = creative || {};
  const src = c.posterUrl || c.imageUrl || (Array.isArray(c.imageUrls) ? c.imageUrls[0] : null);
  const isVideo = c.type === 'VIDEO';

  if (src) {
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

  // No image — try RSA-style text preview from headlines/descriptions
  const headlines = _cleanList(c.headlines);
  const descriptions = _cleanList(c.descriptions);
  const hostName = (() => {
    try {
      if (!c.landingUrl) return '';
      return new URL(c.landingUrl).hostname.replace(/^www\./, '');
    } catch (e) { return ''; }
  })();

  if (headlines.length > 0 || descriptions.length > 0) {
    return (
      <div style={{
        height, background: '#fafaf9', padding: compact ? '10px 12px' : '14px 16px',
        display: 'flex', flexDirection: 'column', gap: 4, overflow: 'hidden',
        borderBottom: '1px solid var(--line)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, color: '#15803d',
            border: '1px solid #15803d', borderRadius: 3, padding: '0 4px',
            letterSpacing: 0.3,
          }}>Ad</span>
          {hostName && (
            <span style={{ fontSize: 11, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {hostName}
            </span>
          )}
        </div>
        {headlines.slice(0, 2).map((h, i) => (
          <div key={i} style={{
            fontSize: compact ? 13 : 15, lineHeight: 1.25, fontWeight: 500,
            color: '#1a0dab', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {h}
          </div>
        ))}
        {descriptions.slice(0, 2).map((d, i) => (
          <div key={i} style={{
            fontSize: compact ? 11 : 12, lineHeight: 1.35, color: '#475569',
            overflow: 'hidden', display: '-webkit-box',
            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          }}>
            {d}
          </div>
        ))}
      </div>
    );
  }

  // Last-resort placeholder
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

/* ========================== Grid card ========================== */
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
      <CreativeThumb creative={ad.creative} ad={ad} height={170} />
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <PlatformBadge platform={platform} />
          <StatusBadge status={ad.ad?.status} />
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3, color: 'var(--ink)' }}>
          {_adTitle(ad)}
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

/* ========================== List row (horizontal) ========================== */
function AdRow({ ad, onOpen }) {
  const t = ad.totals || {};
  const platform = ad.platform;
  const platformTint = PLATFORM_TINT[platform] || '#64748b';
  return (
    <button
      onClick={() => onOpen(ad)}
      className="card is-clean"
      style={{
        textAlign: 'left', padding: 0, overflow: 'hidden',
        cursor: 'pointer', display: 'grid',
        gridTemplateColumns: '180px 1fr 380px 130px',
        gap: 0, border: '1px solid var(--line)', borderRadius: 10,
        alignItems: 'stretch', width: '100%',
      }}
    >
      <CreativeThumb creative={ad.creative} ad={ad} height={120} compact />
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <PlatformBadge platform={platform} size="xs" />
          <StatusBadge status={ad.ad?.status} />
        </div>
        <div style={{
          fontSize: 13, fontWeight: 700, lineHeight: 1.3, color: 'var(--ink)',
          overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>
          {_adTitle(ad)}
        </div>
        <div style={{
          fontSize: 11, color: 'var(--muted)', lineHeight: 1.4,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {ad.campaign?.name || '—'}
          <span style={{ opacity: 0.5 }}> · </span>
          {ad.adgroup?.name || '—'}
        </div>
      </div>
      <div style={{
        padding: '12px 14px', display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 11,
        alignItems: 'center', borderLeft: '1px solid var(--line)',
      }}>
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 10 }}>Spend</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtMoney(t.spend)}</div>
        </div>
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 10 }}>Impr.</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtIntShort(t.impressions)}</div>
        </div>
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 10 }}>Clicks</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtIntShort(t.clicks)}</div>
        </div>
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 10 }}>CTR</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtPct(t.ctr)}</div>
        </div>
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 10 }}>Conv.</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtIntShort(t.conversions)}</div>
        </div>
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 10 }}>CPC</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtMoney(t.cpc)}</div>
        </div>
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 10 }}>CPA</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtMoney(t.cpa)}</div>
        </div>
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 10 }}>CPM</div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtMoney(t.cpm)}</div>
        </div>
      </div>
      <div style={{
        padding: '12px 14px', display: 'flex', flexDirection: 'column',
        justifyContent: 'center', borderLeft: '1px solid var(--line)',
      }}>
        <div style={{ color: 'var(--muted)', fontSize: 10, marginBottom: 2 }}>Daily spend</div>
        <Sparkline daily={ad.daily} color={platformTint} width={110} height={36} />
      </div>
    </button>
  );
}

/* ========================== Compact table row ========================== */
function AdCompactRow({ ad, onOpen }) {
  const t = ad.totals || {};
  const platform = ad.platform;
  const platformTint = PLATFORM_TINT[platform] || '#64748b';
  return (
    <tr onClick={() => onOpen(ad)} style={{ cursor: 'pointer' }}
        onMouseEnter={(e) => e.currentTarget.style.background = '#f8fafc'}
        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
      <td style={tdStyle}>
        <PlatformBadge platform={platform} size="xs" />
      </td>
      <td style={{ ...tdStyle, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{_adTitle(ad)}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {ad.campaign?.name || '—'} · {ad.adgroup?.name || '—'}
        </div>
      </td>
      <td style={tdStyle}>
        <StatusBadge status={ad.ad?.status} />
      </td>
      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(t.spend)}</td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtIntShort(t.impressions)}</td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtIntShort(t.clicks)}</td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtPct(t.ctr)}</td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(t.cpc)}</td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtIntShort(t.conversions)}</td>
      <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(t.cpa)}</td>
      <td style={tdStyle}>
        <Sparkline daily={ad.daily} color={platformTint} width={80} height={24} />
      </td>
    </tr>
  );
}
const tdStyle = {
  padding: '8px 10px', borderBottom: '1px solid var(--line)',
  fontSize: 12, verticalAlign: 'middle',
};
const thStyle = {
  padding: '8px 10px', borderBottom: '1px solid var(--line)',
  fontSize: 10, fontWeight: 700, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: 0.3,
  background: '#fafaf9', position: 'sticky', top: 0, zIndex: 1,
};

/* ========================== Detail modal ========================== */
function AdDetailModal({ ad, onClose }) {
  if (!ad) return null;
  const t = ad.totals || {};
  const c = ad.creative || {};
  const headlines = _cleanList(c.headlines);
  const descriptions = _cleanList(c.descriptions);
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
        {/* LEFT: video / image / RSA-style preview */}
        <div style={{ background: '#0f172a', display: 'flex', alignItems: 'stretch', justifyContent: 'stretch', padding: 0 }}>
          {c.type === 'VIDEO' && c.videoUrl ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, width: '100%' }}>
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
            </div>
          ) : c.imageUrl || (Array.isArray(c.imageUrls) && c.imageUrls[0]) ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, width: '100%' }}>
              <img
                src={c.imageUrl || c.imageUrls[0]}
                style={{ maxWidth: '100%', maxHeight: '60vh', borderRadius: 6 }}
                alt={_adTitle(ad)}
              />
            </div>
          ) : (headlines.length > 0 || descriptions.length > 0) ? (
            <div style={{ width: '100%', alignSelf: 'stretch' }}>
              <CreativeThumb creative={c} ad={ad} height={'100%'} />
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, color: '#94a3b8', fontSize: 13, width: '100%' }}>
              No preview available
            </div>
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
              {_adTitle(ad)}
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

          {headlines.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>
                Headlines ({headlines.length})
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.6 }}>
                {headlines.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            </div>
          )}

          {descriptions.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>
                Descriptions ({descriptions.length})
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}>
                {descriptions.map((d, i) => <li key={i}>{d}</li>)}
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
            <Sparkline daily={ad.daily} height={56} color={PLATFORM_TINT[ad.platform] || '#6366f1'} width={400} />
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

/* ========================== Compact filter bar ========================== */
function FilterBar({ platform, setPlatform, status, setStatus, viewMode, setViewMode, total, loading }) {
  const chipBase = {
    padding: '5px 10px', fontSize: 11, fontWeight: 600,
    border: '1px solid var(--line)', background: 'white',
    borderRadius: 6, cursor: 'pointer', color: 'var(--muted)',
    whiteSpace: 'nowrap', transition: 'all 120ms',
  };
  const chipActive = {
    ...chipBase, background: 'var(--ink)', color: 'white', borderColor: 'var(--ink)',
  };
  const segBase = {
    padding: '5px 9px', fontSize: 11, fontWeight: 600,
    border: 'none', background: 'transparent', cursor: 'pointer',
    color: 'var(--muted)', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 4,
  };
  const segActive = { ...segBase, background: 'white', color: 'var(--ink)', boxShadow: '0 1px 2px rgba(0,0,0,0.06)' };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '8px 12px', background: '#fafaf9',
      border: '1px solid var(--line)', borderRadius: 8,
      marginBottom: 14, position: 'sticky', top: 0, zIndex: 5,
    }}>
      {/* Platform */}
      <div style={{ display: 'flex', gap: 4 }}>
        {['all', 'tiktok', 'meta', 'google'].map(p => (
          <button
            key={p}
            onClick={() => setPlatform(p)}
            style={platform === p ? chipActive : chipBase}
          >
            {p === 'all' ? 'All' : (PLATFORM_LABELS[p] || p)}
          </button>
        ))}
      </div>

      <div style={{ height: 20, width: 1, background: 'var(--line)' }} />

      {/* Status */}
      <div style={{ display: 'flex', gap: 4 }}>
        {[
          { k: 'all', label: 'All status' },
          { k: 'active', label: 'Active' },
          { k: 'paused', label: 'Paused' },
        ].map(s => (
          <button
            key={s.k}
            onClick={() => setStatus(s.k)}
            style={status === s.k ? chipActive : chipBase}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {/* Result count */}
      {!loading && (
        <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
          {total} {total === 1 ? 'ad' : 'ads'}
        </span>
      )}

      {/* View mode segment */}
      <div style={{
        display: 'flex', gap: 2, padding: 2, background: '#f1f5f9',
        borderRadius: 6, border: '1px solid var(--line)',
      }}>
        <button onClick={() => setViewMode('grid')} style={viewMode === 'grid' ? segActive : segBase} title="Grid view">
          <ViewIcon kind="grid" /> Grid
        </button>
        <button onClick={() => setViewMode('list')} style={viewMode === 'list' ? segActive : segBase} title="List view">
          <ViewIcon kind="list" /> List
        </button>
        <button onClick={() => setViewMode('compact')} style={viewMode === 'compact' ? segActive : segBase} title="Compact table">
          <ViewIcon kind="compact" /> Table
        </button>
      </div>
    </div>
  );
}

function ViewIcon({ kind }) {
  // Inline SVG so we don't depend on the global Icon registry having these names.
  const sw = 1.6, color = 'currentColor';
  if (kind === 'grid') return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={sw}>
      <rect x="2" y="2" width="5" height="5" /><rect x="9" y="2" width="5" height="5" />
      <rect x="2" y="9" width="5" height="5" /><rect x="9" y="9" width="5" height="5" />
    </svg>
  );
  if (kind === 'list') return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={sw}>
      <rect x="2" y="3" width="12" height="3" /><rect x="2" y="10" width="12" height="3" />
    </svg>
  );
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={sw}>
      <line x1="2" y1="4" x2="14" y2="4" /><line x1="2" y1="8" x2="14" y2="8" /><line x1="2" y1="12" x2="14" y2="12" />
    </svg>
  );
}

/* ========================== Page root ========================== */
window.TopAdsPage = function TopAdsPage() {
  const [platform, setPlatform] = React.useState('all');     // 'all'|'tiktok'|'meta'|'google'
  const [status, setStatus]     = React.useState('all');     // 'all'|'active'|'paused'
  const [viewMode, setViewMode] = React.useState(() => {
    try { return localStorage.getItem('pulse_topads_view') || 'grid'; } catch (e) { return 'grid'; }
  });
  const [ads, setAds] = React.useState([]);
  const [nextCursor, setNextCursor] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [openAd, setOpenAd] = React.useState(null);

  // persist view mode
  React.useEffect(() => {
    try { localStorage.setItem('pulse_topads_view', viewMode); } catch (e) {}
  }, [viewMode]);

  const loadPage = React.useCallback(async (reset, cursorOverride) => {
    if (typeof window._pulseCallable !== 'function') {
      setError('Firebase bridge not ready');
      return;
    }
    setLoading(true);
    if (reset) setError(null);
    try {
      const args = {
        platform: platform === 'all' ? null : platform,
        limit: 24,
        cursor: reset ? null : (cursorOverride ?? null),
      };
      const r = await window._pulseCallable('marketingAdsList', args);
      const data = r?.data || {};
      const newAds = Array.isArray(data.ads) ? data.ads : [];
      setAds(prev => reset ? newAds : [...prev, ...newAds]);
      setNextCursor(data.nextCursor || null);
      if (reset) setError(null);
    } catch (e) {
      const m = String(e?.message || e || '');
      if (/permission-denied|Root admin/.test(m)) {
        setError('Permission denied — admin only.');
      } else if (/not-found|UNAVAILABLE|deadline/.test(m)) {
        setError('Backend not deployed yet. The Top Ads sync runs once the per-platform ad-level cron is live.');
      } else {
        setError('Failed to load ads: ' + m.slice(0, 240));
      }
    } finally {
      setLoading(false);
    }
  }, [platform]);

  // Reload on platform change (full reset).
  React.useEffect(() => {
    setAds([]);
    setNextCursor(null);
    setError(null);
    loadPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  // Client-side status filter — server-side filter currently only supports
  // platform. Status filter on top of already-loaded page.
  const filteredAds = React.useMemo(() => {
    if (status === 'all') return ads;
    return ads.filter(a => {
      const s = String(a?.ad?.status || '').toUpperCase();
      if (status === 'active') return s === 'ACTIVE' || s === 'ENABLED';
      if (status === 'paused') return s === 'PAUSED';
      return true;
    });
  }, [ads, status]);

  return (
    <div className="page">
      <div className="page-h" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 className="title">Top Ads</h1>
          <div className="subtitle">
            Cross-platform creative leaderboard — sorted by spend across the last 90 days
          </div>
        </div>
      </div>

      <FilterBar
        platform={platform} setPlatform={setPlatform}
        status={status} setStatus={setStatus}
        viewMode={viewMode} setViewMode={setViewMode}
        total={filteredAds.length}
        loading={loading && ads.length === 0}
      />

      {error && (
        <div className="card is-clean" style={{
          padding: 12, marginBottom: 14, borderLeft: '3px solid #ef4444',
          color: '#991b1b', fontSize: 12, lineHeight: 1.5,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={() => { setError(null); loadPage(true); }}
            className="btn is-ghost" style={{ padding: '3px 8px', fontSize: 11 }}>
            Retry
          </button>
          <button onClick={() => setError(null)}
            className="btn is-ghost" style={{ padding: '3px 8px', fontSize: 11 }}>
            Dismiss
          </button>
        </div>
      )}

      {!error && !loading && filteredAds.length === 0 && (
        <div className="card is-clean" style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No ads loaded yet</div>
          <div style={{ fontSize: 12 }}>
            {ads.length > 0
              ? <>No ads match the current filter. Try resetting status to «All status».</>
              : <>Once the per-platform ad-level Cloud Function has run, ads will populate here automatically.</>}
          </div>
        </div>
      )}

      {/* === GRID === */}
      {viewMode === 'grid' && filteredAds.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 14,
        }}>
          {filteredAds.map(ad => (
            <AdCard key={ad.id} ad={ad} onOpen={setOpenAd} />
          ))}
        </div>
      )}

      {/* === LIST === */}
      {viewMode === 'list' && filteredAds.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filteredAds.map(ad => (
            <AdRow key={ad.id} ad={ad} onOpen={setOpenAd} />
          ))}
        </div>
      )}

      {/* === COMPACT TABLE === */}
      {viewMode === 'compact' && filteredAds.length > 0 && (
        <div className="card is-clean" style={{ padding: 0, overflow: 'auto', maxHeight: '72vh' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={thStyle}>Platform</th>
                <th style={thStyle}>Ad</th>
                <th style={thStyle}>Status</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Spend</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Impr.</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Clicks</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>CTR</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>CPC</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Conv.</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>CPA</th>
                <th style={thStyle}>Daily</th>
              </tr>
            </thead>
            <tbody>
              {filteredAds.map(ad => (
                <AdCompactRow key={ad.id} ad={ad} onOpen={setOpenAd} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(nextCursor || (loading && ads.length > 0)) && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '18px 0' }}>
          <button
            onClick={() => loadPage(false, nextCursor)}
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
