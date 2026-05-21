/* Phase 18 — Pulse Firebase bridge.
   Lazy-loads Firebase v10 modular SDK from gstatic so Pulse can call
   Cloud Functions (e.g. getAircallRecording для fresh recording URL).
   Auth state shares persistent IndexedDB with floor-map so user
   is already signed-in when they reach Pulse.

   Public API:
     await window._pulseCallable('functionName', { arg: ... })
     → returns { data: ... }  (same shape as Firebase httpsCallable result)

   First call kicks off SDK init + auth-wait (up to 5 sec). Subsequent
   calls reuse the loaded app + functions instance.
*/
(function () {
  if (window._pulseCallable) return; // already loaded
  let _initPromise = null;

  async function _init() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      const FB_CDN = 'https://www.gstatic.com/firebasejs';
      const VER = '10.14.1';
      const [appMod, authMod, fnMod] = await Promise.all([
        import(`${FB_CDN}/${VER}/firebase-app.js`),
        import(`${FB_CDN}/${VER}/firebase-auth.js`),
        import(`${FB_CDN}/${VER}/firebase-functions.js`),
      ]);
      // Firebase Hosting auto-serves config at /__/firebase/init.json
      // when a Web App is linked. Tier-2 same as floor-map.
      let config = null;
      try {
        const r = await fetch('/__/firebase/init.json');
        if (r.ok) config = await r.json();
      } catch (e) { /* fall through */ }
      if (!config || !config.apiKey) {
        throw new Error('Firebase config missing (init.json not served?)');
      }
      // Use named app so we don't collide with anything else that
      // may have initialized firebase on this page.
      const app = appMod.initializeApp(config, 'pulse-bridge');
      const auth = authMod.getAuth(app);
      // Wait for auth state (persistent from floor-map via IndexedDB).
      // Timeout 5 sec — if no signed-in user, callable will fail with
      // unauthenticated; we still resolve the init promise.
      await new Promise((resolve) => {
        let done = false;
        const unsub = authMod.onAuthStateChanged(auth, (user) => {
          if (done) return;
          if (user) {
            done = true;
            try { unsub(); } catch (e) {}
            resolve();
          }
        });
        setTimeout(() => {
          if (!done) { done = true; try { unsub(); } catch (e) {} resolve(); }
        }, 5000);
      });
      const fns = fnMod.getFunctions(app, 'us-central1');
      return { app, auth, fns, httpsCallable: fnMod.httpsCallable };
    })();
    return _initPromise;
  }

  window._pulseCallable = async function (name, data) {
    const { fns, httpsCallable } = await _init();
    const fn = httpsCallable(fns, name);
    return await fn(data || {});
  };

  // Expose init explicitly so callers can prime the bridge eagerly
  // (avoids first-click delay on Play button).
  window._pulseCallableInit = _init;
})();
