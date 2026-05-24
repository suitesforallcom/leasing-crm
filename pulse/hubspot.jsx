/* global React, DATA, Icon */

/* ===================================================================
   Pulse — HubSpot Insights page (extracted from OverviewPage 2026-05-24)

   Standalone page accessible via sidebar nav «HubSpot». Reads
   window._hsDataCache populated by /pulse/data-shim.jsx (which calls
   the hubspotGetData Cloud Function and caches in localStorage).
   Renders:
     • Sync status + «Open in HubSpot» button
     • Warning banner: HubSpot ↔ SuitesForAll sync gap (when funnel.signed
       = 0 but local leases exist) OR generic «no signed detected»
     • Conversion funnel (5 rows: Inquiry / Qualified / Tour scheduled /
       Tour done / Signed)
     • Actual signs card (cross-system, from floor-map state)
     • Forecast card (active tours × historical conv)
     • Coaching alerts (auto-detected anomalies)
     • Tour leaderboard with sparklines
     • Stage breakdown collapsible (populated + configured-but-empty)
   =================================================================== */

window.HubspotPage = function HubspotPage({ centerFilter }) {
  // Pull users — same shape used by OverviewPage; the component is
  // currently centerFilter-agnostic (funnel/alerts aggregate ALL owners
  // regardless of building filter, because HubSpot doesn't know about
  // our centers). The arg is accepted for routing-API parity.
  const users = [...(window.DATA?.USERS || [])];
  void centerFilter; // reserved for future per-center HubSpot views

  return (
    <div className="page">
      {/* Page header — title + last-sync subtitle. HubspotInsights body
          shows its own header (🎯 + sync status + open-in-HubSpot link)
          so we keep this one slim. */}
      <div className="page-h">
        <div>
          <h1 className="title">HubSpot</h1>
          <div className="subtitle">
            <span>Pipeline analytics from HubSpot CRM, cross-referenced with SuitesForAll leases</span>
          </div>
        </div>
      </div>

      <HubspotInsights users={users} />
    </div>
  );
};

