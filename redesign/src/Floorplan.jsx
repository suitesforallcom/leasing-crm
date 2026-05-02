// Floorplan — the hero. Renders suites with status-based coloring.
// Hover shows a richer tooltip; click selects.

const Floorplan = ({
  suites, commonAreas,
  selectedId, onSelect,
  hoveredId, onHover,
  colorMode, // "status" | "type" | "rent"
  overlays,  // { overdue, pendingSignature, newTenant }
  zoom, setZoom,
}) => {
  const svgRef = React.useRef(null);

  // Viewport
  const VB_W = 1040, VB_H = 880;

  const getFill = (s) => {
    if (colorMode === "type") {
      return s.type === "window" ? "#E8EFE4" : "#F4F2EE";
    }
    if (colorMode === "rent") {
      // Heatmap by $/sqft
      const perSqft = s.rent / s.sqft;
      // normalize 2..12
      const t = Math.max(0, Math.min(1, (perSqft - 2) / 10));
      const hue = 145 - t * 145; // green→red
      return `oklch(0.92 0.05 ${hue})`;
    }
    // status mode
    const meta = STATUS_META[s.status];
    return meta ? meta.bg : "#fff";
  };

  const getStroke = (s) => {
    if (selectedId === s.id) return THEME.accent;
    if (hoveredId === s.id) return THEME.borderStrong;
    if (s.status === "vacant") return THEME.borderStrong;
    return THEME.border;
  };

  const getStrokeWidth = (s) => {
    if (selectedId === s.id) return 2;
    return 1;
  };

  const getDash = (s) => {
    if (colorMode === "status" && s.status === "vacant") return "3 3";
    return null;
  };

  // Overlay badges
  const renderOverlay = (s) => {
    const badges = [];
    if (overlays.overdue && s.status === "overdue") {
      badges.push(<circle key="ov" cx={s.x + s.w - 10} cy={s.y + 10} r={6} fill={THEME.overdue}/>);
      badges.push(<text key="ov-t" x={s.x + s.w - 10} y={s.y + 13} textAnchor="middle" fontSize={9} fill="#fff" fontWeight={700}>!</text>);
    }
    if (overlays.pendingSignature && s.status === "pending-signature") {
      badges.push(
        <g key="sig" transform={`translate(${s.x + s.w - 18}, ${s.y + 4})`}>
          <rect width={14} height={14} rx={3} fill={THEME.pending}/>
          <path d="M3 9s1.5-4 3-4 1 4 2.5 4 1-2 2.5-2" stroke="#fff" strokeWidth={1.3} fill="none" strokeLinecap="round"/>
        </g>
      );
    }
    if (overlays.newTenant && s.newTenant) {
      badges.push(
        <g key="new" transform={`translate(${s.x + 4}, ${s.y + 4})`}>
          <circle cx={6} cy={6} r={6} fill={THEME.newStar}/>
          <path d="M6 2l1.2 2.4 2.6.3-1.9 1.8.5 2.6L6 7.9 3.6 9.1l.5-2.6L2.2 4.7l2.6-.3L6 2z" fill="#fff"/>
        </g>
      );
    }
    return badges;
  };

  return (
    <div style={fpStyles.root}>
      {/* Color-mode segmented control */}
      <div style={fpStyles.topControls}>
        <div style={fpStyles.segGroup}>
          {[
            { id: "status", label: "Lease status" },
            { id: "type",   label: "Unit type" },
            { id: "rent",   label: "Rent heatmap" },
          ].map(m => (
            <button
              key={m.id}
              onClick={() => window.__setColorMode?.(m.id)}
              style={{
                ...fpStyles.segBtn,
                ...(colorMode === m.id ? fpStyles.segBtnActive : {}),
              }}
            >{m.label}</button>
          ))}
        </div>
        <div style={{ flex: 1 }}/>
        <div style={fpStyles.floorLabel}>
          <Icon name="building" size={13} style={{ color: THEME.inkSubtle }}/>
          <span>4th Floor · Floorplan</span>
        </div>
      </div>

      {/* Plan SVG */}
      <div style={fpStyles.svgWrap}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: "100%", height: "100%", display: "block" }}
        >
          {/* Subtle floor outline */}
          <defs>
            <pattern id="gridDots" width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.5" fill={THEME.gridLine}/>
            </pattern>
          </defs>
          <rect width={VB_W} height={VB_H} fill="url(#gridDots)"/>

          {/* Building outline */}
          <rect x={40} y={40} width={960} height={800} rx={6}
            fill={THEME.surface} stroke={THEME.border} strokeWidth={1.5}/>

          {/* Common areas */}
          {commonAreas.map(ca => (
            <g key={ca.id}>
              <rect
                x={ca.x} y={ca.y} width={ca.w} height={ca.h}
                fill={THEME.common} stroke={THEME.border} strokeWidth={0.5}
              />
              {ca.label && (
                <text
                  x={ca.x + ca.w/2} y={ca.y + ca.h/2}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={9} fill={THEME.commonInk}
                  fontWeight={500}
                  letterSpacing={0.5}
                >{ca.label}</text>
              )}
            </g>
          ))}

          {/* Suites */}
          {suites.map(s => {
            const isSel = selectedId === s.id;
            const isHover = hoveredId === s.id;
            const showDetail = isSel || isHover || (s.w > 85 && s.h > 75);
            return (
              <g
                key={s.id}
                onMouseEnter={() => onHover(s.id)}
                onMouseLeave={() => onHover(null)}
                onClick={() => onSelect(s.id)}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={s.x} y={s.y} width={s.w} height={s.h}
                  fill={getFill(s)}
                  stroke={getStroke(s)}
                  strokeWidth={getStrokeWidth(s)}
                  strokeDasharray={getDash(s)}
                  rx={2}
                />
                {/* Suite number — always visible */}
                <text
                  x={s.x + 5} y={s.y + 13}
                  fontSize={10} fontWeight={600}
                  fill={THEME.ink}
                >{s.id}</text>
                {/* Rent — visible when big enough OR selected/hover */}
                {showDetail && (
                  <text
                    x={s.x + 5} y={s.y + 26}
                    fontSize={9} fill={THEME.inkMuted}
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >${s.rent.toLocaleString()}</text>
                )}
                {/* Tenant name — only when big or selected */}
                {(isSel || isHover || (s.w > 85 && s.h > 85)) && s.tenant !== "—" && (
                  <text
                    x={s.x + 5} y={s.y + 38}
                    fontSize={8.5} fill={THEME.inkSubtle}
                    style={{ pointerEvents: "none" }}
                  >
                    {s.tenant.length > 14 ? s.tenant.slice(0, 13) + "…" : s.tenant}
                  </text>
                )}
                {/* Window indicator — small bracket on top edge if window type */}
                {s.type === "window" && (
                  <line
                    x1={s.x + 12} y1={s.y - 0.5}
                    x2={s.x + s.w - 12} y2={s.y - 0.5}
                    stroke={THEME.pending} strokeWidth={2}
                  />
                )}
                {/* Overlays */}
                {renderOverlay(s)}
              </g>
            );
          })}

          {/* Compass */}
          <g transform={`translate(${VB_W - 60}, 60)`}>
            <circle r={18} fill={THEME.surface} stroke={THEME.border}/>
            <path d="M0 -12 L4 0 L0 -4 L-4 0 Z" fill={THEME.ink}/>
            <text x={0} y={-14} textAnchor="middle" fontSize={8} fill={THEME.inkMuted} fontWeight={600}>N</text>
          </g>

          {/* Scale bar */}
          <g transform={`translate(60, ${VB_H - 40})`}>
            <line x1={0} y1={0} x2={80} y2={0} stroke={THEME.ink} strokeWidth={1.5}/>
            <line x1={0} y1={-3} x2={0} y2={3} stroke={THEME.ink} strokeWidth={1.5}/>
            <line x1={40} y1={-3} x2={40} y2={3} stroke={THEME.ink} strokeWidth={1.5}/>
            <line x1={80} y1={-3} x2={80} y2={3} stroke={THEME.ink} strokeWidth={1.5}/>
            <text x={40} y={15} textAnchor="middle" fontSize={9} fill={THEME.inkMuted}>20 ft</text>
          </g>
        </svg>
      </div>

      {/* Bottom legend bar — compact, inline */}
      <div style={fpStyles.legend}>
        {colorMode === "status" && (
          <>
            <LegendItem color={THEME.paid}     label="Paid"/>
            <LegendItem color={THEME.due}      label="Due"/>
            <LegendItem color={THEME.overdue}  label="Overdue"/>
            <LegendItem color={THEME.reserved} label="Reserved"/>
            <LegendItem color={THEME.pending}  label="Awaiting signature"/>
            <LegendItem color="#fff" border={THEME.borderStrong} dashed label="Vacant"/>
          </>
        )}
        {colorMode === "type" && (
          <>
            <LegendItem color="#E8EFE4" label="Window"/>
            <LegendItem color="#F4F2EE" label="Interior"/>
            <LegendItem color={THEME.common} label="Common"/>
          </>
        )}
        {colorMode === "rent" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: THEME.inkSubtle }}>$/ft²</span>
            <div style={{
              width: 120, height: 10, borderRadius: 5,
              background: "linear-gradient(90deg, oklch(0.92 0.05 145), oklch(0.92 0.05 75), oklch(0.92 0.05 0))",
              border: `1px solid ${THEME.border}`,
            }}/>
            <span style={{ fontSize: 11, color: THEME.inkMuted }}>$2 – $12</span>
          </div>
        )}

        <div style={{ flex: 1 }}/>

        {/* Overlay toggles */}
        <div style={fpStyles.overlayToggles}>
          <OverlayToggle
            active={overlays.overdue}
            onClick={() => window.__toggleOverlay?.("overdue")}
            color={THEME.overdue}
            label="Overdue"
          />
          <OverlayToggle
            active={overlays.pendingSignature}
            onClick={() => window.__toggleOverlay?.("pendingSignature")}
            color={THEME.pending}
            label="Signatures"
          />
          <OverlayToggle
            active={overlays.newTenant}
            onClick={() => window.__toggleOverlay?.("newTenant")}
            color={THEME.newStar}
            label="New (30d)"
          />
        </div>
      </div>

      {/* Zoom controls (floating, bottom-left) */}
      <div style={fpStyles.zoom}>
        <button style={fpStyles.zoomBtn} onClick={() => setZoom(z => Math.min(2, z + 0.1))}>
          <Icon name="zoomIn" size={14}/>
        </button>
        <div style={fpStyles.zoomReadout}>{Math.round(zoom * 100)}%</div>
        <button style={fpStyles.zoomBtn} onClick={() => setZoom(z => Math.max(0.5, z - 0.1))}>
          <Icon name="zoomOut" size={14}/>
        </button>
      </div>
    </div>
  );
};

