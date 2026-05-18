/* global React, ReactDOM, TopNavShell, MobileMenu, OverviewPage, EmployeeDetail, ComparePage, AlertsPage, PeoplePage, BonusesPage, BonusRulesPage, CentersPage, MyDayPage, MyJourneyPage, EarnPage, EventDrawer, FilterDrawer, MessageDrawer, QuickActionDrawer, CommandPalette, NotificationPanel, KudosDrawer, useTweaks, TweaksPanel, TweakRadio, TweakToggle, TweakSection */

/* ================================================================
   App root — TOP NAV variant
   Same routing + state as sidebar variant, just different shell.
   ================================================================ */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "indigo",
  "density": "comfortable"
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

  React.useEffect(() => {
    if (role === "employee" && view !== "myday" && view !== "myjourney") setView("myday");
  }, [role]);

  function pushRecent(id) {
    const next = [id, ...recentIds.filter(x => x !== id)].slice(0, 5);
    setRecentIds(next);
    try { localStorage.setItem("pulse_recent", JSON.stringify(next)); } catch (e) {}
  }
  function nav(v) {
    if (role === "employee" && v !== "myday" && v !== "myjourney" && v !== "earn") {
      window.toast("This page is admin-only — switch to Owner view.");
      return;
    }
    setView(v);
    if (v !== "employee") setEmployeeId(null);
  }
  function openEmployee(id) {
    if (role === "employee" && id !== "u1") {
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
    setCompareInit([id, "u3", "u9"].filter((v, i, a) => a.indexOf(v) === i).slice(0, 4));
    setView("compare");
  }

  React.useEffect(() => {
    const root = document.documentElement;
    const accents = { indigo: "264", emerald: "150", sunset: "30", violet: "300" };
    root.style.setProperty("--accent", `oklch(56% 0.17 ${accents[tweaks.accent] || 264})`);
    root.style.setProperty("--accent-2", `oklch(50% 0.18 ${accents[tweaks.accent] || 264})`);
    root.style.setProperty("--accent-soft", `oklch(96% 0.03 ${accents[tweaks.accent] || 264})`);
    root.style.setProperty("--accent-ink", `oklch(35% 0.14 ${accents[tweaks.accent] || 264})`);
  }, [tweaks]);

  return (
    <TopNavShell
      view={view}
      onNav={nav}
      role={role}
      onRoleChange={setRole}
      employeeId={employeeId}
      centerFilter={centerFilter}
      onCenterFilterChange={setCenterFilter}
      onOpenCmd={() => setCmdOpen(true)}
      onOpenNotif={() => setNotifOpen(true)}
    >
      {view === "myday" && (
        <MyDayPage
          meId="u1"
          onOpenEmployee={(id) => openEmployee(id)}
          onOpenQuickAction={() => setQuickOpen(true)}
          onOpenJourney={() => setView("myjourney")}
        />
      )}
      {view === "myjourney" && (
        <MyJourneyPage meId="u1" onBack={() => setView("myday")} />
      )}
      {view === "earn" && (
        <EarnPage meId="u1" onBack={() => setView("myday")} />
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
          onBack={() => nav(role === "owner" ? "people" : "myday")}
          onCompareAdd={compareAdd}
          onMessage={setMessageTo}
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

      <EventDrawer
        event={drawerEvent}
        onClose={() => setDrawerEvent(null)}
        onOpenEmployee={(id) => { setDrawerEvent(null); openEmployee(id); }}
      />
      <FilterDrawer open={filterOpen} onClose={() => setFilterOpen(false)} initial={{}} onApply={() => {}} />
      <MessageDrawer open={!!messageTo} onClose={() => setMessageTo(null)} to={messageTo} />
      <QuickActionDrawer open={quickOpen} onClose={() => setQuickOpen(false)} />
      <KudosDrawer open={!!kudosTo} onClose={() => setKudosTo(null)} to={kudosTo} />
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
        </TweakSection>
      </TweaksPanel>
    </TopNavShell>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