function HubspotInsights({ users }) {
  const hs = window._hsDataCache;
  if (!hs) {
    return (
      <div className="card is-clean" style={{ marginBottom: 18, padding: 16, borderLeft: "3px solid #ff7a59" }}>
        <div className="row">
          <div style={{ fontSize: 14, fontWeight: 700 }}>🎯 HubSpot insights</div>
          <span className="muted" style={{ fontSize: 12 }}>Loading from HubSpot…</span>
        </div>
      </div>
    );
  }
  // Time helpers
  const now = new Date();
  const thisYm = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  const prevYm = (() => {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  })();
  // Last 6 months keys (oldest → newest)
  const last6 = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    last6.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
  }

  // Per-owner aggregates for this month
  const ownerStats = [];
  for (const [email, months] of Object.entries(hs.toursByMonth || {})) {
    const tCur = months[thisYm] || { scheduled: 0, conducted: 0 };
    const tPrev = months[prevYm] || { scheduled: 0, conducted: 0 };
    const signs = ((hs.signsByMonth || {})[email] || {})[thisYm] || 0;
    const ownerObj = Object.values(hs.owners || {}).find(o => o.email === email) || { id: null, name: email, email };
    const conv = tCur.conducted > 0 ? Math.round((signs / tCur.conducted) * 100) : 0;
    ownerStats.push({
      email,
      ownerId: ownerObj.id,
      name: ownerObj.name,
      toursThis: tCur.scheduled,
      toursDone: tCur.conducted,
      toursPrev: tPrev.scheduled,
      signs,
      conversionPct: conv,
      sparkline: last6.map(ym => (months[ym] || { scheduled: 0 }).scheduled),
    });
  }
  // Sort by tours this month, desc
  ownerStats.sort((a, b) => (b.toursThis - a.toursThis) || (b.signs - a.signs));

  // Funnel: aggregate across all owners using dealsByStage + stageMeta.
  // Counts of deals currently sitting in each stage class. Order of
  // precedence: signed → pastTour → scheduledTour → qualified → inquiry.
  const stageMeta = hs.stageMeta || {};
  const funnel = { inquiry: 0, qualified: 0, scheduledTour: 0, pastTour: 0, signed: 0 };
  for (const stageMap of Object.values(hs.dealsByStage || {})) {
    for (const [stageId, count] of Object.entries(stageMap)) {
      const m = stageMeta[stageId];
      if (!m) continue;
      if (m.isSigned)             funnel.signed += count;
      else if (m.isPastTour)      funnel.pastTour += count;
      else if (m.isScheduledTour) funnel.scheduledTour += count;
      else if (m.isQualified)     funnel.qualified += count;
      else if (m.isLost)          { /* lost is excluded from funnel */ }
      else                        funnel.inquiry += count;
    }
  }
  const funnelTotal = funnel.inquiry + funnel.qualified + funnel.scheduledTour + funnel.pastTour + funnel.signed;
  // Stage diagnostics from CF — array of { stageId, label, bucket, deals, isWon, empty }
  // Buckets now include 'qualified' (Sprint 4) and stages with empty=true
  // (Sprint 4) are kept in the list so we can show the «Configured but
  // empty» section — gives the operator a clear picture of unused stages.
  const stageDiag = hs.stageDiagnostics || [];
  const diagByBucket = { signed: [], pastTour: [], scheduledTour: [], qualified: [], inquiry: [], lost: [] };
  for (const d of stageDiag) {
    if (diagByBucket[d.bucket]) diagByBucket[d.bucket].push(d);
  }
  // Local cross-system signs from floor-map state (Sprint 4 Item 1).
  // Real lease executions this month — what HubSpot SHOULD see if
  // operators moved deals to «Contract». Surfaces the gap explicitly.
  const localSigns = window._localSignsThisMonth || { count: 0, sample: [], ym: '' };
  // Warning: HubSpot funnel says 0 signed BUT local state says we have
  // actual lease executions. This means operators don't update HubSpot
  // when leases close in SuitesForAll. Show a more specific warning.
  const shouldWarnNoSigns = funnelTotal >= 10 && funnel.signed === 0;
  const shouldWarnGap = shouldWarnNoSigns && localSigns.count > 0;

  // Pipeline forecasting — naive historical conv rate.
  const totalToursLast3 = ownerStats.reduce((s, o) => s + (o.sparkline[3] + o.sparkline[4] + o.sparkline[5]), 0) || 1;
  const totalSignsLast3 = Object.values(hs.signsByMonth || {}).reduce((s, m) => {
    return s + last6.slice(3).reduce((acc, ym) => acc + (m[ym] || 0), 0);
  }, 0);
  const historicalConvPct = Math.round((totalSignsLast3 / totalToursLast3) * 100);
  const activeTourPipeline = funnel.scheduledTour + funnel.pastTour;
  const expectedSigns30d = Math.round(activeTourPipeline * (historicalConvPct / 100));

  // Coaching alerts — auto-derived from stats
  const alerts = [];
  for (const o of ownerStats) {
    if (o.toursPrev >= 5 && o.toursThis === 0) {
      alerts.push({ severity: "high", text: `${o.name} — 0 tours this month (was ${o.toursPrev} in ${prevYm}). Possible burnout or process gap.` });
    } else if (o.toursPrev > 0 && o.toursThis > 0 && o.toursThis < o.toursPrev * 0.4) {
      const drop = Math.round((1 - o.toursThis / o.toursPrev) * 100);
      alerts.push({ severity: "med", text: `${o.name} — tour volume down ${drop}% MoM (${o.toursThis} vs ${o.toursPrev}). Worth checking pipeline.` });
    } else if (o.toursDone === 0 && o.toursThis >= 5) {
      alerts.push({ severity: "med", text: `${o.name} — scheduled ${o.toursThis} tours but conducted 0 this month. Confirm outcomes are logged.` });
    } else if (o.conversionPct === 0 && o.toursDone >= 3) {
      alerts.push({ severity: "med", text: `${o.name} — ${o.toursDone} tours conducted, 0 signed contracts. Tour quality / qualification issue?` });
    }
  }
  if (alerts.length === 0) alerts.push({ severity: "low", text: "All managers on pace — nothing flagged this month." });

  // Sync status
  const syncedAt = hs.syncedAt ? new Date(hs.syncedAt) : null;
  const syncedAgo = syncedAt ? Math.round((Date.now() - syncedAt.getTime()) / 60000) : null;
  const syncedFresh = syncedAgo !== null && syncedAgo < 60;
  // HubSpot portal id baked from the API; portal 243651196 is na2.
  const hubspotBase = "https://app-na2.hubspot.com/contacts/243651196";

  return (
    <div className="card is-clean" style={{ marginBottom: 18, padding: 16, borderLeft: "3px solid #ff7a59" }}>
      {/* Header */}
      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>🎯 HubSpot insights</div>
        {syncedAt && (
          <span style={{ fontSize: 11, color: syncedFresh ? "var(--muted)" : "var(--danger-ink)" }}>
            {syncedFresh ? "🟢" : "🟡"} Synced {syncedAgo < 1 ? "just now" : syncedAgo + "m ago"}
          </span>
        )}
        <div className="spacer" />
        <a href={hubspotBase + "/objects/0-3/views/all/list"} target="_blank" rel="noopener" className="btn is-small is-ghost" style={{ textDecoration: "none" }}>
          Open in HubSpot ↗
        </a>
      </div>

      {/* Warning banner — two flavors:
          (a) HubSpot says 0 signed AND we have actual local leases → call
              out the data gap. Operators close in SuitesForAll but don't
              update HubSpot.
          (b) HubSpot says 0 signed AND no local leases either → general
              «pipeline stages aren't classified» warning. */}
      {shouldWarnGap ? (
        <div style={{
          padding: "8px 12px", marginBottom: 12, borderRadius: 6,
          background: "rgba(239,68,68,.10)", borderLeft: "3px solid #dc2626",
          fontSize: 12, color: "var(--ink)",
        }}>
          <strong>HubSpot ↔ SuitesForAll sync gap:</strong> HubSpot pipeline shows <strong>0 signed</strong> deals, but {localSigns.count} lease{localSigns.count === 1 ? " was" : "s were"} executed in your floor-map this month. Either move closed deals to the «Contract» stage in HubSpot, or treat the «Actual signs» card (right) as the truth. Forecast uses local lease counts where present.
        </div>
      ) : shouldWarnNoSigns ? (
        <div style={{
          padding: "8px 12px", marginBottom: 12, borderRadius: 6,
          background: "rgba(245,158,11,.10)", borderLeft: "3px solid #d97706",
          fontSize: 12, color: "var(--ink)",
        }}>
          <strong>No "signed" deals detected in the pipeline.</strong> Your HubSpot pipeline stages don't match standard closed-won patterns. Open <em>Stage breakdown</em> below to see what's classified where, or rename a stage in HubSpot to include "Contract", "Signed", "Won", or "Active Lease".
        </div>
      ) : null}

      {/* 3-column grid: Funnel + Actual signs / Forecast + Alerts */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.2fr", gap: 14, marginBottom: 14 }}>
        {/* Conversion Funnel */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Conversion funnel · all owners</div>
          {[
            { l: "Inquiry / other", n: funnel.inquiry,       c: "#6b7280" },
            { l: "Qualified",       n: funnel.qualified,     c: "#0891b2" },
            { l: "Tour scheduled",  n: funnel.scheduledTour, c: "#3b82f6" },
            { l: "Tour done",       n: funnel.pastTour,      c: "#a16207" },
            { l: "Signed / contract", n: funnel.signed,      c: "#16a34a" },
          ].map((row, i) => {
            const pct = funnelTotal > 0 ? Math.round((row.n / funnelTotal) * 100) : 0;
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "100px 1fr 50px", gap: 6, alignItems: "center", marginBottom: 4, fontSize: 12 }}>
                <div style={{ color: "var(--muted)" }}>{row.l}</div>
                <div style={{ background: "var(--surface-2)", borderRadius: 3, height: 14, overflow: "hidden" }}>
                  <div style={{ background: row.c, width: pct + "%", height: "100%", transition: "width 300ms" }} />
                </div>
                <div className="mono" style={{ textAlign: "right", fontWeight: 700, color: "var(--ink)" }}>{row.n}</div>
              </div>
            );
          })}
        </div>

        {/* Actual signs + Forecast — split card.
            Top: REAL signs from local floor-map leases this month (the
            number that matters; HubSpot funnel often lies).
            Bottom: Pipeline forecast based on active tours × historical
            conversion. */}
        <div style={{ padding: "10px 12px", background: "var(--surface-2)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--success-ink)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>
              Actual signs · {localSigns.ym}
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: "var(--success-ink)" }}>{localSigns.count}</div>
            <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
              from floor-map leases (HubSpot says {funnel.signed})
            </div>
            {localSigns.sample.length > 0 && (
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
                {localSigns.sample.slice(0, 3).map(s => `Suite ${s.unitId}`).join(" · ")}
                {localSigns.sample.length > 3 ? " · …" : ""}
              </div>
            )}
          </div>
          <div style={{ borderTop: "1px dashed var(--border)", paddingTop: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Forecast · next 30d</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)" }}>{expectedSigns30d}</div>
            <div style={{ fontSize: 10, color: "var(--muted)" }}>
              {activeTourPipeline} active tours × {historicalConvPct}% conv
            </div>
          </div>
        </div>

        {/* Coaching Alerts */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Coaching alerts</div>
          {alerts.slice(0, 4).map((a, i) => (
            <div key={i} style={{
              padding: "6px 8px", marginBottom: 4, borderRadius: 5, fontSize: 11.5,
              background: a.severity === "high" ? "rgba(239,68,68,.08)" : a.severity === "med" ? "rgba(245,158,11,.08)" : "var(--surface-2)",
              borderLeft: "2px solid " + (a.severity === "high" ? "#dc2626" : a.severity === "med" ? "#d97706" : "var(--border)"),
              color: "var(--ink)",
            }}>
              {a.text}
            </div>
          ))}
        </div>
      </div>

      {/* Tour leaderboard */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Tour leaderboard · this month ({thisYm})</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 60px 60px 70px 110px", gap: 6, fontSize: 11.5, color: "var(--muted)", padding: "4px 8px", fontWeight: 600 }}>
          <div>Manager</div>
          <div style={{ textAlign: "right" }}>Scheduled</div>
          <div style={{ textAlign: "right" }}>Done</div>
          <div style={{ textAlign: "right" }}>Signs</div>
          <div style={{ textAlign: "right" }}>Conv%</div>
          <div>Trend · last 6mo</div>
        </div>
        {ownerStats.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: "var(--muted)", textAlign: "center" }}>
            No tours data for this month yet.
          </div>
        )}
        {ownerStats.map((o, idx) => (
          <div key={o.email} style={{
            display: "grid", gridTemplateColumns: "1fr 60px 60px 60px 70px 110px", gap: 6,
            padding: "8px 8px", borderTop: "1px solid var(--border)", alignItems: "center", fontSize: 12.5,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 18, height: 18, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                background: idx === 0 ? "#fbbf24" : idx === 1 ? "#d1d5db" : idx === 2 ? "#d97706" : "var(--surface-2)",
                color: idx < 3 ? "#fff" : "var(--muted)", fontSize: 10, fontWeight: 700,
              }}>{idx + 1}</span>
              <span style={{ fontWeight: 600, color: "var(--ink)" }}>{o.name}</span>
              {o.ownerId && (
                <a href={hubspotBase + "/objects/0-3/views/all/list?hubspot_owner_id=" + o.ownerId} target="_blank" rel="noopener" title="Open in HubSpot" style={{ fontSize: 11, color: "var(--muted)", textDecoration: "none" }}>↗</a>
              )}
            </div>
            <div className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{o.toursThis}</div>
            <div className="mono" style={{ textAlign: "right", color: o.toursDone > 0 ? "var(--success-ink)" : "var(--muted)", fontWeight: 700 }}>{o.toursDone}</div>
            <div className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{o.signs}</div>
            <div className="mono" style={{ textAlign: "right", color: o.conversionPct >= 30 ? "var(--success-ink)" : o.conversionPct >= 10 ? "var(--warning-ink)" : "var(--muted)", fontWeight: 700 }}>
              {o.toursDone > 0 ? o.conversionPct + "%" : "—"}
            </div>
            <Sparkline6 data={o.sparkline} />
          </div>
        ))}
      </div>

      {/* Stage breakdown — collapsible. Shows EVERY pipeline stage seen
          (with at least 1 deal) grouped by detected bucket. Lets Tony
          eyeball which stages aren't classified as expected and either
          rename them in HubSpot or report it back so we can extend the
          regex in functions/hubspot-sync.js. */}
      {stageDiag.length > 0 && (
        <details style={{ marginTop: 14, fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)", padding: "6px 0", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>
            🔎 Stage breakdown · how funnel was classified ({stageDiag.length} stages with deals)
          </summary>
          <div style={{ marginTop: 8, padding: "8px 10px", background: "var(--surface-2)", borderRadius: 6 }}>
            {[
              { key: "signed", label: "Signed / contract", color: "#16a34a" },
              { key: "pastTour", label: "Tour done", color: "#a16207" },
              { key: "scheduledTour", label: "Tour scheduled", color: "#3b82f6" },
              { key: "qualified", label: "Qualified", color: "#0891b2" },
              { key: "inquiry", label: "Inquiry / other", color: "#6b7280" },
              { key: "lost", label: "Lost / disqualified (excluded from funnel)", color: "#9ca3af" },
            ].map(b => {
              const rows = diagByBucket[b.key] || [];
              const populated = rows.filter(r => !r.empty);
              const empties = rows.filter(r => r.empty);
              if (populated.length === 0 && empties.length === 0) return null;
              const populatedDeals = populated.reduce((s, r) => s + r.deals, 0);
              return (
                <div key={b.key} style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, color: b.color, fontSize: 11.5, marginBottom: 4 }}>
                    {b.label} · {populatedDeals} deal{populatedDeals === 1 ? "" : "s"}
                    {empties.length > 0 && (
                      <span style={{ fontWeight: 500, color: "var(--muted)", marginLeft: 6 }}>
                        ({empties.length} stage{empties.length === 1 ? "" : "s"} configured but empty)
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {populated.map(r => (
                      <span key={r.stageId} style={{
                        padding: "3px 7px", borderRadius: 4, background: "var(--surface)",
                        border: "1px solid var(--border)", fontSize: 11.5, color: "var(--ink)",
                      }} title={r.isWon ? "Marked as Won by HubSpot" : (r.isClosed ? "Marked as Closed by HubSpot" : "")}>
                        {r.label} <span className="mono" style={{ color: "var(--muted)", marginLeft: 4 }}>{r.deals}</span>
                        {r.isWon && <span style={{ marginLeft: 4 }}>★</span>}
                      </span>
                    ))}
                    {empties.map(r => (
                      <span key={r.stageId} style={{
                        padding: "3px 7px", borderRadius: 4, background: "transparent",
                        border: "1px dashed var(--border)", fontSize: 11.5, color: "var(--muted)",
                        fontStyle: "italic",
                      }} title="No deals are currently in this stage. Operators may close deals elsewhere (e.g. SuitesForAll) and never move them here.">
                        {r.label} <span className="mono" style={{ marginLeft: 4 }}>0</span>
                        {r.isWon && <span style={{ marginLeft: 4 }}>★</span>}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--border)" }}>
              ★ = HubSpot's "Won" flag · dashed = configured but no deals.
              To reclassify a stage, rename it in HubSpot or ping engineering to extend the detection regex.
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

// Inline 6-month sparkline (SVG).
function Sparkline6({ data }) {
  if (!data || data.length === 0) return <div style={{ color: "var(--muted)", fontSize: 10 }}>—</div>;
  const max = Math.max(...data, 1);
  const w = 100, h = 22, pad = 1;
  const pts = data.map((v, i) => {
    const x = pad + (i * (w - 2 * pad)) / (data.length - 1);
    const y = pad + (h - 2 * pad) - (v / max) * (h - 2 * pad);
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  const last = data[data.length - 1];
  const prev = data[data.length - 2] || 0;
  const trend = last > prev ? "↗" : last < prev ? "↘" : "→";
  const trendCol = last > prev ? "var(--success-ink)" : last < prev ? "var(--danger-ink)" : "var(--muted)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <svg width={w} height={h} style={{ display: "block" }}>
        <polyline fill="none" stroke="#ff7a59" strokeWidth="1.5" points={pts} />
        {data.map((v, i) => {
          const x = pad + (i * (w - 2 * pad)) / (data.length - 1);
          const y = pad + (h - 2 * pad) - (v / max) * (h - 2 * pad);
          return <circle key={i} cx={x} cy={y} r={1.5} fill="#ff7a59" />;
        })}
      </svg>
      <span style={{ fontSize: 10, color: trendCol, fontWeight: 700 }}>{trend}</span>
    </div>
  );
}
