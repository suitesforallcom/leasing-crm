// Right panel — contextual
// When nothing selected: Portfolio dashboard (KPIs, revenue, floor summary, action queues)
// When a suite is selected: Unit detail with actions (send reminder, message tenant, etc.)

const RightPanel = ({
  tab, setTab,
  suites, floors, currentFloor,
  selectedId, onSelect,
  onSendReminder, onMessageTenant, onMarkPaid,
  messageToast,
}) => {
  const selected = suites.find(s => s.id === selectedId);

  return (
    <aside style={rpStyles.root}>
      {/* Tabs */}
      <div style={rpStyles.tabs}>
        {["Dashboard", "Unit", "Layers"].map(t => {
          const active = tab === t.toLowerCase();
          const enabled = t !== "Unit" || selected;
          return (
            <button
              key={t}
              onClick={() => enabled && setTab(t.toLowerCase())}
              style={{
                ...rpStyles.tab,
                ...(active ? rpStyles.tabActive : {}),
                opacity: enabled ? 1 : 0.4,
                cursor: enabled ? "pointer" : "not-allowed",
              }}
            >
              {t}
              {t === "Unit" && selected && (
                <span style={rpStyles.tabBadge}>{selected.id}</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={rpStyles.scroll}>
        {tab === "dashboard" && <DashboardTab suites={suites} floors={floors} currentFloor={currentFloor} onSelect={onSelect} setTab={setTab}/>}
        {tab === "unit" && selected && <UnitTab suite={selected} onSendReminder={onSendReminder} onMessageTenant={onMessageTenant} onMarkPaid={onMarkPaid}/>}
        {tab === "layers" && <LayersTab/>}
      </div>

      {messageToast && (
        <div style={rpStyles.toast}>
          <Icon name="check" size={13} style={{ color: THEME.paid }}/>
          <span>{messageToast}</span>
        </div>
      )}
    </aside>
  );
};

// ─── Dashboard Tab ────────────────────────────────────────────
const DashboardTab = ({ suites, floors, currentFloor, onSelect, setTab }) => {
  const vacant = suites.filter(s => s.status === "vacant").length;
  const occupied = suites.filter(s => s.status !== "vacant" && s.status !== "reserved").length;
  const total = suites.length;

  const monthly = suites.reduce((sum, s) => s.status === "paid" || s.status === "due" ? sum + s.rent : sum, 0);
  const potential = suites.reduce((sum, s) => sum + s.rent, 0);
  const occupiedPct = Math.round((occupied / total) * 100);

  const overdueList = suites.filter(s => s.status === "overdue");
  const pendingList = suites.filter(s => s.status === "pending-signature");
  const dueList     = suites.filter(s => s.status === "due");

  const rentableSqft = suites.reduce((sum, s) => sum + s.sqft, 0);
  const occupiedSqft = suites.filter(s => s.status !== "vacant" && s.status !== "reserved").reduce((sum, s) => sum + s.sqft, 0);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Context */}
      <div>
        <div style={rpStyles.contextLabel}>FLOOR</div>
        <div style={rpStyles.contextValue}>SuitesForAll · 4th Floor</div>
      </div>

      {/* Revenue — hero metric */}
      <div style={rpStyles.heroCard}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={rpStyles.heroNum}>{fmt$(monthly)}</span>
          <span style={rpStyles.heroUnit}>/ month</span>
        </div>
        <div style={rpStyles.heroSub}>
          Collected {Math.round(monthly/potential*100)}% of potential {fmt$(potential)}
        </div>
        <div style={rpStyles.progressTrack}>
          <div style={{ ...rpStyles.progressFill, width: `${monthly/potential*100}%`, background: THEME.paid }}/>
        </div>
        <div style={rpStyles.heroGrid}>
          <MiniStat label="Occupied" value={`${occupied}/${total}`} sub={`${occupiedPct}%`}/>
          <MiniStat label="Vacant"   value={vacant}  sub={`${Math.round(vacant/total*100)}%`}/>
          <MiniStat label="Rentable" value={`${occupiedSqft.toLocaleString()}`} sub={`of ${rentableSqft.toLocaleString()} ft²`}/>
        </div>
      </div>

      {/* Action queues — the property manager's to-do list */}
      <Section title="Needs attention" count={overdueList.length + pendingList.length + dueList.length}>
        {overdueList.length > 0 && (
          <ActionGroup
            title={`${overdueList.length} overdue`}
            amount={overdueList.reduce((a,s)=>a+s.rent, 0)}
            color={THEME.overdue}
            items={overdueList}
            onSelect={(s) => { onSelect(s.id); setTab("unit"); }}
            actionLabel="Send reminder"
          />
        )}
        {pendingList.length > 0 && (
          <ActionGroup
            title={`${pendingList.length} awaiting signature`}
            color={THEME.pending}
            items={pendingList}
            onSelect={(s) => { onSelect(s.id); setTab("unit"); }}
            actionLabel="Resend"
          />
        )}
        {dueList.length > 0 && (
          <ActionGroup
            title={`${dueList.length} due this week`}
            color={THEME.due}
            items={dueList}
            onSelect={(s) => { onSelect(s.id); setTab("unit"); }}
            actionLabel="Remind"
          />
        )}
      </Section>

      {/* Floor summary */}
      <Section title="Floors in building">
        {floors.map(f => (
          <FloorRow key={f.id} floor={f} active={f.id === currentFloor}/>
        ))}
      </Section>

      {/* Rates summary */}
      <Section title="Average rent">
        <div style={{ display: "flex", gap: 8 }}>
          <RateCard label="Window" value="$92" sub="per ft²" icon="window"/>
          <RateCard label="Interior" value="$68" sub="per ft²" icon="wrench"/>
        </div>
      </Section>
    </div>
  );
};

// ─── Unit Tab ────────────────────────────────────────────
const UnitTab = ({ suite, onSendReminder, onMessageTenant, onMarkPaid }) => {
  const meta = STATUS_META[suite.status];
  const isEmpty = suite.tenant === "—";

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={rpStyles.unitId}>Suite {suite.id}</span>
          <StatusPill status={suite.status}/>
          {suite.newTenant && (
            <span style={{ ...rpStyles.ghostChip, color: THEME.newStar, borderColor: THEME.newStar }}>
              <Icon name="star" size={10}/> New
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: THEME.inkSubtle }}>
          4th Floor · {suite.type === "window" ? "Window unit" : "Interior unit"} · {suite.sqft} ft² · {suite.party}-person capacity
        </div>
      </div>

      {/* Rent breakdown */}
      <div style={rpStyles.unitCard}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span style={rpStyles.unitCardLabel}>Monthly rent</span>
          <span style={rpStyles.unitCardNum}>{fmt$(suite.rent)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: THEME.inkSubtle, marginTop: 4 }}>
          <span>Effective rate</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>${(suite.rent / suite.sqft).toFixed(2)} / ft²</span>
        </div>
      </div>

      {/* Tenant */}
      {!isEmpty ? (
        <div>
          <div style={rpStyles.sectionTitle}>
            <span>Tenant</span>
          </div>
          <div style={rpStyles.tenantCard}>
            <div style={rpStyles.tenantAvatar}>{suite.tenant.split(/\s+/).map(p=>p[0]).slice(0,2).join("")}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: THEME.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{suite.tenant}</div>
              <div style={{ fontSize: 11, color: THEME.inkSubtle }}>Tenant · since Mar 2025</div>
            </div>
            <button style={rpStyles.iconBtn} title="Message" onClick={() => onMessageTenant(suite)}>
              <Icon name="message" size={14}/>
            </button>
          </div>
        </div>
      ) : (
        <div style={rpStyles.emptyTenant}>
          <div style={{ fontSize: 13, fontWeight: 500, color: THEME.ink, marginBottom: 2 }}>Unit is vacant</div>
          <div style={{ fontSize: 11, color: THEME.inkSubtle, marginBottom: 10 }}>Available immediately · list rate {fmt$(suite.rent)}/mo</div>
          <button style={rpStyles.primaryBtn}>
            <Icon name="plus" size={13}/> Add to listing
          </button>
        </div>
      )}

      {/* Contextual actions */}
      {!isEmpty && (
        <div>
          <div style={rpStyles.sectionTitle}><span>Actions</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {suite.status === "overdue" && (
              <ActionRow icon="send" label="Send payment reminder" sub={`3 days past due · ${fmt$(suite.rent)}`} onClick={() => onSendReminder(suite)} color={THEME.overdue}/>
            )}
            {suite.status === "due" && (
              <ActionRow icon="send" label="Send gentle reminder" sub={`Due in 4 days`} onClick={() => onSendReminder(suite)} color={THEME.due}/>
            )}
            {suite.status === "pending-signature" && (
              <ActionRow icon="signature" label="Resend lease for signature" sub="Sent 5 days ago via DocuSign" onClick={() => onSendReminder(suite)} color={THEME.pending}/>
            )}
            {(suite.status === "overdue" || suite.status === "due") && (
              <ActionRow icon="check" label="Mark as paid" onClick={() => onMarkPaid(suite)}/>
            )}
            <ActionRow icon="file" label="View lease agreement" sub="Expires Mar 2026"/>
            <ActionRow icon="dollar" label="Invoice history" sub="12 of 12 paid on time · 2 late"/>
            <ActionRow icon="calendar" label="Schedule inspection"/>
          </div>
        </div>
      )}

      {/* Mini 12-month payment strip */}
      {!isEmpty && (
        <div>
          <div style={rpStyles.sectionTitle}><span>Payment history · 12 mo</span></div>
          <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
            {Array.from({ length: 12 }).map((_, i) => {
              // Deterministic pattern based on suite id
              const seed = (parseInt(suite.id) + i) % 7;
              const late = seed === 0 && i > 2;
              const missing = seed === 3 && i > 8;
              const color = missing ? THEME.overdue : late ? THEME.due : THEME.paid;
              return (
                <div key={i} style={{
                  flex: 1, height: 22, borderRadius: 3,
                  background: `${color}28`,
                  border: `1px solid ${color}`,
                }}/>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={{ fontSize: 10, color: THEME.inkSubtle }}>May '25</span>
            <span style={{ fontSize: 10, color: THEME.inkSubtle }}>Apr '26</span>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Layers Tab ────────────────────────────────────────────
const LayersTab = () => (
  <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
    <div style={{ fontSize: 11, color: THEME.inkSubtle, marginBottom: 4 }}>Show on floorplan</div>
    {[
      { id: "suites", label: "Suites", on: true },
      { id: "labels", label: "Suite numbers", on: true },
      { id: "tenants", label: "Tenant names", on: true },
      { id: "rent", label: "Monthly rent", on: true },
      { id: "windows", label: "Window indicators", on: true },
      { id: "common", label: "Common areas", on: true },
      { id: "dimensions", label: "Room dimensions", on: false },
      { id: "hvac", label: "HVAC zones", on: false },
      { id: "network", label: "Network drops", on: false },
    ].map(l => (
      <label key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: `1px solid ${THEME.border}`, borderRadius: 8, cursor: "pointer" }}>
        <input type="checkbox" defaultChecked={l.on} style={{ accentColor: THEME.accent }}/>
        <span style={{ fontSize: 13, color: THEME.ink }}>{l.label}</span>
      </label>
    ))}
  </div>
);

// ─── Sub-components ────────────────────────────────────────────
const Section = ({ title, count, children }) => (
  <div>
    <div style={rpStyles.sectionTitle}>
      <span>{title}</span>
      {count != null && <span style={rpStyles.sectionCount}>{count}</span>}
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
  </div>
);

const MiniStat = ({ label, value, sub }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
    <span style={{ fontSize: 10, color: THEME.inkSubtle, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
    <span style={{ fontSize: 14, fontWeight: 600, color: THEME.ink, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    {sub && <span style={{ fontSize: 10, color: THEME.inkSubtle }}>{sub}</span>}
  </div>
);

const ActionGroup = ({ title, amount, color, items, onSelect, actionLabel }) => {
  const [expanded, setExpanded] = React.useState(true);
  return (
    <div style={{ border: `1px solid ${THEME.border}`, borderRadius: 8, overflow: "hidden" }}>
      <button onClick={() => setExpanded(e => !e)} style={rpStyles.actionGroupHeader}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: color }}/>
        <span style={{ flex: 1, textAlign: "left", fontSize: 12, fontWeight: 500, color: THEME.ink }}>{title}</span>
        {amount != null && <span style={{ fontSize: 12, fontWeight: 600, color, fontVariantNumeric: "tabular-nums" }}>{fmt$(amount)}</span>}
        <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} style={{ color: THEME.inkSubtle }}/>
      </button>
      {expanded && (
        <div>
          {items.slice(0, 4).map(s => (
            <button key={s.id} onClick={() => onSelect(s)} style={rpStyles.actionGroupItem}>
              <div style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: THEME.ink }}>
                  Suite {s.id} · <span style={{ color: THEME.inkMuted, fontWeight: 400 }}>{s.tenant !== "—" ? s.tenant : "vacant"}</span>
                </div>
                <div style={{ fontSize: 10, color: THEME.inkSubtle, fontVariantNumeric: "tabular-nums" }}>
                  {fmt$(s.rent)} / mo
                </div>
              </div>
              <span style={rpStyles.ghostChip}>{actionLabel}</span>
            </button>
          ))}
          {items.length > 4 && (
            <div style={{ padding: "6px 10px", fontSize: 11, color: THEME.inkSubtle, textAlign: "center", borderTop: `1px solid ${THEME.border}` }}>
              + {items.length - 4} more
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const FloorRow = ({ floor, active }) => {
  const pct = floor.total ? Math.round((floor.occupied / floor.total) * 100) : 0;
  return (
    <div style={{
      padding: "8px 10px",
      border: `1px solid ${active ? THEME.accent : THEME.border}`,
      background: active ? THEME.accentSoft : THEME.surface,
      borderRadius: 8,
      display: "flex", alignItems: "center", gap: 10,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: active ? THEME.accentInk : THEME.ink }}>{floor.name}</div>
        <div style={{ fontSize: 10, color: THEME.inkSubtle, fontVariantNumeric: "tabular-nums" }}>
          {floor.occupied}/{floor.total} suites · {fmt$(floor.revenue)}
        </div>
      </div>
      <div style={{ width: 48, textAlign: "right" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: active ? THEME.accentInk : THEME.ink, fontVariantNumeric: "tabular-nums" }}>{pct}%</div>
        <div style={{ width: "100%", height: 3, background: THEME.surfaceAlt, borderRadius: 2, marginTop: 2 }}>
          <div style={{ width: `${pct}%`, height: "100%", background: active ? THEME.accent : THEME.borderStrong, borderRadius: 2 }}/>
        </div>
      </div>
    </div>
  );
};

const RateCard = ({ label, value, sub, icon }) => (
  <div style={{
    flex: 1,
    padding: 10,
    border: `1px solid ${THEME.border}`,
    borderRadius: 8,
    background: THEME.surface,
  }}>
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, color: THEME.inkSubtle }}>
      <Icon name={icon} size={11}/>
      <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
    </div>
    <div style={{ fontSize: 18, fontWeight: 600, color: THEME.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    <div style={{ fontSize: 10, color: THEME.inkSubtle }}>{sub}</div>
  </div>
);

const StatusPill = ({ status }) => {
  const meta = STATUS_META[status];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "2px 7px",
      background: meta.bg,
      color: meta.ink,
      borderRadius: 10,
      fontSize: 10, fontWeight: 500,
      textTransform: "capitalize",
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 3, background: meta.dot }}/>
      {meta.label}
    </span>
  );
};

const ActionRow = ({ icon, label, sub, onClick, color }) => (
  <button onClick={onClick} style={{
    display: "flex", alignItems: "center", gap: 10,
    padding: "8px 10px",
    border: `1px solid ${THEME.border}`,
    borderRadius: 8,
    background: THEME.surface,
    cursor: "pointer",
    textAlign: "left",
  }}>
    <div style={{
      width: 28, height: 28, borderRadius: 6,
      background: color ? `${color}14` : THEME.surfaceAlt,
      color: color || THEME.inkMuted,
      display: "grid", placeItems: "center",
      flexShrink: 0,
    }}>
      <Icon name={icon} size={14}/>
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: THEME.ink }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: THEME.inkSubtle, marginTop: 1 }}>{sub}</div>}
    </div>
    <Icon name="chevronRight" size={12} style={{ color: THEME.inkSubtle }}/>
  </button>
);

const rpStyles = {
  root: {
    width: 360,
    display: "flex", flexDirection: "column",
    background: THEME.surface,
    borderLeft: `1px solid ${THEME.border}`,
    flexShrink: 0,
    position: "relative",
  },
  tabs: {
    display: "flex",
    padding: "8px 10px 0",
    gap: 2,
    borderBottom: `1px solid ${THEME.border}`,
  },
  tab: {
    flex: 1,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
    padding: "8px 10px",
    border: "none", background: "transparent",
    borderBottom: "2px solid transparent",
    fontSize: 12, fontWeight: 500,
    color: THEME.inkMuted,
    marginBottom: -1,
    cursor: "pointer",
  },
  tabActive: {
    color: THEME.accentInk,
    borderBottomColor: THEME.accent,
  },
  tabBadge: {
    fontSize: 10,
    padding: "1px 5px",
    background: THEME.accentSoft,
    color: THEME.accentInk,
    borderRadius: 4,
    fontWeight: 600,
  },
  scroll: { flex: 1, overflowY: "auto" },

  contextLabel: { fontSize: 10, color: THEME.inkSubtle, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  contextValue: { fontSize: 13, fontWeight: 500, color: THEME.ink },

  heroCard: {
    padding: 14,
    background: `linear-gradient(180deg, ${THEME.paidSoft}, ${THEME.surface})`,
    border: `1px solid ${THEME.border}`,
    borderRadius: 10,
    display: "flex", flexDirection: "column", gap: 8,
  },
  heroNum: {
    fontSize: 28, fontWeight: 700, color: THEME.paidInk,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: -0.5,
  },
  heroUnit: { fontSize: 11, color: THEME.inkSubtle },
  heroSub: { fontSize: 11, color: THEME.inkMuted },
  progressTrack: {
    width: "100%", height: 4, background: THEME.surfaceAlt,
    borderRadius: 2, overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 2 },
  heroGrid: {
    display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
    gap: 10,
    paddingTop: 10,
    borderTop: `1px solid ${THEME.border}`,
  },

  sectionTitle: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    fontSize: 11, fontWeight: 600, color: THEME.inkMuted,
    textTransform: "uppercase", letterSpacing: 0.5,
    marginBottom: 8,
  },
  sectionCount: {
    fontSize: 10, fontWeight: 600,
    padding: "1px 6px",
    background: THEME.surfaceAlt,
    color: THEME.inkMuted,
    borderRadius: 8,
  },

  actionGroupHeader: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "8px 10px",
    border: "none", background: THEME.surfaceAlt,
    width: "100%", cursor: "pointer",
    borderBottom: `1px solid ${THEME.border}`,
  },
  actionGroupItem: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "8px 10px",
    border: "none", background: THEME.surface,
    borderBottom: `1px solid ${THEME.border}`,
    width: "100%", cursor: "pointer",
  },
  ghostChip: {
    display: "inline-flex", alignItems: "center", gap: 4,
    fontSize: 10, fontWeight: 500,
    padding: "2px 7px",
    border: `1px solid ${THEME.border}`,
    borderRadius: 10,
    color: THEME.inkMuted,
    background: THEME.surface,
  },

  unitId: { fontSize: 18, fontWeight: 700, color: THEME.ink, letterSpacing: -0.2 },
  unitCard: {
    padding: 12,
    background: THEME.surfaceAlt,
    borderRadius: 8,
  },
  unitCardLabel: { fontSize: 11, color: THEME.inkMuted },
  unitCardNum: { fontSize: 22, fontWeight: 700, color: THEME.ink, fontVariantNumeric: "tabular-nums" },

  tenantCard: {
    display: "flex", alignItems: "center", gap: 10,
    padding: 10,
    border: `1px solid ${THEME.border}`,
    borderRadius: 8,
  },
  tenantAvatar: {
    width: 32, height: 32, borderRadius: 8,
    background: THEME.accentSoft,
    color: THEME.accentInk,
    display: "grid", placeItems: "center",
    fontSize: 11, fontWeight: 600,
    flexShrink: 0,
  },
  iconBtn: {
    width: 28, height: 28,
    display: "grid", placeItems: "center",
    border: `1px solid ${THEME.border}`,
    borderRadius: 6, background: THEME.surface,
    cursor: "pointer", color: THEME.inkMuted,
  },
  emptyTenant: {
    padding: 14,
    border: `1px dashed ${THEME.borderStrong}`,
    borderRadius: 8,
    textAlign: "center",
  },
  primaryBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "6px 12px",
    background: THEME.accent,
    color: "#fff",
    border: "none", borderRadius: 6,
    fontSize: 12, fontWeight: 500,
    cursor: "pointer",
  },

  toast: {
    position: "absolute",
    left: 16, right: 16, bottom: 16,
    padding: "10px 12px",
    background: THEME.ink,
    color: THEME.surface,
    borderRadius: 8,
    fontSize: 12,
    display: "flex", alignItems: "center", gap: 8,
    boxShadow: THEME.shadowLg,
    animation: "slideUp 0.25s ease-out",
  },
};

window.RightPanel = RightPanel;
