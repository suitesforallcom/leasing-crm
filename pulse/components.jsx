/* global React, Icon, DATA */

/* ================================================================
   Toast — for confirming button actions globally
   Usage: window.toast("Saved!") or window.toast("Error", "danger")
   ================================================================ */
window.toast = function (msg, tone = "info") {
  let host = document.getElementById("__toast_host");
  if (!host) {
    host = document.createElement("div");
    host.id = "__toast_host";
    Object.assign(host.style, {
      position: "fixed", bottom: "24px", left: "50%",
      transform: "translateX(-50%)", zIndex: "200",
      display: "flex", flexDirection: "column", gap: "8px",
      alignItems: "center", pointerEvents: "none",
    });
    document.body.appendChild(host);
  }
  const toneMap = {
    info:    { bg: "var(--ink)",      fg: "white" },
    success: { bg: "var(--success-ink)", fg: "white" },
    warning: { bg: "var(--warning-ink)", fg: "white" },
    danger:  { bg: "var(--danger-ink)",  fg: "white" },
  };
  const t = document.createElement("div");
  const c = toneMap[tone] || toneMap.info;
  t.style.cssText = `background:${c.bg};color:${c.fg};padding:10px 16px;border-radius:10px;font:600 13px/1.3 "Manrope",sans-serif;box-shadow:var(--shadow-lg);opacity:0;transform:translateY(10px);transition:.22s;pointer-events:auto;max-width:380px;text-align:center;`;
  t.textContent = msg;
  host.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = "1"; t.style.transform = "translateY(0)"; });
  setTimeout(() => {
    t.style.opacity = "0"; t.style.transform = "translateY(10px)";
    setTimeout(() => t.remove(), 250);
  }, 2400);
};

/* ================================================================
   Center chip — small badge showing which branch a user belongs to
   ================================================================ */
window.CenterChip = function CenterChip({ center, compact }) {
  if (!center) return null;
  return (
    <span className="chip" style={{ background: "transparent", color: center.color, borderColor: center.color + "55", fontWeight: 600, fontSize: compact ? 10.5 : 11.5 }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: center.color }} />
      {compact ? center.short : center.name}
    </span>
  );
};

/* ================================================================
   Shared UI primitives
   ================================================================ */

window.Avatar = function Avatar({ user, size = "md", showStatus = true }) {
  // Phase 17 rev — guard against undefined user. После удаления демо-сидов
  // (Maya/Daniel/...) код в нескольких местах всё ещё пытался искать их
  // по id ("u1", "u2") и передавал undefined → Avatar крашил всю страницу.
  // Render fallback chip вместо crash.
  if (!user) {
    return (
      <span className={"avatar " + size + " a-c1"} title="(deleted user)">?</span>
    );
  }
  return (
    <span className={"avatar " + size + " " + (user.avatar || "a-c1")}>
      {user.initials || "?"}
      {showStatus && user.status && <span className={"status " + user.status} />}
    </span>
  );
};

window.CatIcon = function CatIcon({ cat, size = "md", style }) {
  const c = DATA.CATEGORIES[cat] || DATA.CATEGORIES.system;
  const cls = "cat-icon" + (size === "sm" ? " sm" : size === "lg" ? " lg" : "");
  return (
    <span className={cls} style={{ background: c.color, ...style }}>
      <Icon name={c.icon} />
    </span>
  );
};

window.Trend = function Trend({ now, prev, suffix = "", inverse = false }) {
  if (prev === undefined || prev === null) return null;
  const diff = now - prev;
  const dir = diff > 0.5 ? "up" : diff < -0.5 ? "dn" : "fl";
  const good = inverse ? diff < 0 : diff > 0;
  const cls = dir === "fl" ? "fl" : good ? "up" : "dn";
  const arrow = dir === "up" ? "arrowUp" : dir === "dn" ? "arrowDn" : "minus";
  const pct = prev === 0 ? 0 : Math.round((diff / Math.max(1, prev)) * 100);
  return (
    <span className={"trend " + cls}>
      <Icon name={arrow} style={{ width: 11, height: 11 }} />
      {Math.abs(pct)}%{suffix}
    </span>
  );
};

window.KPI = function KPI({ icon, label, value, sub, trend, tone, onClick }) {
  const toneClass = tone === "warning" ? " is-warning" : tone === "danger" ? " is-danger" : "";
  return (
    <button className={"kpi" + toneClass} onClick={onClick} style={{ textAlign: "left", cursor: onClick ? "pointer" : "default" }}>
      <div className="kpi-head">
        <Icon name={icon} />
        {label}
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-foot">
        {trend}
        {sub && <span>{sub}</span>}
      </div>
    </button>
  );
};

