// Topbar — contextual, compact. Only what the property manager needs to orient:
// building + floor selector, search, notifications, user.
// Removed from previous: standalone "Info" pill, generic "+" button, "Live sync" button,
// "$8,225" floating number without context.

const Topbar = ({
  currentFloor, floors, onFloorChange,
  overdueAmount, overdueCount, onOpenOverdue,
  onSearchFocus, query, setQuery,
  density, onToggleDensity,
  dark, onToggleDark,
}) => {
  return (
    <header style={topbarStyles.root}>
      {/* Brand + building */}
      <div style={topbarStyles.brand}>
        <div style={topbarStyles.logo}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="5" height="5" rx="1" fill={THEME.accent}/>
            <rect x="9" y="2" width="5" height="5" rx="1" fill={THEME.accent} opacity="0.5"/>
            <rect x="2" y="9" width="5" height="5" rx="1" fill={THEME.accent} opacity="0.5"/>
            <rect x="9" y="9" width="5" height="5" rx="1" fill={THEME.accent}/>
          </svg>
        </div>
        <div style={topbarStyles.buildingBtn}>
          <div style={topbarStyles.buildingThumb}>
            <svg width="100%" height="100%" viewBox="0 0 40 28" preserveAspectRatio="xMidYMid slice">
              <rect width="40" height="28" fill="#C9D4C4"/>
              <rect x="6" y="10" width="28" height="14" fill="#6B7E68"/>
              <rect x="9" y="13" width="3" height="3" fill="#FAF9F7"/>
              <rect x="14" y="13" width="3" height="3" fill="#FAF9F7"/>
              <rect x="19" y="13" width="3" height="3" fill="#FAF9F7"/>
              <rect x="24" y="13" width="3" height="3" fill="#FAF9F7"/>
              <rect x="29" y="13" width="3" height="3" fill="#FAF9F7"/>
              <rect x="9" y="18" width="3" height="3" fill="#FAF9F7"/>
              <rect x="14" y="18" width="3" height="3" fill="#FAF9F7"/>
              <rect x="19" y="18" width="3" height="3" fill="#FAF9F7"/>
              <rect x="24" y="18" width="3" height="3" fill="#FAF9F7"/>
              <rect x="29" y="18" width="3" height="3" fill="#FAF9F7"/>
            </svg>
          </div>
          <div style={topbarStyles.buildingText}>
            <div style={topbarStyles.buildingName}>SuitesForAll</div>
            <div style={topbarStyles.buildingAddr}>6698 68th Ave N · Pinellas Park, FL</div>
          </div>
          <Icon name="chevronDown" size={14} style={{ color: THEME.inkSubtle, marginLeft: 4 }}/>
        </div>
      </div>

      {/* Floor tabs */}
      <div style={topbarStyles.floorTabs}>
        {floors.map(f => {
          const active = f.id === currentFloor;
          return (
            <button
              key={f.id}
              onClick={() => onFloorChange(f.id)}
              style={{
                ...topbarStyles.floorTab,
                ...(active ? topbarStyles.floorTabActive : {}),
              }}
            >
              <span style={topbarStyles.floorTabNum}>{f.id}</span>
              <span style={topbarStyles.floorTabLabel}>Floor</span>
            </button>
          );
        })}
        <div style={topbarStyles.floorTabDivider}/>
        <button style={topbarStyles.stackingBtn} title="Stacking view">
          <Icon name="layers" size={14}/>
          <span>Stacking</span>
        </button>
      </div>

      {/* Search */}
      <div style={topbarStyles.searchWrap}>
        <Icon name="search" size={14} style={{ color: THEME.inkSubtle }}/>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={onSearchFocus}
          placeholder="Search suite or tenant…"
          style={topbarStyles.search}
        />
        <kbd style={topbarStyles.kbd}>⌘K</kbd>
      </div>

      {/* Right side: alert + density + dark + user */}
      <div style={topbarStyles.right}>
        {overdueCount > 0 && (
          <button onClick={onOpenOverdue} style={topbarStyles.alert}>
            <span style={topbarStyles.alertDot}/>
            <span style={topbarStyles.alertLabel}>{overdueCount} overdue</span>
            <span style={topbarStyles.alertAmount}>{fmt$(overdueAmount)}</span>
          </button>
        )}
        <button style={topbarStyles.iconBtn} title="Toggle density" onClick={onToggleDensity}>
          <Icon name={density === "compact" ? "grid" : "move"} size={15}/>
        </button>
        <button style={topbarStyles.iconBtn} title="Toggle theme" onClick={onToggleDark}>
          <Icon name={dark ? "sun" : "moon"} size={15}/>
        </button>
        <button style={topbarStyles.iconBtn} title="Notifications">
          <Icon name="bell" size={15}/>
          <span style={topbarStyles.bellDot}/>
        </button>
        <div style={topbarStyles.user}>
          <div style={topbarStyles.avatar}>TZ</div>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: THEME.ink }}>Tony Zhukovskyi</span>
            <span style={{ fontSize: 10, color: THEME.inkSubtle, letterSpacing: 0.4 }}>ADMIN</span>
          </div>
        </div>
      </div>
    </header>
  );
};

