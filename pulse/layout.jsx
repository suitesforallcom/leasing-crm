/* global React, Icon, DATA */

/* ================================================================
   Layout shell — sidebar with sections + topbar with role switcher
   ================================================================ */

window.Sidebar = function Sidebar({ view, onNav, role }) {
  const onlineCount = DATA.USERS.filter(u => u.status === "online").length;
  const unusual = DATA.ALL_EVENTS.filter(e => e.isUnusual).length;

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">P</span>
        <div>
          <div className="brand-name">Pulse</div>
          <div className="brand-sub">Activity Center</div>
        </div>
      </div>

      {/* MY WORKSPACE — visible to everyone */}
      <div className="nav-section-title">My workspace</div>
      <NavItem id="myday" view={view} onNav={onNav} icon="sparkle" label="My Day" />
      <NavItem id="myjourney" view={view} onNav={onNav} icon="trendUp" label="My Journey" />
      <NavItem id="earn" view={view} onNav={onNav} icon="star" label="How to earn" />

      {/* ADMIN — only visible in owner mode */}
      {role === "owner" && (
        <>
          <div className="nav-divider" />
          <div className="nav-section-title">Owner · admin</div>
          <NavItem id="overview" view={view} onNav={onNav} icon="activity" label="Activity Center" />
          <NavItem id="people"   view={view} onNav={onNav} icon="people"   label="People"  count={onlineCount + " on"} isActive={view === "people" || view === "employee"} />
          <NavItem id="centers"  view={view} onNav={onNav} icon="building" label="Centers" count={DATA.CENTERS.length} />
          <NavItem id="compare"  view={view} onNav={onNav} icon="compare"  label="Compare" />
          <NavItem id="bonuses"  view={view} onNav={onNav} icon="star"     label="Bonuses" />
          <NavItem id="bonusrules" view={view} onNav={onNav} icon="settings" label="Bonus rules" />
          <NavItem id="alerts"   view={view} onNav={onNav} icon="warning"  label="Unusual" count={unusual || null} />

          <div className="nav-section">
            <div className="nav-section-title">Saved filters</div>
            {["Today by employee", "Contracts · this month", "Calls · leasing team", "Low activity users"].map(s => (
              <button key={s} className="nav-item" style={{ fontSize: 12.5 }} onClick={() => window.toast(`"${s}" filter loaded`, "success")}>
                <Icon name="star" />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div style={{ flex: 1 }} />

      <div className="nav-section">
        <button className="nav-item" onClick={() => window.toast("Settings coming soon")}>
          <Icon name="settings" />
          Settings
        </button>
      </div>
    </aside>
  );
};

function NavItem({ id, view, onNav, icon, label, count, isActive }) {
  const active = isActive != null ? isActive : view === id;
  return (
    <button className={"nav-item" + (active ? " is-active" : "")} onClick={() => onNav(id)}>
      <Icon name={icon} />
      {label}
      {count != null && <span className="count">{count}</span>}
    </button>
  );
}

window.Topbar = function Topbar({ view, employeeId, onNav, role, onRoleChange, meId, onMeIdChange, centerFilter, onCenterFilterChange, onOpenFilter, onOpenCmd, onOpenNotif, recentIds = [], onOpenEmployee }) {
  const employee = employeeId ? DATA.USERS.find(u => u.id === employeeId) : null;
  const [roleMenu, setRoleMenu] = React.useState(false);
  const [centerMenu, setCenterMenu] = React.useState(false);

  /* close menus on outside click */
  React.useEffect(() => {
    function onClick() { setRoleMenu(false); setCenterMenu(false); }
    if (roleMenu || centerMenu) {
      window.addEventListener("click", onClick);
      return () => window.removeEventListener("click", onClick);
    }
  }, [roleMenu, centerMenu]);

  const titleMap = {
    overview: "Activity",  people: "People",   compare: "Compare",
    bonuses: "Bonuses",    bonusrules: "Bonus rules",
    alerts: "Alerts",   centers: "Centers",
    myday: "My Day",       myjourney: "My Journey",   earn: "How to earn",
    employee: "People",
  };

  return (
    <div className="topbar">
      <div className="crumbs">
        <button onClick={() => onNav("overview")} style={{ color: "var(--muted)" }}>Pulse</button>
        <span className="sep">/</span>
        <span className="cur">{titleMap[view] || "—"}</span>
        {view === "employee" && employee && <><span className="sep">/</span><span className="cur" style={{ whiteSpace: "nowrap" }}>{employee.name}</span></>}
      </div>

      <div className="spacer" />

      {/* Center filter (admin only) */}
      {role === "owner" && view !== "myday" && (
        <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
          <button className="center-pill" onClick={() => setCenterMenu(v => !v)}>
            <Icon name="building" style={{ width: 14, height: 14 }} />
            <span style={{ fontWeight: 600 }}>
              {centerFilter === "all" ? "All centers" : DATA.CENTER_BY_ID[centerFilter]?.name || "All centers"}
            </span>
            <Icon name="chevD" style={{ width: 12, height: 12, opacity: .6 }} />
          </button>
          {centerMenu && (
            <div style={{
              position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 50,
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 10, padding: 6, minWidth: 220,
              boxShadow: "var(--shadow-lg)",
            }}>
              <MenuItem active={centerFilter === "all"} onClick={() => { onCenterFilterChange("all"); setCenterMenu(false); }}>
                <Icon name="globe" /> All centers
              </MenuItem>
              <div style={{ height: 1, background: "var(--border)", margin: 4 }} />
              {DATA.CENTERS.map(c => (
                <MenuItem key={c.id} active={centerFilter === c.id} onClick={() => { onCenterFilterChange(c.id); setCenterMenu(false); }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: c.color }} />
                  {c.name}
                  <span className="spacer" />
                  <span className="muted" style={{ fontSize: 11 }}>{DATA.USERS.filter(u => u.centerId === c.id).length}</span>
                </MenuItem>
              ))}
            </div>
          )}
        </div>
      )}

      <button className="search" onClick={onOpenCmd} style={{ cursor: "pointer", border: "1px solid var(--border)" }} title="Search (⌘K)">
        <Icon name="search" />
        <span style={{ flex: 1, textAlign: "left", color: "var(--muted)", fontSize: 13 }}>Search people, pages, actions…</span>
        <span className="kbd">⌘K</span>
      </button>

      <button className="ic-btn" onClick={onOpenNotif} title="Notifications" style={{ position: "relative" }}>
        <Icon name="bell" />
        <span style={{ position: "absolute", top: 5, right: 5, width: 7, height: 7, borderRadius: 999, background: "var(--danger)", border: "2px solid var(--surface)" }} />
      </button>

      {/* Role switcher */}
      <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
        <button className="center-pill" onClick={() => setRoleMenu(v => !v)} title="Switch view">
          <Icon name={role === "owner" ? "shield" : "user"} style={{ width: 14, height: 14, color: role === "owner" ? "var(--accent)" : "var(--success-ink)" }} />
          <span style={{ fontWeight: 600 }}>{role === "owner" ? "Owner view" : "Employee view"}</span>
          <Icon name="chevD" style={{ width: 12, height: 12, opacity: .6 }} />
        </button>
        {roleMenu && (
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 50,
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 10, padding: 6, minWidth: 260,
            boxShadow: "var(--shadow-lg)",
          }}>
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>Switch perspective</div>
            <MenuItem active={role === "owner"} onClick={() => { onRoleChange("owner"); setRoleMenu(false); window.toast("Now viewing as Owner — full admin access", "success"); }}>
              <Icon name="shield" />
              <div style={{ textAlign: "left" }}>
                <div style={{ fontWeight: 700 }}>Owner / Admin</div>
                <div className="muted" style={{ fontSize: 11 }}>See every employee, center, bonus</div>
              </div>
            </MenuItem>
            {/* Phase 11b — full list of impersonate-able employees. Real
                workspace members listed first, then demo seed. Click any
                to become them (role=employee + meId=their id). */}
            <div style={{ padding: "8px 10px", marginTop: 4, fontSize: 11, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", borderTop: "1px solid var(--border)" }}>View as employee</div>
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {[...DATA.USERS]
                .sort((a, b) => Number(!!b._isReal) - Number(!!a._isReal)) // real first
                .map(u => (
                <MenuItem key={u.id} active={role === "employee" && meId === u.id} onClick={() => {
                  if (typeof onMeIdChange === "function") onMeIdChange(u.id);
                  onRoleChange("employee");
                  setRoleMenu(false);
                  window.toast("Now viewing as " + u.name, "success");
                }}>
                  <Icon name="user" />
                  <div style={{ textAlign: "left" }}>
                    <div style={{ fontWeight: 700 }}>
                      {u.name}
                      {u._isReal && <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", background: "var(--success-soft)", color: "var(--success-ink)", borderRadius: 4, verticalAlign: "1px" }}>real</span>}
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>{u.email || (u.first + " " + u.last)}</div>
                  </div>
                </MenuItem>
              ))}
            </div>
          </div>
        )}
      </div>

      <button className="me" onClick={() => window.toast("Profile menu — coming soon")} title="Account">TO</button>
    </div>
  );
};

function MenuItem({ active, onClick, children }) {
  return (
    <button
      className="row"
      onClick={onClick}
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

window.MobileMenu = function MobileMenu({ view, onNav, role }) {
  const items = role === "owner" ? [
    { id: "overview", label: "Activity", icon: "activity" },
    { id: "people",   label: "People",   icon: "people" },
    { id: "centers",  label: "Centers",  icon: "building" },
    { id: "bonuses",  label: "Bonuses",  icon: "star" },
    { id: "myday",    label: "My Day",   icon: "sparkle" },
  ] : [
    { id: "myday",    label: "Today",    icon: "sparkle" },
    { id: "myjourney",label: "Journey",  icon: "trendUp" },
  ];
  return (
    <nav className="mobile-menu">
      {items.map(it => (
        <button
          key={it.id}
          className={view === it.id || (it.id === "people" && view === "employee") ? "is-active" : ""}
          onClick={() => onNav(it.id)}
        >
          <Icon name={it.icon} />
          {it.label}
        </button>
      ))}
    </nav>
  );
};
