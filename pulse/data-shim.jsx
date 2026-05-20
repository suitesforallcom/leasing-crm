/* global window */

/* ================================================================
   Pulse — Real-data shim (FIXES_LOG Entry 23, Phase 5+6)
   ------------------------------------------------------------------
   Replaces data.jsx's mock USERS/CENTERS/EVENTS with values read from
   the floor-map app's `sfa_v5_state` localStorage doc. Same origin →
   same browser → same authenticated session.

   What this shim does:
     1. USERS  — state.employees mapped to prototype's user shape.
                 Real contracts (this month) computed from
                 u.leaseEnvelopes sent by each employee email.
     2. CENTERS — state.buildings mapped to prototype's center shape.
     3. EVENTS — outreach trail + lease-envelope events for the
                 last 24h, mapped to prototype's event shape so the
                 Activity / Live Feed sections show real activity.
     4. Live-sync — `storage` event listener reloads the page when
                 floor-map mutates state in another tab (Web Locks
                 leader writes saveState).
     5. Sidebar back-link — small "← Floor map" anchor injected after
                 React mounts so the operator can flip back.

   If localStorage has no state (fresh browser / signed out / cross-
   origin), the shim no-ops and prototype keeps its mock data.
   ================================================================ */

(function () {
  'use strict';

  // ---------- Utilities ----------
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return Math.abs(h);
  }
  function namePart(fn, idx) {
    const parts = String(fn || '').trim().split(/\s+/).filter(Boolean);
    return parts[idx] || (idx === 0 ? '?' : '');
  }
  function classifyRole(raw) {
    const r = String(raw || '').toLowerCase();
    if (r.includes('owner') || r.includes('admin') || r.includes('principal')) return 'admin';
    if (r.includes('account') || r.includes('book') || r.includes('finance')) return 'accountant';
    if (r.includes('manager') || r.includes('director') || r.includes('lead')) return 'manager';
    return 'agent';
  }
  function timeStr(minSinceMidnight) {
    const h24 = Math.floor(minSinceMidnight / 60);
    const m = minSinceMidnight % 60;
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 || 12;
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
  }
  function fmtTimeFromIso(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }

  // ---------- Read state ----------
  let st;
  try {
    const raw = localStorage.getItem('sfa_v5_state');
    if (!raw) { console.info('[pulse-shim] no state in localStorage — keeping mock DATA'); return; }
    st = JSON.parse(raw);
  } catch (e) {
    console.warn('[pulse-shim] state parse failed, keeping mock DATA:', e);
    return;
  }
  if (!window.DATA) {
    console.warn('[pulse-shim] window.DATA not initialized yet — abort');
    return;
  }

  // Phase 11a — keep DEMO seed users/centers from data.jsx, APPEND real ones
  // (instead of replacing). Operator wants both: demo for UI richness +
  // real workspace people with real Phase 10 numbers. Real IDs prefixed
  // ('r' for users, 'rc' for centers) to avoid collision with seed u1..u12.
  const _seedUsers   = (Array.isArray(window.DATA.USERS)   ? window.DATA.USERS   : []).slice();
  const _seedCenters = (Array.isArray(window.DATA.CENTERS) ? window.DATA.CENTERS : []).slice();

  // ---------- Map state.buildings → DATA.CENTERS ----------
  const buildings = Array.isArray(st.buildings) ? st.buildings : [];
  const palette = [
    'oklch(62% 0.14 264)', 'oklch(60% 0.13 158)', 'oklch(73% 0.15 78)',
    'oklch(62% 0.14 300)', 'oklch(62% 0.14 340)', 'oklch(62% 0.14 30)',
    'oklch(62% 0.14 200)', 'oklch(62% 0.14 130)',
  ];
  if (buildings.length) {
    const realCenters = buildings.map(function (b, i) {
      // Count floors+units for "properties" stat
      let propCount = 0;
      try {
        (b.floors || []).forEach(function (f) {
          propCount += (f.units || []).filter(function (u) { return u && u.type === 'office'; }).length;
        });
      } catch {}
      return {
        id: 'rc' + (i + 1), // Phase 11a — 'rc' prefix to not collide with seed c1..c4
        name: b.name || b.id || ('Building ' + (i + 1)),
        short: ((b.name || b.id || '').slice(0, 3).toUpperCase()) || ('B' + (i + 1)),
        address: b.address || '',
        properties: propCount,
        color: palette[i % palette.length],
        headcount: 0,
        _bId: b.id,
        _isReal: true,
      };
    });
    window.DATA.CENTERS = _seedCenters.concat(realCenters);
    // Also rebuild CENTER_BY_ID for prototype consumers
    window.DATA.CENTER_BY_ID = Object.fromEntries(window.DATA.CENTERS.map(function (c) { return [c.id, c]; }));
  }

  // ---------- Build emp index for sentBy lookup ----------
  const emps = Array.isArray(st.employees) ? st.employees : [];
  const active = emps.filter(function (e) { return e && e.status !== 'terminated'; });
  const empByEmail = new Map();
  active.forEach(function (e) {
    if (e.email) empByEmail.set(e.email.toLowerCase(), e);
  });

  // ---------- Single pass over state → bin every email-attributed action ----------
  // Phase 7 (FIXES_LOG Entry 26) — aggregate real activity by employee email.
  // Every record carrying a `sentBy` / `callerEmail` / `recordedBy` stamp gets
  // counted into the matching employee's bucket. Score, contracts, emails,
  // calls, actions all derive from this single walk so we never iterate the
  // state more than once.
  const monthStartMs = startOfMonth(new Date());
  const last24Ms = Date.now() - 24 * 60 * 60 * 1000;
  // Phase 12 — Mon-Sun weekly bucket boundaries. Used for "this week vs
  // last week" panel in MyDay. Week starts Monday 00:00 local time.
  function startOfWeekMs(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    const day = x.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const diff = day === 0 ? -6 : 1 - day; // back to Monday
    x.setDate(x.getDate() + diff);
    return x.getTime();
  }
  const thisWeekStartMs = startOfWeekMs(new Date());
  const lastWeekStartMs = thisWeekStartMs - 7 * 24 * 60 * 60 * 1000;
  const lastWeekEndMs = thisWeekStartMs - 1;
  function blankStats() {
    return {
      contractsMtd: 0,        // leaseEnvelopes sent this month
      contractsCompleted: 0,  // status=completed within month
      contractsThisWeek: 0,   // Phase 12 — Mon-Sun current week
      contractsLastWeek: 0,   // Phase 12 — Mon-Sun previous week
      envelopesAllTime: 0,    // lifetime envelope count
      emailsMtd: 0,           // outreach type contains 'email'/'lease' this month
      emailsSentThisWeek: 0,  // Phase 12 — Mon-Sun current week (sent only)
      emailsSentLastWeek: 0,  // Phase 12 — Mon-Sun previous week
      callsMtd: 0,            // outreach type === 'call' / 'phone'
      notesMtd: 0,            // outreach type 'note'
      paymentsMtd: 0,         // u.payments[ym].sentBy this month
      invoicesMtd: 0,         // u.stripe.*.sentBy stamps this month
      actionsMtd: 0,          // sum of all the above
      lastActivityMs: 0,
    };
  }
  const statsByEmail = new Map();
  function bucket(email) {
    const e = (email || '').toLowerCase();
    if (!e) return null;
    if (!statsByEmail.has(e)) statsByEmail.set(e, blankStats());
    return statsByEmail.get(e);
  }

  const recentEnvelopeEvents = [];
  const recentOutreachEvents = [];

  // Hoisted out of try{} so user.map() ниже может прочитать (Phase 10).
  const emailStatsByOwner = new Map();

  // Phase 12 (hotfix) — read sessions from SEPARATE localStorage key
  // `sfa_v5_sessions`. Stored separately to avoid triggering Pulse's
  // storage-event reload (which fires only on `sfa_v5_state` changes).
  const sessionsByUid = (function () {
    try {
      const raw = localStorage.getItem('sfa_v5_sessions');
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
  })();

  // Phase 15 — daily history { email → [snapshots] } written by
  // runDailySnapshot CF. Drives real streak + records.
  const dailyHistoryByEmail = (st && typeof st.dailyHistory === 'object' && st.dailyHistory) ? st.dailyHistory : {};

  // Phase 14 — calendar events { email → [today's events] } written by
  // refreshCalendarEvents CF (polled every 5min). Drives MyDay Schedule.
  const calendarEventsByEmail = (st && typeof st.calendarEvents === 'object' && st.calendarEvents) ? st.calendarEvents : {};
  function _streakFromHistory(email) {
    const arr = dailyHistoryByEmail[email];
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    // Sort desc by date
    const sorted = arr.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    let streak = 0;
    let expected = new Date();
    expected.setHours(0, 0, 0, 0);
    // If most recent is today AND targetHit → start counting. Otherwise
    // check yesterday backward.
    const todayStr = expected.toISOString().slice(0, 10);
    if (sorted[0].date !== todayStr) {
      // Move expected to yesterday — streak counts from completed days
      expected = new Date(expected.getTime() - 24 * 3600 * 1000);
    }
    for (const snap of sorted) {
      const expectedStr = expected.toISOString().slice(0, 10);
      if (snap.date !== expectedStr) break;
      if (!snap.targetHit) break;
      streak++;
      expected = new Date(expected.getTime() - 24 * 3600 * 1000);
    }
    return streak;
  }
  function _recordsFromHistory(email) {
    const arr = dailyHistoryByEmail[email];
    if (!Array.isArray(arr) || arr.length === 0) {
      return { mostEmails: 0, mostContracts: 0, highestScore: 0, mostEmailsWhen: '', mostContractsWhen: '', highestScoreWhen: '' };
    }
    let mostEmails = 0, mostEmailsWhen = '';
    let mostContracts = 0, mostContractsWhen = '';
    let highestScore = 0, highestScoreWhen = '';
    for (const s of arr) {
      if ((s.sentEmails || 0) > mostEmails) { mostEmails = s.sentEmails; mostEmailsWhen = s.date; }
      if ((s.contracts || 0) > mostContracts) { mostContracts = s.contracts; mostContractsWhen = s.date; }
      if ((s.score || 0) > highestScore) { highestScore = s.score; highestScoreWhen = s.date; }
    }
    return { mostEmails, mostContracts, highestScore, mostEmailsWhen, mostContractsWhen, highestScoreWhen };
  }

  // Phase 11d — tenant email → unit lookup. Used by EmailsTab to tag
  // each row as «Tenant · Suite N» (with unit link) vs «New contact».
  // Source: u.email + u.tenant/company on occupied units.
  const tenantEmailIndex = new Map(); // email-lower → { unitId, suite, tenantName, buildingName }
  try {
    for (const b of buildings) {
      for (const f of (b.floors || [])) {
        for (const u of (f.units || [])) {
          const emailRaw = u.email || '';
          const email = String(emailRaw).trim().toLowerCase();
          if (!email) continue;
          if (tenantEmailIndex.has(email)) continue; // first wins
          tenantEmailIndex.set(email, {
            unitId: u.id,
            suite: u.id, // unit id is the suite number (Suite 305 etc.)
            tenantName: (u.tenant || u.company || '').trim() || '?',
            buildingName: b.name || b.id || '',
          });
        }
      }
    }
  } catch (e) { console.warn('[pulse-shim] tenant index build failed:', e); }

  try {
    for (const b of buildings) {
      for (const f of (b.floors || [])) {
        for (const u of (f.units || [])) {
          // --- Lease envelopes ---
          for (const env of (u.leaseEnvelopes || [])) {
            const stat = bucket(env.sentBy);
            const sentMs = new Date(env.sentAt || env.createdAt || 0).getTime();
            if (stat) {
              stat.envelopesAllTime++;
              if (sentMs >= monthStartMs) {
                stat.contractsMtd++;
                stat.actionsMtd++;
                if (env.status === 'completed') stat.contractsCompleted++;
              }
              // Phase 12 — weekly bucket
              if (sentMs >= thisWeekStartMs) stat.contractsThisWeek++;
              else if (sentMs >= lastWeekStartMs && sentMs <= lastWeekEndMs) stat.contractsLastWeek++;
              if (sentMs > stat.lastActivityMs) stat.lastActivityMs = sentMs;
            }
            if (sentMs >= last24Ms) {
              recentEnvelopeEvents.push({
                ts: sentMs, sentBy: (env.sentBy || '').toLowerCase(),
                cat: 'contract', type: 'sent',
                desc: 'Sent lease contract',
                ent: { kind: 'contract', name: 'Lease — Suite ' + (u.id || '?'), id: env.envelopeId || env.id || '' },
                status: env.status === 'completed' ? 'ok' : (env.status === 'voided' ? 'cancelled' : 'pending'),
                source: 'docusign',
              });
            }
          }

          // --- Outreach trail ---
          for (const o of (u.outreach || [])) {
            const ts = new Date(o.ts || 0).getTime();
            const email = (o.sentBy || o.callerEmail || '').toLowerCase();
            const type = String(o.type || '').toLowerCase();
            const stat = bucket(email);
            if (stat && ts >= monthStartMs) {
              if (type === 'email' || type === 'lease') stat.emailsMtd++;
              else if (type === 'call' || type === 'phone') stat.callsMtd++;
              else if (type === 'note') stat.notesMtd++;
              stat.actionsMtd++;
              if (ts > stat.lastActivityMs) stat.lastActivityMs = ts;
            }
            if (ts >= last24Ms) {
              let cat = 'system';
              if (type === 'lease' || type.includes('contract')) cat = 'contract';
              else if (type === 'email') cat = 'email';
              else if (type === 'call' || type === 'phone') cat = 'call';
              else if (type === 'note') cat = 'task';
              else if (type === 'payment') cat = 'invoice';
              recentOutreachEvents.push({
                ts: ts, sentBy: email,
                cat: cat, type: type || 'note',
                desc: (o.text || o.summary || '(no description)').slice(0, 140),
                ent: { kind: 'unit', name: 'Suite ' + (u.id || '?'), id: u.id },
                status: 'ok', source: 'web',
              });
            }
          }

          // --- Stripe invoice stamps (per FIXES_LOG Entry 10) ---
          const stripeStamps = [
            u.stripe?.moveInRent,
            u.stripe?.depositInvoice,
            u.stripe?.lastInvoice,
          ];
          for (const s of stripeStamps) {
            if (!s || !s.sentBy) continue;
            const stat = bucket(s.sentBy);
            const sentMs = new Date(s.sentAt || s.createdAt || 0).getTime();
            if (!stat) continue;
            if (sentMs >= monthStartMs) {
              stat.invoicesMtd++;
              stat.actionsMtd++;
            }
            if (sentMs > stat.lastActivityMs) stat.lastActivityMs = sentMs;
          }

          // --- Per-month payment stamps ---
          if (u.payments && typeof u.payments === 'object') {
            for (const ym of Object.keys(u.payments)) {
              const p = u.payments[ym];
              if (!p || !p.sentBy) continue;
              const stat = bucket(p.sentBy);
              const ts = new Date(p.recordedAt || p.sentAt || p.date || 0).getTime();
              if (!stat) continue;
              if (ts >= monthStartMs) {
                stat.paymentsMtd++;
                stat.actionsMtd++;
              }
              if (ts > stat.lastActivityMs) stat.lastActivityMs = ts;
            }
          }
        }
      }
    }

    // --- Gmail-ingest aggregation (Phase 10) ---
    // Собираем ВСЕ email-events (и attached → u.outreach, и unattached →
    // state.gmailActivity) в единый список — чтобы потом построить thread
    // index и резолвить In-Reply-To через obe source'а.
    const allEmailEntries = [];
    for (const b of buildings) {
      for (const f of (b.floors || [])) {
        for (const u of (f.units || [])) {
          for (const o of (u.outreach || [])) {
            if (o.source !== 'gmail-api' || !o.messageId) continue;
            allEmailEntries.push({
              ts: new Date(o.ts || 0).getTime(),
              messageId: o.messageId,
              messageIdHeader: (o.messageIdHeader || '').toLowerCase(),
              direction: o.direction || (o.type === 'received' ? 'received' : 'sent'),
              owner: (o.ownerEmail || o.sentBy || '').toLowerCase(),
              from: (o.sentBy || '').toLowerCase(),
              to: o.recipientEmail || null,
              subject: o.subject || '',
              inReplyTo: (o.inReplyTo || '').toLowerCase(),
              threadId: o.threadId || null,
              unitId: u.id || null,
            });
          }
        }
      }
    }
    const gmailActivity = (st && Array.isArray(st.gmailActivity)) ? st.gmailActivity : [];
    for (const g of gmailActivity) {
      if (!g || !g.messageId) continue;
      allEmailEntries.push({
        ts: new Date(g.ts || 0).getTime(),
        messageId: g.messageId,
        messageIdHeader: (g.messageIdHeader || '').toLowerCase(),
        direction: g.direction || 'sent',
        owner: (g.owner || g.from || '').toLowerCase(),
        from: (g.from || '').toLowerCase(),
        to: g.to || null,
        subject: g.subject || '',
        inReplyTo: (g.inReplyTo || '').toLowerCase(),
        threadId: g.threadId || null,
        unitId: null,
      });
    }

    // Build thread index by messageIdHeader для резолва In-Reply-To.
    const threadIndex = new Map();
    for (const e of allEmailEntries) {
      if (e.messageIdHeader) threadIndex.set(e.messageIdHeader, e);
    }

    // Per-owner thread stats. owner = email менеджера чьим watch'ем
    // событие попало; в outreach получаем через ownerEmail/sentBy fallback.
    // (emailStatsByOwner declared at outer scope above для user.map().)
    function emailStatBucket(email) {
      const e = (email || '').toLowerCase();
      if (!e) return null;
      if (!emailStatsByOwner.has(e)) emailStatsByOwner.set(e, {
        sentMtd: 0,
        receivedMtd: 0,
        repliesMtd: 0,
        replyTimesMs: [],
      });
      return emailStatsByOwner.get(e);
    }

    for (const e of allEmailEntries) {
      const stat = emailStatBucket(e.owner);
      if (!stat) continue;
      const inMtd = e.ts >= monthStartMs;

      if (e.direction === 'sent') {
        if (inMtd) stat.sentMtd++;

        // Reply: есть In-Reply-To и парент это полученное письмо.
        if (e.inReplyTo) {
          const parent = threadIndex.get(e.inReplyTo);
          if (parent && parent.direction === 'received' && parent.ts > 0 && parent.ts < e.ts) {
            if (inMtd) stat.repliesMtd++;
            const deltaMs = e.ts - parent.ts;
            // Sanity cap: ответы дольше 30 дней не учитываем (это уже
            // не reply а новая переписка).
            if (deltaMs > 0 && deltaMs < 30 * 24 * 60 * 60 * 1000 && inMtd) {
              stat.replyTimesMs.push(deltaMs);
            }
          }
        }

        // Также делаем legacy `bucket()` инкремент чтобы emailsMtd считался
        // (он же используется и для не-Gmail outreach типа manual emails).
        const ownerStat = bucket(e.owner);
        if (ownerStat) {
          if (inMtd) {
            ownerStat.emailsMtd++;
            ownerStat.actionsMtd++;
          }
          // Phase 12 — weekly bucket
          if (e.ts >= thisWeekStartMs) ownerStat.emailsSentThisWeek++;
          else if (e.ts >= lastWeekStartMs && e.ts <= lastWeekEndMs) ownerStat.emailsSentLastWeek++;
          if (e.ts > ownerStat.lastActivityMs) ownerStat.lastActivityMs = e.ts;
        }
      } else if (e.direction === 'received') {
        if (inMtd) stat.receivedMtd++;
        // RECEIVED не идёт в emailsMtd/actionsMtd — это входящее, не действие.
      }

      // Recent events (last 24h) для timeline / live feed.
      if (e.ts >= last24Ms) {
        // Phase 11d — для received матчим SENDER против tenant'ов, для sent
        // матчим RECIPIENT. Если совпало — это контакт с существующим
        // tenant'ом (показываем Suite N + tenantName). Если нет — новый
        // контакт (внешний адрес, спам, новый lead).
        const counterparty = (e.direction === 'received' ? e.from : e.to) || '';
        const tenantMatch = tenantEmailIndex.get(String(counterparty).toLowerCase()) || null;

        recentOutreachEvents.push({
          ts: e.ts,
          sentBy: e.owner,
          cat: 'email',
          type: e.direction === 'received'
            ? 'received'
            : (e.inReplyTo && threadIndex.get(e.inReplyTo)?.direction === 'received' ? 'reply' : 'sent'),
          desc: (e.direction === 'received' ? 'Email from ' + (e.from || '?') + ': ' : 'Email to ' + (e.to || '?') + ': ')
                + (e.subject || '(no subject)').slice(0, 110),
          ent: { kind: 'contact', name: (e.direction === 'received' ? e.from : e.to) || '(external)', id: e.messageId },
          status: 'ok',
          source: 'gmail',
          _tenantMatch: tenantMatch, // { unitId, suite, tenantName, buildingName } | null
        });
      }
    }

    // ----------------------------------------------------------------
    // Phase 17 (rev) — bucket SENT events by hour-of-day for TODAY.
    // Сохраняем не только counts, но и сами события (to/subject/ts) —
    // чтобы при hover'е на bar показать кому/что/во сколько отправил.
    // Лимит 8 items per hour bucket — больше нет смысла отображать в UI.
    // Stash on window.__pulseHourlyByEmail так как allEmailEntries —
    // const внутри try; helper _hourlyTodayFor ниже читает из window.
    // ----------------------------------------------------------------
    const _startOfTodayMs = (function () {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    const PER_BUCKET_LIMIT = 8;
    const hourlyTodayByEmail = new Map();
    for (const e of allEmailEntries) {
      if (!e.owner || !e.ts) continue;
      if (e.ts < _startOfTodayMs) continue;
      if (e.direction !== 'sent') continue;
      const h = new Date(e.ts).getHours();
      if (h < 7 || h > 19) continue;
      if (!hourlyTodayByEmail.has(e.owner)) hourlyTodayByEmail.set(e.owner, new Map());
      const bucket = hourlyTodayByEmail.get(e.owner);
      if (!bucket.has(h)) bucket.set(h, { count: 0, items: [] });
      const slot = bucket.get(h);
      slot.count++;
      if (slot.items.length < PER_BUCKET_LIMIT) {
        slot.items.push({
          ts: e.ts,
          to: e.to || '(no recipient)',
          subject: e.subject || '(no subject)',
        });
      }
    }
    window.__pulseHourlyByEmail = hourlyTodayByEmail;
  } catch (e) { console.warn('[pulse-shim] state walk failed:', e); }

  // ----------------------------------------------------------------
  // Phase 17 — per-email hourly buckets for «Activity by hour today».
  // KEY INVARIANT: allEmailEntries — const внутри try выше; до выноса
  // в outer scope мы НЕ можем читать его здесь напрямую (ReferenceError
  // ломал весь шим, и реальные сотрудники пропадали из DATA.USERS).
  // Поэтому используем уже наполненный hourlyTodayByEmail, который
  // строим внутри try (см. ниже). Тут только _hourlyTodayFor helper.
  // ----------------------------------------------------------------
  function _hourlyTodayFor(email) {
    const m = (window.__pulseHourlyByEmail instanceof Map) ? window.__pulseHourlyByEmail.get((email || '').toLowerCase()) : null;
    const out = [];
    for (let h = 7; h <= 19; h++) {
      const slot = m ? m.get(h) : null;
      out.push({
        h,
        v: slot ? slot.count : 0,
        items: slot ? slot.items : [],   // [{ts, to, subject}], up to PER_BUCKET_LIMIT
      });
    }
    return out;
  }

  // ---------- Map state.employees → DATA.USERS ----------
  const DEVICES = ['MacBook Pro · Chrome', 'Dell XPS · Edge', 'Lenovo ThinkPad · Firefox', 'iMac · Safari', 'Surface Laptop · Chrome'];
  const LOCS    = ['Office', 'Office', 'Office', 'Remote', 'On-site'];
  const usersByEmail = new Map();   // emp.email.lower → DATA.USERS[i]

  // Phase 11a — prefer real center for real employees so leaderboard
  // grouping makes sense (real building, not demo c1). Fall back to first
  // available center if no real one exists.
  const _realCenterId = (function () {
    const real = (window.DATA.CENTERS || []).find(function (c) { return c && c._isReal; });
    if (real) return real.id;
    if (window.DATA.CENTERS && window.DATA.CENTERS[0]) return window.DATA.CENTERS[0].id;
    return 'c1';
  })();

  if (active.length) {
    const realUsers = active.map(function (emp, i) {
      const seed = hashStr(emp.id || emp.fullName || 'x' + i);
      const first = namePart(emp.fullName, 0);
      const last  = namePart(emp.fullName, 1);
      const role = classifyRole(emp.role);
      const centerId = _realCenterId;
      const onlineMin = 240 + (seed % 280);
      const loginMin  = 480 + (seed % 90);
      const statusPick = seed % 10;
      const status = statusPick < 7 ? 'online' : statusPick < 9 ? 'idle' : 'offline';
      const score = 60 + (seed % 40);
      const prev  = 55 + ((seed >> 2) % 38);

      // ↓ Real fields aggregated from state walk above (Phase 7).
      // Every value below is keyed off emp.email — same email that the
      // CFs (dsSendEnvelope, createStripeInvoice, recordOutreach) stamp
      // when this employee acts on a unit. Sign-in attribution is the
      // contract: corporate-domain auto-onboard (Entry 25) gives every
      // new employee a member doc with email → their actions stamp →
      // these counters reflect their work without manual wiring.
      const emailLower = (emp.email || '').toLowerCase();
      const realStats = statsByEmail.get(emailLower) || blankStats();
      const realContracts = realStats.contractsMtd;
      const realEmails    = realStats.emailsMtd;
      const realCalls     = realStats.callsMtd;
      const realInvoices  = realStats.invoicesMtd;
      const realPayments  = realStats.paymentsMtd;
      const realActions   = realStats.actionsMtd;
      const hasAnyActivity = realActions > 0;

      // Phase 10 — Gmail thread stats per employee.
      // emailStatsByOwner buckets by owner email = ящик чьего watch'а событие.
      const realEmailStat = emailStatsByOwner.get(emailLower) || {
        sentMtd: 0, receivedMtd: 0, repliesMtd: 0, replyTimesMs: [],
      };
      const realAvgReplyMs = realEmailStat.replyTimesMs.length
        ? realEmailStat.replyTimesMs.reduce((a, b) => a + b, 0) / realEmailStat.replyTimesMs.length
        : 0;
      const realAvgReplyMin = realAvgReplyMs ? Math.round(realAvgReplyMs / 60000) : 0;

      // Score = simple weighted hit-rate (0..100). Each metric capped so a
      // single huge category can't drag the score artificially. Weights:
      // contracts 30, emails 25, calls 20, invoices 15, notes 10.
      // Targets are role-tuned so an agent doing 4 contracts/month maxes
      // the contracts axis; a manager handling 6 maxes it.
      const tgt = role === 'agent'
        ? { contracts: 4, emails: 60, calls: 30, invoices: 8 }
        : role === 'manager'
          ? { contracts: 6, emails: 40, calls: 20, invoices: 15 }
          : role === 'accountant'
            ? { contracts: 0, emails: 30, calls: 5, invoices: 20 }
            : { contracts: 1, emails: 20, calls: 10, invoices: 5 };
      function pctOf(x, t) { return t > 0 ? Math.min(1, x / t) : 0; }
      const realScore = hasAnyActivity ? Math.round(
        pctOf(realContracts, tgt.contracts) * 30 +
        pctOf(realEmails,    tgt.emails)    * 25 +
        pctOf(realCalls,     tgt.calls)     * 20 +
        pctOf(realInvoices,  tgt.invoices)  * 15 +
        Math.min(1, realStats.notesMtd / 10) * 10
      ) : 0;
      // Phase 12 — operator wants ALL stats to be real (or 0), no mock
      // fallback. score = realScore directly (= 0 if no activity).
      const scoreFinal = realScore;

      const u = {
        id: 'r' + (i + 1), // Phase 11a — 'r' prefix to not collide with seed u1..u12
        first: first,
        last: last,
        name: emp.fullName || (first + ' ' + last).trim() || ('Employee ' + (i + 1)),
        _isReal: true,
        initials: ((first[0] || '?') + (last[0] || '')).toUpperCase(),
        role: role,
        centerId: centerId,
        email: emp.email || '',
        phone: emp.phone || '',
        status: status,
        // Phase 13 — real hours-worked: from session heartbeat
        // (firstLoginToday → lastActivityAt). Cap at 12h sanity.
        // Falls back to 0 for users without active session today.
        online: (function () {
          const s = sessionsByUid[emp.workspaceMemberUid];
          if (s && s.firstLoginToday && s.lastActivityAt) {
            const start = new Date(s.firstLoginToday).getTime();
            const end = new Date(s.lastActivityAt).getTime();
            if (end > start) {
              const minutes = Math.round((end - start) / 60000);
              return Math.min(12 * 60, minutes); // cap 12h sanity
            }
          }
          return 0;
        })(),
        // Phase 12 — real session data when available, else null/0 (no mock).
        // Source: state.sessions[emp.workspaceMemberUid] populated by floor-map's
        // _refreshSessionsCache. If member hasn't signed in since deploy → null.
        login: (function () {
          const s = sessionsByUid[emp.workspaceMemberUid];
          if (s && s.firstLoginToday) {
            const d = new Date(s.firstLoginToday);
            if (!isNaN(d.getTime())) {
              // Format as h:MM AM/PM for display
              const h = d.getHours(), mm = String(d.getMinutes()).padStart(2, '0');
              return ((h % 12) || 12) + ':' + mm + ' ' + (h >= 12 ? 'PM' : 'AM');
            }
          }
          return null;
        })(),
        logout: null, // no real logout-tracking yet
        ip: '', // no IP tracking
        device: (function () {
          const s = sessionsByUid[emp.workspaceMemberUid];
          return (s && s.device) ? s.device : '— not tracked —';
        })(),
        loc: '— not tracked —',
        // Phase 12 — real numbers only. No mock fallback when activity=0.
        // Exception: `calls` stays mock per operator («подключи всё кроме звонков»)
        // because we have no telephony integration source.
        actions: realActions,
        calls: hasAnyActivity ? realCalls : (5 + (seed % 30)), // mock OK — calls excluded
        emails: realEmails,
        contracts: realContracts,
        docs: realStats.notesMtd,
        invoices: realInvoices,
        payments: realPayments,
        score: scoreFinal,
        prev: 0, // historical previous-period score requires daily snapshots (Phase 15)
        unusual: realActions === 0 && status !== 'offline',
        center: (window.DATA.CENTERS || []).find(function (c) { return c.id === centerId; }),
        // Phase 10 — Gmail thread-stats (used by EmailsTab + metrics override)
        emailsSent: realEmailStat.sentMtd,
        emailsReceived: realEmailStat.receivedMtd,
        emailsReplies: realEmailStat.repliesMtd,
        emailReplyMinAvg: realAvgReplyMin,
        _emailReplyTimesMs: realEmailStat.replyTimesMs,
        // Phase 12 — weekly Mon-Sun buckets for MyDay "This week vs last week"
        weekEmailsNow: realStats.emailsSentThisWeek,
        weekEmailsPrev: realStats.emailsSentLastWeek,
        weekContractsNow: realStats.contractsThisWeek,
        weekContractsPrev: realStats.contractsLastWeek,
        // Phase 12 — XP/Level derived from score. Each daily target hit
        // ≈ 100 XP. Composite score 0-100 maps to ~6-7 XP per day on
        // average. XP * daysInMonth ≈ level. Honest, simple, replaces
        // hardcoded 6320/Level 6.
        xpToday: realScore * 10, // 0..1000 per day
        level: Math.max(1, Math.floor((realScore * 10) / 100)),
        // Phase 15 — real streak + records computed from daily snapshots.
        streak: _streakFromHistory(emailLower),
        records: _recordsFromHistory(emailLower),
        // Phase 14 — today's calendar events from Google Calendar API
        calendarEvents: calendarEventsByEmail[emailLower] || [],
        // Phase 17 — full daily-history array (last 90 days). EmployeeDetail
        // page uses this to render stats for any historical date via the
        // day navigator (← Prev / [date] / Next →).
        _dailyHistory: Array.isArray(dailyHistoryByEmail[emailLower]) ? dailyHistoryByEmail[emailLower] : [],
        // Phase 17 — per-hour activity for today (7-19h buckets).
        // Real outbound emails только; past days сейчас не сохраняются
        // (snapshot cron не пишет hourly). Используется в карточке
        // «Activity by hour» в шапке employee-detail.
        _hourlyToday: _hourlyTodayFor(emailLower),
        _empId: emp.id,
        _hireDate: emp.hireDate || null,
        _workspaceMemberUid: emp.workspaceMemberUid || null,
        _statsAreReal: hasAnyActivity,
        // Phase 12 — prefer real session heartbeat lastActivityAt over
        // activity-derived ms (outreach timestamps).
        _lastActivityMs: (function () {
          const s = sessionsByUid[emp.workspaceMemberUid];
          if (s && s.lastActivityAt) {
            const ms = new Date(s.lastActivityAt).getTime();
            if (!isNaN(ms)) return ms;
          }
          return realStats.lastActivityMs || 0;
        })(),
      };
      usersByEmail.set(emailLower, u);
      return u;
    });

    // Phase 11a — append real employees AFTER demo seed (don't replace).
    window.DATA.USERS = _seedUsers.concat(realUsers);

    // Update center headcount across BOTH seed + real users.
    (window.DATA.CENTERS || []).forEach(function (c) {
      c.headcount = window.DATA.USERS.filter(function (u) { return u.centerId === c.id; }).length;
    });
  }

  // ---------- Replace ALL_EVENTS with real events from outreach + envelopes ----------
  // Prototype shape: {time, cat, type, desc, ent, status, source, user}.
  // We sort by ts desc, cap at 200 for performance, attach user via sentBy.
  const allRealEvents = recentOutreachEvents.concat(recentEnvelopeEvents)
    .sort(function (a, b) { return b.ts - a.ts; })
    .slice(0, 200)
    .map(function (e) {
      const u = e.sentBy ? usersByEmail.get(e.sentBy) : null;
      return {
        time: fmtTimeFromIso(new Date(e.ts).toISOString()),
        cat: e.cat, type: e.type, desc: e.desc, ent: e.ent,
        status: e.status, source: e.source,
        user: u || null,
        // Phase 10 — добавляем userId чтобы employee-detail.jsx фильтр
        // `events.filter(e => e.userId === u.id)` работал.
        userId: u ? u.id : null,
        // Phase 11d — пропускаем tenant-match через final map.
        _tenantMatch: e._tenantMatch || null,
      };
    });

  if (allRealEvents.length > 0) {
    window.DATA.ALL_EVENTS = allRealEvents;
    // Split for prototype's "EVENTS_MAYA" (their featured-user subject) +
    // "EVENTS_OTHERS" if any code depends on the split — point both at the
    // same array so consumers see the same data regardless of which they
    // happened to grab.
    window.DATA.EVENTS_MAYA = allRealEvents;
    window.DATA.EVENTS_OTHERS = allRealEvents;
    console.info('[pulse-shim] replaced ALL_EVENTS with ' + allRealEvents.length + ' real events from outreach + envelopes (last 24h)');
  }

  console.info(
    '[pulse-shim] ready · USERS=' + (window.DATA.USERS || []).length +
    ' · CENTERS=' + (window.DATA.CENTERS || []).length +
    ' · EVENTS=' + (window.DATA.ALL_EVENTS || []).length
  );

  // ---------- Back-link to floor-map (position:fixed, outside React tree) ----------
  // First version injected into .sidebar via MutationObserver, but React's
  // re-renders kept blowing away the appended anchor. Now anchored to <body>
  // with position:fixed at the bottom-left of the sidebar column. React
  // can't touch elements it doesn't own.
  function ensureBackLink() {
    if (document.getElementById('pulseBackToMap')) return;
    const a = document.createElement('a');
    a.id = 'pulseBackToMap';
    a.href = '/floor-map-editor.html';
    a.title = 'Return to the floor-map app';
    a.style.cssText =
      'position: fixed; left: 16px; bottom: 16px; z-index: 9000; ' +
      'display: inline-flex; align-items: center; gap: 8px; ' +
      'padding: 9px 14px; border-radius: 999px; ' +
      'font-family: "Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; ' +
      'font-size: 12.5px; font-weight: 600; ' +
      'color: oklch(35% 0.14 264); ' +
      'background: white; ' +
      'border: 1px solid oklch(85% 0.06 264); ' +
      'box-shadow: 0 4px 14px rgba(20,22,30,.08), 0 0 0 1px rgba(20,22,30,.03); ' +
      'cursor: pointer; text-decoration: none; ' +
      'transition: background .12s, border-color .12s, transform .08s;';
    a.onmouseenter = function () {
      a.style.background = 'oklch(96% 0.03 264)';
      a.style.borderColor = 'oklch(75% 0.10 264)';
    };
    a.onmouseleave = function () {
      a.style.background = 'white';
      a.style.borderColor = 'oklch(85% 0.06 264)';
    };
    a.onmousedown = function () { a.style.transform = 'scale(0.97)'; };
    a.onmouseup   = function () { a.style.transform = 'scale(1)'; };
    a.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<polyline points="15 18 9 12 15 6"/>' +
      '</svg>' +
      '<span>Floor map</span>';
    document.body.appendChild(a);
  }
  if (document.body) ensureBackLink();
  document.addEventListener('DOMContentLoaded', ensureBackLink);
  setTimeout(ensureBackLink, 500);
  setTimeout(ensureBackLink, 2000);

  // ---------- Live sync — reload when state changes in another tab ----------
  // The floor-map saves to `sfa_v5_state` whenever the leader writes. Pulse
  // can re-render with the latest by reloading the page (cheap; React tree
  // is already small). Throttle to once every 5s so a rapid burst of writes
  // doesn't loop us.
  let lastReloadAt = 0;
  window.addEventListener('storage', function (e) {
    if (e.key !== 'sfa_v5_state') return;
    const now = Date.now();
    if (now - lastReloadAt < 5000) return;
    lastReloadAt = now;
    console.info('[pulse-shim] state changed in another tab — reloading');
    setTimeout(function () { location.reload(); }, 800);
  });
})();
