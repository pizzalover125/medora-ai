window.Messages = (() => {
  'use strict';

  const OPEN_POLL_MS = 4000;
  const IDLE_POLL_MS = 12000;
  const PUSHED_POLL_MS = 60000;

  let body = null;
  let view = null;
  let timer = null;
  let pushOn = false;
  let announced = null;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const isOpen = () => !!body && body.isConnected;

  const LINK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 ' +
    '4.2 0 0 0-6-6l-1 1M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1"/></svg>';

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
    const add = el('button', 'msg-add', '+ Add someone');
    add.type = 'button';
    add.addEventListener('click', openAdd);
    head.append(heading, el('span', 'msg-head__count',
      unread ? `${unread} new` : 'All read'), add);
    body.appendChild(head);
    alertsBanner(body);

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

    if (!contacts.length) {
      list.appendChild(el('div', 'msg-empty',
        'No one here yet. Add someone, then send them their link.'));
    }

    body.appendChild(el('p', 'msg-hint',
      'Tap a name to read and reply. Each person has their own link - with it ' +
      'they can text and call you at any time.'));
  }

  function note(message) {
    const row = el('div', 'chat-note');
    row.append(document.createTextNode(message.text),
               el('span', 'chat-note__time', when(message.at)));
    return row;
  }

  function bubble(message) {
    if (message.kind && message.kind !== 'text') return note(message);
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

    const shareButton = el('button', 'call-start msg-share');
    shareButton.type = 'button';
    shareButton.title = 'Share link';
    shareButton.setAttribute('aria-label', `Share ${contact.name}'s link`);
    shareButton.innerHTML = LINK;
    shareButton.addEventListener('click', () => openShare(contact));

    head.append(back, avatar(contact.name, 'msg-avatar--small'), heading, shareButton, callButton);

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
    const idle = pushOn ? PUSHED_POLL_MS : IDLE_POLL_MS;
    timer = setTimeout(tick, isOpen() && view && view.kind === 'thread' ? OPEN_POLL_MS : idle);
  }

  async function tick() {
    try {
      const contacts = await requestJSON('/api/contacts');
      setBadge(totalUnread(contacts.contacts || []));
      announce(contacts.contacts || []);

      if (!isOpen() || !view) return;
      if (view.kind === 'list') {
        if (listSignature(contacts.contacts || []) !== view.signature) {
          renderList(contacts.contacts || []);
        }
        return;
      }
      if (view.kind !== 'thread') return;

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

  function announce(contacts) {
    const fresh = contacts.filter((c) => c.unread && c.last && c.last.from === 'contact' &&
                                         c.last.kind !== 'call');
    if (announced === null) {
      announced = new Set(fresh.map((c) => c.last.id));
      return;
    }
    fresh.forEach((c) => {
      if (announced.has(c.last.id)) return;
      announced.add(c.last.id);
      const onScreen = isOpen() && view && view.kind === 'thread' && view.slug === c.slug &&
        document.visibilityState === 'visible';
      if (onScreen || !window.Reminders || !window.Reminders.say) return;
      window.Reminders.say(c.last.kind === 'note'
        ? `${c.name} ${c.last.text.charAt(0).toLowerCase()}${c.last.text.slice(1)}.`
        : `New message from ${c.name}. ${c.last.text}`);
    });
  }

  async function alertsBanner(target) {
    if (!window.Push) return;
    const state = await Push.status();
    pushOn = state === 'on';
    if (state === 'on') { Push.refresh(); return; }
    if (state === 'unsupported' || !target.isConnected) return;

    const banner = el('div', 'care-banner care-banner--window');
    const text = el('p', 'care-banner__text', {
      off: 'Turn on notifications so calls and messages reach you even when this app is closed.',
      blocked: 'Notifications are blocked for this app. Allow them in the browser settings so calls reach you when it is closed.',
      'needs-install': 'Add this app to your Home Screen so calls and messages reach you when it is closed.',
    }[state]);
    banner.appendChild(text);
    if (state === 'off') {
      const on = el('button', 'care-banner__button', 'Turn on');
      on.type = 'button';
      on.addEventListener('click', async () => {
        on.disabled = true;
        try {
          await Push.enable();
          pushOn = true;
          VideoCall.pushed = true;
          banner.remove();
        } catch (error) {
          text.textContent = error.message;
          on.disabled = false;
        }
      });
      banner.appendChild(on);
    }
    const head = target.querySelector('.msg-head');
    if (head) head.after(banner);
  }

  function panelHead(eyebrow, title, onBack) {
    const head = el('div', 'msg-thread__head');
    const back = el('button', 'msg-back', '←');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back');
    back.addEventListener('click', onBack);
    const heading = el('div', 'msg-thread__copy');
    heading.append(el('p', 'app-panel__eyebrow', eyebrow), el('h2', 'app-panel__title', title));
    head.append(back, heading);
    return head;
  }

  function field(label, name, placeholder, value = '') {
    const wrap = el('label', 'msg-field');
    const input = document.createElement('input');
    input.className = 'msg-composer__input';
    input.name = name;
    input.placeholder = placeholder;
    input.value = value;
    input.maxLength = name === 'name' ? 40 : 30;
    input.autocomplete = 'off';
    wrap.append(el('span', 'msg-field__label', label), input);
    return wrap;
  }

  function openAdd() {
    if (!isOpen()) return;
    view = {kind: 'add'};
    body.textContent = '';
    body.appendChild(panelHead('Messages', 'Add someone', openList));

    const form = el('form', 'msg-panel');
    form.append(
      el('p', 'msg-panel__lead',
        'Add a family member, friend or carer. You will get a link to send them - ' +
        'with it they can text and video call you at any time.'),
      field('Their name', 'name', 'e.g. Michael'),
      field('Who they are to you', 'relation', 'e.g. Son, Carer, Neighbour'),
      field('What they call you', 'calls', 'e.g. Dad, Grandma, George'),
    );
    const status = el('div', 'msg-status');
    status.setAttribute('role', 'alert');
    const submit = el('button', 'msg-composer__send msg-panel__primary', 'Add and get their link');
    submit.type = 'submit';
    form.append(status, submit);
    body.appendChild(form);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.textContent = '';
      submit.disabled = true;
      const data = Object.fromEntries(new FormData(form));
      try {
        const made = await requestJSON('/api/contacts', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(data),
        });
        renderShare(made.contact, made.link, true);
      } catch (error) {
        status.textContent = error.message;
        submit.disabled = false;
      }
    });
    requestAnimationFrame(() => form.querySelector('input').focus({preventScroll: true}));
  }

  function openShare(contact) {
    if (!isOpen()) return;
    loading(`Getting ${contact.name}'s link…`);
    view = null;
    requestJSON(`/api/contacts/${encodeURIComponent(contact.slug)}/link`)
      .then((data) => { if (isOpen()) renderShare(data.contact, data.link, false); })
      .catch(failed);
  }

  function qrFor(link) {
    if (typeof window.qrcode !== 'function') return null;
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      const box = el('div', 'msg-qr');
      box.innerHTML = qr.createSvgTag({cellSize: 4, margin: 2, scalable: true});
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', 'A code to scan with a phone camera');
      return box;
    } catch (_) {
      return null;
    }
  }

  function confirmButton(label, sure, action) {
    const button = el('button', 'msg-panel__danger', label);
    button.type = 'button';
    let armed = null;
    button.addEventListener('click', async () => {
      if (!armed) {
        button.textContent = sure;
        button.classList.add('is-armed');
        armed = setTimeout(() => {
          armed = null;
          button.textContent = label;
          button.classList.remove('is-armed');
        }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      button.disabled = true;
      try { await action(); } finally { button.disabled = false; }
    });
    return button;
  }

  function permissionsBlock(contact) {
    const block = el('div', 'msg-perms');
    block.appendChild(el('p', 'msg-field__label', `What ${contact.name} can see`));
    const status = el('div', 'msg-panel__status');
    status.setAttribute('role', 'status');

    const rows = [
      ['doses', `Tell ${contact.name} if I miss a dose`,
       'A notification to their phone when a Medora dose goes unanswered.'],
      ['day', `Share my day with ${contact.name}`,
       "They can see today's medicines and my calendar, and add reminders that I'll hear."],
    ];
    rows.forEach(([key, label, hint]) => {
      const row = el('label', 'msg-perm');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'msg-perm__box';
      box.checked = !!(contact.permissions && contact.permissions[key]);
      const copy = el('span', 'msg-perm__copy');
      copy.append(el('span', 'msg-perm__label', label), el('span', 'msg-perm__hint', hint));
      row.append(box, copy);
      box.addEventListener('change', async () => {
        box.disabled = true;
        status.textContent = '';
        try {
          const data = await requestJSON(`/api/contacts/${encodeURIComponent(contact.slug)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({permissions: {[key]: box.checked}}),
          });
          contact.permissions = data.contact.permissions;
          status.textContent = 'Saved.';
        } catch (error) {
          box.checked = !box.checked;
          status.textContent = error.message;
        } finally {
          box.disabled = false;
        }
      });
      block.appendChild(row);
    });
    block.appendChild(status);
    return block;
  }

  function renderShare(contact, link, isNew) {
    view = {kind: 'share', slug: contact.slug};
    body.textContent = '';
    body.appendChild(panelHead(contact.relation, `${contact.name}'s link`,
      () => openThread(contact)));

    const panel = el('div', 'msg-panel');
    panel.appendChild(el('p', 'msg-panel__lead', isNew
      ? `${contact.name} is added. Send them this link - with it they can text you and video call you at any time. No account needed.`
      : `Send this to ${contact.name}. With it they can text you and video call you at any time.`));

    const qr = qrFor(link);
    if (qr) {
      const row = el('div', 'msg-share-row');
      row.append(qr, el('p', 'msg-panel__note',
        `${contact.name} can point their phone's camera at this code to open the link.`));
      panel.appendChild(row);
    }

    const linkBox = document.createElement('input');
    linkBox.className = 'msg-composer__input msg-link';
    linkBox.readOnly = true;
    linkBox.value = link;
    linkBox.setAttribute('aria-label', `${contact.name}'s link`);
    linkBox.addEventListener('focus', () => linkBox.select());
    panel.appendChild(linkBox);

    const status = el('div', 'msg-panel__status');
    status.setAttribute('role', 'status');

    const actions = el('div', 'msg-panel__actions');
    const copy = el('button', 'msg-composer__send', 'Copy link');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
      } catch (_) {
        linkBox.select();
        document.execCommand('copy');
      }
      status.textContent = 'Copied. Paste it into a text or email to them.';
    });
    actions.appendChild(copy);

    if (navigator.share) {
      const share = el('button', 'msg-panel__secondary', 'Send…');
      share.type = 'button';
      share.addEventListener('click', () => {
        navigator.share({
          title: 'Messages',
          text: `Hi ${contact.name} - use this link to message me or video call me any time:`,
          url: link,
        }).catch(() => {  });
      });
      actions.appendChild(share);
    }
    panel.append(actions, status);

    panel.appendChild(permissionsBlock(contact));

    const danger = el('div', 'msg-panel__footer');
    danger.append(
      confirmButton('New link', 'Old link will stop - press again', async () => {
        const data = await requestJSON(`/api/contacts/${encodeURIComponent(contact.slug)}/link`,
                                       {method: 'POST'});
        renderShare(data.contact, data.link, false);
        const note = body.querySelector('.msg-panel__status');
        if (note) note.textContent = 'This is a new link. The old one no longer works.';
      }),
      confirmButton(`Remove ${contact.name}`, 'Press again to remove', async () => {
        await requestJSON(`/api/contacts/${encodeURIComponent(contact.slug)}`, {method: 'DELETE'});
        openList();
      }),
    );
    panel.appendChild(danger);
    body.appendChild(panel);
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

  if (window.Push) {
    Push.status().then((state) => {
      pushOn = state === 'on';
      if (pushOn) Push.refresh();
    }).catch(() => {});
    Push.on((payload) => {
      if (payload.kind === 'message' || payload.kind === 'missed') tick();
    });
  }

  return {open, close: () => Win.close()};
})();
