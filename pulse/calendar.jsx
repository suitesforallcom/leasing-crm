/* global React, Icon, DATA, fmt */

/* ================================================================
   Google Calendar integration (mocked)
   ================================================================ */

/* Mock events for "today" — would come from GCal API */
const TODAY_EVENTS = [
  { id: "g1", time: "9:00 AM",  end: "9:30 AM",  title: "Team standup",                attendees: 6,  kind: "meeting",  source: "gcal", color: "oklch(58% 0.16 264)" },
  { id: "g2", time: "10:15 AM", end: "11:00 AM", title: "Property tour · ABC Medical", attendees: 2,  kind: "tour",     source: "gcal", color: "oklch(60% 0.13 158)", location: "2104 Maple Ave Suite 300" },
  { id: "g3", time: "11:30 AM", end: "12:00 PM", title: "1:1 with Daniel",             attendees: 2,  kind: "1:1",      source: "gcal", color: "oklch(58% 0.18 300)" },
  { id: "g4", time: "1:30 PM",  end: "2:30 PM",  title: "Focus block · contracts",     attendees: 1,  kind: "focus",    source: "pulse", color: "oklch(73% 0.15 78)" },
  { id: "g5", time: "3:00 PM",  end: "3:30 PM",  title: "Call · Greentree Yoga",       attendees: 2,  kind: "call",     source: "gcal", color: "oklch(62% 0.14 30)" },
  { id: "g6", time: "5:00 PM",  end: "5:15 PM",  title: "EOD wrap-up",                 attendees: 1,  kind: "task",     source: "pulse", color: "oklch(55% 0.02 250)" },
];

/* This week (for upcoming widget) */
const WEEK_EVENTS = [
  { day: "Tue", time: "2:00 PM", title: "Bluestone renewal review",  attendees: 3 },
  { day: "Wed", time: "10:00 AM",title: "Property walkthrough · Cedar Park", attendees: 2 },
  { day: "Wed", time: "3:30 PM", title: "Vendor meeting · HVAC",     attendees: 4 },
  { day: "Thu", time: "9:30 AM", title: "Quarterly review with team", attendees: 8 },
  { day: "Fri", time: "11:00 AM",title: "Greentree contract review", attendees: 2 },
];

const KIND_ICON = {
  meeting: "people", tour: "building", "1:1": "user",
  focus: "bolt",    call: "phone",    task: "task",
};

/* ===== Today's meetings widget (compact, for My Day) ===== */
window.CalendarTodayWidget = function CalendarTodayWidget({ connected = true, onConnect, onBlockFocus, user }) {
  if (!connected) {
    return (
      <div className="card" style={{ padding: 16, background: "linear-gradient(135deg, oklch(97% 0.03 220), oklch(98% 0.02 200))", borderColor: "transparent" }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="cat-icon" style={{ background: "oklch(58% 0.16 220)" }}><Icon name="cal" /></span>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Connect Google Calendar</div>
        </div>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>
          Pulse will pull in your meetings, tours, and time blocks so today's schedule and focus tracking work seamlessly.
        </div>
        <button className="btn is-primary" onClick={onConnect} style={{ width: "100%" }}>
          <Icon name="link" /> Connect Google
        </button>
      </div>
    );
  }

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  /* upcoming = events where start time > nowMin */
  function eventMin(t) {
    const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) return 0;
    let h = parseInt(m[1], 10);
    if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
    if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
    return h * 60 + parseInt(m[2], 10);
  }
  // Phase 17 rev — для real user'а с реальными событиями строим список
  // из me.calendarEvents (Phase 14 cron из Google Calendar API).
  // Real без событий → empty. Demo seed → mock TODAY_EVENTS.
  const isRealUser = !!(user && user._isReal);
  const todayStr = (function () {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  })();
  let normalized;
  if (isRealUser && Array.isArray(user.calendarEvents) && user.calendarEvents.length > 0) {
    normalized = user.calendarEvents
      .filter(e => String(e.start || "").slice(0, 10) === todayStr)
      .map(e => {
        const s = new Date(e.start);
        const en = e.end ? new Date(e.end) : new Date(s.getTime() + 30 * 60000);
        const formatTime = d => {
          const h = d.getHours(), mm = String(d.getMinutes()).padStart(2, "0");
          return ((h % 12) || 12) + ":" + mm + " " + (h >= 12 ? "PM" : "AM");
        };
        const kind = _kindFromSummary(e.summary);
        return {
          id: e.htmlLink || e.summary,
          title: e.summary || "(untitled event)",
          time: formatTime(s),
          end: formatTime(en),
          attendees: Array.isArray(e.attendees) ? e.attendees.length : 1,
          kind,
          color: kind === "lead" ? "oklch(60% 0.13 158)" : kind === "call" ? "oklch(62% 0.14 30)" : "oklch(58% 0.16 264)",
          _startMin: s.getHours() * 60 + s.getMinutes(),
          _endMin: en.getHours() * 60 + en.getMinutes(),
        };
      });
  } else if (isRealUser) {
    normalized = []; // real user, no events today
  } else {
    normalized = TODAY_EVENTS.map(e => Object.assign({}, e, { _startMin: eventMin(e.time), _endMin: eventMin(e.end) }));
  }
  const upcoming = normalized.filter(e => e._startMin >= nowMin).slice(0, 3);
  const past     = normalized.filter(e => e._endMin < nowMin).length;
  const showList = upcoming.length > 0 ? upcoming : normalized.slice(0, 3);

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="row" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <span className="cat-icon" style={{ background: "oklch(58% 0.16 220)" }}><Icon name="cal" /></span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Today's calendar</div>
          <div className="muted" style={{ fontSize: 11 }}>{normalized.length} events · {past} done</div>
        </div>
        <div className="spacer" />
        <span className="chip is-success" style={{ fontSize: 10.5 }}><Icon name="check" /> Google</span>
      </div>
      <div style={{ padding: "6px 8px" }}>
        {showList.map(e => (
          <button
            key={e.id}
            onClick={() => window.toast(`Opening ${e.title}`)}
            className="row"
            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, textAlign: "left", fontSize: 12.5 }}
          >
            <span className="cat-icon sm" style={{ background: e.color, flexShrink: 0 }}>
              <Icon name={KIND_ICON[e.kind] || "cal"} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div>
              <div className="muted" style={{ fontSize: 11 }}>{e.time} – {e.end}{e.attendees > 1 ? " · " + e.attendees + " people" : ""}</div>
            </div>
          </button>
        ))}
      </div>
      <div className="row" style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", gap: 6 }}>
        <button className="btn is-small" onClick={onBlockFocus} style={{ flex: 1 }}><Icon name="bolt" /> Block focus</button>
        <button className="btn is-small is-ghost" onClick={() => window.open("https://calendar.google.com/calendar/u/0/r", "_blank")} style={{ flex: 1 }}><Icon name="link" /> Open Google</button>
      </div>
    </div>
  );
};

