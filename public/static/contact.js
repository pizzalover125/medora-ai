/* ---------------------------------------------------------------------------
   A caretaker's link: /c/<token>.

   The senior shares this link from their Messages window, and it is the
   caretaker's whole way in - no account, no password. It opens one
   conversation with the senior, and from it they can text or video call at
   any time. Turning on notifications (once per phone) means the senior's
   replies and calls reach them with this page closed, too.

   If the senior has shared their day, a Today tab shows the medicines due
   today and how each went, what is coming up on their calendar, and a form
   to add a reminder - which the assistant says out loud when it comes due.

   If the senior replaces the link, the old one stops working and this page
   says so.
--------------------------------------------------------------------------- */

(() => {
  'use strict';

  const POLL_MS = 4000;            // open and on screen, notifications off
  const QUIET_POLL_MS = 20000;     // a push will say when something arrives

  const token = decodeURIComponent(location.pathname.split('/')[2] || '');
  const log = document.getElementById('log');
  const form = document.getElementById('composer');
  const input = document.getElementById('text');
  const status = document.getElementById('status');
  const send = form.querySelector('.msg-composer__send');
  const callButton = document.getElementById('call');
  const alerts = document.getElementById('alerts');
  const alertsText = document.getElementById('alerts-text');
  const alertsButton = document.getElementById('alerts-button');
  const tabs = document.getElementById('tabs');
  const todayPanel = document.getElementById('today');
  const seen = new Set();
  let contact = null;
  let tab = 'messages';
  let todayTimer = null;
  let pushOn = false;
  let timer = null;

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
    try { data = await response.json(); } catch (_) { /* handled below */ }
    if (!response.ok) {
      const error = new Error(data.message || 'Messages are not answering.');
      error.code = data.error;
      throw error;
    }
    return data;
  }

  function note(message) {
    const row = el('div', 'chat-note');
    row.append(document.createTextNode(message.text),
               el('span', 'chat-note__time', when(message.at)));
    return row;
  }

  /* This page is the caretaker, so their own messages are on the right. */
  function bubble(message) {
    if (message.kind && message.kind !== 'text') return note(message);
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

  const url = `/api/c/${encodeURIComponent(token)}/messages`;

  /* The link was replaced or the contact removed: say so plainly, and stop
     asking the server about it. */
  function closed(message) {
    clearTimeout(timer);
    document.title = 'Link expired';
    document.getElementById('title').textContent = 'This link has expired';
    document.getElementById('you').textContent = '';
    log.textContent = '';
    log.appendChild(el('div', 'msg-empty', message ||
      'This link is no longer active. Ask for a new one.'));
    input.disabled = send.disabled = callButton.disabled = true;
    alerts.hidden = true;
    tabs.hidden = true;
    todayPanel.hidden = true;
    log.hidden = form.hidden = false;
  }

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
      if (error.code === 'link_not_found') { closed(error.message); return false; }
      console.warn('[contact] refresh failed', error);
    }
    return true;
  }

  function schedule() {
    clearTimeout(timer);
    const hidden = document.visibilityState !== 'visible';
    timer = setTimeout(async () => {
      if (await refresh() !== false) schedule();
    }, pushOn || hidden ? QUIET_POLL_MS : POLL_MS);
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
        body: JSON.stringify({text}),
      });
      input.value = '';
      appendMessages(data.messages || []);
      log.scrollTop = log.scrollHeight;
    } catch (error) {
      if (error.code === 'link_not_found') closed(error.message);
      else status.textContent = error.message;
    } finally {
      if (contact) input.disabled = send.disabled = false;
      input.focus({preventScroll: true});
    }
  });

  /* ── notifications ────────────────────────────────────────────────────── */

  async function showAlerts() {
    const state = await Push.status();
    pushOn = state === 'on';
    const name = contact.calls;
    if (state === 'on' || state === 'unsupported') {
      alerts.hidden = true;
      if (state === 'on') Push.refresh(token);
      return;
    }
    alerts.hidden = false;
    alertsButton.hidden = state !== 'off';
    const doses = contact.permissions && contact.permissions.doses
      ? `, are told if ${name} misses a dose,` : '';
    alertsText.textContent = {
      off: `Turn on notifications so you hear from ${name}${doses} and can be called - even when this page is closed.`,
      blocked: `Notifications are blocked for this page. Allow them in your browser settings to hear from ${name} when it is closed.`,
      'needs-install': `To get ${name}'s calls and messages with this page closed, tap Share, then "Add to Home Screen", and open it from there.`,
    }[state];
  }

  alertsButton.addEventListener('click', async () => {
    alertsButton.disabled = true;
    try {
      await Push.enable(token);
      await showAlerts();
    } catch (error) {
      alertsText.textContent = error.message;
    } finally {
      alertsButton.disabled = false;
    }
  });

  // A push while the page is open: look now rather than at the next poll.
  Push.on((payload) => {
    refresh();
    VideoCall.check();
    if (payload.kind === 'dose' && tab === 'today') loadToday();
  });

  /* ── today: what the senior has shared ────────────────────────────────── */

  const STATUS = {
    taken: ['Taken', 'is-good'],
    skipped: ['Skipped', 'is-quiet'],
    missed: ['Not taken', 'is-bad'],
    due: ['Due now', 'is-due'],
    upcoming: ['Later', 'is-quiet'],
  };

  const clockOf = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
  };

  function dayOf(date, today) {
    if (date === today) return 'Today';
    const d = new Date(`${date}T12:00:00Z`);
    const t = new Date(`${today}T12:00:00Z`);
    const days = Math.round((d - t) / 86400000);
    if (days === 1) return 'Tomorrow';
    return new Intl.DateTimeFormat(undefined, days < 7
      ? {weekday: 'long', timeZone: 'UTC'}
      : {weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'}).format(d);
  }

  function showTab(next) {
    tab = next;
    tabs.querySelectorAll('.care-tab').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.tab === next));
    });
    const today = next === 'today';
    todayPanel.hidden = !today;
    log.hidden = form.hidden = today;
    status.hidden = today;
    clearInterval(todayTimer);
    if (today) {
      loadToday();
      todayTimer = setInterval(() => {
        // Not while they are typing a reminder - a redraw would take the caret.
        if (document.visibilityState === 'visible' && !todayPanel.contains(document.activeElement)) {
          loadToday();
        }
      }, 60000);
    } else {
      log.scrollTop = log.scrollHeight;
    }
  }

  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('.care-tab');
    if (button) showTab(button.dataset.tab);
  });

  /* Shown or hidden as the senior changes what they share. */
  function applyPermissions() {
    const day = !!(contact.permissions && contact.permissions.day);
    tabs.hidden = !day;
    if (!day && tab === 'today') showTab('messages');
  }

  async function loadToday() {
    let data;
    try {
      data = await requestJSON(`/api/c/${encodeURIComponent(token)}/today`);
    } catch (error) {
      if (error.code === 'not_shared') {
        contact.permissions = {...contact.permissions, day: false};
        applyPermissions();
      } else if (error.code === 'link_not_found') {
        closed(error.message);
      } else if (!todayPanel.childElementCount) {
        todayPanel.textContent = '';
        todayPanel.appendChild(el('div', 'msg-error', error.message));
      }
      return;
    }
    if (!data.shared) {
      contact.permissions = {...contact.permissions, day: false};
      applyPermissions();
      return;
    }
    renderToday(data);
  }

  function renderToday(data) {
    const name = contact.calls;
    const keepForm = todayPanel.querySelector('form');
    const draft = keepForm ? Object.fromEntries(new FormData(keepForm)) : null;
    todayPanel.textContent = '';

    // Medicines
    const meds = el('section', 'care-card');
    meds.appendChild(el('h2', 'care-card__title', 'Medicines today'));
    if (!data.doses.length) {
      meds.appendChild(el('p', 'care-card__empty', `${name} has no medicines scheduled today.`));
    } else {
      const list = el('ul', 'care-list');
      data.doses.forEach((dose) => {
        const [label, cls] = STATUS[dose.status] || ['', ''];
        const row = el('li', 'care-row');
        row.append(
          el('span', 'care-row__time', clockOf(dose.time)),
          el('span', 'care-row__what', dose.quantity > 1 ? `${dose.name} ×${dose.quantity}` : dose.name),
          el('span', `care-chip ${cls}`, label),
        );
        list.appendChild(row);
      });
      meds.appendChild(list);
    }
    todayPanel.appendChild(meds);

    // Calendar
    const cal = el('section', 'care-card');
    cal.appendChild(el('h2', 'care-card__title', 'Coming up'));
    if (!data.events.length) {
      cal.appendChild(el('p', 'care-card__empty', `Nothing on ${name}'s calendar.`));
    } else {
      const list = el('ul', 'care-list');
      data.events.forEach((event) => {
        const row = el('li', 'care-row');
        const what = el('span', 'care-row__what', event.title);
        if (event.by) what.appendChild(el('span', 'care-row__by', ` · from ${event.by}`));
        row.append(
          el('span', 'care-row__time',
            `${dayOf(event.date, data.today)}${event.time ? `, ${clockOf(event.time)}` : ''}`),
          what,
        );
        list.appendChild(row);
      });
      cal.appendChild(list);
    }
    todayPanel.appendChild(cal);

    // Add a reminder
    const add = el('section', 'care-card');
    add.appendChild(el('h2', 'care-card__title', 'Add a reminder'));
    add.appendChild(el('p', 'care-card__empty',
      `It goes on ${name}'s calendar, and the assistant says it out loud at that time.`));
    const reminder = document.createElement('form');
    reminder.className = 'care-form';
    const field = (label, type, fieldName, value, extra = {}) => {
      const wrap = el('label', 'msg-field');
      const fieldInput = document.createElement('input');
      fieldInput.className = 'msg-composer__input';
      fieldInput.type = type;
      fieldInput.name = fieldName;
      fieldInput.value = value;
      Object.assign(fieldInput, extra);
      wrap.append(el('span', 'msg-field__label', label), fieldInput);
      return wrap;
    };
    reminder.append(
      field('What', 'text', 'title', draft ? draft.title : '',
        {required: true, maxLength: 160, placeholder: 'e.g. Take the bins out', autocomplete: 'off'}),
      field('Day', 'date', 'date', draft ? draft.date : data.today, {required: true, min: data.today}),
      field('Time', 'time', 'time', draft ? draft.time : ''),
    );
    const mine = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; }
    })();
    if (data.timezone && mine && data.timezone !== mine && data.timezone !== 'UTC') {
      reminder.appendChild(el('p', 'care-card__note',
        `Times are in ${name}'s time zone (${data.timezone.replace(/_/g, ' ')}).`));
    }
    const note = el('div', 'msg-panel__status');
    note.setAttribute('role', 'status');
    const submit = el('button', 'msg-composer__send', 'Add reminder');
    submit.type = 'submit';
    reminder.append(submit, note);
    add.appendChild(reminder);
    todayPanel.appendChild(add);

    reminder.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      note.textContent = '';
      try {
        const values = Object.fromEntries(new FormData(reminder));
        const result = await requestJSON(`/api/c/${encodeURIComponent(token)}/events`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(values),
        });
        reminder.reset();
        await loadToday();
        const after = todayPanel.querySelector('.care-form .msg-panel__status');
        if (after) after.textContent = `Added. ${name} will hear: "${result.event.title}".`;
        refresh();
      } catch (error) {
        note.textContent = error.message;
        submit.disabled = false;
        if (error.code === 'not_shared') loadToday();
      }
    });
  }

  /* ── start ────────────────────────────────────────────────────────────── */

  async function start() {
    try {
      const data = await requestJSON(`/api/c/${encodeURIComponent(token)}`);
      contact = data.contact;
    } catch (error) {
      closed(error.code === 'link_not_found' ? error.message : 'This conversation could not be opened.');
      return;
    }

    const name = contact.calls;
    document.title = `${name} · Messages`;
    document.getElementById('title').textContent = name;
    document.getElementById('avatar').textContent = name.charAt(0).toUpperCase();
    document.getElementById('you').textContent = `You are ${contact.name} · ${contact.relation}`;
    log.setAttribute('aria-label', `Messages with ${name}`);
    input.placeholder = `Message ${name}…`;
    input.setAttribute('aria-label', `Message ${name}`);
    callButton.setAttribute('aria-label', `Start a video call with ${name}`);
    input.disabled = send.disabled = callButton.disabled = false;

    // An installable app that opens straight on this link.
    const manifest = document.createElement('link');
    manifest.rel = 'manifest';
    manifest.href = `/api/manifest/${encodeURIComponent(token)}`;
    document.head.appendChild(manifest);

    applyPermissions();
    callButton.addEventListener('click', () => VideoCall.place());
    VideoCall.init({me: 'contact', token, onchange: refresh});

    await refresh();
    await showAlerts();
    schedule();
  }

  /* Coming back to the page: catch up, including anything the senior has
     started or stopped sharing meanwhile. */
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !contact) return;
    refresh();
    schedule();
    try {
      const data = await requestJSON(`/api/c/${encodeURIComponent(token)}`);
      contact = data.contact;
      applyPermissions();
      if (tab === 'today') loadToday();
    } catch (error) {
      if (error.code === 'link_not_found') closed(error.message);
    }
  });

  start();
})();
