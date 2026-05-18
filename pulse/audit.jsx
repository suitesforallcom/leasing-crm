/* global React, Icon, DATA, Avatar, CatIcon, fmt */

/* ================================================================
   Detailed audit log — every micro-action on the computer
   ================================================================ */

/* Action kinds & their icons + colors */
const KINDS = {
  login:    { icon: "login",   color: "var(--cat-login)",    label: "Sign in" },
  logout:   { icon: "logout",  color: "var(--cat-login)",    label: "Sign out" },
  nav:      { icon: "arrowR",  color: "var(--cat-system)",   label: "Page view" },
  view:     { icon: "eye",     color: "var(--cat-tenant)",   label: "Viewed" },
  open:     { icon: "docOpen", color: "var(--cat-doc)",      label: "Opened" },
  copy:     { icon: "copy",    color: "oklch(60% 0.10 220)", label: "Copied" },
  paste:    { icon: "edit",    color: "oklch(60% 0.10 220)", label: "Pasted" },
  search:   { icon: "search",  color: "var(--cat-system)",   label: "Searched" },
  click:    { icon: "link",    color: "var(--cat-system)",   label: "Clicked" },
  scroll:   { icon: "chevD",   color: "var(--muted-2)",      label: "Scrolled" },
  hover:    { icon: "eye",     color: "var(--muted-2)",      label: "Hovered" },
  type:     { icon: "edit",    color: "var(--cat-task)",     label: "Typed" },
  send:     { icon: "share",   color: "var(--success)",      label: "Sent" },
  call:     { icon: "phone",   color: "var(--cat-call)",     label: "Call" },
  email:    { icon: "mail",    color: "var(--cat-email)",    label: "Email" },
  doc:      { icon: "doc",     color: "var(--cat-doc)",      label: "Document" },
  contract: { icon: "contract",color: "var(--cat-contract)", label: "Contract" },
  upload:   { icon: "docUpload",color: "var(--cat-doc)",     label: "Uploaded" },
  download: { icon: "download",color: "var(--cat-doc)",      label: "Downloaded" },
  edit:     { icon: "edit",    color: "var(--cat-task)",     label: "Edited" },
  save:     { icon: "check",   color: "var(--success)",      label: "Saved" },
  create:   { icon: "plus",    color: "var(--cat-tenant)",   label: "Created" },
  delete:   { icon: "trash",   color: "var(--danger)",       label: "Deleted" },
  idle:     { icon: "pause",   color: "var(--muted-2)",      label: "Idle" },
  active:   { icon: "play",    color: "var(--muted-2)",      label: "Active" },
  shortcut: { icon: "bolt",    color: "var(--cat-system)",   label: "Shortcut" },
  print:    { icon: "doc",     color: "var(--cat-doc)",      label: "Printed" },
  tab:      { icon: "laptop",  color: "var(--muted-2)",      label: "Tab" },
};

/* The detailed event stream for Maya (u1).
   Each event: { t (h:mm:ss), kind, action, entity?, value?, source?, dur? } */
