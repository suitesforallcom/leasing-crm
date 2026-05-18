/* global React, Icon, DATA */

/* ================================================================
   Top-nav layout — horizontal nav variant (no sidebar)
   ================================================================ */

window.TopNavShell = function TopNavShell({
  view, onNav, role, onRoleChange, employeeId,
  centerFilter, onCenterFilterChange,
  onOpenCmd, onOpenNotif,
  children,
}) {
  const onlineCount = DATA.USERS.filter(u => u.status === "online").length;
  const unusual = DATA.ALL_EVENTS.filter(e => e.isUnusual).length;
  const [roleMenu, setRoleMenu] = React.useState(false);
  const [centerMenu, setCenterMenu] = React.useState(false);
  const [moreMenu, setMoreMenu] = React.useState(false);

  React.useEffect(() => {
    function onClick() { setRoleMenu(false); setCenterMenu(false); setMoreMenu(false); }
    if (roleMenu || centerMenu || moreMenu) {
      window.addEventListener("click", onClick);
      return () => window.removeEventListener("click", onClick);
    }
  }, [roleMenu, centerMenu, moreMenu]);

  /* Primary tabs depend on role */
  const ownerTabs = [
    { id: "overview", label: "Activity",  icon: "activity" },
    { id: "people",   label: "People",    icon: "people",   count: onlineCount },
    { id: "centers",  label: "Centers",   icon: "building" },
    { id: "compare",  label: "Compare",   icon: "compare" },
    { id: "bonuses",  label: "Bonuses",   icon: "star" },
    { id: "bonusrules", label: "Bonus rules", icon: "settings" },
    { id: "alerts",   label: "Unusual",   icon: "warning",  count: unusual || null },
    { id: "myday",    label: "My Day",    icon: "sparkle" },
  ];
  const employeeTabs = [
    { id: "myday",     label: "My Day",     icon: "sparkle" },
    { id: "myjourney", label: "My Journey", icon: "trendUp" },
    { id: "earn",      label: "How to earn", icon: "star" },
  ];
  const tabs = role === "owner" ? ownerTabs : employeeTabs;

  const currentTab = view === "employee" ? "people" : view;
  const employee = employeeId ? DATA.USERS.find(u => u.id === employeeId) : null;

  return (
    <div className="topnav-app">
      <header className="topnav-shell">
        {/* Row 1 — brand + global controls */}
        <div className="topnav-top">
          <button className="topnav-brand" onClick={() => onNav(role === "owner" ? "overview" : "myday")}>
            <span className="brand-mark">P</span>
            <span className="brand-text">
              <span className="brand-name">Pulse</span>
              <span className="brand-sub">Activity Center</span>
            </span>
          </button>

          <div className="topnav-search-wrap">
            <button className="topnav-search" onClick={onOpenCmd} title="Search (⌘K)">
              <Icon name="search" />
              <span>Search people, pages, actions…</span>
              <span className="kbd">⌘K</span>
            </button>
          </div>

          <div className="topnav-util">
            {/* Center filter */}
            {role === "owner" && (
              <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
                <button className="topnav-pill" onClick={() => setCenterMenu(v => !v)}>
                  <Icon name="building" />
                  <span>{centerFilter === "all" ? "All centers" : DATA.CENTER_BY_ID[centerFilter]?.short}</span>
                  <Icon name="chevD" />
                </button>
                {centerMenu && (
                  <DropMenu align="right">
                    <DropItem active={centerFilter === "all"} onClick={() => { onCenterFilterChange("all"); setCenterMenu(false); }}>
                      <Icon name="globe" /> All centers
                      <span className="spacer" />
                      <span className="muted" style={{ fontSize: 11 }}>{DATA.USERS.length}</span>
                    </DropItem>
                    <div className="drop-divider" />
                    {DATA.CENTERS.map(c => (
                      <DropItem key={c.id} active={centerFilter === c.id} onClick={() => { onCenterFilterChange(c.id); setCenterMenu(false); }}>
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: c.color }} />
                        {c.name}
                        <span className="spacer" />
                        <span className="muted" style={{ fontSize: 11 }}>{DATA.USERS.filter(u => u.centerId === c.id).length}</span>
                      </DropItem>
                    ))}
                  </DropMenu>
                )}
              </div>
            )}

            <button className="topnav-icon-btn" onClick={onOpenNotif} title="Notifications" style={{ position: "relative" }}>
              <Icon name="bell" />
              <span className="topnav-dot" />
            </button>

            {/* Role switcher */}
            <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
              <button className="topnav-pill" onClick={() => setRoleMenu(v => !v)}>
                <Icon name={role === "owner" ? "shield" : "user"} style={{ color: role === "owner" ? "var(--accent)" : "var(--success-ink)" }} />
                <span>{role === "owner" ? "Owner" : "Maya"}</span>
                <Icon name="chevD" />
              </button>
              {roleMenu && (
                <DropMenu align="right">
                  <div className="drop-h">View as</div>
                  <DropItem active={role === "owner"} onClick={() => { onRoleChange("owner"); setRoleMenu(false); window.toast("Now viewing as Owner", "success"); }}>
                    <Icon name="shield" />
                    <div style={{ textAlign: "left", flex: 1 }}>
                      <div style={{ fontWeight: 700 }}>Owner / Admin</div>
                      <div className="muted" style={{ fontSize: 11 }}>See everyone, all centers</div>
                    </div>
                  </DropItem>
                  <DropItem active={role === "employee"} onClick={() => { onRoleChange("employee"); setRoleMenu(false); window.toast("Now viewing as Maya", "success"); }}>
                    <Icon name="user" />
                    <div style={{ textAlign: "left", flex: 1 }}>
                      <div style={{ fontWeight: 700 }}>Employee (Maya)</div>
                      <div className="muted" style={{ fontSize: 11 }}>Personal view only</div>
                    </div>
                  </DropItem>
                </DropMenu>
              )}
            </div>

            <button className="topnav-me" title="Account" onClick={() => window.toast("Account menu — coming soon")}>TO</button>
          </div>
        </div>

        {/* Row 2 — primary tabs */}
        <nav className="topnav-tabs">
          {tabs.map(t => (
            <button
              key={t.id}
              className={"topnav-tab" + (currentTab === t.id ? " is-active" : "")}
              onClick={() => onNav(t.id)}
            >
              <Icon name={t.icon} />
              {t.label}
              {t.count != null && <span className="topnav-tab-count">{t.count}</span>}
            </button>
          ))}

          {role === "owner" && (
            <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
              <button className="topnav-tab" onClick={() => setMoreMenu(v => !v)}>
                <Icon name="more" />
                More
              </button>
              {moreMenu && (
                <DropMenu align="left" top="100%">
                  <div className="drop-h">Saved filters</div>
                  {["Today by employee", "Contracts · this month", "Calls · leasing team", "Low activity users", "Unusual logins"].map(s => (
                    <DropItem key={s} onClick={() => { window.toast(`"${s}" filter loaded`, "success"); setMoreMenu(false); }}>
                      <Icon name="star" />{s}
                    </DropItem>
                  ))}
                  <div className="drop-divider" />
                  <DropItem onClick={() => { window.toast("Settings — coming soon"); setMoreMenu(false); }}>
                    <Icon name="settings" />Settings
                  </DropItem>
                </DropMenu>
              )}
            </div>
          )}

          <div style={{ flex: 1 }} />

          {/* Right-side breadcrumb when on employee detail */}
          {view === "employee" && employee && (
            <div className="topnav-crumb">
              <Icon name="chevR" />
              <span className="muted">People /</span>
              <span style={{ fontWeight: 600, color: "var(--ink)" }}>{employee.name}</span>
            </div>
          )}
        </nav>
      </header>

      <main className="topnav-content">{children}</main>
    </div>
  );
};

function DropMenu({ align = "right", top, children }) {
  const style = {
    position: "absolute",
    top: top || "calc(100% + 6px)",
    [align === "right" ? "right" : "left"]: 0,
    zIndex: 50,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: 6,
    minWidth: 240,
    boxShadow: "var(--shadow-lg)",
  };
  return <div style={style}>{children}</div>;
}

function DropItem({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className="row drop-item"
      style={{
        width: "100%", padding: "8px 10px", borderRadius: 6,
        textAlign: "left", fontSize: 13,
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent-ink)" : "var(--ink-2)",
      }}
    >
      {children}
      {active && <Icon name="check" style={{ marginLeft: "auto", color: "var(--accent)" }} />}
    </button>
  );
}
