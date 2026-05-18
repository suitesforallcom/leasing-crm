/* ============================================================
   Mock data layer — realistic enough to feel like a real product.
   Real-estate leasing context: tenants, leases, contracts, properties.
   ============================================================ */

const ROLES = {
  agent: { label: "Leasing Agent", short: "Agent" },
  manager: { label: "Property Manager", short: "Manager" },
  accountant: { label: "Accountant", short: "Acct" },
  admin: { label: "Administrator", short: "Admin" },
};

/* ============================================================
   Centers (branches / locations)
   ============================================================ */
const CENTERS = [
  { id: "c1", name: "Downtown Tower",    short: "DT", address: "412 Congress Ave, Austin",   properties: 14, color: "oklch(56% 0.17 264)" },
  { id: "c2", name: "Westside Plaza",    short: "WS", address: "2210 Bowman Rd, Austin",     properties: 8,  color: "oklch(60% 0.13 158)" },
  { id: "c3", name: "Cedar Park Annex",  short: "CP", address: "1812 Cedar Park Dr",         properties: 5,  color: "oklch(73% 0.15 78)"  },
  { id: "c4", name: "Riverside Center",  short: "RS", address: "55 Riverview Pkwy, SA",      properties: 4,  color: "oklch(60% 0.20 25)"  },
];
const CENTER_BY_ID = Object.fromEntries(CENTERS.map(c => [c.id, c]));

const CATEGORIES = {
  login:    { label: "Login",     color: "var(--cat-login)",    icon: "login" },
  logout:   { label: "Logout",    color: "var(--cat-login)",    icon: "logout" },
  document: { label: "Document",  color: "var(--cat-doc)",      icon: "doc" },
  contract: { label: "Contract",  color: "var(--cat-contract)", icon: "contract" },
  email:    { label: "Email",     color: "var(--cat-email)",    icon: "mail" },
  call:     { label: "Call",      color: "var(--cat-call)",     icon: "phone" },
  lead:     { label: "Lead",      color: "var(--cat-lead)",     icon: "user" },
  tenant:   { label: "Tenant",    color: "var(--cat-tenant)",   icon: "building" },
  invoice:  { label: "Invoice",   color: "var(--cat-invoice)",  icon: "invoice" },
  task:     { label: "Task",      color: "var(--cat-task)",     icon: "task" },
  system:   { label: "System",    color: "var(--cat-system)",   icon: "settings" },
  security: { label: "Security",  color: "var(--cat-security)", icon: "shield" },
};