const DETAILED_MAYA = [
  /* === 8:42 AM Login === */
  { t: "8:42:14",  kind: "login",    action: "Signed in",                                 source: "web", meta: { browser: "Chrome 126", os: "macOS 14.4" } },
  { t: "8:42:18",  kind: "nav",      action: "Loaded dashboard",                          page: "/dashboard" },
  { t: "8:42:31",  kind: "view",     action: "Viewed today's KPI summary",                page: "/dashboard" },
  { t: "8:43:04",  kind: "click",    action: "Clicked notification bell",                 value: "3 new" },
  { t: "8:43:09",  kind: "view",     action: "Read notification",                         value: "Bluestone Apparel lease expires in 14 days" },
  { t: "8:43:22",  kind: "nav",      action: "Opened Inbox",                              page: "/inbox" },
  { t: "8:43:28",  kind: "view",     action: "Viewed email",                              entity: "Karen Liu · Lease renewal request",   id: "EM-9821" },
  { t: "8:44:11",  kind: "scroll",   action: "Scrolled email thread",                     value: "2 messages back" },
  { t: "8:45:02",  kind: "copy",     action: "Copied email address",                      value: "karen.liu@abcmedical.com",  source: "EM-9821" },
  { t: "8:45:09",  kind: "click",    action: "Opened sender profile",                     entity: "Karen Liu",                id: "CON-771" },
  { t: "8:45:17",  kind: "view",     action: "Viewed contact card",                       entity: "Karen Liu",                id: "CON-771" },
  { t: "8:45:34",  kind: "copy",     action: "Copied phone number",                       value: "+1 (512) 555-0184",         source: "CON-771" },
  { t: "8:46:11",  kind: "click",    action: "Opened related lead",                       entity: "ABC Medical Office",       id: "LEAD-2104" },
  { t: "8:46:18",  kind: "view",     action: "Viewed lead details",                       entity: "ABC Medical Office",       id: "LEAD-2104" },
  { t: "8:47:01",  kind: "hover",    action: "Previewed lease document",                  entity: "MasterLease_ABC_2024.pdf", id: "DOC-4399", dur: 4 },

  /* === 8:51 AM Email reply === */
  { t: "8:51:08",  kind: "click",    action: "Clicked Reply",                             entity: "Karen Liu thread" },
  { t: "8:51:24",  kind: "type",     action: "Started drafting email",                    entity: "Re: Lease renewal",  chars: 4 },
  { t: "8:52:33",  kind: "type",     action: "Drafted reply",                             entity: "Re: Lease renewal",  chars: 218 },
  { t: "8:53:17",  kind: "paste",    action: "Pasted clipboard content",                  value: "$4,250.00 per month"  },
  { t: "8:53:48",  kind: "send",     action: "Sent email",                                entity: "Karen Liu · Re: Lease renewal", id: "EM-9822" },

  /* === 9:00 — Lead deep-dive === */
  { t: "9:04:11",  kind: "nav",      action: "Opened Leads board",                        page: "/leads" },
  { t: "9:04:28",  kind: "search",   action: "Searched leads",                            value: "medical office" },
  { t: "9:04:46",  kind: "click",    action: "Filtered by stage",                         value: "Qualified" },
  { t: "9:05:02",  kind: "click",    action: "Opened lead",                               entity: "ABC Medical Office",       id: "LEAD-2104" },
  { t: "9:05:08",  kind: "view",     action: "Viewed lead overview",                      entity: "ABC Medical Office" },
  { t: "9:05:34",  kind: "view",     action: "Viewed lease history",                      entity: "ABC Medical Office" },
  { t: "9:05:51",  kind: "view",     action: "Viewed financial summary",                  entity: "ABC Medical Office",       value: "$51,000 ARR" },
  { t: "9:06:18",  kind: "copy",     action: "Copied space requirement",                  value: "2,200 sqft, ground floor" },
  { t: "9:07:09",  kind: "edit",     action: "Updated lead stage",                        entity: "ABC Medical Office", before: "Qualified", after: "Proposal" },
  { t: "9:07:14",  kind: "save",     action: "Saved lead changes",                        entity: "ABC Medical Office" },
  { t: "9:08:22",  kind: "create",   action: "Added activity note",                       entity: "ABC Medical Office", value: "Spoke with Karen — ready for proposal package, 36-mo term preferred" },

  /* === 9:09 — Tenant profile === */
  { t: "9:09:14",  kind: "shortcut", action: "Used keyboard shortcut",                    value: "⌘K (search palette)" },
  { t: "9:09:18",  kind: "type",     action: "Typed in search",                           value: "Bluestone" },
  { t: "9:09:23",  kind: "click",    action: "Selected from search results",              entity: "Bluestone Apparel" },
  { t: "9:09:25",  kind: "view",     action: "Viewed tenant profile",                     entity: "Bluestone Apparel",        id: "TEN-118" },
  { t: "9:09:48",  kind: "view",     action: "Viewed payment history",                    entity: "Bluestone Apparel",        value: "12 mo on-time" },
  { t: "9:10:12",  kind: "view",     action: "Viewed contact list",                       entity: "Bluestone Apparel",        value: "3 contacts" },
  { t: "9:10:31",  kind: "copy",     action: "Copied primary contact email",              value: "aman.p@bluestone.shop", source: "TEN-118" },
  { t: "9:11:02",  kind: "hover",    action: "Hovered occupancy chart",                   entity: "Suite 200, 412 Maple",     dur: 3 },
  { t: "9:11:48",  kind: "view",     action: "Viewed lease PDF preview",                  entity: "MasterLease_2103_Maple_Suite200.pdf", id: "DOC-4399" },
  { t: "9:13:09",  kind: "scroll",   action: "Scrolled to page 14",                       entity: "MasterLease_2103_Maple_Suite200.pdf" },
  { t: "9:14:33",  kind: "copy",     action: "Copied lease section",                      value: "CAM charges: 15% pro-rata of common area" },

  /* === 9:15 — Email send === */
  { t: "9:15:02",  kind: "click",    action: "Clicked Compose",                           page: "/inbox" },
  { t: "9:15:18",  kind: "type",     action: "Drafted subject",                           value: "Rent adjustment proposal" },
  { t: "9:16:33",  kind: "type",     action: "Drafted email body",                        chars: 487 },
  { t: "9:17:01",  kind: "click",    action: "Attached file",                             entity: "RentSchedule_2026.xlsx",   id: "DOC-4420" },
  { t: "9:17:14",  kind: "send",     action: "Sent email",                                entity: "Bluestone Apparel · Rent adjustment proposal", id: "EM-9824" },

  /* === 9:30 — Upload === */
  { t: "9:31:08",  kind: "nav",      action: "Opened Documents",                          page: "/documents" },
  { t: "9:31:14",  kind: "click",    action: "Clicked Upload",                            page: "/documents" },
  { t: "9:31:38",  kind: "upload",   action: "Uploaded file",                             entity: "Insurance_COI_2026.pdf",   id: "DOC-4421", value: "1.2 MB" },
  { t: "9:31:42",  kind: "view",     action: "Reviewed upload preview",                   entity: "Insurance_COI_2026.pdf" },
  { t: "9:31:54",  kind: "edit",     action: "Tagged document",                           entity: "Insurance_COI_2026.pdf", value: "insurance, COI, 2026" },
  { t: "9:32:08",  kind: "edit",     action: "Linked to tenant",                          entity: "Insurance_COI_2026.pdf", value: "→ Bluestone Apparel" },
  { t: "9:32:14",  kind: "save",     action: "Saved document metadata" },

  /* === 9:48 Task complete === */
  { t: "9:48:11",  kind: "click",    action: "Opened tasks panel",                        page: "/tasks" },
  { t: "9:48:33",  kind: "edit",     action: "Marked task complete",                      entity: "Follow up with Brookline Dental", id: "TSK-882" },

  /* === 10:02 — Contract send === */
  { t: "10:01:11", kind: "nav",      action: "Opened Contracts",                          page: "/contracts" },
  { t: "10:01:18", kind: "click",    action: "Clicked New contract",                      page: "/contracts" },
  { t: "10:01:34", kind: "create",   action: "Created contract from template",            entity: "Office Lease v3",          id: "CTR-2204" },
  { t: "10:01:48", kind: "edit",     action: "Set tenant",                                entity: "CTR-2204",                 value: "ABC Medical Office" },
  { t: "10:02:09", kind: "edit",     action: "Set property",                              entity: "CTR-2204",                 value: "2104 Maple Ave Suite 300" },
  { t: "10:02:24", kind: "edit",     action: "Set rent",                                  entity: "CTR-2204",                 value: "$4,375.00 / mo" },
  { t: "10:02:48", kind: "click",    action: "Clicked Send for signature",                entity: "CTR-2204" },
  { t: "10:02:58", kind: "send",     action: "Sent contract via DocuSign",                entity: "Lease – 2104 Maple Ave Suite 300", id: "CTR-2204" },

  /* === 10:21 — Outgoing call === */
  { t: "10:20:51", kind: "click",    action: "Clicked Call",                              entity: "Karen Liu" },
  { t: "10:21:02", kind: "call",     action: "Dialed contact",                            entity: "Karen Liu · ABC Medical", id: "CALL-771", value: "+1 (512) 555-0184" },
  { t: "10:21:14", kind: "call",     action: "Call connected",                            entity: "CALL-771" },
  { t: "10:26:36", kind: "call",     action: "Call ended",                                entity: "CALL-771", value: "5m 22s" },
  { t: "10:27:01", kind: "type",     action: "Added call note",                           entity: "CALL-771", value: "Discussed move-in date Jun 15, confirmed insurance requirements" },
  { t: "10:27:18", kind: "save",     action: "Saved call note" },

  /* === 10:45 Contract opened === */
  { t: "10:45:08", kind: "view",     action: "DocuSign event received",                   entity: "CTR-2204", value: "Recipient opened envelope" },

  /* === 11:13 Incoming call === */
  { t: "11:13:02", kind: "call",     action: "Incoming call",                             entity: "Bluestone Apparel · Aman P.", id: "CALL-772" },
  { t: "11:13:14", kind: "call",     action: "Answered call",                             entity: "CALL-772", value: "12s pickup" },
  { t: "11:17:36", kind: "call",     action: "Call ended",                                entity: "CALL-772", value: "4m 22s" },

  /* === 11:32 Lead edit === */
  { t: "11:31:48", kind: "search",   action: "Searched leads",                            value: "yoga" },
  { t: "11:32:01", kind: "click",    action: "Opened lead",                               entity: "Greentree Yoga Studio",    id: "LEAD-2111" },
  { t: "11:32:14", kind: "edit",     action: "Changed lead stage",                        entity: "Greentree Yoga Studio", before: "Qualified", after: "Proposal" },

  /* === 12:08 Document view === */
  { t: "12:07:58", kind: "view",     action: "Viewed lease",                              entity: "MasterLease_2103_Maple_Suite200.pdf", id: "DOC-4399" },

  /* === 12:34 — 1:16 Idle === */
  { t: "12:34:00", kind: "idle",     action: "Went idle (lunch)",                         dur: 2520 },
  { t: "1:16:00",  kind: "active",   action: "Came back to active",                       value: "from idle 42m" },

  /* === 1:34 Invoice edit === */
  { t: "1:33:48",  kind: "nav",      action: "Opened Invoices",                           page: "/invoices" },
  { t: "1:34:02",  kind: "search",   action: "Searched invoices",                         value: "INV-1182" },
  { t: "1:34:11",  kind: "click",    action: "Opened invoice",                            entity: "INV-1182 · Bluestone Apparel", id: "INV-1182" },
  { t: "1:34:33",  kind: "edit",     action: "Edited invoice amount",                     entity: "INV-1182", before: "$4,250.00", after: "$4,375.00" },
  { t: "1:34:48",  kind: "save",     action: "Saved invoice changes" },

  /* === 1:52 Email === */
  { t: "1:52:14",  kind: "send",     action: "Sent email",                                entity: "Greentree Yoga · Tour scheduled", id: "EM-9831" },

  /* === 2:14 Contract signed === */
  { t: "2:14:11",  kind: "view",     action: "DocuSign event received",                   entity: "CTR-2204", value: "Signed by tenant" },

  /* === 2:18 Download === */
  { t: "2:18:09",  kind: "download", action: "Downloaded signed contract",                entity: "Lease_2104_Maple_Suite300_signed.pdf", id: "DOC-4429" },
  { t: "2:18:42",  kind: "print",    action: "Printed contract",                          entity: "DOC-4429" },

  /* === 2:51 Outgoing call === */
  { t: "2:51:08",  kind: "call",     action: "Outgoing call",                             entity: "Greentree Yoga · Andrea M.", id: "CALL-773", value: "2m 58s" },

  /* === 3:07 Tenant create === */
  { t: "3:06:48",  kind: "click",    action: "Clicked New tenant",                        page: "/tenants" },
  { t: "3:07:01",  kind: "create",   action: "Created tenant record",                     entity: "Cascade Pediatric Therapy", id: "TEN-141" },
  { t: "3:07:18",  kind: "edit",     action: "Added contact info",                        entity: "TEN-141" },
  { t: "3:07:33",  kind: "edit",     action: "Linked to lease",                           entity: "TEN-141",  value: "Suite 4F" },
  { t: "3:07:48",  kind: "save",     action: "Saved tenant record" },

  /* === 3:35 Invoice send === */
  { t: "3:35:11",  kind: "send",     action: "Sent invoice",                              entity: "INV-1186 · Cascade Pediatric · setup fee", id: "INV-1186", value: "$1,500.00" },

  /* === 3:58 Missed call === */
  { t: "3:58:11",  kind: "call",     action: "Missed incoming call",                      entity: "Unknown · +1 (512) 555-0142", id: "CALL-774" },

  /* === 4:12 Task === */
  { t: "4:12:14",  kind: "create",   action: "Created follow-up task",                    entity: "Return missed call · +1 (512) 555-0142", id: "TSK-891" },

  /* === 4:30 Email reply === */
  { t: "4:30:08",  kind: "send",     action: "Replied to email",                          entity: "Karen Liu · Re: Lease renewal", id: "EM-9842" },

  /* === 4:48 Doc edit === */
  { t: "4:48:11",  kind: "edit",     action: "Edited marketing sheet",                    entity: "Marketing_Sheet_2104_Maple.docx", id: "DOC-4435" },
  { t: "4:48:48",  kind: "save",     action: "Auto-saved (3 keystroke pause)" },

  /* === Some random ambient micro-actions === */
  { t: "10:33:14", kind: "tab",      action: "Switched to tab",                           value: "Bluestone payment history" },
  { t: "11:05:02", kind: "shortcut", action: "Used shortcut",                             value: "⌘S (save)" },
  { t: "11:48:33", kind: "hover",    action: "Hovered tooltip",                           value: "What does \"on-time\" mean?", dur: 2 },
  { t: "2:02:18",  kind: "scroll",   action: "Scrolled to bottom of contracts list" },
  { t: "2:34:09",  kind: "tab",      action: "Switched away from Pulse",                  value: "→ Gmail" },
  { t: "2:35:11",  kind: "tab",      action: "Returned to Pulse",                         value: "← Gmail" },
];

