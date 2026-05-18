/* global React, Icon, DATA, Avatar, CenterChip */

/* ================================================================
   Form drawers — shared shell + Filter / Message / Confirm modals
   ================================================================ */

window.FormDrawer = function FormDrawer({ open, onClose, title, icon, footer, children, width = 480 }) {
  React.useEffect(() => {
    if (!open) return;
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <>
      <div className={"scrim" + (open ? " is-open" : "")} onClick={onClose} />
      <aside className={"drawer" + (open ? " is-open" : "")} style={{ width }} role="dialog" aria-hidden={!open}>
        <div className="drawer-h">
          {icon && <Icon name={icon} />}
          <div className="title">{title}</div>
          <button className="x" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="drawer-b">{children}</div>
        {footer && (
          <div style={{ padding: 14, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {footer}
          </div>
        )}
      </aside>
    </>
  );
};

/* ================================================================
   Filter drawer — date range, users, categories, status, source, search
   ================================================================ */
window.FilterDrawer = function FilterDrawer({ open, onClose, initial, onApply }) {
  const [range, setRange] = React.useState(initial?.range || "Today");
  const [centers, setCenters] = React.useState(new Set(initial?.centers || []));
  const [cats, setCats] = React.useState(new Set(initial?.cats || []));
  const [statuses, setStatuses] = React.useState(new Set(initial?.statuses || []));
  const [sources, setSources] = React.useState(new Set(initial?.sources || []));
  const [unusualOnly, setUnusualOnly] = React.useState(initial?.unusualOnly || false);
  const [query, setQuery] = React.useState(initial?.query || "");

  const tog = (set, setter, v) => () => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setter(n); };

  function apply() {
    onApply({ range, centers: [...centers], cats: [...cats], statuses: [...statuses], sources: [...sources], unusualOnly, query });
    onClose();
    window.toast("Filters applied", "success");
  }
  function reset() {
    setRange("Today"); setCenters(new Set()); setCats(new Set()); setStatuses(new Set()); setSources(new Set()); setUnusualOnly(false); setQuery("");
  }

  const totalActive = (range !== "Today" ? 1 : 0) + centers.size + cats.size + statuses.size + sources.size + (unusualOnly ? 1 : 0) + (query ? 1 : 0);

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Filters"
      icon="filter"
      footer={
        <>
          <button className="btn is-ghost" onClick={reset}>Reset all</button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn is-primary" onClick={apply}>Apply {totalActive > 0 && `(${totalActive})`}</button>
        </>
      }
    >
      <FilterSection label="Search">
        <div className="form-input">
          <Icon name="search" />
          <input placeholder="Keyword, name, contract id…" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
      </FilterSection>

      <FilterSection label="Date range">
        <div className="chip-group">
          {["Today", "Yesterday", "Last 7 days", "Last 30 days", "This month", "Custom"].map(r => (
            <button
              key={r}
              className={"chip" + (range === r ? " is-accent" : "")}
              onClick={() => setRange(r)}
              style={{ cursor: "pointer", padding: "6px 12px" }}
            >{r}</button>
          ))}
        </div>
      </FilterSection>

      <FilterSection label="Centers">
        <div className="chip-group">
          {DATA.CENTERS.map(c => (
            <button
              key={c.id}
              className="chip"
              onClick={tog(centers, setCenters, c.id)}
              style={{
                cursor: "pointer", padding: "6px 12px",
                background: centers.has(c.id) ? c.color + "22" : "var(--surface-2)",
                color: centers.has(c.id) ? c.color : "var(--ink-2)",
                borderColor: centers.has(c.id) ? c.color + "55" : "var(--border)",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: c.color }} />
              {c.name}
            </button>
          ))}
        </div>
      </FilterSection>

      <FilterSection label="Event category">
        <div className="chip-group">
          {Object.entries(DATA.CATEGORIES).map(([k, c]) => (
            <button
              key={k}
              className={"chip" + (cats.has(k) ? " is-accent" : "")}
              onClick={tog(cats, setCats, k)}
              style={{ cursor: "pointer", padding: "6px 12px" }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: c.color }} />
              {c.label}
            </button>
          ))}
        </div>
      </FilterSection>

      <FilterSection label="Status">
        <div className="chip-group">
          {["completed", "pending", "warning", "failed"].map(s => (
            <button key={s} className={"chip" + (statuses.has(s) ? " is-accent" : "")} onClick={tog(statuses, setStatuses, s)} style={{ cursor: "pointer", padding: "6px 12px" }}>{s}</button>
          ))}
        </div>
      </FilterSection>

      <FilterSection label="Source">
        <div className="chip-group">
          {["web", "mobile", "email", "phone", "docusign", "crm"].map(s => (
            <button key={s} className={"chip" + (sources.has(s) ? " is-accent" : "")} onClick={tog(sources, setSources, s)} style={{ cursor: "pointer", padding: "6px 12px" }}>{s}</button>
          ))}
        </div>
      </FilterSection>

      <FilterSection label="Quick toggles">
        <label className="toggle-row">
          <input type="checkbox" checked={unusualOnly} onChange={e => setUnusualOnly(e.target.checked)} />
          <span>Show only unusual activity</span>
        </label>
      </FilterSection>

      <div style={{ padding: "14px 0 6px" }}>
        <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>Saved filters</div>
        <div className="col" style={{ gap: 4 }}>
          {["Today by employee", "Contracts sent this month", "Calls by leasing team", "Low activity users", "Unusual logins"].map(s => (
            <button key={s} className="row" style={{ padding: "6px 8px", borderRadius: 6, textAlign: "left", color: "var(--ink-2)", fontSize: 13 }}>
              <Icon name="star" />{s}
            </button>
          ))}
        </div>
      </div>
    </FormDrawer>
  );
};