const USERS = [
  { id: "u1", first: "Maya",    last: "Okafor",     role: "agent",      avatar: "a-c4", status: "online",  online: 312, login: "8:42 AM", logout: null,     ip: "73.118.42.17",  device: "MacBook · Chrome",   loc: "Austin, TX",   score: 92, prev: 84, actions: 147, calls: 14, emails: 32, contracts: 4, docs: 11, unread: 0 },
  { id: "u2", first: "Daniel",  last: "Park",       role: "manager",    avatar: "a-c5", status: "online",  online: 287, login: "9:08 AM", logout: null,     ip: "73.118.42.18",  device: "iMac · Safari",      loc: "Austin, TX",   score: 88, prev: 90, actions: 121, calls: 8,  emails: 24, contracts: 6, docs: 9,  unread: 0 },
  { id: "u3", first: "Aaliyah", last: "Brooks",     role: "agent",      avatar: "a-c1", status: "online",  online: 261, login: "8:51 AM", logout: null,     ip: "104.32.18.7",   device: "Windows · Edge",     loc: "Houston, TX",  score: 95, prev: 89, actions: 162, calls: 22, emails: 41, contracts: 3, docs: 14, unread: 2 },
  { id: "u4", first: "Henry",   last: "Müller",     role: "accountant", avatar: "a-c6", status: "idle",    online: 198, login: "9:32 AM", logout: null,     ip: "73.118.42.21",  device: "MacBook · Chrome",   loc: "Austin, TX",   score: 71, prev: 78, actions: 64,  calls: 0,  emails: 12, contracts: 0, docs: 28, unread: 0 },
  { id: "u5", first: "Priya",   last: "Raman",      role: "agent",      avatar: "a-c2", status: "online",  online: 244, login: "8:58 AM", logout: null,     ip: "73.118.42.22",  device: "MacBook · Chrome",   loc: "Austin, TX",   score: 81, prev: 76, actions: 98,  calls: 11, emails: 27, contracts: 2, docs: 6,  unread: 0 },
  { id: "u6", first: "Joaquin", last: "Vargas",     role: "manager",    avatar: "a-c3", status: "online",  online: 219, login: "9:15 AM", logout: null,     ip: "73.118.42.23",  device: "iPad · Safari",      loc: "On-site",      score: 84, prev: 80, actions: 88,  calls: 6,  emails: 17, contracts: 5, docs: 7,  unread: 1 },
  { id: "u7", first: "Sofia",   last: "Reyes",      role: "agent",      avatar: "a-c7", status: "offline", online: 0,   login: null,        logout: null,    ip: "—",             device: "—",                  loc: "PTO",          score: 0,  prev: 86, actions: 0,   calls: 0,  emails: 0,  contracts: 0, docs: 0,  unread: 0, away: "Paid time off" },
  { id: "u8", first: "Marcus",  last: "Whitfield",  role: "agent",      avatar: "a-c8", status: "online",  online: 175, login: "10:04 AM",login: "10:04 AM", logout: null, ip: "73.118.42.24",  device: "MacBook · Chrome",   loc: "Austin, TX",   score: 67, prev: 72, actions: 51,  calls: 7,  emails: 11, contracts: 1, docs: 3,  unread: 0 },
  { id: "u9", first: "Elena",   last: "Volkova",    role: "admin",      avatar: "a-c4", status: "online",  online: 296, login: "8:30 AM", logout: null,     ip: "73.118.42.25",  device: "Linux · Firefox",    loc: "Austin, TX",   score: 89, prev: 91, actions: 134, calls: 2,  emails: 38, contracts: 0, docs: 19, unread: 0 },
  { id: "u10", first: "Theo",   last: "Nakamura",   role: "accountant", avatar: "a-c9", status: "idle",    online: 142, login: "9:48 AM", logout: null,     ip: "73.118.42.26",  device: "MacBook · Chrome",   loc: "Austin, TX",   score: 74, prev: 70, actions: 47,  calls: 1,  emails: 9,  contracts: 0, docs: 22, unread: 0 },
  { id: "u11", first: "Beatriz",last: "Carvalho",   role: "agent",      avatar: "a-c10",status: "online",  online: 228, login: "9:12 AM", logout: null,     ip: "104.32.18.9",   device: "Windows · Chrome",   loc: "San Antonio",  score: 86, prev: 82, actions: 109, calls: 16, emails: 29, contracts: 3, docs: 8,  unread: 0 },
  { id: "u12", first: "James",  last: "O'Sullivan", role: "manager",    avatar: "a-c1", status: "offline", online: 0,   login: "7:54 AM", logout: "8:22 AM", ip: "—",             device: "MacBook · Chrome",   loc: "Off duty",     score: 22, prev: 78, actions: 8,   calls: 0,  emails: 1,  contracts: 0, docs: 0,  unread: 0, away: "Logged out early", unusual: true },
];

USERS.forEach(u => { u.name = u.first + " " + u.last; u.initials = (u.first[0] + u.last[0]).toUpperCase(); });

/* Assign each user to a center */
const USER_CENTER = {
  u1: "c1", u2: "c2", u3: "c1", u4: "c2", u5: "c1", u6: "c2",
  u7: "c3", u8: "c1", u9: "c1", u10: "c1", u11: "c4", u12: "c3",
};
USERS.forEach(u => { u.centerId = USER_CENTER[u.id]; u.center = CENTER_BY_ID[u.centerId]; });

/* ============================================================
   Event seed for Maya Okafor (u1) — feature subject for Timeline.
   ============================================================ */
