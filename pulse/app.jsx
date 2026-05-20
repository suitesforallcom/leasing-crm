/* global React, ReactDOM, Sidebar, Topbar, MobileMenu, OverviewPage, EmployeeDetail, ComparePage, AlertsPage, PeoplePage, BonusesPage, BonusRulesPage, CentersPage, MyDayPage, MyJourneyPage, EarnPage, EventDrawer, FilterDrawer, MessageDrawer, QuickActionDrawer, CommandPalette, NotificationPanel, KudosDrawer, useTweaks, TweaksPanel, TweakRadio, TweakToggle, TweakSection */

/* ================================================================
   App root — view routing + global form/drawer state
   ================================================================ */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "indigo",
  "density": "comfortable",
  "showLiveDot": true,
  "showSparklines": true
}/*EDITMODE-END*/;

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  /* Routing */
  const [view, setView] = React.useState("overview");
  const [employeeId, setEmployeeId] = React.useState(null);
  const [employeeTab, setEmployeeTab] = React.useState("performance");
  const [compareInit, setCompareInit] = React.useState(null);

  /* Global filters */
  const [centerFilter, setCenterFilter] = React.useState("all");
  const [role, setRole] = React.useState("owner");
  /* Phase 11b — meId chooses which employee is "me" when role=employee.
     Default to first real employee if any, else seed u1 (Maya). */
  const [meId, setMeId] = React.useState(() => {
    // Phase 17 rev — после удаления демо-сидов "u1" может не существовать.
    // Берём первого реального user; если их нет — первый из DATA.USERS;
    // если массив пустой — null (компоненты должны это переварить).
    const users = window.DATA?.USERS || [];
    const real = users.find(u => u && u._isReal);
    if (real) return real.id;
    if (users.length > 0 && users[0] && users[0].id) return users[0].id;
    return null;
  });

  /* Drawer state */
  const [drawerEvent, setDrawerEvent] = React.useState(null);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [messageTo, setMessageTo] = React.useState(null);
  const [quickOpen, setQuickOpen] = React.useState(false);
  const [kudosTo, setKudosTo] = React.useState(null);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [notifOpen, setNotifOpen] = React.useState(false);
  const [recentIds, setRecentIds] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem("pulse_recent") || "[]"); } catch (e) { return []; }
  });

  /* Global keyboard — ⌘K / Ctrl+K toggles command palette */
  React.useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen(o => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function pushRecent(id) {
    const next = [id, ...recentIds.filter(x => x !== id)].slice(0, 5);
    setRecentIds(next);
    try { localStorage.setItem("pulse_recent", JSON.stringify(next)); } catch (e) {}
  }

  /* When role changes to employee, force MyDay view */
  React.useEffect(() => {
    if (role === "employee" && view !== "myday") setView("myday");
  }, [role]);

  function nav(v) {
    /* Employee can only see their own personal pages */
    if (role === "employee" && v !== "myday" && v !== "myjourney" && v !== "earn") {
      window.toast("This page is admin-only — switch to Owner view in the top bar.");
      return;
    }
    setView(v);
    if (v !== "employee") setEmployeeId(null);
  }
  function openEmployee(id) {
    if (role === "employee" && id !== meId) {
      window.toast("Employees only see their own profile.");
      return;
    }
    setEmployeeId(id);
    setEmployeeTab("performance");
    setView("employee");
    pushRecent(id);
    window.scrollTo({ top: 0 });
  }
  function compareAdd(id) {
    // Phase 17 rev — defaults pull from live DATA.USERS (top-2 by score
    // excluding clicked user). Demo seed IDs ["u3","u9"] больше не
    // существуют после removal of seeds → compare.jsx крашил.
    const users = window.DATA?.USERS || [];
    const others = users
      .filter(u => u && u.id !== id)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 3)
      .map(u => u.id);
    setCompareInit([id, ...others].filter((v, i, a) => a.indexOf(v) === i).slice(0, 4));
    setView("compare");
  }
  function openMessage(user) {
    setMessageTo(user);
  }

  /* Apply tweaks via root data attrs / CSS vars */
  React.useEffect(() => {
    const root = document.documentElement;
    const accents = { indigo: "264", emerald: "150", sunset: "30", violet: "300" };
    root.style.setProperty("--accent", `oklch(56% 0.17 ${accents[tweaks.accent] || 264})`);
    root.style.setProperty("--accent-2", `oklch(50% 0.18 ${accents[tweaks.accent] || 264})`);
    root.style.setProperty("--accent-soft", `oklch(96% 0.03 ${accents[tweaks.accent] || 264})`);
    root.style.setProperty("--accent-ink", `oklch(35% 0.14 ${accents[tweaks.accent] || 264})`);
    if (tweaks.density === "compact") {
      root.style.setProperty("--s-3", "8px");
      root.style.setProperty("--s-4", "12px");
      root.style.setProperty("--s-6", "18px");
    } else {
      root.style.setProperty("--s-3", "12px");
      root.style.setProperty("--s-4", "16px");
      root.style.setProperty("--s-6", "24px");
    }
  }, [tweaks]);

  return (
    <div className="app">
      <Sidebar view={view} onNav={nav} role={role} />
      <main>
        <Topbar
          view={view}
          employeeId={employeeId}
          onNav={nav}
          role={role}
          onRoleChange={setRole}
          meId={meId}
          onMeIdChange={setMeId}
          centerFilter={centerFilter}
          onCenterFilterChange={setCenterFilter}
          onOpenFilter={() => setFilterOpen(true)}
          onOpenCmd={() => setCmdOpen(true)}
          onOpenNotif={() => setNotifOpen(true)}
          recentIds={recentIds}
          onOpenEmployee={openEmployee}
        />

        {view === "myday" && (
          <MyDayPage
            meId={meId}
            onOpenEmployee={(id) => openEmployee(id)}
            onOpenQuickAction={() => setQuickOpen(true)}
            onOpenJourney={() => setView("myjourney")}
          />
        )}
        {view === "myjourney" && (
          <MyJourneyPage
            meId={meId}
            onBack={() => setView("myday")}
          />
        )}
        {view === "earn" && (
          <EarnPage meId={meId} onBack={() => setView("myday")} />
        )}
        {view === "overview" && role === "owner" && (
          <OverviewPage
            centerFilter={centerFilter}
            onOpenEmployee={openEmployee}
            onOpenEvent={setDrawerEvent}
            onNav={nav}
            onOpenFilter={() => setFilterOpen(true)}
          />
        )}
        {view === "people" && role === "owner" && (
          <PeoplePage centerFilter={centerFilter} onOpenEmployee={openEmployee} />
        )}
        {view === "centers" && role === "owner" && (
          <CentersPage onOpenEmployee={openEmployee} />
        )}
        {view === "employee" && (
          <EmployeeDetail
            employeeId={employeeId}
            tab={employeeTab}
            onTab={setEmployeeTab}
            onOpenEvent={setDrawerEvent}
            onBack={() => nav(role === "owner" ? "overview" : "myday")}
            onCompareAdd={compareAdd}
            onMessage={openMessage}
            onOpenFilter={() => setFilterOpen(true)}
            onSendKudos={(u) => setKudosTo(u)}
            role={role}
          />
        )}
        {view === "compare" && role === "owner" && (
          <ComparePage initial={compareInit} onOpenEmployee={openEmployee} />
        )}
        {view === "bonuses" && role === "owner" && (
          <BonusesPage onOpenEmployee={openEmployee} />
        )}
        {view === "bonusrules" && role === "owner" && (
          <BonusRulesPage onOpenEmployee={openEmployee} />
        )}
        {view === "alerts" && role === "owner" && (
          <AlertsPage onOpenEmployee={openEmployee} onOpenEvent={setDrawerEvent} />
        )}
      </main>

      <EventDrawer
        event={drawerEvent}
        onClose={() => setDrawerEvent(null)}
        onOpenEmployee={(id) => { setDrawerEvent(null); openEmployee(id); }}
      />

      <FilterDrawer
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        initial={{}}
        onApply={() => {}}
      />

      <MessageDrawer
        open={!!messageTo}
        onClose={() => setMessageTo(null)}
        to={messageTo}
      />

      <QuickActionDrawer
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
      />

      <KudosDrawer
        open={!!kudosTo}
        onClose={() => setKudosTo(null)}
        to={kudosTo}
      />

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onNavPage={(id) => nav(id)}
        onOpenEmployee={openEmployee}
        onAction={(id) => {
          if (id === "export")   window.toast("Activity exported as CSV", "success");
          else if (id === "filter")   setFilterOpen(true);
          else if (id === "quicklog") setQuickOpen(true);
          else if (id === "kudos")    setKudosTo(DATA.USERS[2]);
          else if (id === "explainScore") window.openScoreExplainer(DATA.USERS[0]);
        }}
        recentIds={recentIds}
      />

      <NotificationPanel
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        onOpenEmployee={openEmployee}
        onNav={nav}
      />

      <MobileMenu view={view} onNav={nav} role={role} />

      <TweaksPanel title="Tweaks">
        <TweakSection title="Theme">
          <TweakRadio
            label="Accent color"
            value={tweaks.accent}
            onChange={(v) => setTweak("accent", v)}
            options={[
              { label: "Indigo",  value: "indigo" },
              { label: "Emerald", value: "emerald" },
              { label: "Sunset",  value: "sunset" },
              { label: "Violet",  value: "violet" },
            ]}
          />
          <TweakRadio
            label="Density"
            value={tweaks.density}
            onChange={(v) => setTweak("density", v)}
            options={[
              { label: "Comfortable", value: "comfortable" },
              { label: "Compact",     value: "compact" },
            ]}
          />
        </TweakSection>
        <TweakSection title="Display">
          <TweakToggle
            label="Live activity badge"
            value={tweaks.showLiveDot}
            onChange={(v) => setTweak("showLiveDot", v)}
          />
          <TweakToggle
            label="Person card sparklines"
            value={tweaks.showSparklines}
            onChange={(v) => setTweak("showSparklines", v)}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

/* Error boundary — prevents blank-page-on-crash. Wraps App so any
   uncaught render error shows a readable message + recovery buttons
   instead of a totally empty viewport (operator can no longer tell
   whether the page is broken or still loading). */
class PulseErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, info: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    this.setState({ info });
    try { console.error('[pulse] uncaught render error:', error, info); } catch {}
  }
  render() {
    if (!this.state.error) return this.props.children;
    const msg = String(this.state.error?.message || this.state.error || 'Unknown error');
    const stack = String(this.state.error?.stack || '').split('\n').slice(0, 5).join('\n');
    return (
      <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'Manrope, -apple-system, sans-serif' }}>
        <div style={{ maxWidth: 560, background: 'white', border: '1px solid #e2e8f0', borderRadius: 14, padding: 24, boxShadow: '0 10px 40px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, color: '#dc2626' }}>
            <span style={{ fontSize: 22 }}>⚠</span>
            <h2 style={{ margin: 0, fontSize: 18 }}>Something broke while rendering Pulse</h2>
          </div>
          <div style={{ fontSize: 13, color: '#475569', marginBottom: 12 }}>
            The page caught an error before it could mount. Your data is safe — the floor-map app and Firestore aren't affected.
          </div>
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#0f172a', marginBottom: 16, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
            <strong>{msg}</strong>
            {stack && <div style={{ marginTop: 6, fontSize: 11, color: '#64748b' }}>{stack}</div>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { this.setState({ error: null, info: null }); }} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: 'white', cursor: 'pointer', fontWeight: 600 }}>Try again</button>
            <button onClick={() => { localStorage.removeItem('pulse_compare_picked'); location.reload(); }} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: 'white', cursor: 'pointer' }}>Reset filters & reload</button>
            <button onClick={() => { location.href = '/floor-map-editor.html'; }} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: 'white', cursor: 'pointer' }}>Back to Floor map</button>
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 12 }}>
            If this keeps happening, copy the error text above and share it with the operator.
          </div>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <PulseErrorBoundary>
    <App />
  </PulseErrorBoundary>
);
