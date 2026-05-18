/* global window */

/* ================================================================
   Pulse — Real-data shim (FIXES_LOG Entry 23, Phase 5)
   ------------------------------------------------------------------
   Replaces data.jsx's mock USERS + CENTERS with values read from the
   floor-map app's localStorage state document (`sfa_v5_state`). Runs
   BEFORE app.jsx mounts so the React tree sees real people on the
   first render — no flash of mock data, no manual re-mount.

   Shape contract: prototype's USER shape (id, first, last, name,
   initials, role, centerId, status, online, login, logout, ip,
   device, loc, actions, calls, emails, contracts, docs, score, prev,
   unusual). Real-state has only `id, fullName, role, email, phone,
   hireDate, status, workspaceMemberUid`. The fields we don't have are
   stubbed deterministically off a hash of the employee id so the same
   person always renders with the same numbers. Production wiring of
   real counts (calls/emails/contracts/score) comes from the activity
   pipeline in a follow-up.

   If localStorage has no state (operator on a fresh browser / signed
   out / different origin), the shim no-ops and prototype keeps its
   mock data — graceful fallback.
   ================================================================ */

(function () {
  'use strict';

  try {
    const raw = localStorage.getItem('sfa_v5_state');
    if (!raw) {
      console.info('[pulse-shim] no state in localStorage — keeping mock DATA');
      return;
    }
    const st = JSON.parse(raw);
    if (!window.DATA) {
      console.warn('[pulse-shim] window.DATA not initialized yet — abort');
      return;
    }

    // ---- Map state.buildings → DATA.CENTERS ----
    const buildings = Array.isArray(st.buildings) ? st.buildings : [];
    const centersByBuildingId = new Map();
    if (buildings.length) {
      const palette = [
        'oklch(62% 0.14 264)', 'oklch(60% 0.13 158)', 'oklch(73% 0.15 78)',
        'oklch(62% 0.14 300)', 'oklch(62% 0.14 340)', 'oklch(62% 0.14 30)',
        'oklch(62% 0.14 200)', 'oklch(62% 0.14 130)',
      ];
      window.DATA.CENTERS = buildings.map(function (b, i) {
        const center = {
          id: 'c' + (i + 1),
          name: b.name || b.id || ('Building ' + (i + 1)),
          short: ((b.name || b.id || '').slice(0, 3).toUpperCase()) || ('B' + (i + 1)),
          color: palette[i % palette.length],
          headcount: 0,   // filled below
        };
        centersByBuildingId.set(b.id, center.id);
        return center;
      });
    }

    // ---- Map state.employees → DATA.USERS ----
    const emps = Array.isArray(st.employees) ? st.employees : [];
    const active = emps.filter(function (e) { return e && e.status !== 'terminated'; });

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
    function pickCenter(emp) {
      // Centers default — first building. If we ever wire workspace
      // members' buildings array, swap to that here.
      const first = (window.DATA.CENTERS || [])[0];
      return first ? first.id : 'c1';
    }

    function timeStr(minSinceMidnight) {
      const h24 = Math.floor(minSinceMidnight / 60);
      const m = minSinceMidnight % 60;
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12 = h24 % 12 || 12;
      return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
    }

    const DEVICES = ['MacBook Pro', 'Dell XPS', 'Lenovo ThinkPad', 'Surface Laptop', 'iMac'];
    const LOCS    = ['Office', 'Office', 'Office', 'Remote', 'Office · WFH'];

    if (active.length) {
      window.DATA.USERS = active.map(function (emp, i) {
        const seed = hashStr(emp.id || emp.fullName || 'x' + i);
        const first = namePart(emp.fullName, 0);
        const last  = namePart(emp.fullName, 1);
        const role = classifyRole(emp.role);
        const centerId = pickCenter(emp);
        const onlineMin = 240 + (seed % 280);
        const loginMin  = 480 + (seed % 90);   // 8:00..9:30 AM
        const statusPick = seed % 10;
        const status = statusPick < 7 ? 'online' : statusPick < 9 ? 'idle' : 'offline';
        const score = 60 + (seed % 40);
        const prev  = 55 + ((seed >> 2) % 38);

        return {
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
          actions: 60 + (seed % 80),
          calls: 5 + (seed % 30),
          emails: 8 + ((seed >> 1) % 25),
          contracts: (seed % 5),
          docs: (seed % 10),
          score: score,
          prev: prev,
          unusual: (seed % 13) === 0,
          // Preserve real-world keys so a future tab in the employee
          // detail drawer can show "Hired YYYY-MM-DD" and similar.
          _empId: emp.id,
          _hireDate: emp.hireDate || null,
          _workspaceMemberUid: emp.workspaceMemberUid || null,
        };
      });

      // Backfill center headcounts
      (window.DATA.CENTERS || []).forEach(function (c) {
        c.headcount = window.DATA.USERS.filter(function (u) { return u.centerId === c.id; }).length;
      });
      // Centers' default headcount totals (used by Centers page) — kept
      // in sync with USERS.
      if (window.DATA.CENTERS) {
        window.DATA.CENTERS.forEach(function (c) {
          if (c.headcount == null) c.headcount = 0;
        });
      }
      console.info('[pulse-shim] replaced DATA.USERS with ' + window.DATA.USERS.length +
                   ' real employees, DATA.CENTERS with ' + (window.DATA.CENTERS || []).length + ' buildings');
    } else {
      console.info('[pulse-shim] no active employees — keeping prototype mock USERS');
    }
  } catch (e) {
    console.warn('[pulse-shim] failed, keeping mock DATA:', e);
  }
})();