const EVENTS_MAYA = [
  { time: "8:42 AM", cat: "login",    type: "login",      desc: "Signed in",                                ent: null,                              status: "ok",       source: "web" },
  { time: "8:46 AM", cat: "system",   type: "view",       desc: "Opened today's dashboard",                  ent: null,                              status: "ok",       source: "web" },
  { time: "8:51 AM", cat: "email",    type: "received",   desc: "Read email from",                            ent: { kind: "email",   name: "Karen Liu · Lease renewal request", id: "EM-9821" }, status: "ok", source: "web" },
  { time: "9:04 AM", cat: "lead",     type: "open",       desc: "Opened lead",                                ent: { kind: "lead",    name: "ABC Medical Office",   id: "LEAD-2104" }, status: "ok",       source: "web" },
  { time: "9:09 AM", cat: "tenant",   type: "view",       desc: "Viewed tenant profile",                      ent: { kind: "tenant",  name: "Bluestone Apparel",    id: "TEN-118"  }, status: "ok",       source: "web" },
  { time: "9:15 AM", cat: "email",    type: "sent",       desc: "Sent email to tenant",                       ent: { kind: "email",   name: "Bluestone Apparel · Rent adjustment proposal", id: "EM-9824" }, status: "ok", source: "web" },
  { time: "9:31 AM", cat: "document", type: "uploaded",   desc: "Uploaded document",                          ent: { kind: "doc",     name: "Insurance_COI_2026.pdf", id: "DOC-4421", size: "1.2 MB" }, status: "ok", source: "web" },
  { time: "9:48 AM", cat: "task",     type: "completed",  desc: "Completed task",                             ent: { kind: "task",    name: "Follow up with Brookline Dental", id: "TSK-882" }, status: "ok", source: "web" },
  { time: "10:02 AM",cat: "contract", type: "sent",       desc: "Sent contract for signature",                ent: { kind: "contract",name: "Lease – 2104 Maple Ave Suite 300", id: "CTR-2204" }, status: "pending", source: "docusign" },
  { time: "10:21 AM",cat: "call",     type: "outgoing",   desc: "Outgoing call to lead",                      ent: { kind: "call",    name: "Karen Liu · ABC Medical", id: "CALL-771", durationSeconds: 322 }, status: "ok", source: "phone" },
  { time: "10:45 AM",cat: "contract", type: "opened",     desc: "Contract opened by recipient",               ent: { kind: "contract",name: "Lease – 2104 Maple Ave Suite 300", id: "CTR-2204" }, status: "ok", source: "docusign" },
  { time: "11:13 AM",cat: "call",     type: "incoming",   desc: "Incoming call completed",                    ent: { kind: "call",    name: "Bluestone Apparel · Aman P.", id: "CALL-772", durationSeconds: 262 }, status: "ok", source: "phone" },
  { time: "11:32 AM",cat: "lead",     type: "edit",       desc: "Updated lead stage",                         ent: { kind: "lead",    name: "Greentree Yoga Studio", id: "LEAD-2111" }, status: "ok", before: "Qualified", after: "Proposal", source: "web" },
  { time: "12:08 PM",cat: "document", type: "viewed",     desc: "Viewed lease document",                      ent: { kind: "doc",     name: "MasterLease_2103_Maple_Suite200.pdf", id: "DOC-4399" }, status: "ok", source: "web" },
  { time: "12:34 PM",cat: "system",   type: "idle",       desc: "Lunch break (idle 42 min)",                  ent: null,                              status: "info",     source: "web" },
  { time: "1:34 PM", cat: "invoice",  type: "edit",       desc: "Edited invoice amount",                      ent: { kind: "invoice", name: "INV-1182 · Bluestone Apparel · Apr", id: "INV-1182" }, status: "ok", before: "$4,250.00", after: "$4,375.00", source: "web" },
  { time: "1:52 PM", cat: "email",    type: "sent",       desc: "Sent email to",                              ent: { kind: "email",   name: "Greentree Yoga · Tour scheduled", id: "EM-9831" }, status: "ok", source: "web" },
  { time: "2:14 PM", cat: "contract", type: "signed",     desc: "Contract signed by tenant",                  ent: { kind: "contract",name: "Lease – 2104 Maple Ave Suite 300", id: "CTR-2204" }, status: "ok", source: "docusign" },
  { time: "2:18 PM", cat: "document", type: "downloaded", desc: "Downloaded signed contract",                 ent: { kind: "doc",     name: "Lease_2104_Maple_Suite300_signed.pdf", id: "DOC-4429" }, status: "ok", source: "web" },
  { time: "2:51 PM", cat: "call",     type: "outgoing",   desc: "Outgoing call",                              ent: { kind: "call",    name: "Greentree Yoga · Andrea M.", id: "CALL-773", durationSeconds: 178 }, status: "ok", source: "phone" },
  { time: "3:07 PM", cat: "tenant",   type: "create",     desc: "Created new tenant record",                  ent: { kind: "tenant",  name: "Cascade Pediatric Therapy", id: "TEN-141" }, status: "ok", source: "web" },
  { time: "3:35 PM", cat: "invoice",  type: "send",       desc: "Sent invoice",                               ent: { kind: "invoice", name: "INV-1186 · Cascade Pediatric · setup fee", id: "INV-1186" }, status: "ok", source: "web" },
  { time: "3:58 PM", cat: "call",     type: "missed",     desc: "Missed call from",                           ent: { kind: "call",    name: "Unknown · +1 (512) 555-0142", id: "CALL-774", durationSeconds: 0 }, status: "warn", source: "phone" },
  { time: "4:12 PM", cat: "task",     type: "create",     desc: "Created follow-up task",                     ent: { kind: "task",    name: "Return missed call · +1 (512) 555-0142", id: "TSK-891" }, status: "ok", source: "web" },
  { time: "4:30 PM", cat: "email",    type: "reply",      desc: "Replied to email from",                      ent: { kind: "email",   name: "Karen Liu · Re: Lease renewal", id: "EM-9842" }, status: "ok", source: "web" },
  { time: "4:48 PM", cat: "document", type: "edited",     desc: "Edited document",                            ent: { kind: "doc",     name: "Marketing_Sheet_2104_Maple.docx", id: "DOC-4435" }, status: "ok", source: "web" },
];

