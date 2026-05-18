/* global React, Icon, DATA, Avatar, CenterChip, fmt, metricsFor, FormDrawer */

/* ================================================================
   ⌘K Command palette — search people, jump to pages, run actions
   ================================================================ */

window.CommandPalette = function CommandPalette({ open, onClose, onNavPage, onOpenEmployee, onAction, recentIds = [] }) {
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (open) {
      setQ(""); setActive(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  /* Build searchable items */
  const allItems = React.useMemo(() => {
    const items = [];
    const recentSet = new Set(recentIds);
    /* People — recents first */
    [...recentIds.map(id => DATA.USERS.find(u => u.id === id)).filter(Boolean),
     ...DATA.USERS.filter(u => !recentSet.has(u.id))].forEach(u => {
      items.push({
        kind: "person", id: u.id,
        label: u.name,
        sub: DATA.ROLES[u.role].label + " · " + (u.center?.short || "—"),
        avatar: u,
        recent: recentSet.has(u.id),
      });
    });
    /* Pages */
    [
      { id: "overview",   label: "Activity Center",  icon: "activity" },
      { id: "people",     label: "People",           icon: "people" },
      { id: "centers",    label: "Centers",          icon: "building" },
      { id: "compare",    label: "Compare employees",icon: "compare" },
      { id: "bonuses",    label: "Bonuses",          icon: "star" },
      { id: "alerts",     label: "Unusual activity", icon: "warning" },
      { id: "myday",      label: "My Day",           icon: "sparkle" },
      { id: "myjourney",  label: "My Journey",       icon: "trendUp" },
    ].forEach(p => items.push({ kind: "page", id: p.id, label: "Go to " + p.label, sub: "Page · ⏎", icon: p.icon }));
    /* Actions */
    [
      { id: "export",       label: "Export today's activity as CSV", icon: "download" },
      { id: "filter",       label: "Open filters",                   icon: "filter" },
      { id: "quicklog",     label: "Quick log a call or email",      icon: "plus" },
      { id: "kudos",        label: "Send kudos to someone…",         icon: "star" },
      { id: "explainScore", label: "How is Pulse score calculated?", icon: "sparkle" },
    ].forEach(a => items.push({ kind: "action", id: a.id, label: a.label, sub: "Action · ⏎", icon: a.icon }));
    return items;
  }, [recentIds]);

  /* Filter */
  const filtered = React.useMemo(() => {
    if (!q.trim()) return allItems.slice(0, 14);
    const qq = q.toLowerCase();
    return allItems.filter(it =>
      it.label.toLowerCase().includes(qq) ||
      (it.sub || "").toLowerCase().includes(qq)
    ).slice(0, 16);
  }, [allItems, q]);

  /* Group by kind for display */
  const groups = filtered.reduce((acc, it) => {
    (acc[it.kind] = acc[it.kind] || []).push(it);
    return acc;
  }, {});

  /* Keep active index within bounds */
  React.useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered, active]);

  /* Keyboard */
  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(filtered.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === "Enter")   { e.preventDefault(); pick(filtered[active]); }
    else if (e.key === "Escape")  { e.preventDefault(); onClose(); }
  }

  function pick(it) {
    if (!it) return;
    if (it.kind === "person") onOpenEmployee(it.id);
    else if (it.kind === "page") onNavPage(it.id);
    else if (it.kind === "action") onAction(it.id);
    onClose();
  }

  if (!open) return null;

  const order = ["person", "page", "action"];
  const groupLabels = { person: "People", page: "Pages", action: "Actions" };

  return (
    <div className="cmd-scrim" onClick={onClose}>
      <div className="cmd-shell" onClick={e => e.stopPropagation()} role="dialog">
        <div className="cmd-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            placeholder="Search people, pages, or actions…"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="cmd-results">
          {order.map(k => groups[k] && (
            <div key={k}>
              <div className="cmd-group-h">{groupLabels[k]}</div>
              {groups[k].map((it) => {
                const idx = filtered.indexOf(it);
                const isActive = idx === active;
                return (
                  <button
                    key={it.kind + "-" + it.id}
                    onClick={() => pick(it)}
                    onMouseEnter={() => setActive(idx)}
                    className={"cmd-row" + (isActive ? " is-active" : "")}
                  >
                    {it.avatar ? <Avatar user={it.avatar} size="sm" /> : (
                      <span className="cmd-icon"><Icon name={it.icon || "arrowR"} /></span>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{it.label}</div>
                      {it.sub && <div className="muted" style={{ fontSize: 11.5 }}>{it.sub}</div>}
                    </div>
                    {it.recent && <span className="chip" style={{ background: "var(--surface-2)", color: "var(--muted)", border: "none", fontSize: 10 }}>recent</span>}
                    {isActive && <Icon name="arrowR" style={{ color: "var(--accent)" }} />}
                  </button>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="empty" style={{ padding: 30 }}>
              <div className="icon-wrap"><Icon name="search" /></div>
              <h4>Nothing matched "{q}"</h4>
              <p>Try a name, a page, or an action.</p>
            </div>
          )}
        </div>
        <div className="cmd-footer">
          <span><span className="kbd">↑↓</span> navigate</span>
          <span><span className="kbd">⏎</span> select</span>
          <span><span className="kbd">esc</span> close</span>
          <div className="spacer" />
          <span className="muted" style={{ fontSize: 11 }}>{filtered.length} result{filtered.length === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
};

/* ================================================================
   Notification panel — popover from bell
   ================================================================ */
window.NotificationPanel = function NotificationPanel({ open, onClose, onOpenEmployee, onNav }) {
  const [items, setItems] = React.useState([
    { id: "n1", icon: "warning", tone: "warning", title: "Unusual logout — James O'Sullivan", sub: "Signed out at 8:22 AM after only 28 min", time: "1h ago", action: { kind: "alerts", label: "Review" } },
    { id: "n2", icon: "star",    tone: "success", title: "Aaliyah hit Gold tier",                sub: "First in May — well done!",                  time: "2h ago", action: { kind: "person", id: "u3", label: "Send kudos" } },
    { id: "n3", icon: "contract",tone: "info",    title: "Contract signed",                       sub: "Lease – 2104 Maple Ave Suite 300 by ABC Medical", time: "3h ago", action: { kind: "person", id: "u1", label: "Open" } },
    { id: "n4", icon: "phone",   tone: "warning", title: "Missed callback open",                  sub: "Maya has 1 missed call without follow-up",   time: "5h ago", action: { kind: "person", id: "u1", label: "View" } },
    { id: "n5", icon: "trendDn", tone: "danger",  title: "Marcus below target 2 days in a row",   sub: "Calls 7/18 today · suggest check-in",        time: "today",  action: { kind: "person", id: "u8", label: "Open" } },
  ]);
  const [filter, setFilter] = React.useState("all");
  const visible = filter === "all" ? items : items.filter(it => it.tone === filter);

  React.useEffect(() => {
    if (!open) return;
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function dismiss(id) { setItems(items.filter(x => x.id !== id)); }
  function clearAll() { setItems([]); window.toast("All notifications cleared"); }

  return (
    <div className="popover-scrim" onClick={onClose}>
      <div className="notif-panel" onClick={e => e.stopPropagation()}>
        <div className="row" style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <Icon name="bell" />
          <div style={{ fontWeight: 700 }}>Notifications</div>
          <span className="chip is-accent" style={{ fontSize: 10.5 }}>{items.length}</span>
          <div className="spacer" />
          <button className="btn is-small is-ghost" onClick={clearAll}>Clear all</button>
        </div>
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: 6 }}>
          {[
            { id: "all",     label: "All" },
            { id: "danger",  label: "Critical" },
            { id: "warning", label: "Needs attention" },
            { id: "success", label: "Good news" },
          ].map(f => (
            <button key={f.id} className={"chip" + (filter === f.id ? " is-accent" : "")} onClick={() => setFilter(f.id)} style={{ cursor: "pointer", padding: "4px 10px", fontSize: 11.5 }}>{f.label}</button>
          ))}
        </div>
        <div style={{ maxHeight: 460, overflowY: "auto" }}>
          {visible.length === 0 && (
            <div className="empty" style={{ padding: 40 }}>
              <div className="icon-wrap"><Icon name="check" /></div>
              <h4>All caught up</h4>
              <p>Nothing needs your attention right now.</p>
            </div>
          )}
          {visible.map(n => {
            const toneColor = { success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", info: "var(--info)" }[n.tone] || "var(--muted)";
            return (
              <div key={n.id} className="row" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", alignItems: "flex-start", gap: 12 }}>
                <span style={{ width: 28, height: 28, borderRadius: 8, background: toneColor + "22", color: toneColor, display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Icon name={n.icon} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{n.title}</div>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 1 }}>{n.sub}</div>
                  <div className="row" style={{ marginTop: 6, gap: 6 }}>
                    {n.action && (
                      <button
                        className="btn is-small"
                        onClick={() => {
                          if (n.action.kind === "person") onOpenEmployee(n.action.id);
                          else onNav(n.action.kind);
                          onClose();
                        }}
                      >{n.action.label}</button>
                    )}
                    <button className="btn is-small is-ghost" onClick={() => dismiss(n.id)}>Dismiss</button>
                    <div className="spacer" />
                    <span className="mono muted" style={{ fontSize: 10.5 }}>{n.time}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ padding: 10, borderTop: "1px solid var(--border)" }}>
          <button className="btn is-small is-ghost" style={{ width: "100%" }} onClick={() => window.toast("Notification settings — coming soon")}>
            <Icon name="settings" /> Notification settings
          </button>
        </div>
      </div>
    </div>
  );
};

/* ================================================================
   Send Kudos drawer — recognition flow
   ================================================================ */
window.KudosDrawer = function KudosDrawer({ open, onClose, to }) {
  const [emoji, setEmoji] = React.useState("👏");
  const [note, setNote] = React.useState("");
  const [visibility, setVisibility] = React.useState("team");
  const presets = [
    { e: "👏", t: "Crushing it today" },
    { e: "🚀", t: "Best call I've seen this week" },
    { e: "🔥", t: "Loved the way you handled that tenant" },
    { e: "💎", t: "Quality over quantity — perfect" },
    { e: "🏆", t: "Setting the bar for the whole team" },
  ];

  function send() {
    window.toast(`${emoji} Kudos sent to ${to?.first || "employee"}!`, "success");
    onClose();
    setNote("");
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Send kudos"
      icon="star"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn is-primary" onClick={send}>{emoji} Send kudos</button>
        </>
      }
    >
      {to && (
        <div className="row" style={{ padding: 12, background: "var(--surface-2)", borderRadius: 10, marginBottom: 14 }}>
          <Avatar user={to} size="md" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>{to.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>{DATA.ROLES[to.role].label}{to.center && " · " + to.center.name}</div>
          </div>
        </div>
      )}

      <div style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
        <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 10 }}>Pick a reaction</div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {["👏", "🚀", "🔥", "💎", "🏆", "💪", "⚡", "🌟"].map(e => (
            <button
              key={e}
              onClick={() => setEmoji(e)}
              style={{
                fontSize: 22, padding: "6px 10px",
                borderRadius: 10,
                background: emoji === e ? "var(--accent-soft)" : "var(--surface-2)",
                border: "1px solid " + (emoji === e ? "var(--accent)" : "var(--border)"),
              }}
            >{e}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
        <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>Why?</div>
        <textarea
          className="form-textarea"
          rows={3}
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Tell them what made you proud…"
        />
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Quick preset:</div>
        <div className="chip-group" style={{ marginTop: 4 }}>
          {presets.map(p => (
            <button key={p.t} className="chip" onClick={() => { setEmoji(p.e); setNote(p.t); }} style={{ cursor: "pointer" }}>{p.e} {p.t}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "14px 0" }}>
        <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>Who sees this?</div>
        <div className="chip-group">
          {[
            { id: "team",   label: "Whole team",  icon: "people", sub: "Posts to team channel" },
            { id: "center", label: "This center",  icon: "building", sub: "Only their branch" },
            { id: "private",label: "Just them",   icon: "user", sub: "Private message" },
          ].map(v => (
            <button
              key={v.id}
              onClick={() => setVisibility(v.id)}
              className={"chip" + (visibility === v.id ? " is-accent" : "")}
              style={{ cursor: "pointer", padding: "8px 12px", fontSize: 13 }}
            ><Icon name={v.icon} />{v.label}</button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          {visibility === "team" ? "Posted to the team feed and pinned for a day" :
           visibility === "center" ? "Visible only to people in their center" :
           "Sent as a private message"}
        </div>
      </div>
    </FormDrawer>
  );
};

/* ================================================================
   Pulse Score explainer modal — opens when clicking any score
   ================================================================ */
window.openScoreExplainer = function (user) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const close = () => { root.remove(); };
  const m = metricsFor(user);
  const weights = user.role === "agent" ? { c: 30, e: 20, k: 30, p: 20 }
                : user.role === "manager" ? { c: 15, e: 25, k: 40, p: 20 }
                : user.role === "accountant" ? { c: 10, e: 30, k: 0, p: 60 }
                : { c: 10, e: 40, k: 0, p: 50 };

  const callsP    = Math.min(100, Math.round((m.mtd.calls / m.monthTargets.calls) * 100));
  const emailsP   = Math.min(100, Math.round((m.mtd.emails / m.monthTargets.emails) * 100));
  const contractsP= m.targets.contracts === 0 ? 100 : Math.min(100, Math.round((m.mtd.contracts / m.monthTargets.contracts) * 100));
  const presenceP = Math.min(100, Math.round((m.mtd.daysWorked / m.mtd.daysExpected) * 100));

  root.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(20,22,30,.45);backdrop-filter:blur(3px);z-index:300;display:grid;place-items:center;padding:20px;">
      <div style="background:white;border-radius:16px;max-width:480px;width:100%;box-shadow:var(--shadow-lg);overflow:hidden;">
        <div style="padding:18px 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border);">
          <span style="font-size:16px;font-weight:700;">How Pulse score works</span>
          <button data-act="x" style="margin-left:auto;background:none;border:none;cursor:pointer;color:var(--muted);font-size:20px;line-height:1;padding:4px 8px;border-radius:6px;">×</button>
        </div>
        <div style="padding:20px;">
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;">
            <div style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,var(--accent),oklch(58% 0.16 290));color:white;display:grid;place-items:center;font:800 28px/1 var(--font-mono);">${user.score || "—"}</div>
            <div>
              <div style="font-weight:700;font-size:15px;">${user.name}</div>
              <div style="color:var(--muted);font-size:12.5px;">${DATA.ROLES[user.role].label} · today's productivity score</div>
            </div>
          </div>

          <div style="color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;">Formula for ${DATA.ROLES[user.role].short}</div>
          <div style="font-family:var(--font-mono);font-size:11.5px;background:var(--surface-2);padding:10px 12px;border-radius:8px;margin-bottom:18px;line-height:1.6;">
            score = ${weights.c}% × calls + ${weights.e}% × emails${weights.k > 0 ? " + " + weights.k + "% × contracts" : ""} + ${weights.p}% × days worked
          </div>

          <div style="color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;">Maya's month-to-date</div>
          ${factorRow("Calls",       callsP,    weights.c, m.mtd.calls + " of " + m.monthTargets.calls)}
          ${factorRow("Emails",      emailsP,   weights.e, m.mtd.emails + " of " + m.monthTargets.emails)}
          ${weights.k > 0 ? factorRow("Contracts", contractsP, weights.k, m.mtd.contracts + " of " + Math.round(m.monthTargets.contracts)) : ""}
          ${factorRow("Days worked", presenceP, weights.p, m.mtd.daysWorked + " of " + m.mtd.daysExpected)}

          <div style="margin-top:16px;padding:10px 12px;background:var(--accent-soft);color:var(--accent-ink);border-radius:8px;font-size:12.5px;line-height:1.5;">
            <b>How to improve:</b> ${improveTip(m, user)}
          </div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid var(--border);background:var(--surface-2);">
          <div style="color:var(--muted);font-size:11px;">Score recalculates nightly. Weights differ by role.</div>
        </div>
      </div>
    </div>
  `;
  root.querySelector('[data-act="x"]').onclick = close;
  root.querySelector('div').onclick = (e) => { if (e.target === root.firstElementChild) close(); };
};

function factorRow(label, pct, weight, sub) {
  const color = pct >= 100 ? "var(--success)" : pct >= 70 ? "var(--warning)" : "var(--danger)";
  return `
    <div style="margin-bottom:10px;">
      <div style="display:flex;align-items:baseline;gap:8px;font-size:12.5px;margin-bottom:4px;">
        <span style="font-weight:600;">${label}</span>
        <span style="color:var(--muted);font-size:11px;">weight ${weight}%</span>
        <span style="margin-left:auto;font-family:var(--font-mono);font-weight:700;color:${color};">${pct}%</span>
      </div>
      <div style="height:6px;background:var(--surface-3);border-radius:999px;overflow:hidden;">
        <span style="display:block;height:100%;width:${Math.min(100, pct)}%;background:${color};border-radius:999px;"></span>
      </div>
      <div style="color:var(--muted);font-size:10.5px;margin-top:3px;">${sub}</div>
    </div>
  `;
}

function improveTip(m, user) {
  const tips = [];
  if (m.mtd.calls < m.monthTargets.calls * .9)   tips.push("hit your monthly call target");
  if (m.mtd.emails < m.monthTargets.emails * .9) tips.push("send more proactive emails");
  if (m.targets.contracts > 0 && m.mtd.contracts < m.monthTargets.contracts) tips.push("push 1 more contract over the line");
  if (tips.length === 0) return "Keep this pace — you're crushing all your targets.";
  return "Focus on: " + tips.join(", ") + ".";
}