/* Sparkline — points 0..100 normalized */
window.Sparkline = function Sparkline({ values, color = "var(--accent)", fill = true }) {
  if (!values || values.length === 0) return null;
  const w = 100, h = 32, pad = 2;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = (w - pad * 2) / (values.length - 1 || 1);
  const points = values.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y];
  });
  const linePath = points.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const fillPath = linePath + ` L${w - pad},${h - pad} L${pad},${h - pad} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {fill && (
        <linearGradient id={"sp-" + color.replace(/[^a-z0-9]/gi, "")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      )}
      {fill && <path d={fillPath} fill={`url(#sp-${color.replace(/[^a-z0-9]/gi, "")})`} />}
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

/* Bars for hourly distribution */
window.HourBars = function HourBars({ data, color = "var(--accent)", height = 80 }) {
  const max = Math.max(...data.map(d => d.v), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height }}>
      {data.map(d => (
        <div key={d.h} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <div
            title={`${d.h}:00 — ${d.v} actions`}
            style={{
              width: "100%",
              height: `${Math.max(2, (d.v / max) * (height - 18))}px`,
              background: color,
              borderRadius: "4px 4px 2px 2px",
              opacity: .85,
            }}
          />
          <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
            {d.h % 4 === 0 ? d.h : ""}
          </div>
        </div>
      ))}
    </div>
  );
};

/* Day activity bar (login history) */
window.DayBar = function DayBar({ segs, login, logout }) {
  /* segs use minutes from 6am, total 14h = 840min */
  const total = 14 * 60;
  return (
    <div>
      <div className="day-bar">
        {segs.map((s, i) => (
          <span
            key={i}
            className={"seg " + s.t}
            style={{
              left: `${(s.s / total) * 100}%`,
              width: `${(s.l / total) * 100}%`,
            }}
            title={`${s.t} · ${s.l}m`}
          />
        ))}
      </div>
      <div className="day-axis">
        <span>6 AM</span><span>9</span><span>12</span><span>3 PM</span><span>6 PM</span><span>8 PM</span>
      </div>
    </div>
  );
};

window.StatusDot = function StatusDot({ status }) {
  const map = { online: "var(--success)", idle: "var(--warning)", offline: "var(--muted-2)" };
  return <span className="dot" style={{ background: map[status] || "var(--muted-2)" }} />;
};

window.Empty = function Empty({ icon = "search", title, children }) {
  return (
    <div className="empty">
      <div className="icon-wrap"><Icon name={icon} /></div>
      <h4>{title}</h4>
      <p>{children}</p>
    </div>
  );
};

/* ================================================================
   Status pill — plain-English "Crushing it" / "On track" / etc.
   ================================================================ */
window.StatusPill = function StatusPill({ status, size = "md" }) {
  const tone = status.tone || "muted";
  const cls = "chip is-" + (tone === "success" ? "success" : tone === "warning" ? "warning" : tone === "danger" ? "danger" : "");
  const style = size === "lg" ? { padding: "5px 12px", fontSize: 13, fontWeight: 600 } : {};
  return (
    <span className={cls} style={style}>
      <Icon name={status.icon} />
      {status.label}
    </span>
  );
};

/* ================================================================
   Target meter — labeled progress with value/target + tone color
   Compact horizontal bar with text — used in person cards
   ================================================================ */