/* Add id + parse time */
DETAILED_MAYA.forEach((e, i) => {
  e.id = "AUD-" + (90000 + i);
  e.userId = "u1";
  /* derive minutes for sort */
  const m = e.t.match(/(\d+):(\d+):(\d+)/);
  if (m) {
    let h = parseInt(m[1], 10);
    /* AM/PM heuristic: if h <= 7 treat as PM (afternoon) */
    if (h <= 7) h += 12;
    e._sec = h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  } else e._sec = 0;
});

window.DETAILED_AUDIT = { events: DETAILED_MAYA, KINDS };

/* ================================================================
   Audit log tab UI
   ================================================================ */

window.AuditLogTab = function AuditLogTab({ user, onOpenEvent }) {
  const events = user.id === "u1" ? DETAILED_MAYA : [];
  const [kindFilter, setKindFilter] = React.useState("all");
  const [search, setSearch] = React.useState("");

  const filtered = events.filter(e => {
    if (kindFilter !== "all" && e.kind !== kindFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!e.action.toLowerCase().includes(q)
        && !(e.entity || "").toLowerCase().includes(q)
        && !(e.value || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  /* Group by 5-minute window */
  const groups = {};
  filtered.forEach(e => {
    const m = e.t.match(/(\d+):(\d+)/);
    if (!m) return;
    let h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    /* keep AM/PM as in original */
    const ampm = e._sec >= 12 * 3600 ? "PM" : "AM";
    const dispH = h === 12 ? 12 : h <= 7 ? h : h > 12 ? h - 12 : h;
    const bucket = `${dispH}:${String(Math.floor(mm / 5) * 5).padStart(2, "0")} ${ampm}`;
    if (!groups[bucket]) groups[bucket] = [];
    groups[bucket].push(e);
  });
  const groupList = Object.entries(groups).sort((a, b) => a[1][0]._sec - b[1][0]._sec);

  /* Counts per kind for filter chips */
  const counts = events.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {});
  const topKinds = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([k]) => k);

  if (events.length === 0) {
    return <div className="card"><div className="empty"><div className="icon-wrap"><Icon name="signal" /></div><h4>Detailed audit only available for Maya</h4><p>This demo includes a full {DETAILED_MAYA.length}-event audit trail for Maya. Click her profile or switch to her view.</p></div></div>;
  }

  return (
    <div>
      {/* Summary strip */}
      <div className="card" style={{ padding: 14, marginBottom: 14, background: "linear-gradient(180deg, var(--surface), var(--surface-2))" }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <Icon name="bolt" style={{ color: "var(--accent)" }} />
          <div style={{ fontWeight: 700, fontSize: 14 }}>Full audit log · today</div>
          <span className="chip is-accent">{events.length} actions tracked</span>
          <div className="spacer" />
          <span className="muted" style={{ fontSize: 11.5 }}>Every click, view, copy, and keystroke (privacy-respecting summary)</span>
        </div>
        <div className="row" style={{ gap: 14, flexWrap: "wrap", fontSize: 12 }}>
          {[
            { label: "Pages viewed",   v: events.filter(e => e.kind === "nav" || e.kind === "view").length },
            { label: "Items copied",   v: events.filter(e => e.kind === "copy" || e.kind === "paste").length },
            { label: "Contacts opened",v: events.filter(e => e.action.toLowerCase().includes("contact") || e.action.toLowerCase().includes("tenant") || e.action.toLowerCase().includes("lead")).length },
            { label: "Edits saved",    v: events.filter(e => e.kind === "save" || e.kind === "edit").length },
            { label: "Searches",       v: events.filter(e => e.kind === "search").length },
            { label: "Idle time",      v: "42m" },
          ].map(s => (
            <div key={s.label}>
              <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 600 }}>{s.label}</div>
              <div className="num" style={{ fontWeight: 800, fontSize: 16 }}>{s.v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="filters">
        <div className="search" style={{ minWidth: 240, padding: "6px 10px", background: "var(--surface)" }}>
          <Icon name="search" />
          <input placeholder="Search actions, contacts, copied text…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <button className={"chip" + (kindFilter === "all" ? " is-accent" : "")} onClick={() => setKindFilter("all")} style={{ cursor: "pointer", padding: "6px 12px" }}>
          All
          <span className="num" style={{ marginLeft: 4, fontWeight: 700 }}>{events.length}</span>
        </button>
        {topKinds.map(k => {
          const kd = KINDS[k];
          if (!kd) return null;
          const active = kindFilter === k;
          return (
            <button
              key={k}
              className={"chip" + (active ? " is-accent" : "")}
              onClick={() => setKindFilter(k)}
              style={{ cursor: "pointer", padding: "6px 12px" }}
            >
              <Icon name={kd.icon} style={{ color: active ? "var(--accent-ink)" : kd.color }} />
              {kd.label}
              <span className="num" style={{ marginLeft: 4, fontWeight: 700 }}>{counts[k]}</span>
            </button>
          );
        })}
      </div>

      {/* Audit list */}
      <div className="card is-clean">
        {groupList.map(([bucket, items], gi) => (
          <div key={bucket}>
            <div style={{ padding: "10px 18px", background: "var(--surface-2)", borderTop: gi === 0 ? "none" : "1px solid var(--border)", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 11.5, color: "var(--muted)", letterSpacing: ".04em", textTransform: "uppercase" }}>
              {bucket} · {items.length} action{items.length === 1 ? "" : "s"}
            </div>
            {items.map((e, i) => <AuditRow key={e.id} e={e} onOpen={onOpenEvent} />)}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="empty"><div className="icon-wrap"><Icon name="search" /></div><h4>No matching events</h4><p>Try clearing the filter or search.</p></div>
        )}
      </div>
    </div>
  );
};

function AuditRow({ e, onOpen }) {
  const k = KINDS[e.kind] || KINDS.nav;
  return (
    <button
      className="row audit-row"
      onClick={() => onOpen && onOpen({
        id: e.id,
        cat: e.kind === "call" ? "call" : e.kind === "email" || e.kind === "send" ? "email" : e.kind === "contract" ? "contract" : e.kind === "upload" || e.kind === "download" || e.kind === "doc" ? "document" : "system",
        type: e.kind,
        desc: e.action,
        ent: e.entity ? { kind: "audit", name: e.entity, id: e.id } : null,
        time: e.t,
        userId: "u1",
        ip: "73.118.42.17",
        device: "MacBook Pro · Chrome 126",
        status: "ok",
        source: e.source || "web",
        before: e.before,
        after: e.after,
      })}
      style={{
        width: "100%", textAlign: "left",
        padding: "10px 18px",
        gap: 14,
        borderTop: "1px solid var(--border)",
        cursor: "pointer",
        alignItems: "flex-start",
      }}
    >
      <span className="mono" style={{ fontSize: 11, color: "var(--muted)", minWidth: 60, paddingTop: 3 }}>{e.t}</span>
      <span className="cat-icon sm" style={{ background: k.color, flexShrink: 0, marginTop: 1 }}>
        <Icon name={k.icon} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, lineHeight: 1.4 }}>
          <span style={{ fontWeight: 500 }}>{e.action}</span>
          {e.entity && <> <span style={{ color: "var(--accent-ink)", fontWeight: 600 }}>{e.entity}</span></>}
        </div>
        {(e.value || e.before || e.chars || e.dur || e.page) && (
          <div className="muted" style={{ fontSize: 11.5, marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {e.before && e.after && (
              <span className="chip" style={{ padding: "0 6px", fontSize: 10.5 }}>
                <span style={{ color: "var(--danger-ink)", textDecoration: "line-through" }}>{e.before}</span>
                <Icon name="arrowR" style={{ width: 10, height: 10, color: "var(--muted)" }} />
                <span style={{ color: "var(--success-ink)", fontWeight: 600 }}>{e.after}</span>
              </span>
            )}
            {e.value && <span style={{ fontFamily: "var(--font-mono)", background: "var(--surface-2)", padding: "1px 6px", borderRadius: 4, fontSize: 11 }}>{e.value.length > 60 ? e.value.slice(0, 60) + "…" : e.value}</span>}
            {e.chars && <span>{e.chars} chars</span>}
            {e.dur && <span>{e.dur < 60 ? e.dur + "s" : Math.round(e.dur / 60) + "m"}</span>}
            {e.page && <span>{e.page}</span>}
            {e.source && <span>via {e.source}</span>}
          </div>
        )}
      </div>
      {e.id && <span className="mono muted" style={{ fontSize: 10, paddingTop: 4 }}>{e.id.replace("AUD-", "#")}</span>}
    </button>
  );
}
