/* global React, Icon, DATA, Avatar, CatIcon, Trend, Sparkline, HourBars, fmt */

/* ================================================================
   Compare view — pick 2-4 employees, see side-by-side
   ================================================================ */

window.ComparePage = function ComparePage({ initial, onOpenEmployee }) {
  // Phase 12+ — persist user selection across page navigation + reloads.
  // Source priority: `initial` (passed from caller like compareAdd action)
  //                  → localStorage saved set → defaults [u1, u3, u9].
  const LS_KEY = 'pulse_compare_picked';
  const [picked, setPicked] = React.useState(() => {
    if (initial && initial.length) return initial;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0 && arr.length <= 4) {
          // Phase 17 rev — filter out stale IDs (demo seeds, deleted real users)
          const live = arr.filter(id => (window.DATA?.USERS || []).some(u => u && u.id === id));
          if (live.length > 0) return live;
        }
      }
    } catch (e) { /* ignore */ }
    // Phase 17 rev — defaults pulled from current DATA.USERS (top 3 by score).
    // Demo seed IDs ["u1","u3","u9"] больше не существуют — fallback на live.
    const users = window.DATA?.USERS || [];
    return users.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3).map(u => u.id);
  });
  const [pickerOpen, setPickerOpen] = React.useState(false);

  // Persist on every change. Also fired by togglePicked indirectly via setPicked.
  React.useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(picked)); } catch (e) { /* ignore */ }
  }, [picked]);

  function togglePicked(id) {
    if (picked.includes(id)) setPicked(picked.filter(p => p !== id));
    else if (picked.length < 4) setPicked([...picked, id]);
  }

  const users = picked.map(id => DATA.USERS.find(u => u.id === id)).filter(Boolean);

  const rows = [
    { key: "role",       label: "Role",            fmt: u => DATA.ROLES[u.role].label,                 isText: true },
    { key: "score",      label: "Productivity",    fmt: u => u.score === 0 ? "—" : u.score,            trend: u => u.score === 0 ? null : <Trend now={u.score} prev={u.prev} />, higher: true },
    { key: "actions",    label: "Actions today",   fmt: u => u.actions,                                higher: true },
    { key: "online",     label: "Active time",     fmt: u => u.online === 0 ? "—" : fmt.hm(u.online),  higher: true },
    { key: "calls",      label: "Calls",           fmt: u => u.calls,                                  higher: true },
    { key: "emails",     label: "Emails",          fmt: u => u.emails,                                 higher: true },
    { key: "contracts",  label: "Contracts sent",  fmt: u => u.contracts,                              higher: true },
    { key: "docs",       label: "Documents",       fmt: u => u.docs,                                   higher: true },
    { key: "login",      label: "First login",     fmt: u => u.login || "—",                           isText: true },
  ];

  function winnerIdx(row) {
    if (row.isText) return -1;
    const vals = users.map(u => Number(u[row.key]) || 0);
    const max = Math.max(...vals);
    return row.higher ? vals.indexOf(max) : vals.indexOf(Math.min(...vals));
  }

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1 className="title">Compare employees</h1>
          <div className="subtitle">
            <span>Side-by-side benchmark across activity, calls, emails, and productivity.</span>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setPickerOpen(true)}><Icon name="plus" /> Pick people ({picked.length}/4)</button>
          <button className="btn" onClick={() => window.toast("Comparison exported as PDF", "success")}><Icon name="download" /> Export</button>
        </div>
      </div>

      {/* Picked chips */}
      <div className="row" style={{ marginBottom: 18, flexWrap: "wrap", gap: 8 }}>
        {users.map(u => (
          <div key={u.id} className="row" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 999, padding: "4px 6px 4px 4px" }}>
            <Avatar user={u} size="sm" showStatus={false} />
            <span style={{ fontWeight: 600, fontSize: 13, paddingLeft: 4 }}>{u.first} {u.last[0]}.</span>
            <button onClick={() => togglePicked(u.id)} className="btn is-small is-ghost" style={{ padding: 2 }}><Icon name="close" /></button>
          </div>
        ))}
        {picked.length < 4 && (
          <button className="chip" onClick={() => setPickerOpen(true)} style={{ cursor: "pointer", padding: "6px 12px" }}>
            <Icon name="plus" /> Add person
          </button>
        )}
      </div>

      {/* Comparison table */}
      <div className="card is-clean" style={{ marginBottom: 22 }}>
        <div style={{ display: "grid", gridTemplateColumns: `200px repeat(${users.length}, 1fr)` }}>
          {/* Header row */}
          <div style={{ padding: 18, borderBottom: "1px solid var(--border)" }}></div>
          {users.map(u => (
            <div key={u.id} style={{ padding: 18, borderBottom: "1px solid var(--border)", borderLeft: "1px solid var(--border)" }}>
              <button onClick={() => onOpenEmployee(u.id)} className="row" style={{ width: "100%", textAlign: "left" }}>
                <Avatar user={u} size="md" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{u.name}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{DATA.ROLES[u.role].label}</div>
                </div>
                <Icon name="arrowR" style={{ width: 14, height: 14, color: "var(--muted)" }} />
              </button>
            </div>
          ))}

          {/* Rows */}
          {rows.map(r => {
            const win = winnerIdx(r);
            return (
              <React.Fragment key={r.key}>
                <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", color: "var(--muted)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 600, display: "flex", alignItems: "center" }}>
                  {r.label}
                </div>
                {users.map((u, i) => (
                  <div
                    key={u.id}
                    style={{
                      padding: "14px 18px",
                      borderBottom: "1px solid var(--border)",
                      borderLeft: "1px solid var(--border)",
                      background: i === win ? "var(--success-soft)" : "transparent",
                    }}
                  >
                    <div className="num" style={{ fontWeight: 700, fontSize: r.isText ? 13 : 18, letterSpacing: "-.01em" }}>
                      {r.fmt(u)}
                    </div>
                    {r.trend && <div style={{ marginTop: 2 }}>{r.trend(u)}</div>}
                  </div>
                ))}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Hourly distribution overlay chart */}
      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Actions per hour — today</div>
          <div className="spacer" />
          <div className="row" style={{ gap: 12 }}>
            {users.map((u, i) => (
              <div key={u.id} className="row" style={{ fontSize: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: ["var(--accent)", "oklch(62% 0.14 30)", "oklch(62% 0.14 150)", "oklch(62% 0.14 280)"][i] }} />
                <span>{u.first}</span>
              </div>
            ))}
          </div>
        </div>
        <OverlayBars users={users} />
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14 }}>30-day productivity trend</div>
        <OverlayLines users={users} />
      </div>

      {/* Picker modal */}
      {pickerOpen && (
        <>
          <div className="scrim is-open" onClick={() => setPickerOpen(false)} />
          <div className="drawer is-open" style={{ width: 420 }}>
            <div className="drawer-h">
              <Icon name="people" />
              <div className="title">Pick employees</div>
              <button className="x" onClick={() => setPickerOpen(false)}><Icon name="close" /></button>
            </div>
            <div className="drawer-b">
              <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>Pick up to 4. Currently {picked.length} selected.</div>
              <div className="col" style={{ gap: 4 }}>
                {DATA.USERS.map(u => {
                  const sel = picked.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      onClick={() => togglePicked(u.id)}
                      className="row"
                      style={{
                        padding: "8px 10px", borderRadius: 8,
                        background: sel ? "var(--accent-soft)" : "transparent",
                        textAlign: "left",
                      }}
                    >
                      <Avatar user={u} size="md" />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{u.name}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{DATA.ROLES[u.role].label}</div>
                      </div>
                      <span className="num" style={{ fontWeight: 700 }}>{u.score || "—"}</span>
                      {sel && <Icon name="check" style={{ color: "var(--accent-ink)", marginLeft: 8 }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

function OverlayBars({ users }) {
  // Phase 17 rev — guard against empty users[]. После очистки демо-сидов
  // если saved compare-picked содержал только seed-ids → users=[].
  if (!users || users.length === 0) {
    return <div className="muted" style={{ fontSize: 12, padding: 12, fontStyle: "italic" }}>Pick at least one person to see hourly comparison.</div>;
  }
  const colors = ["var(--accent)", "oklch(62% 0.14 30)", "oklch(62% 0.14 150)", "oklch(62% 0.14 280)"];
  /* group bars per hour */
  const hours = DATA.hourlyActionsFor(users[0].id).map(d => d.h);
  const data = hours.map(h => ({
    h, vals: users.map(u => DATA.hourlyActionsFor(u.id).find(d => d.h === h)?.v || 0),
  }));
  const max = Math.max(...data.flatMap(d => d.vals), 1);

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 140 }}>
      {data.map(d => (
        <div key={d.h} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120, width: "100%", justifyContent: "center" }}>
            {d.vals.map((v, i) => (
              <div
                key={i}
                title={users[i].first + ": " + v}
                style={{
                  flex: 1,
                  height: Math.max(2, (v / max) * 118) + "px",
                  background: colors[i],
                  borderRadius: "3px 3px 1px 1px",
                  opacity: .85,
                }}
              />
            ))}
          </div>
          <div className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{d.h % 4 === 0 ? d.h : ""}</div>
        </div>
      ))}
    </div>
  );
}

function OverlayLines({ users }) {
  const colors = ["var(--accent)", "oklch(62% 0.14 30)", "oklch(62% 0.14 150)", "oklch(62% 0.14 280)"];
  const w = 800, h = 180, pad = 24;
  const series = users.map(u => DATA.trend30(u.id));
  const all = series.flat();
  const max = Math.max(...all);
  const min = Math.min(...all);
  const range = max - min || 1;
  const step = (w - pad * 2) / 29;
  const paths = series.map(s =>
    s.map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ")
  );

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 200 }} preserveAspectRatio="none">
      {/* gridlines */}
      {[0, 0.25, 0.5, 0.75, 1].map(t => (
        <line key={t} x1={pad} x2={w - pad} y1={pad + t * (h - pad * 2)} y2={pad + t * (h - pad * 2)} stroke="var(--border)" strokeDasharray="3 4" />
      ))}
      {paths.map((p, i) => (
        <path key={i} d={p} fill="none" stroke={colors[i]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {/* y labels */}
      <text x={4} y={pad + 4} fontSize="10" fill="var(--muted)" fontFamily="var(--font-mono)">{Math.round(max)}</text>
      <text x={4} y={h - pad + 4} fontSize="10" fill="var(--muted)" fontFamily="var(--font-mono)">{Math.round(min)}</text>
    </svg>
  );
}