window.TargetMeter = function TargetMeter({ icon, label, meter, formatValue, formatTarget, hint, compact }) {
  const tone = meter.tone || "muted";
  const colors = {
    success: "var(--success)",
    warning: "var(--warning)",
    danger:  "var(--danger)",
    muted:   "var(--muted-2)",
  };
  const fg = {
    success: "var(--success-ink)",
    warning: "var(--warning-ink)",
    danger:  "var(--danger-ink)",
    muted:   "var(--muted)",
  };
  const pctClamped = Math.min(100, meter.pct);
  const fmtV = formatValue ? formatValue(meter.value) : meter.value;
  const fmtT = formatTarget ? formatTarget(meter.target) : meter.target;

  if (compact) {
    return (
      <div title={`${label}: ${fmtV} of ${fmtT} ${hint || ""}`}>
        <div className="row" style={{ fontSize: 11.5, marginBottom: 2 }}>
          {icon && <Icon name={icon} style={{ width: 11, height: 11, color: fg[tone] }} />}
          <span style={{ color: "var(--ink-2)", flex: 1, fontWeight: 500 }}>{label}</span>
          <span className="num" style={{ fontWeight: 700, color: fg[tone] }}>
            {fmtV}<span style={{ color: "var(--muted)", fontWeight: 500 }}>/{fmtT}</span>
            {meter.hit && <Icon name="check" style={{ width: 10, height: 10, marginLeft: 2, color: fg[tone] }} />}
          </span>
        </div>
        <div style={{ height: 4, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
          <span style={{ display: "block", height: "100%", width: pctClamped + "%", background: colors[tone], borderRadius: 999 }} />
        </div>
      </div>
    );
  }

  return (
    <div title={hint}>
      <div className="row" style={{ fontSize: 12, marginBottom: 4 }}>
        {icon && <Icon name={icon} style={{ width: 13, height: 13, color: fg[tone] }} />}
        <span style={{ flex: 1, fontWeight: 500 }}>{label}</span>
        <span className="num" style={{ fontWeight: 700, color: fg[tone] }}>
          {fmtV} <span style={{ color: "var(--muted-2)", fontWeight: 500 }}>/ {fmtT}</span>
          {meter.hit && <Icon name="check" style={{ width: 11, height: 11, marginLeft: 4, color: fg[tone] }} />}
        </span>
      </div>
      <div style={{ height: 6, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: pctClamped + "%", background: colors[tone], borderRadius: 999 }} />
      </div>
      {hint && <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>{hint}</div>}
    </div>
  );
};

/* ================================================================
   Bonus badge — small medal-like chip
   ================================================================ */
window.BonusBadge = function BonusBadge({ tier, amount, size = "md" }) {
  if (!tier || tier.id === "none") {
    return (
      <span className="chip" style={{ background: "var(--surface-2)", color: "var(--muted)", border: "none" }}>
        <Icon name="minus" /> No bonus yet
      </span>
    );
  }
  const sz = size === "lg" ? { padding: "6px 12px", fontSize: 13 } : {};
  return (
    <span className="chip" style={{
      background: tier.color, color: "white", border: "none", fontWeight: 600, ...sz,
    }}>
      <Icon name="star" />
      {tier.label}
      {amount != null && <span className="num" style={{ marginLeft: 4 }}>· ${amount.toLocaleString()}</span>}
    </span>
  );
};

/* ================================================================
   Tooltip-ish hint pill with question mark
   ================================================================ */
window.HelpHint = function HelpHint({ children }) {
  const [open, setOpen] = React.useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span style={{
        width: 14, height: 14, borderRadius: 999, background: "var(--surface-3)",
        color: "var(--muted)", display: "grid", placeItems: "center",
        fontSize: 9, fontWeight: 700, cursor: "help",
      }}>?</span>
      {open && (
        <span style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0,
          background: "var(--ink)", color: "white",
          padding: "8px 10px", borderRadius: 8, fontSize: 11.5, fontWeight: 400,
          width: 220, zIndex: 100, lineHeight: 1.4,
          boxShadow: "var(--shadow-md)",
        }}>{children}</span>
      )}
    </span>
  );
};

/* Format helpers */
window.fmt = {
  duration(sec) {
    if (!sec) return "0s";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return s + "s";
    return m + "m " + (s ? s + "s" : "");
  },
  hm(mins) {
    if (!mins) return "0m";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return m + "m";
    return h + "h " + (m ? m + "m" : "");
  },
  num(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  },
};

/* Parse "h:mm AM/PM" -> minutes since midnight (for sorting) */
window.parseTime = function parseTime(t) {
  if (!t) return -1;
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return -1;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return h * 60 + min;
};

/* Group events by time-of-day bucket */
window.groupByBucket = function (events) {
  const buckets = {
    Morning:   { label: "Morning",   sub: "8 AM – 11 AM",  list: [] },
    Midday:    { label: "Midday",    sub: "11 AM – 2 PM",  list: [] },
    Afternoon: { label: "Afternoon", sub: "2 PM – 5 PM",   list: [] },
    Evening:   { label: "Evening",   sub: "after 5 PM",    list: [] },
  };
  events.forEach(e => {
    const m = parseTime(e.time);
    const h = m / 60;
    if (h < 11) buckets.Morning.list.push(e);
    else if (h < 14) buckets.Midday.list.push(e);
    else if (h < 17) buckets.Afternoon.list.push(e);
    else buckets.Evening.list.push(e);
  });
  return Object.values(buckets).filter(b => b.list.length > 0);
};
