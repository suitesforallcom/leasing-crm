// Left rail — navigation only (no duplicates of topbar actions)
// Collapsed icon rail with tooltip labels.

const LeftRail = ({ current, onChange }) => {
  const items = [
    { id: "overview",  icon: "grid",     label: "Overview" },
    { id: "leases",    icon: "file",     label: "Leases" },
    { id: "tenants",   icon: "people",   label: "Tenants" },
    { id: "billing",   icon: "dollar",   label: "Billing" },
    { id: "activity",  icon: "pulse",    label: "Activity" },
    { id: "reports",   icon: "printer",  label: "Reports" },
  ];
  const bottom = [
    { id: "goals",    icon: "trophy",   label: "Goals" },
    { id: "settings", icon: "settings", label: "Settings" },
  ];
  return (
    <aside style={railStyles.root}>
      <div style={railStyles.group}>
        {items.map(it => (
          <RailBtn key={it.id} item={it} active={current === it.id} onClick={() => onChange(it.id)}/>
        ))}
      </div>
      <div style={{ flex: 1 }}/>
      <div style={railStyles.group}>
        {bottom.map(it => (
          <RailBtn key={it.id} item={it} active={current === it.id} onClick={() => onChange(it.id)}/>
        ))}
      </div>
    </aside>
  );
};

const RailBtn = ({ item, active, onClick }) => {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...railStyles.btn,
        background: active ? THEME.accentSoft : (hover ? THEME.surfaceAlt : "transparent"),
        color: active ? THEME.accentInk : THEME.inkMuted,
      }}
    >
      <Icon name={item.icon} size={16}/>
      {hover && (
        <span style={railStyles.tooltip}>{item.label}</span>
      )}
    </button>
  );
};

const railStyles = {
  root: {
    width: 48,
    display: "flex", flexDirection: "column",
    padding: "10px 6px",
    background: THEME.surface,
    borderRight: `1px solid ${THEME.border}`,
    flexShrink: 0,
  },
  group: { display: "flex", flexDirection: "column", gap: 2 },
  btn: {
    position: "relative",
    width: 36, height: 36,
    display: "grid", placeItems: "center",
    border: "none", borderRadius: 8,
    cursor: "pointer",
    transition: "background 0.12s",
  },
  tooltip: {
    position: "absolute",
    left: "calc(100% + 10px)",
    top: "50%",
    transform: "translateY(-50%)",
    padding: "4px 8px",
    background: THEME.ink,
    color: THEME.surface,
    fontSize: 11, fontWeight: 500,
    borderRadius: 5,
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: 100,
  },
};

window.LeftRail = LeftRail;
