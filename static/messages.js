window.Messages = (() => {
  'use strict';

  const OPEN_POLL_MS = 4000;
  const IDLE_POLL_MS = 12000;

  let body = null;
  let view = null;
  let timer = null;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const isOpen = () => !!body && body.isConnected;

  const CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7.5h9a2 ' +
    '2 0 0 1 2 2v5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Zm11 3.2 4-2.4v7.4l-4-2.4"/></svg>';

  async function requestJSON(url, options = {}) {
    const response = await fetch(url, {cache: 'no-store', ...options});
    let data = {};
    try { data = await response.json(); } catch (_) {  }
    if (!response.ok) throw new Error(data.message || 'Messages are not answering.');
    return data;
  }

  function setBadge(count) {
    const item = document.querySelector('.app-dock__item[data-app="messages"]');
    if (!item) return;
    let badge = item.querySelector('.app-dock__badge');

    if (!count) {
      if (badge) badge.remove();
      item.setAttribute('aria-label', 'Messages');
      return;
    }
    if (!badge) {
      badge = el('span', 'app-dock__badge');
      badge.setAttribute('aria-hidden', 'true');
      item.appendChild(badge);
    }
    badge.textContent = count > 9 ? '9+' : String(count);
    item.setAttribute('aria-label',
      `Messages, ${count} unread message${count === 1 ? '' : 's'}`);
  }

  const totalUnread = (contacts) =>
    contacts.reduce((sum, contact) => sum + (contact.unread || 0), 0);

  const clock = (date) => new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit',
  }).format(date);

  const sameDay = (a, b) => a.toDateString() === b.toDateString();

  function when(iso, brief = false) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';

    const now = new Date();
    if (sameDay(date, now)) return clock(date);

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) {
      return brief ? 'Yesterday' : `Yesterday ${clock(date)}`;
    }

    const fmt = (now - date) < 6 * 86400000 ? {weekday: 'short'}
                                            : {month: 'short', day: 'numeric'};
    const day = new Intl.DateTimeFormat(undefined, fmt).format(date);
    return brief ? day : `${day} ${clock(date)}`;
  }

  function avatar(name, cls) {
    const letter = name.replace(/^dr\.?\s*/i, '').trim().charAt(0).toUpperCase();
    return el('span', cls ? `msg-avatar ${cls}` : 'msg-avatar', letter || '?');
  }

  function listSignature(contacts) {
    return contacts.map((c) => [c.slug, c.unread, c.last && c.last.id].join(':')).join('|');
  }

  function renderList(contacts) {
    view = {kind: 'list', signature: listSignature(contacts)};
    body.textContent = '';

    const head = el('div', 'msg-head');
    const heading = el('div', 'msg-head__copy');
    const unread = totalUnread(contacts);
    heading.append(
      el('p', 'app-panel__eyebrow', 'Messages'),
      el('h2', 'app-panel__title', 'Your people'),
    );
    head.append(heading, el('span', 'msg-head__count',
      unread ? `${unread} new` : 'All read'));
    body.appendChild(head);

    const list = el('div', 'msg-list');
    contacts.forEach((contact) => {
      const item = el('button', 'msg-contact');
      item.type = 'button';
      if (contact.unread) item.classList.add('is-unread');
      item.setAttribute('aria-label',
        `Open messages with ${contact.name}, your ${contact.relation.toLowerCase()}` +
        (contact.unread ? `, ${contact.unread} unread` : ''));

      const copy = el('span', 'msg-contact__copy');
      const line = el('span', 'msg-contact__line');
      line.append(
        el('span', 'msg-contact__name', contact.name),
        el('span', 'msg-contact__relation', contact.relation),
      );
      const preview = contact.last
        ? (contact.last.from === 'senior' ? `You: ${contact.last.text}` : contact.last.text)
        : 'No messages yet';
      copy.append(line, el('span', 'msg-contact__preview', preview));

      const meta = el('span', 'msg-contact__meta');
      meta.append(el('span', 'msg-contact__time',
        contact.last ? when(contact.last.at, true) : ''));
      if (contact.unread) {
        meta.appendChild(el('span', 'msg-contact__unread', String(contact.unread)));
      }

      item.append(avatar(contact.name), copy, meta);
      item.addEventListener('click', () => openThread(contact));
      list.appendChild(item);
    });
    body.appendChild(list);

    body.appendChild(el('p', 'msg-hint',
      'Tap a name to read and reply. They write back from their own page.'));
  }

  function note(message) {
    const row = el('div', 'chat-note');
    row.append(document.createTextNode(message.text),
               el('span', 'chat-note__time', when(message.at)));
    return row;
  }

  function bubble(message) {
    if (message.kind === 'call') return note(message);
    const row = el('div', `chat-row ${message.from === 'senior' ? 'is-me' : 'is-them'}`);
    const bubbleEl = el('div', 'bubble');
    bubbleEl.append(
      el('span', 'bubble__text', message.text),
      el('span', 'bubble__time', when(message.at)),
    );
    row.appendChild(bubbleEl);
    return row;
  }

  function appendMessages(messages) {
    if (!view || view.kind !== 'thread') return;
    const {log, seen} = view;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;

    let added = 0;
    messages.forEach((message) => {
      if (seen.has(message.id)) return;
      seen.add(message.id);
      log.appendChild(bubble(message));
      added++;
    });

    if (added && nearBottom) log.scrollTop = log.scrollHeight;
    return added;
  }

  function renderThread(contact, messages) {
    body.textContent = '';

    const head = el('div', 'msg-thread__head');
    const back = el('button', 'msg-back', '←');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back to all messages');
    back.addEventListener('click', openList);

    const heading = el('div', 'msg-thread__copy');
    heading.append(
      el('p', 'app-panel__eyebrow', contact.relation),
      el('h2', 'app-panel__title', contact.name),
    );
    const callButton = el('button', 'call-start');
    callButton.type = 'button';
    callButton.title = 'Video call';
    callButton.setAttribute('aria-label', `Start a video call with ${contact.name}`);
    callButton.innerHTML = CAMERA;
    callButton.addEventListener('click', () => VideoCall.place(contact.slug));

    head.append(back, avatar(contact.name, 'msg-avatar--small'), heading, callButton);

    const log = el('div', 'chat-log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-label', `Messages with ${contact.name}`);

    const form = el('form', 'msg-composer');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'msg-composer__input';
    input.maxLength = 600;
    input.autocomplete = 'off';
    input.placeholder = `Message ${contact.name}…`;
    input.setAttribute('aria-label', `Message ${contact.name}`);

    const send = el('button', 'msg-composer__send', 'Send');
    send.type = 'submit';
    form.append(input, send);

    const status = el('div', 'msg-status');
    status.setAttribute('role', 'alert');

    body.append(head, log, status, form);
    view = {kind: 'thread', slug: contact.slug, contact, log, input, seen: new Set()};

    if (!messages.length) {
      log.appendChild(el('div', 'msg-empty', `No messages with ${contact.name} yet.`));
    }
    appendMessages(messages);
    log.scrollTop = log.scrollHeight;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;

      status.textContent = '';
      input.disabled = send.disabled = true;
      try {
        const data = await requestJSON(`/api/messages/${encodeURIComponent(contact.slug)}`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({text, from: 'senior'}),
        });
        input.value = '';
        log.querySelectorAll('.msg-empty').forEach((node) => node.remove());
        appendMessages(data.messages || []);
        view.log.scrollTop = view.log.scrollHeight;
      } catch (error) {
        status.textContent = error.message;
      } finally {
        input.disabled = send.disabled = false;
        input.focus({preventScroll: true});
      }
    });

    requestAnimationFrame(() => input.focus({preventScroll: true}));
  }

  function loading(message) {
    body.textContent = '';
    body.appendChild(el('div', 'msg-loading', message));
  }

  function failed(error) {
    console.error('[messages] %s', error.message);
    if (!isOpen()) return;
    body.textContent = '';
    body.appendChild(el('div', 'msg-error', error.message));
    view = null;
  }

  function openList() {
    if (!isOpen()) return;
    loading('Opening messages…');
    view = null;
    requestJSON('/api/contacts')
      .then((data) => {
        if (!isOpen()) return;
        setBadge(totalUnread(data.contacts || []));
        renderList(data.contacts || []);
      })
      .catch(failed);
  }

  function openThread(contact) {
    if (!isOpen()) return;
    loading(`Opening ${contact.name}…`);
    view = null;
    requestJSON(`/api/messages/${encodeURIComponent(contact.slug)}?as=senior`)
      .then((data) => {
        if (!isOpen()) return;
        renderThread(contact, data.messages || []);
        return requestJSON('/api/contacts')
          .then((list) => setBadge(totalUnread(list.contacts || [])));
      })
      .catch(failed);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(tick, isOpen() ? OPEN_POLL_MS : IDLE_POLL_MS);
  }

  async function tick() {
    try {
      const contacts = await requestJSON('/api/contacts');
      setBadge(totalUnread(contacts.contacts || []));

      if (!isOpen() || !view) return;
      if (view.kind === 'list') {
        if (listSignature(contacts.contacts || []) !== view.signature) {
          renderList(contacts.contacts || []);
        }
        return;
      }

      const data = await requestJSON(
        `/api/messages/${encodeURIComponent(view.slug)}?as=senior`);
      if (!isOpen() || !view || view.kind !== 'thread') return;
      if (appendMessages(data.messages || [])) {
        view.log.querySelectorAll('.msg-empty').forEach((node) => node.remove());
      }
    } catch (error) {
      console.warn('[messages] poll failed', error);
    } finally {
      schedule();
    }
  }

  function open() {
    Win.open('Messages', {
      build: (target) => {
        body = target;
        target.classList.add('messages');
        target.appendChild(el('div', 'msg-loading', 'Opening messages…'));
      },
      onClose: () => {
        body = null;
        view = null;
        schedule();
      },
    });
    openList();
    schedule();
  }

  tick();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });

  VideoCall.init({me: 'senior', onchange: tick});

  return {open, close: () => Win.close()};
})();
