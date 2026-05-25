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
        <window.EmployeeActivityTable users={users} onOpenEmployee={onOpenEmployee} storageKey="pulse_people_table" />
      )}
    </div>
  );
};

/* ================================================================
   EmployeeActivityTable — 2026-05-24 Tony.
   Компактная sortable таблица с column toggle + period selector.
   Используется на People page (table view) и на My Day owner view.

   Требования Tony:
     • Убрать Role + Status колонки (status = dot на avatar'е)
     • Sort по любой колонке (click header)
     • Toggle колонок через ⚙ menu, persisted в localStorage
     • Period selector: Today / MTD
     • Колонки: Tours, Emails, Calls, Actions, Login, Logout, Score
     • Компактнее People-таблицы (мельче padding + меньше chip'ов)

   Props:
     users         — массив для отображения (pre-filtered внешним кодом)
     onOpenEmployee(id) — клик по row
     storageKey    — уникальный ключ для localStorage (cols + sort + period)
   ================================================================ */
window.EmployeeActivityTable = function EmployeeActivityTable({ users, onOpenEmployee, storageKey = "pulse_emp_activity_table" }) {
  // --- Available columns. `getValue(u, period)` возвращает «raw» число
  //     для sort'а. `render(u, period)` отдаёт JSX. period = 'today' | 'mtd'.
  const COLS = React.useMemo(() => ([
    {
      key: "name", label: "Name", align: "left", required: true,
      getValue: u => (u.name || "").toLowerCase(),
      render: (u) => (
        <div className="row" style={{ gap: 8 }}>
          <Avatar user={u} size="sm" />
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>{u.name}</span>
        </div>
      ),
    },
    {
      // 2026-05-24 Tony: «сколько Туров сделано» — completed only, not scheduled+completed.
      key: "tours", label: "Tours", align: "right",
      getValue: u => (u.toursCompleted || 0),
      render: (u) => {
        const v = (u.toursCompleted || 0);
        return <span className="mono num" style={{ fontWeight: v > 0 ? 600 : 400, color: v > 0 ? "var(--ink)" : "var(--muted-2)" }} title="Completed tours (MTD, from HubSpot)">{v || "—"}</span>;
      },
    },
    {
      key: "emails", label: "Emails", align: "right",
      getValue: (u, p) => p === "mtd" ? (u.emailsMtd || 0) : (u.emails || 0),
      render: (u, p) => {
        const v = p === "mtd" ? (u.emailsMtd || 0) : (u.emails || 0);
        return <span className="mono num" style={{ fontWeight: v > 0 ? 600 : 400, color: v > 0 ? "var(--ink)" : "var(--muted-2)" }}>{v || "—"}</span>;
      },
    },
    {
      // 2026-05-24 Tony: «сколько звонков принято больше 5 секунд» —
      // inbound calls с talkSec > 5 (фильтрует misdials, voicemails,
      // быстрые hangups). Period = today/MTD.
      key: "callsIn", label: "Calls in (>5s)", align: "right",
      getValue: (u, p) => _countCalls(u, "inbound", 5, p),
      render: (u, p) => {
        const v = _countCalls(u, "inbound", 5, p);
        const hasAircall = u._aircallConnected;
        return <span className="mono num" style={{ fontWeight: v > 0 ? 600 : 400, color: v > 0 ? "var(--ink)" : "var(--muted-2)" }} title={hasAircall ? `${v} inbound calls answered with talk-time > 5 seconds` : "Aircall not connected"}>{hasAircall ? (v || "—") : "—"}</span>;
      },
    },
    {
      // 2026-05-24 Tony: «сколько звонков сделано больше 5 секунд» —
      // outbound calls с talkSec > 5.
      key: "callsOut", label: "Calls out (>5s)", align: "right",
      getValue: (u, p) => _countCalls(u, "outbound", 5, p),
      render: (u, p) => {
        const v = _countCalls(u, "outbound", 5, p);
        const hasAircall = u._aircallConnected;
        return <span className="mono num" style={{ fontWeight: v > 0 ? 600 : 400, color: v > 0 ? "var(--ink)" : "var(--muted-2)" }} title={hasAircall ? `${v} outbound calls connected with talk-time > 5 seconds` : "Aircall not connected"}>{hasAircall ? (v || "—") : "—"}</span>;
      },
    },
    {
      // Legacy «total calls» column — keep available but hidden by default
      // (Tony больше не хочет видеть «весь объём», только quality-фильтр).
      key: "calls", label: "Calls (all)", align: "right",
      getValue: (u, p) => p === "mtd" ? (u.callsMtd || 0) : (u.calls || 0),
      render: (u, p) => {
        const v = p === "mtd" ? (u.callsMtd || 0) : (u.calls || 0);
        return <span className="mono num" style={{ fontWeight: v > 0 ? 600 : 400, color: v > 0 ? "var(--ink)" : "var(--muted-2)" }} title="All calls including misdials / voicemails / quick hangups">{v || "—"}</span>;
      },
    },
    {
      key: "actions", label: "Actions", align: "right",
      getValue: (u, p) => p === "mtd" ? (u.actionsMtd || 0) : (u.actions || 0),
      render: (u, p) => {
        const v = p === "mtd" ? (u.actionsMtd || 0) : (u.actions || 0);
        return <span className="mono num" style={{ fontWeight: v > 0 ? 600 : 400, color: v > 0 ? "var(--ink)" : "var(--muted-2)" }}>{v || "—"}</span>;
      },
    },
    {
      key: "contracts", label: "Contracts", align: "right",
      getValue: (u, p) => p === "mtd" ? (u.contractsMtd || 0) : (u.contracts || 0),
      render: (u, p) => {
        const v = p === "mtd" ? (u.contractsMtd || 0) : (u.contracts || 0);
        return <span className="mono num" style={{ fontWeight: v > 0 ? 700 : 400, color: v > 0 ? "var(--success-ink)" : "var(--muted-2)" }}>{v || "—"}</span>;
      },
    },
    {
      key: "login", label: "Login", align: "right",
      getValue: u => u.login ? _parseTimeForSort(u.login) : -1,
      render: (u) => <span className="mono" style={{ fontSize: 11.5, color: u.login ? "var(--ink)" : "var(--muted-2)" }}>{u.login || "—"}</span>,
    },
    {
      key: "logout", label: "Logout", align: "right",
      getValue: u => u.logout ? _parseTimeForSort(u.logout) : (u.status === "online" || u.status === "idle" ? 9999 : -1),
      render: (u) => {
        if (u.status === "online" || u.status === "idle") {
          return <span style={{ fontSize: 11, color: "var(--success-ink)", fontWeight: 600 }}>still in</span>;
        }
        return <span className="mono" style={{ fontSize: 11.5, color: u.logout ? "var(--ink)" : "var(--muted-2)" }}>{u.logout || "—"}</span>;
      },
    },
    {
      key: "score", label: "Score", align: "right",
      getValue: u => u.score || 0,
      render: (u) => <span className="num" style={{ fontWeight: 700, fontSize: 13, color: (u.score || 0) >= 80 ? "var(--success-ink)" : (u.score || 0) >= 50 ? "var(--ink)" : "var(--muted)" }}>{u.score || "—"}</span>,
    },
  ]), []);

  // 2026-05-24 Tony: четыре требуемых колонки — Tours / Emails /
  // Calls in (>5s) / Calls out (>5s) — плюс Login, Logout, Score.
  // «Calls (all)» доступна через ⚙ Columns, но скрыта по умолчанию.
  const DEFAULT_VISIBLE = ["name", "tours", "emails", "callsIn", "callsOut", "login", "logout", "score"];

  // --- State: visible columns, sort, period — все persisted в localStorage.
  // 2026-05-24 — _v2 в ключе после расширения column set'а (старый
  // содержал «calls» без callsIn/callsOut). Sayed v1 prefs игнорируются
  // → пользователь видит новый default набор колонок.
  const [visibleCols, setVisibleCols] = React.useState(() => {
    try {
      const raw = localStorage.getItem(storageKey + "_cols_v2");
      const arr = raw ? JSON.parse(raw) : null;
      return Array.isArray(arr) && arr.length > 0 ? arr : DEFAULT_VISIBLE;
    } catch (e) { return DEFAULT_VISIBLE; }
  });
  const [sort, setSort] = React.useState(() => {
    try {
      const raw = localStorage.getItem(storageKey + "_sort");
      const v = raw ? JSON.parse(raw) : null;
      return v && v.key ? v : { key: "score", dir: "desc" };
    } catch (e) { return { key: "score", dir: "desc" }; }
  });
  const [period, setPeriod] = React.useState(() => {
    try { return localStorage.getItem(storageKey + "_period") || "today"; } catch (e) { return "today"; }
  });
  const [colMenuOpen, setColMenuOpen] = React.useState(false);

  React.useEffect(() => { try { localStorage.setItem(storageKey + "_cols_v2", JSON.stringify(visibleCols)); } catch (e) {} }, [visibleCols, storageKey]);
  React.useEffect(() => { try { localStorage.setItem(storageKey + "_sort", JSON.stringify(sort)); } catch (e) {} }, [sort, storageKey]);
  React.useEffect(() => { try { localStorage.setItem(storageKey + "_period", period); } catch (e) {} }, [period, storageKey]);

  // Close col menu on outside-click
  React.useEffect(() => {
    if (!colMenuOpen) return;
    const h = () => setColMenuOpen(false);
    setTimeout(() => document.addEventListener("click", h, { once: true }), 0);
    return () => document.removeEventListener("click", h);
  }, [colMenuOpen]);

  // --- Sort helper. Click on column header toggles dir (asc → desc → asc).
  function onHeaderClick(key) {
    setSort(s => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  }
  function toggleCol(key) {
    setVisibleCols(prev => {
      if (prev.includes(key)) {
        if (prev.length <= 2) return prev; // нельзя оставить меньше двух
        return prev.filter(k => k !== key);
      }
      return [...prev, key];
    });
  }

  // --- Sort + filter to visible cols
  const sortCol = COLS.find(c => c.key === sort.key) || COLS[0];
  const sortedUsers = React.useMemo(() => {
    const arr = users.slice();
    arr.sort((a, b) => {
      const va = sortCol.getValue(a, period);
      const vb = sortCol.getValue(b, period);
      let cmp = 0;
      if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [users, sort, period, sortCol]);

  // Filter cols to visible (preserve COLS order, not state-order)
  const cols = COLS.filter(c => visibleCols.includes(c.key) || c.required);

  // Status dot helper — color по status; рисуется внутри Avatar в наших
  // Pulse styles, но если такого нет — добавим точку справа от avatar.
  function statusDot(status) {
    const color = status === "online" ? "var(--success)" : status === "idle" ? "var(--warning)" : "var(--muted-2)";
    return <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", marginRight: 4 }} />;
  }

  return (
    <div className="card is-clean" style={{ overflow: "hidden" }}>
      {/* Toolbar — period selector + column toggle */}
      <div className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface-2)", gap: 8 }}>
        <div className="f-segment" style={{ fontSize: 11.5 }}>
          {[["today", "Today"], ["mtd", "MTD"]].map(([k, l]) => (
            <button key={k} className={period === k ? "is-active" : ""} onClick={() => setPeriod(k)}>{l}</button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 11.5 }}>{sortedUsers.length} {sortedUsers.length === 1 ? "person" : "people"}</span>
        <div className="spacer" />
        <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
          <button className="btn is-small" onClick={() => setColMenuOpen(o => !o)} title="Show/hide columns">
            <Icon name="settings" /> Columns
          </button>
          {colMenuOpen && (
            <div style={{
              position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 50,
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 8, padding: 6, minWidth: 180,
              boxShadow: "0 6px 24px rgba(0,0,0,0.12)",
            }}>
              <div style={{ padding: "6px 10px", fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Show columns</div>
              {COLS.map(c => (
                <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", cursor: c.required ? "default" : "pointer", opacity: c.required ? 0.6 : 1, fontSize: 12, borderRadius: 5 }}
                       onMouseEnter={e => !c.required && (e.currentTarget.style.background = "var(--surface-2)")}
                       onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                  <input type="checkbox" checked={visibleCols.includes(c.key) || c.required} disabled={c.required} onChange={() => toggleCol(c.key)} />
                  {c.label}
                  {c.required && <span style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--muted-2)" }}>required</span>}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <table className="table" style={{ fontSize: 12.5 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key}
                  style={{ textAlign: c.align, cursor: "pointer", userSelect: "none", padding: "8px 10px", fontSize: 10.5, fontWeight: 700, letterSpacing: ".05em" }}
                  onClick={() => onHeaderClick(c.key)}
                  title={"Sort by " + c.label}>
                {c.label}
                {sort.key === c.key && (
                  <span style={{ marginLeft: 4, fontSize: 9, color: "var(--accent)" }}>
                    {sort.dir === "asc" ? "▲" : "▼"}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedUsers.map(u => (
            <tr key={u.id} className="is-clickable" onClick={() => onOpenEmployee && onOpenEmployee(u.id)} style={{ cursor: "pointer" }}>
              {cols.map(c => {
                if (c.key === "name") {
                  // Special-case: status dot inline before name
                  return (
                    <td key={c.key} style={{ padding: "6px 10px" }}>
                      <div className="row" style={{ gap: 6 }}>
                        {statusDot(u.status)}
                        <Avatar user={u} size="sm" />
                        <span style={{ fontWeight: 600 }}>{u.name}</span>
                      </div>
                    </td>
                  );
                }
                return (
                  <td key={c.key} style={{ textAlign: c.align, padding: "6px 10px" }}>
                    {c.render(u, period)}
                  </td>
                );
              })}
            </tr>
          ))}
          {sortedUsers.length === 0 && (
            <tr><td colSpan={cols.length} style={{ padding: 24, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>No employees match the current filter.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

// Helper — convert «8:51 AM» / «9:48 PM» / «Yesterday 4:10 PM» → minutes since midnight (sort).
// Day-prefixed strings (Yesterday/Mon/etc.) sorted before today by subtracting big offsets.
// 2026-05-24 Tony: count calls of given direction with talkSec above
// threshold, scoped to period ('today' / 'mtd'). 5-sec threshold weeds
// out misdials / quick hangups / voicemail-bot calls — left only the
// «real conversation» calls. Reads from u._callActivity (raw Aircall
// array attached by data-shim).
function _countCalls(u, direction, minTalkSec, periodKind) {
  if (!Array.isArray(u._callActivity)) return 0;
  const now = new Date();
  let cutoffMs;
  if (periodKind === "mtd") {
    cutoffMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  } else {
    // today — midnight local
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    cutoffMs = d.getTime();
  }
  let n = 0;
  for (const c of u._callActivity) {
    if (!c || !c.ts || c.ts < cutoffMs) continue;
    if (c.direction !== direction) continue;
    if ((c.talkSec || 0) <= minTalkSec) continue;
    n++;
  }
  return n;
}

function _parseTimeForSort(s) {
  if (!s) return -1;
  let offset = 0;
  // Strip day prefix
  const prefixMatch = /^(yesterday|mon|tue|wed|thu|fri|sat|sun|[a-z]{3}\s+\d+,?)\s+/i.exec(s);
  if (prefixMatch) {
    offset = -10000; // pushes to bottom on desc sort
    s = s.slice(prefixMatch[0].length);
  }
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(s);
  if (!m) return offset;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return offset + h * 60 + mm;
}
