/* ---------------------------------------------------------------------------
   The senior's device, before anything else loads.

   - Every request to /api carries this device's time zone, because the
     server runs in UTC and the medicine schedule runs on the wall clock.
   - The assistant holds everything private - the schedule, the calendar,
     every conversation - so a device that has not signed in is sent to
     /login. It signs in once; the cookie lasts a year.
--------------------------------------------------------------------------- */

(() => {
  'use strict';

  const tz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
  })();

  const toLogin = () => {
    if (location.pathname !== '/login') location.replace('/login');
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const ours = url.startsWith('/api/') || url.startsWith(`${location.origin}/api/`);
    if (!ours) return nativeFetch(input, init);

    const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
    if (tz) headers.set('X-Timezone', tz);
    const response = await nativeFetch(input, {...init, headers, credentials: 'same-origin'});
    if (response.status === 401) {
      response.clone().json().then((data) => {
        if (data && data.error === 'senior_login') toLogin();
      }).catch(() => {});
    }
    return response;
  };

  nativeFetch('/api/session', {cache: 'no-store', credentials: 'same-origin'})
    .then((r) => r.json())
    .then((s) => { if (s.required && !s.senior) toLogin(); })
    .catch(() => { /* offline - the apps will say so themselves */ });
})();
