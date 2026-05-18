/* global React, Icon, DATA, Avatar, CatIcon, Trend, fmt, parseTime */

/* ================================================================
   Unusual activity / Alerts page
   ================================================================ */

window.AlertsPage = function AlertsPage({ onOpenEmployee, onOpenEvent }) {
  const events = DATA.ALL_EVENTS.filter(e => e.isUnusual || e.status === "warn");
  const users  = DATA.USERS.filter(u => u.unusual || (u.score > 0 && u.score < 35));

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1 className="title">Unusual activity</h1>
          <div className="subtitle">
            <span><Icon name="warning" style={{ width: 13, height: 13, verticalAlign: "-2px", color: "var(--warning-ink)" }} /> {events.length} flagged event{events.length === 1 ? "" : "s"} · {users.length} {users.length === 1 ? "person" : "people"} needing review</span>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => window.toast("Filters coming soon for this view")}><Icon name="filter" /> Filters</button>
          <button className="btn" onClick={() => window.toast("Alerts exported as CSV", "success")}><Icon name="download" /> Export</button>
        </div>
      </div>

      {events.length === 0 && users.length === 0 ? (
        <div className="card" style={{ padding: 40 }}>
          <div className="empty">
            <div className="icon-wrap" style={{ background: "var(--success-soft)", color: "var(--success-ink)" }}><Icon name="check" /></div>
            <h4>All clear</h4>
            <p>No unusual activity detected in the current range.</p>
          </div>
        </div>
      ) : (
        <div className="col" style={{ gap: 22 }}>
          {users.length > 0 && (
            <div>
              <div className="row" style={{ marginBottom: 10 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>People to review</h2>
                <span className="muted" style={{ fontSize: 12 }}>{users.length}</span>
              </div>
              <div className="people-grid">
                {users.map(u => (
                  <div key={u.id} className="card" style={{ padding: 14, background: "var(--warning-soft)", borderColor: "transparent" }}>
                    <div className="row">
                      <Avatar user={u} size="md" />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700 }}>{u.name}</div>
                        <div style={{ fontSize: 12, color: "var(--warning-ink)" }}>{u.away || "Productivity below baseline"}</div>
                      </div>
                      <button className="btn is-small" onClick={() => onOpenEmployee(u.id)}>Review</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {events.length > 0 && (
            <div>
              <div className="row" style={{ marginBottom: 10 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Flagged events</h2>
                <span className="muted" style={{ fontSize: 12 }}>{events.length}</span>
              </div>
              <div className="card is-clean live-feed">
                {events.map(e => {
                  const u = DATA.USERS.find(x => x.id === e.userId);
                  return (
                    <button key={e.id} className="live-row" onClick={() => onOpenEvent(e)}>
                      <CatIcon cat={e.cat} size="sm" />
                      <span className="time">{e.time}</span>
                      <div style={{ minWidth: 0 }}>
                        <div className="who">
                          {u && <Avatar user={u} size="sm" showStatus={false} />}
                          <span className="name">{u ? u.name : "—"}</span>
                        </div>
                        <div className="desc">{e.desc} {e.ent && <span className="ent">{e.ent.name}</span>}</div>
                      </div>
                      <div className="right">
                        <span className="chip is-warning"><Icon name="warning" /> unusual</span>
                        <Icon name="chevR" style={{ width: 14, height: 14, color: "var(--muted-2)" }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* ================================================================
   People listing page (grid + table toggle)
   ================================================================ */
window.PeoplePage = function PeoplePage({ onOpenEmployee }) {
  const [view, setView] = React.useState("grid");
  const [role, setRole] = React.useState("All");
  const [query, setQuery] = React.useState("");

  let users = DATA.USERS;
  if (role !== "All") users = users.filter(u => u.role === role);
  if (query) users = users.filter(u => u.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1 className="title">People</h1>
          <div className="subtitle"><span>{users.length} of {DATA.USERS.length} employees</span></div>
        </div>
        <div className="row">
          <div className="f-segment">
            <button className={view === "grid" ? "is-active" : ""} onClick={() => setView("grid")}>Cards</button>
            <button className={view === "table" ? "is-active" : ""} onClick={() => setView("table")}>Table</button>
          </div>
          <button className="btn" onClick={() => window.toast("People list exported as CSV", "success")}><Icon name="download" /> Export</button>
        </div>
      </div>

      {/* filters */}
      <div className="filters">
        <div className="search" style={{ minWidth: 240, padding: "6px 10px", background: "var(--surface)" }}>
          <Icon name="search" />
          <input placeholder="Search people…" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        {["All", ...Object.keys(DATA.ROLES)].map(r => (
          <button key={r} className={"chip" + (role === r ? " is-accent" : "")} onClick={() => setRole(r)} style={{ cursor: "pointer" }}>
            {r === "All" ? "All roles" : DATA.ROLES[r].label}
          </button>
        ))}
      </div>

      {view === "grid" ? (
        <div className="people-grid">
          {users.map(u => (
            <div key={u.id} className="person-card" onClick={() => onOpenEmployee(u.id)}>
              <div className="row">
                <Avatar user={u} size="md" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{u.name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{DATA.ROLES[u.role].label}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="num" style={{ fontSize: 18, fontWeight: 700 }}>{u.score || "—"}</div>
                  {u.score > 0 && <Trend now={u.score} prev={u.prev} />}
                </div>
              </div>
              <div className="stats">
                <div className="stat"><div className="v">{u.actions}</div><div className="l">actions</div></div>
                <div className="stat"><div className="v">{u.calls}</div><div className="l">calls</div></div>
                <div className="stat"><div className="v">{u.emails}</div><div className="l">emails</div></div>
                <div className="stat"><div className="v">{u.contracts}</div><div className="l">contracts</div></div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card is-clean">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Role</th><th>Status</th><th>Login</th><th>Actions</th><th>Calls</th><th>Emails</th><th>Score</th></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="is-clickable" onClick={() => onOpenEmployee(u.id)}>
                  <td><div className="row"><Avatar user={u} size="sm" /><span style={{ fontWeight: 600 }}>{u.name}</span></div></td>
                  <td>{DATA.ROLES[u.role].label}</td>
                  <td>
                    <span className={"chip is-" + (u.status === "online" ? "success" : u.status === "idle" ? "warning" : "")}>
                      <span className="dot" style={{ background: u.status === "online" ? "var(--success)" : u.status === "idle" ? "var(--warning)" : "var(--muted-2)" }} />
                      {u.status}
                    </span>
                  </td>
                  <td className="mono">{u.login || "—"}</td>
                  <td className="num">{u.actions}</td>
                  <td className="num">{u.calls}</td>
                  <td className="num">{u.emails}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{u.score || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