const topbarStyles = {
  root: {
    height: 56,
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "0 16px",
    background: THEME.surface,
    borderBottom: `1px solid ${THEME.border}`,
    flexShrink: 0,
  },
  brand: { display: "flex", alignItems: "center", gap: 10 },
  logo: {
    width: 28, height: 28, borderRadius: 8,
    background: THEME.accentSoft,
    display: "grid", placeItems: "center",
  },
  buildingBtn: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "4px 8px 4px 4px",
    border: `1px solid ${THEME.border}`,
    borderRadius: 10,
    cursor: "pointer",
    background: THEME.surface,
  },
  buildingThumb: { width: 34, height: 26, borderRadius: 6, overflow: "hidden" },
  buildingText: { display: "flex", flexDirection: "column", lineHeight: 1.1 },
  buildingName: { fontSize: 12, fontWeight: 600, color: THEME.ink },
  buildingAddr: { fontSize: 10, color: THEME.inkSubtle },

  floorTabs: {
    display: "flex", alignItems: "center", gap: 2,
    padding: 3,
    background: THEME.surfaceAlt,
    borderRadius: 10,
  },
  floorTab: {
    display: "flex", flexDirection: "column", alignItems: "center",
    padding: "4px 10px",
    border: "none",
    background: "transparent",
    borderRadius: 7,
    cursor: "pointer",
    color: THEME.inkMuted,
    lineHeight: 1,
  },
  floorTabActive: {
    background: THEME.surface,
    color: THEME.ink,
    boxShadow: THEME.shadowSm,
  },
  floorTabNum: { fontSize: 13, fontWeight: 600 },
  floorTabLabel: { fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2, color: THEME.inkSubtle },

  floorTabDivider: { width: 1, height: 20, background: THEME.border, margin: "0 4px" },
  stackingBtn: {
    display: "flex", alignItems: "center", gap: 6,
    padding: "6px 10px",
    border: "none", background: "transparent",
    borderRadius: 7, cursor: "pointer",
    color: THEME.inkMuted,
    fontSize: 12, fontWeight: 500,
  },

  searchWrap: {
    flex: 1,
    display: "flex", alignItems: "center", gap: 8,
    padding: "6px 10px",
    background: THEME.surfaceAlt,
    border: `1px solid transparent`,
    borderRadius: 8,
    maxWidth: 320,
  },
  search: {
    flex: 1,
    border: "none", outline: "none", background: "transparent",
    fontSize: 13, color: THEME.ink,
    fontFamily: "inherit",
  },
  kbd: {
    fontSize: 10, fontFamily: "ui-monospace, monospace",
    color: THEME.inkSubtle,
    padding: "2px 6px",
    border: `1px solid ${THEME.border}`,
    borderRadius: 4,
    background: THEME.surface,
  },

  right: { display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" },

  alert: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "5px 10px 5px 8px",
    background: THEME.overdueSoft,
    border: `1px solid ${THEME.overdueSoft}`,
    borderRadius: 8,
    cursor: "pointer",
    color: THEME.overdueInk,
  },
  alertDot: {
    width: 6, height: 6, borderRadius: 3, background: THEME.overdue,
    boxShadow: `0 0 0 3px ${THEME.overdueSoft}`,
  },
  alertLabel: { fontSize: 12, fontWeight: 500 },
  alertAmount: { fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums" },

  iconBtn: {
    position: "relative",
    width: 32, height: 32,
    display: "grid", placeItems: "center",
    border: "none", background: "transparent",
    borderRadius: 7, cursor: "pointer",
    color: THEME.inkMuted,
  },
  bellDot: {
    position: "absolute", top: 7, right: 8,
    width: 6, height: 6, borderRadius: 3,
    background: THEME.overdue,
    border: `1.5px solid ${THEME.surface}`,
  },
  user: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "4px 10px 4px 4px",
    border: `1px solid ${THEME.border}`,
    borderRadius: 8,
    cursor: "pointer",
  },
  avatar: {
    width: 26, height: 26, borderRadius: 6,
    background: THEME.accent,
    color: "#fff",
    display: "grid", placeItems: "center",
    fontSize: 10, fontWeight: 600,
  },
};

window.Topbar = Topbar;
