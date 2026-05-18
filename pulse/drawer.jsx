/* global React, Icon, DATA, Avatar, CatIcon, fmt */

/* ================================================================
   Activity Detail Drawer — right-side panel showing one event
   ================================================================ */

window.EventDrawer = function EventDrawer({ event, onClose, onOpenEmployee }) {
  const [advanced, setAdvanced] = React.useState(false);
  const isOpen = !!event;
  const e = event;
  const user = e ? DATA.USERS.find(u => u.id === e.userId) : null;
  const cat = e ? DATA.CATEGORIES[e.cat] : null;

  /* Close on Escape */
  React.useEffect(() => {
    if (!isOpen) return;
    function onKey(ev) { if (ev.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  return (
    <>
      <div className={"scrim" + (isOpen ? " is-open" : "")} onClick={onClose} />
      <aside className={"drawer" + (isOpen ? " is-open" : "")} role="dialog" aria-hidden={!isOpen}>
        {e && (
          <>
            <div className="drawer-h">
              <CatIcon cat={e.cat} />
              <div>
                <div className="title">{cat.label} event</div>
                <div className="muted mono" style={{ fontSize: 11.5 }}>{e.id} · {e.time}</div>
              </div>
              <button className="x" onClick={onClose}><Icon name="close" /></button>
            </div>

            <div className="drawer-b">
              {/* Headline */}
              <div style={{ padding: "8px 0 18px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontWeight: 600, fontSize: 16, letterSpacing: "-.01em" }}>
                  {e.desc}
                </div>
                {e.ent && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <span className="chip is-accent">{e.ent.kind}</span>
                    <span style={{ fontWeight: 500, fontSize: 14 }}>{e.ent.name}</span>
                  </div>
                )}
                {(e.isUnusual || e.status === "warn") && (
                  <div className="row" style={{ marginTop: 10, padding: "8px 10px", background: "var(--warning-soft)", color: "var(--warning-ink)", borderRadius: 8, fontSize: 12 }}>
                    <Icon name="warning" /><span style={{ fontWeight: 500 }}>This event was flagged as unusual.</span>
                  </div>
                )}
              </div>

              {/* Who */}
              {user && (
                <div style={{ padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>Performed by</div>
                  <button onClick={() => onOpenEmployee(user.id)} className="row" style={{ width: "100%", padding: 8, borderRadius: 8, background: "var(--surface-2)" }}>
                    <Avatar user={user} size="md" />
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div style={{ fontWeight: 600 }}>{user.name}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{DATA.ROLES[user.role].label}</div>
                    </div>
                    <Icon name="arrowR" style={{ width: 14, height: 14, color: "var(--muted)" }} />
                  </button>
                </div>
              )}

              {/* Details */}
              <div style={{ padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
                <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>Details</div>
                <div className="kv"><div className="k">Action type</div><div className="v">{e.type}</div></div>
                <div className="kv"><div className="k">Category</div><div className="v">{cat.label}</div></div>
                <div className="kv"><div className="k">Timestamp</div><div className="v mono">Today · {e.time}</div></div>
                {e.source && <div className="kv"><div className="k">Source</div><div className="v"><span className="chip">{e.source}</span></div></div>}
                {e.ent?.durationSeconds > 0 && <div className="kv"><div className="k">Duration</div><div className="v mono">{fmt.duration(e.ent.durationSeconds)}</div></div>}
                {e.ent?.size && <div className="kv"><div className="k">File size</div><div className="v mono">{e.ent.size}</div></div>}
                {e.before && e.after && (
                  <div className="kv">
                    <div className="k">Change</div>
                    <div className="v">
                      <span className="chip" style={{ background: "var(--danger-soft)", color: "var(--danger-ink)", border: "none" }}>{e.before}</span>
                      <Icon name="arrowR" style={{ width: 12, height: 12, margin: "0 6px", verticalAlign: "-2px", color: "var(--muted)" }} />
                      <span className="chip" style={{ background: "var(--success-soft)", color: "var(--success-ink)", border: "none" }}>{e.after}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Quick actions */}
              <div style={{ padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
                <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600, marginBottom: 8 }}>Open</div>
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {e.ent?.kind === "doc" && <button className="btn" onClick={() => window.toast(`Opening ${e.ent.name}…`)}><Icon name="docOpen" /> Open document</button>}
                  {e.ent?.kind === "contract" && <button className="btn" onClick={() => window.toast(`Opening contract envelope ${e.ent.id}`)}><Icon name="contract" /> Open contract</button>}
                  {e.ent?.kind === "email" && <button className="btn" onClick={() => window.toast("Opening email…")}><Icon name="mail" /> Open email</button>}
                  {e.ent?.kind === "call" && e.type !== "missed" && <button className="btn" onClick={() => window.toast("▶ Playing recording…")}><Icon name="play" /> Play recording</button>}
                  {e.ent?.kind === "tenant" && <button className="btn" onClick={() => window.toast(`Opening ${e.ent.name}`)}><Icon name="building" /> Open tenant</button>}
                  {e.ent?.kind === "lead" && <button className="btn" onClick={() => window.toast(`Opening ${e.ent.name}`)}><Icon name="user" /> Open lead</button>}
                  {e.ent?.kind === "invoice" && <button className="btn" onClick={() => window.toast(`Opening ${e.ent.name}`)}><Icon name="invoice" /> Open invoice</button>}
                  {e.ent?.kind === "task" && <button className="btn" onClick={() => window.toast(`Opening task ${e.ent.id}`)}><Icon name="task" /> Open task</button>}
                  <button className="btn" onClick={() => window.toast("Downloaded", "success")}><Icon name="download" /> Download</button>
                  <button className="btn is-ghost" onClick={() => { navigator.clipboard && navigator.clipboard.writeText(`pulse://event/${e.id}`); window.toast("Link copied to clipboard", "success"); }}><Icon name="copy" /> Copy link</button>
                </div>
              </div>

              {/* Advanced (admin only) */}
              <div style={{ padding: "14px 0" }}>
                <button
                  onClick={() => setAdvanced(!advanced)}
                  className="row"
                  style={{ fontSize: 11.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600 }}
                >
                  <Icon name={advanced ? "chevD" : "chevR"} style={{ width: 12, height: 12 }} />
                  Advanced details (admin)
                </button>
                {advanced && (
                  <div style={{ marginTop: 10, padding: 12, background: "var(--surface-2)", borderRadius: 8, fontSize: 12 }}>
                    <div className="kv"><div className="k">Event ID</div><div className="v mono">{e.id}</div></div>
                    {e.ent?.id && <div className="kv"><div className="k">Entity ID</div><div className="v mono">{e.ent.id}</div></div>}
                    <div className="kv"><div className="k">IP address</div><div className="v mono">{e.ip}</div></div>
                    <div className="kv"><div className="k">Device</div><div className="v mono">{e.device}</div></div>
                    <div className="kv"><div className="k">User agent</div><div className="v mono" style={{ fontSize: 11 }}>Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4)…</div></div>
                    <div className="kv"><div className="k">Session ID</div><div className="v mono">sess_2c4f8b91a3e7</div></div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  );
};