const LegendItem = ({ color, border, dashed, label }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
    <div style={{
      width: 14, height: 10, borderRadius: 2,
      background: color,
      border: `1px ${dashed ? "dashed" : "solid"} ${border || color}`,
    }}/>
    <span style={{ fontSize: 11, color: THEME.inkMuted }}>{label}</span>
  </div>
);

const OverlayToggle = ({ active, onClick, color, label }) => (
  <button
    onClick={onClick}
    style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "4px 9px",
      border: `1px solid ${active ? color : THEME.border}`,
      background: active ? `${color}14` : "transparent",
      color: active ? color : THEME.inkMuted,
      borderRadius: 6,
      fontSize: 11, fontWeight: 500,
      cursor: "pointer",
    }}
  >
    <span style={{ width: 6, height: 6, borderRadius: 3, background: active ? color : THEME.inkSubtle }}/>
    {label}
  </button>
);

const fpStyles = {
  root: {
    flex: 1,
    display: "flex", flexDirection: "column",
    background: THEME.bg,
    minWidth: 0,
    position: "relative",
  },
  topControls: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 16px",
    borderBottom: `1px solid ${THEME.border}`,
    background: THEME.surface,
  },
  segGroup: {
    display: "flex",
    padding: 2,
    background: THEME.surfaceAlt,
    borderRadius: 7,
  },
  segBtn: {
    padding: "4px 10px",
    border: "none", background: "transparent",
    borderRadius: 5, cursor: "pointer",
    fontSize: 11, fontWeight: 500,
    color: THEME.inkMuted,
  },
  segBtnActive: {
    background: THEME.surface,
    color: THEME.ink,
    boxShadow: THEME.shadowSm,
  },
  floorLabel: {
    display: "flex", alignItems: "center", gap: 6,
    fontSize: 11, color: THEME.inkMuted,
    fontVariantNumeric: "tabular-nums",
  },
  svgWrap: {
    flex: 1,
    overflow: "hidden",
    padding: 20,
    position: "relative",
  },
  legend: {
    display: "flex", alignItems: "center", gap: 14,
    padding: "10px 16px",
    borderTop: `1px solid ${THEME.border}`,
    background: THEME.surface,
    flexWrap: "wrap",
  },
  overlayToggles: { display: "flex", gap: 6 },
  zoom: {
    position: "absolute",
    left: 16, bottom: 70,
    display: "flex", flexDirection: "column", alignItems: "center",
    background: THEME.surface,
    border: `1px solid ${THEME.border}`,
    borderRadius: 8,
    boxShadow: THEME.shadowMd,
    overflow: "hidden",
  },
  zoomBtn: {
    width: 28, height: 28,
    display: "grid", placeItems: "center",
    border: "none", background: "transparent",
    cursor: "pointer", color: THEME.inkMuted,
  },
  zoomReadout: {
    fontSize: 10, color: THEME.inkSubtle,
    padding: "2px 0",
    borderTop: `1px solid ${THEME.border}`,
    borderBottom: `1px solid ${THEME.border}`,
    width: "100%", textAlign: "center",
    fontVariantNumeric: "tabular-nums",
  },
};

window.Floorplan = Floorplan;
