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
    .catch(() => {  });
})();
