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

  // ---------- Map state.buildings → DATA.CENTERS ----------
  const buildings = Array.isArray(st.buildings) ? st.buildings : [];
  const palette = [
    'oklch(62% 0.14 264)', 'oklch(60% 0.13 158)', 'oklch(73% 0.15 78)',
    'oklch(62% 0.14 300)', 'oklch(62% 0.14 340)', 'oklch(62% 0.14 30)',
    'oklch(62% 0.14 200)', 'oklch(62% 0.14 130)',
  ];
  if (buildings.length) {
    window.DATA.CENTERS = buildings.map(function (b, i) {
      // Count floors+units for "properties" stat
      let propCount = 0;
      try {
        (b.floors || []).forEach(function (f) {
          propCount += (f.units || []).filter(function (u) { return u && u.type === 'office'; }).length;
        });
      } catch {}
      return {
        id: 'c' + (i + 1),
        name: b.name || b.id || ('Building ' + (i + 1)),
        short: ((b.name || b.id || '').slice(0, 3).toUpperCase()) || ('B' + (i + 1)),
        address: b.address || '',
        properties: propCount,
        color: palette[i % palette.length],
        headcount: 0,
        _bId: b.id,
      };
    });
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
  function blankStats() {
    return {
      contractsMtd: 0,        // leaseEnvelopes sent this month
      contractsCompleted: 0,  // status=completed within month
      envelopesAllTime: 0,    // lifetime envelope count
      emailsMtd: 0,           // outreach type contains 'email'/'lease' this month
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

    // --- Gmail-ingest unattached events (Phase 8) ---
    // Письма, у которых recipient не нашёлся в state (не сопоставлен с
    // tenant unit) — CF gmail-ingest.onGmailPush сохраняет их в
    // state.gmailActivity[]. Считаем их в emailsMtd по отправителю,
    // чтобы counter не терял реальные исходящие.
    const gmailActivity = (st && Array.isArray(st.gmailActivity)) ? st.gmailActivity : [];
    for (const g of gmailActivity) {
      if (!g || !g.from) continue;
      const stat = bucket(g.from);
      const ts = new Date(g.ts || 0).getTime();
      if (!stat) continue;
      if (ts >= monthStartMs) {
        stat.emailsMtd++;
        stat.actionsMtd++;
      }
      if (ts > stat.lastActivityMs) stat.lastActivityMs = ts;
      if (ts >= last24Ms) {
        recentOutreachEvents.push({
          ts: ts, sentBy: (g.from || '').toLowerCase(),
          cat: 'email', type: 'email',
          desc: 'Email: ' + ((g.subject || '(no subject)')).slice(0, 130),
          ent: { kind: 'contact', name: g.to || '(external)', id: g.messageId || '' },
          status: 'ok', source: 'gmail',
        });
      }
    }
  } catch (e) { console.warn('[pulse-shim] state walk failed:', e); }

  // ---------- Map state.employees → DATA.USERS ----------
  const DEVICES = ['MacBook Pro · Chrome', 'Dell XPS · Edge', 'Lenovo ThinkPad · Firefox', 'iMac · Safari', 'Surface Laptop · Chrome'];
  const LOCS    = ['Office', 'Office', 'Office', 'Remote', 'On-site'];
  const usersByEmail = new Map();   // emp.email.lower → DATA.USERS[i]

  if (active.length) {
    window.DATA.USERS = active.map(function (emp, i) {
      const seed = hashStr(emp.id || emp.fullName || 'x' + i);
      const first = namePart(emp.fullName, 0);
      const last  = namePart(emp.fullName, 1);
      const role = classifyRole(emp.role);
      const centerId = (window.DATA.CENTERS && window.DATA.CENTERS[0]) ? window.DATA.CENTERS[0].id : 'c1';
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
      // Fall back to seed only when employee has zero real activity (so
      // freshly-onboarded employees still show something rather than a
      // flat zero leaderboard row). Once they act, real numbers take over.
      const scoreFinal = hasAnyActivity ? realScore : score;

      const u = {
        id: 'u' + (i + 1),
        first: first,
        last: last,
        name: emp.fullName || (first + ' ' + last).trim() || ('Employee ' + (i + 1)),
        initials: ((first[0] || '?') + (last[0] || '')).toUpperCase(),
        role: role,
        centerId: centerId,
        email: emp.email || '',
        phone: emp.phone || '',
        status: status,
        online: status === 'offline' ? 0 : onlineMin,
        login: status === 'offline' ? null : timeStr(loginMin),
        logout: status === 'offline' ? timeStr(loginMin + onlineMin) : null,
        ip: '10.0.' + (1 + (seed >> 3) % 200) + '.' + (1 + seed % 250),
        device: DEVICES[seed % DEVICES.length],
        loc: LOCS[(seed >> 4) % LOCS.length],
        actions: hasAnyActivity ? realActions : (60 + (seed % 80)),
        calls: hasAnyActivity ? realCalls : (5 + (seed % 30)),
        emails: hasAnyActivity ? realEmails : (8 + ((seed >> 1) % 25)),
        contracts: realContracts,
        docs: realStats.notesMtd || (seed % 10),
        invoices: realInvoices,
        payments: realPayments,
        score: scoreFinal,
        prev: prev,
        unusual: realActions === 0 && status !== 'offline',
        center: (window.DATA.CENTERS || []).find(function (c) { return c.id === centerId; }),
        _empId: emp.id,
        _hireDate: emp.hireDate || null,
        _workspaceMemberUid: emp.workspaceMemberUid || null,
        _statsAreReal: hasAnyActivity,
        _lastActivityMs: realStats.lastActivityMs || 0,
      };
      usersByEmail.set(emailLower, u);
      return u;
    });

    // Update center headcount (we have no per-emp center assignment yet — all
    // employees land on c1 for now; this matches how floor-map treats them).
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
