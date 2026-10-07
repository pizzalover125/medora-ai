(() => {
  'use strict';

  const POLL_MS = 3000;

  const slug = document.body.dataset.slug;
  const log = document.getElementById('log');
  const form = document.getElementById('composer');
  const input = document.getElementById('text');
  const status = document.getElementById('status');
  const send = form.querySelector('.msg-composer__send');
  const seen = new Set();

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const clock = (date) => new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit',
  }).format(date);

  const sameDay = (a, b) => a.toDateString() === b.toDateString();

  function when(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';

    const now = new Date();
    if (sameDay(date, now)) return clock(date);

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) return `Yesterday ${clock(date)}`;

    const fmt = (now - date) < 6 * 86400000 ? {weekday: 'short'}
                                            : {month: 'short', day: 'numeric'};
    return `${new Intl.DateTimeFormat(undefined, fmt).format(date)} ${clock(date)}`;
  }

  async function requestJSON(url, options = {}) {
    const response = await fetch(url, {cache: 'no-store', ...options});
    let data = {};
    try { data = await response.json(); } catch (_) {  }
    if (!response.ok) throw new Error(data.message || 'Messages are not answering.');
    return data;
  }

  function note(message) {
    const row = el('div', 'chat-note');
    row.append(document.createTextNode(message.text),
               el('span', 'chat-note__time', when(message.at)));
    return row;
  }

  function bubble(message) {
    if (message.kind === 'call') return note(message);
    const row = el('div', `chat-row ${message.from === 'contact' ? 'is-me' : 'is-them'}`);
    const body = el('div', 'bubble');
    body.append(
      el('span', 'bubble__text', message.text),
      el('span', 'bubble__time', when(message.at)),
    );
    row.appendChild(body);
    return row;
  }

  function appendMessages(messages) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    let added = 0;

    messages.forEach((message) => {
      if (seen.has(message.id)) return;
      seen.add(message.id);
      log.appendChild(bubble(message));
      added++;
    });

    if (added) {
      log.querySelectorAll('.msg-loading, .msg-empty').forEach((node) => node.remove());
      if (nearBottom) log.scrollTop = log.scrollHeight;
    }
    return added;
  }

  const url = `/api/messages/${encodeURIComponent(slug)}?as=contact`;

  async function refresh() {
    try {
      const data = await requestJSON(url);
      const first = !seen.size;
      appendMessages(data.messages || []);
      if (first) {
        log.querySelectorAll('.msg-loading').forEach((node) => node.remove());
        if (!seen.size) log.appendChild(el('div', 'msg-empty', 'No messages yet. Say hello.'));
        log.scrollTop = log.scrollHeight;
      }
      status.textContent = '';
    } catch (error) {
      console.warn('[contact] refresh failed', error);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    status.textContent = '';
    input.disabled = send.disabled = true;
    try {
      const data = await requestJSON(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text, from: 'contact'}),
      });
      input.value = '';
      appendMessages(data.messages || []);
      log.scrollTop = log.scrollHeight;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      input.disabled = send.disabled = false;
      input.focus({preventScroll: true});
    }
  });

  document.getElementById('call')
    .addEventListener('click', () => VideoCall.place(slug));

  VideoCall.init({me: 'contact', slug, onchange: refresh});

  refresh();
  setInterval(refresh, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
})();