/* Add metadata to every event */
EVENTS_MAYA.forEach((e, i) => {
  e.id = "EV-" + (10001 + i);
  e.userId = "u1";
  e.ip = "73.118.42.17";
  e.device = "MacBook Pro · Chrome 126";
  e.importance = e.cat === "contract" || e.cat === "call" ? "high" : "normal";
  if (e.status === "warn") e.isUnusual = true;
});

/* Smaller event seeds for other users — used in live feed */
function makeMicroEvents(userId, list) {
  return list.map((e, i) => ({
    id: "EV-" + userId + "-" + i,
    userId,
    ip: USERS.find(u => u.id === userId)?.ip || "—",
    device: USERS.find(u => u.id === userId)?.device || "—",
    status: e.status || "ok",
    ...e,
  }));
}

const EVENTS_OTHERS = [
  ...makeMicroEvents("u3", [
    { time: "8:51 AM", cat: "login",    type: "login",    desc: "Signed in" },
    { time: "9:22 AM", cat: "call",     type: "outgoing", desc: "Outgoing call to lead",    ent: { kind: "call",    name: "Riverside Dental · J. Park", id: "CALL-781", durationSeconds: 412 } },
    { time: "10:14 AM",cat: "contract", type: "sent",     desc: "Sent contract",            ent: { kind: "contract",name: "Lease – 88 Bowman St Suite 210", id: "CTR-2207" }, status: "pending" },
    { time: "11:02 AM",cat: "email",    type: "sent",     desc: "Sent email batch (8)",     ent: { kind: "email",   name: "Q2 prospect outreach", id: "EM-9855" } },
    { time: "1:46 PM", cat: "tenant",   type: "create",   desc: "Created new tenant",       ent: { kind: "tenant",  name: "Northbend Coffee Roasters", id: "TEN-142" } },
    { time: "3:12 PM", cat: "contract", type: "signed",   desc: "Contract signed",          ent: { kind: "contract",name: "Lease – 88 Bowman St Suite 210", id: "CTR-2207" } },
  ]),
  ...makeMicroEvents("u2", [
    { time: "9:11 AM", cat: "login",    type: "login",    desc: "Signed in" },
    { time: "9:48 AM", cat: "document", type: "uploaded", desc: "Uploaded inspection report", ent: { kind: "doc", name: "Inspection_412_Cedar.pdf", id: "DOC-4451" } },
    { time: "11:20 AM",cat: "task",     type: "create",   desc: "Assigned 4 work orders to vendor", ent: { kind: "task", name: "412 Cedar · HVAC quarterly", id: "TSK-901" } },
    { time: "2:18 PM", cat: "contract", type: "completed",desc: "Contract completed",       ent: { kind: "contract",name: "Renewal – Bluestone Apparel", id: "CTR-2199" } },
  ]),
  ...makeMicroEvents("u9", [
    { time: "8:31 AM", cat: "login",    type: "login",    desc: "Signed in" },
    { time: "9:18 AM", cat: "system",   type: "edit",     desc: "Updated user permissions", ent: { kind: "system",  name: "Role: Leasing Agent",        id: "SYS-12" }, importance: "high" },
    { time: "11:55 AM",cat: "email",    type: "sent",     desc: "Sent payroll summary email", ent: { kind: "email",  name: "April payroll summary",      id: "EM-9870" } },
  ]),
  ...makeMicroEvents("u4", [
    { time: "9:35 AM", cat: "login",    type: "login",    desc: "Signed in" },
    { time: "10:22 AM",cat: "invoice",  type: "create",   desc: "Generated 14 monthly invoices", ent: { kind: "invoice", name: "May rent batch",          id: "INV-BATCH-058" } },
    { time: "1:08 PM", cat: "invoice",  type: "send",     desc: "Sent invoice batch to tenants", ent: { kind: "invoice", name: "May rent batch · 14 invoices", id: "INV-BATCH-058" } },
  ]),
  ...makeMicroEvents("u6", [
    { time: "9:18 AM", cat: "login",    type: "login",    desc: "Signed in (mobile)" },
    { time: "10:42 AM",cat: "task",     type: "completed",desc: "Completed walkthrough",    ent: { kind: "task",    name: "412 Cedar · Unit 4B inspection", id: "TSK-922" } },
    { time: "2:34 PM", cat: "document", type: "uploaded", desc: "Uploaded photos (12)",     ent: { kind: "doc",     name: "412_Cedar_4B_photos.zip",        id: "DOC-4480" } },
  ]),
  ...makeMicroEvents("u12", [
    { time: "7:54 AM", cat: "login",    type: "login",    desc: "Signed in", source: "web" },
    { time: "8:14 AM", cat: "security", type: "failed",   desc: "Failed login attempt (3x)", status: "warn", isUnusual: true, source: "web" },
    { time: "8:22 AM", cat: "logout",   type: "logout",   desc: "Signed out (unusual: early)", status: "warn", isUnusual: true },
  ]),
  ...makeMicroEvents("u11", [
    { time: "9:14 AM", cat: "login",    type: "login",    desc: "Signed in" },
    { time: "11:48 AM",cat: "call",     type: "outgoing", desc: "Outgoing call",            ent: { kind: "call",    name: "Westwood Property · L. Tran",   id: "CALL-790", durationSeconds: 540 } },
    { time: "2:08 PM", cat: "contract", type: "sent",     desc: "Sent contract",            ent: { kind: "contract",name: "Lease – Westwood Suite 4F",     id: "CTR-2212" }, status: "pending" },
  ]),
];