/* ===== Calendar events for the schedule strip =====
   Phase 17 rev — для real-users используем реальные события из
   me.calendarEvents (пишутся Phase 14 cron'ом из Google Calendar API).
   Если событий нет / user не _isReal → fallback на TODAY_EVENTS mock. */
function _kindFromSummary(summary) {
  const s = (summary || "").toLowerCase();
  if (/\btour\b|property tour|showing/.test(s)) return "lead";
  if (/\bcall\b/.test(s)) return "call";
  if (/\bfocus\b|deep work/.test(s)) return "task";
  if (/standup|1:?1|sync|meet|catch[- ]up/.test(s)) return "task";
  return "task";
}

function _eventsFromReal(realEvents) {
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const todayStr = (function () {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  })();
  return realEvents
    .filter(e => {
      // Только сегодняшние события
      if (!e.start) return false;
      const startIso = String(e.start);
      return startIso.slice(0, 10) === todayStr;
    })
    .map(e => {
      const startDate = new Date(e.start);
      const endDate   = e.end ? new Date(e.end) : new Date(startDate.getTime() + 30 * 60000);
      const startMin  = startDate.getHours() * 60 + startDate.getMinutes();
      const endMin    = endDate.getHours() * 60 + endDate.getMinutes();
      return {
        start:   startMin / 60,
        end:     endMin / 60,
        label:   e.summary || "(untitled event)",
        kind:    _kindFromSummary(e.summary),
        done:    endMin <= nowMin,
        current: nowMin >= startMin && nowMin < endMin,
      };
    });
}

window.getCalendarEvents = function (me) {
  // Real user with real events from Google Calendar API
  if (me && me._isReal && Array.isArray(me.calendarEvents) && me.calendarEvents.length > 0) {
    return _eventsFromReal(me.calendarEvents);
  }
  // Real user but no events today → empty schedule (no mock)
  if (me && me._isReal) return [];
  // Demo seed user → keep mock
  return TODAY_EVENTS.map(e => {
    const startMin = eventMinFromStr(e.time);
    const endMin   = eventMinFromStr(e.end);
    return {
      start: startMin / 60,
      end:   endMin / 60,
      label: e.title,
      kind:  e.kind === "meeting" ? "task" : e.kind === "tour" ? "lead" : e.kind === "1:1" ? "task" : e.kind === "focus" ? "task" : e.kind,
      done:  endMin <= new Date().getHours() * 60 + new Date().getMinutes(),
      current: (new Date().getHours() * 60 + new Date().getMinutes()) >= startMin && (new Date().getHours() * 60 + new Date().getMinutes()) < endMin,
    };
  });
};

function eventMinFromStr(t) {
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return h * 60 + parseInt(m[2], 10);
}

/* ===== Upcoming this week widget ===== */
window.CalendarWeekWidget = function CalendarWeekWidget() {
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <Icon name="cal" style={{ color: "var(--muted)" }} />
        <div style={{ fontWeight: 700, fontSize: 14 }}>This week</div>
        <span className="chip is-success" style={{ fontSize: 10.5 }}>Google synced</span>
        <div className="spacer" />
        <button className="btn is-small is-ghost" onClick={() => window.toast("New event coming")}><Icon name="plus" /></button>
      </div>
      <div className="col" style={{ gap: 6 }}>
        {WEEK_EVENTS.map((e, i) => (
          <button key={i} onClick={() => window.toast(`Opening "${e.title}"`)} className="row" style={{ padding: "8px 10px", borderRadius: 8, background: "var(--surface-2)", textAlign: "left", width: "100%", fontSize: 12.5 }}>
            <span className="mono" style={{ width: 32, fontWeight: 700, fontSize: 11, color: "var(--muted)" }}>{e.day}</span>
            <span className="mono muted" style={{ width: 60, fontSize: 11 }}>{e.time}</span>
            <span style={{ flex: 1, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.title}</span>
            <span className="muted" style={{ fontSize: 11 }}>{e.attendees}p</span>
          </button>
        ))}
      </div>
    </div>
  );
};