function FilterSection({ label, children }) {
  return (
    <div style={{ padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

/* ================================================================
   Message composer — internal chat / nudge an employee
   ================================================================ */
window.MessageDrawer = function MessageDrawer({ open, onClose, to }) {
  const [subject, setSubject] = React.useState("Quick check-in");
  const [body, setBody] = React.useState("");
  const [channel, setChannel] = React.useState("inapp");
  const presets = [
    "Great work today — keep it up!",
    "Could you call me back when you get a minute?",
    "Heads-up: you have a missed callback to follow up on.",
    "Reminder: please log your contracts before EOD.",
  ];

  function send() {
    if (!body.trim()) { window.toast("Type a message first"); return; }
    window.toast(`Message sent to ${to?.first || "employee"} via ${channel === "inapp" ? "Pulse" : channel}`, "success");
    onClose();
    setBody("");
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Send message"
      icon="mail"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn is-primary" onClick={send}><Icon name="share" /> Send</button>
        </>
      }
    >
      {to && (
        <div className="row" style={{ padding: 12, background: "var(--surface-2)", borderRadius: 10, marginBottom: 14 }}>
          <Avatar user={to} size="md" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>{to.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>{DATA.ROLES[to.role].label} · {to.center?.name}</div>
          </div>
        </div>
      )}

      <FilterSection label="Channel">
        <div className="chip-group">
          {[
            { id: "inapp",  label: "Pulse in-app", icon: "bell" },
            { id: "email",  label: "Email",        icon: "mail" },
            { id: "sms",    label: "SMS",          icon: "mobile" },
          ].map(c => (
            <button
              key={c.id}
              className={"chip" + (channel === c.id ? " is-accent" : "")}
              onClick={() => setChannel(c.id)}
              style={{ cursor: "pointer", padding: "6px 12px" }}
            ><Icon name={c.icon} />{c.label}</button>
          ))}
        </div>
      </FilterSection>

      <FilterSection label="Subject">
        <div className="form-input">
          <input value={subject} onChange={e => setSubject(e.target.value)} />
        </div>
      </FilterSection>

      <FilterSection label="Message">
        <textarea
          className="form-textarea"
          rows={5}
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Type a friendly note…"
        />
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Try a quick preset:</div>
        <div className="chip-group" style={{ marginTop: 4 }}>
          {presets.map(p => (
            <button key={p} className="chip" onClick={() => setBody(p)} style={{ cursor: "pointer" }}>{p}</button>
          ))}
        </div>
      </FilterSection>
    </FormDrawer>
  );
};

/* ================================================================
   Quick Action drawer — log call, log note (for My Day)
   ================================================================ */
window.QuickActionDrawer = function QuickActionDrawer({ open, onClose }) {
  const [kind, setKind] = React.useState("call");
  const [contact, setContact] = React.useState("");
  const [body, setBody] = React.useState("");
  function save() {
    if (!contact.trim()) { window.toast("Pick a contact first"); return; }
    window.toast(`${kind === "call" ? "Call" : kind === "email" ? "Email" : "Note"} logged for ${contact}`, "success");
    onClose(); setContact(""); setBody("");
  }
  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Quick log"
      icon="plus"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn is-primary" onClick={save}>Save</button>
        </>
      }
    >
      <FilterSection label="What did you do?">
        <div className="chip-group">
          {[
            { id: "call",  label: "Logged a call",  icon: "phone" },
            { id: "email", label: "Sent an email",  icon: "mail"  },
            { id: "note",  label: "Added a note",   icon: "edit"  },
            { id: "task",  label: "Created a task", icon: "task"  },
          ].map(c => (
            <button key={c.id} className={"chip" + (kind === c.id ? " is-accent" : "")} onClick={() => setKind(c.id)} style={{ cursor: "pointer", padding: "8px 12px", fontSize: 13 }}>
              <Icon name={c.icon} />{c.label}
            </button>
          ))}
        </div>
      </FilterSection>
      <FilterSection label="Related contact">
        <div className="form-input">
          <Icon name="user" />
          <input value={contact} onChange={e => setContact(e.target.value)} placeholder="Tenant, lead, or contact name…" />
        </div>
      </FilterSection>
      <FilterSection label="Notes (optional)">
        <textarea className="form-textarea" rows={4} value={body} onChange={e => setBody(e.target.value)} placeholder="What was discussed?" />
      </FilterSection>
    </FormDrawer>
  );
};

/* ================================================================
   Confirm modal — small centered prompt
   ================================================================ */
window.confirmModal = function (title, message, confirmLabel = "Confirm") {
  return new Promise(resolve => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const close = (val) => { root.remove(); resolve(val); };
    root.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(20,22,30,.4);backdrop-filter:blur(2px);z-index:200;display:grid;place-items:center;">
        <div style="background:white;border-radius:14px;padding:22px;max-width:380px;box-shadow:var(--shadow-lg);">
          <div style="font-weight:700;font-size:16px;margin-bottom:6px;">${title}</div>
          <div style="color:var(--muted);font-size:13.5px;margin-bottom:18px;">${message}</div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn" data-act="cancel">Cancel</button>
            <button class="btn is-primary" data-act="ok">${confirmLabel}</button>
          </div>
        </div>
      </div>`;
    root.querySelector('[data-act="cancel"]').onclick = () => close(false);
    root.querySelector('[data-act="ok"]').onclick = () => close(true);
  });
};