/* full event list (oldest -> newest); we'll sort in components by time */
const ALL_EVENTS = [...EVENTS_MAYA, ...EVENTS_OTHERS];

/* ============================================================
   Activity bar segments for "today" (login history visualization)
   Each segment: start (minutes from 6am), length (minutes), type (act/idle/away)
   ============================================================ */
function dayBarFor(userId) {
  if (userId === "u1") return [
    { s: 162, l: 28, t: "act" }, { s: 190, l: 80, t: "act" }, { s: 270, l: 14, t: "idle" },
    { s: 284, l: 60, t: "act" }, { s: 344, l: 42, t: "away" }, { s: 386, l: 110, t: "act" },
    { s: 496, l: 22, t: "idle" }, { s: 518, l: 90, t: "act" },
  ];
  if (userId === "u12") return [{ s: 114, l: 8, t: "act" }, { s: 122, l: 6, t: "idle" }];
  if (userId === "u7") return [];
  // generic active day
  return [
    { s: 175, l: 95, t: "act" }, { s: 270, l: 32, t: "idle" }, { s: 302, l: 95, t: "act" },
    { s: 397, l: 50, t: "away" }, { s: 447, l: 130, t: "act" },
  ];
}

/* Hourly action counts for productivity charts */
function hourlyActionsFor(userId) {
  const seed = userId.charCodeAt(1) || 7;
  const peak = 12 + (seed % 4);
  const out = [];
  for (let h = 7; h <= 19; h++) {
    const dist = Math.max(0, 1 - Math.abs(h - peak) / 6);
    const base = Math.round((6 + seed % 5) * dist + (seed % 3));
    out.push({ h, v: Math.max(0, base + (h === 12 ? -3 : 0) + ((h * seed) % 5 - 2)) });
  }
  return out;
}

/* 30-day score trend */
function trend30(userId) {
  const seed = (userId.charCodeAt(1) || 7) * 13;
  const out = [];
  for (let i = 0; i < 30; i++) {
    const wave = Math.sin((i + seed) / 5) * 8 + Math.cos(i / 3) * 4;
    const base = 75 + (seed % 12);
    out.push(Math.round(base + wave + ((i * 7) % 9 - 4)));
  }
  return out;
}

window.DATA = {
  ROLES, CATEGORIES, CENTERS, CENTER_BY_ID, USERS, ALL_EVENTS, EVENTS_MAYA, EVENTS_OTHERS,
  dayBarFor, hourlyActionsFor, trend30,
};
