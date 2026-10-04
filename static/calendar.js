/* ---------------------------------------------------------------------------
   Local calendar manager. Events can be created, edited, or deleted here and
   remain available to the same voice-calendar tools used by Ask.
--------------------------------------------------------------------------- */

window.CalendarApp = (() => {
  'use strict';

  let calendarEvents = [];

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const dateFrom = (iso) => new Date(`${iso}T12:00:00`);

  function localISO(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatTime(value) {
    if (!value) return 'All day';
    const [hours, minutes] = value.split(':').map(Number);
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: minutes ? '2-digit' : undefined,
    }).format(new Date(2000, 0, 1, hours, minutes));
  }

  function dayLabel(iso, today) {
    const days = Math.round((dateFrom(iso) - dateFrom(today)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    return new Intl.DateTimeFormat(undefined, {weekday: 'long'}).format(dateFrom(iso));
  }

  async function requestJSON(url, options = {}) {
    const response = await fetch(url, options);
    let data = {};
    try { data = await response.json(); } catch (_) { /* handled below */ }
    if (!response.ok) {
      throw new Error(data.message || 'The calendar could not save that change.');
    }
    return data;
  }

  function renderCalendar(body, events, notice = '') {
    calendarEvents = (events || []).slice().sort((a, b) => (
      a.date + (a.time || '99:99')
    ).localeCompare(b.date + (b.time || '99:99')));

    body.textContent = '';
    body.classList.add('calendar');

    const now = new Date();
    const today = localISO(now);
    const head = el('div', 'calendar__today');
    head.appendChild(el('div', 'calendar__date', String(now.getDate())));

    const heading = el('div', 'calendar__heading');
    heading.append(
      el('p', 'app-panel__eyebrow', new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
      }).format(now)),
      el('h2', 'app-panel__title', new Intl.DateTimeFormat(undefined, {
        month: 'long',
        year: 'numeric',
      }).format(now)),
    );
    head.appendChild(heading);

    const add = el('button', 'calendar__add', '+ Add');
    add.type = 'button';
    add.setAttribute('aria-label', 'Add calendar event');
    add.addEventListener('click', () => renderForm(body));
    head.appendChild(add);
    body.appendChild(head);

    if (notice) {
      const message = el('div', 'calendar__notice', notice);
      message.setAttribute('role', 'status');
      body.appendChild(message);
    }

    const sectionHead = el('div', 'calendar__section-head');
    sectionHead.append(
      el('h3', null, 'Events'),
      el('span', 'calendar__count', `${calendarEvents.length} ${calendarEvents.length === 1 ? 'event' : 'events'}`),
    );
    body.appendChild(sectionHead);

    if (!calendarEvents.length) {
      body.appendChild(el('div', 'calendar__empty', 'No events yet. Add one when you are ready.'));
    } else {
      const agenda = el('div', 'calendar__agenda');
      calendarEvents.forEach((event) => {
        const date = dateFrom(event.date);
        const item = el('button', 'calendar__event');
        item.type = 'button';
        item.setAttribute('aria-label', `Edit ${event.title}`);
        if (event.date < today) item.classList.add('is-past');

        const dateBlock = el('span', 'calendar__event-date');
        dateBlock.append(
          el('span', 'calendar__event-month', new Intl.DateTimeFormat(undefined, {
            month: 'short',
          }).format(date)),
          el('span', 'calendar__event-day', String(date.getDate())),
        );

        const copy = el('span', 'calendar__event-copy');
        copy.append(
          el('span', 'calendar__event-title', event.title),
          el('span', 'calendar__event-when', `${dayLabel(event.date, today)} · ${formatTime(event.time)}`),
        );

        item.append(dateBlock, copy, el('span', 'calendar__event-edit', 'Edit'));
        item.addEventListener('click', () => renderForm(body, event));
        agenda.appendChild(item);
      });
      body.appendChild(agenda);
    }

    body.appendChild(el(
      'p',
      'calendar__hint',
      'Tap an event to edit it, or use Ask to manage your calendar by voice.',
    ));
  }

  function field(labelText, input) {
    const label = el('label', 'calendar-form__field');
    label.append(el('span', null, labelText), input);
    return label;
  }

  function renderForm(body, event = null) {
    body.textContent = '';
    body.classList.add('calendar');

    const form = el('form', 'calendar-form');
    const head = el('div', 'calendar-form__head');
    const back = el('button', 'calendar-form__back', '←');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back to calendar');
    back.addEventListener('click', () => renderCalendar(body, calendarEvents));

    const heading = el('div', 'calendar-form__heading');
    heading.append(
      el('p', 'app-panel__eyebrow', event ? 'Calendar event' : 'New calendar event'),
      el('h2', 'app-panel__title', event ? 'Edit event' : 'Add event'),
    );
    head.append(back, heading);
    form.appendChild(head);

    const title = document.createElement('input');
    title.type = 'text';
    title.name = 'title';
    title.required = true;
    title.maxLength = 160;
    title.autocomplete = 'off';
    title.placeholder = 'What is happening?';
    title.value = event ? event.title : '';
    form.appendChild(field('Title', title));

    const when = el('div', 'calendar-form__when');
    const date = document.createElement('input');
    date.type = 'date';
    date.name = 'date';
    date.required = true;
    date.value = event ? event.date : localISO();

    const time = document.createElement('input');
    time.type = 'time';
    time.name = 'time';
    time.value = event && event.time ? event.time : '';
    when.append(field('Date', date), field('Time (optional)', time));
    form.appendChild(when);

    const status = el('div', 'calendar-form__status');
    status.setAttribute('role', 'alert');
    status.setAttribute('aria-live', 'polite');
    form.appendChild(status);

    const actions = el('div', 'calendar-form__actions');
    let deleteButton = null;
    let deleteArmed = false;
    let deleteTimer = null;

    if (event) {
      deleteButton = el('button', 'calendar-form__button calendar-form__delete', 'Delete');
      deleteButton.type = 'button';
      deleteButton.addEventListener('click', async () => {
        if (!deleteArmed) {
          deleteArmed = true;
          deleteButton.textContent = 'Delete event?';
          deleteButton.classList.add('is-confirming');
          clearTimeout(deleteTimer);
          deleteTimer = setTimeout(() => {
            deleteArmed = false;
            deleteButton.textContent = 'Delete';
            deleteButton.classList.remove('is-confirming');
          }, 4000);
          return;
        }

        clearTimeout(deleteTimer);
        setBusy(true);
        try {
          const data = await requestJSON(`/api/events/${encodeURIComponent(event.id)}`, {
            method: 'DELETE',
          });
          renderCalendar(body, data.events, 'Event deleted.');
        } catch (error) {
          status.textContent = error.message;
          setBusy(false);
        }
      });
      actions.appendChild(deleteButton);
    }

    const cancel = el('button', 'calendar-form__button', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => renderCalendar(body, calendarEvents));
    const save = el('button', 'calendar-form__button calendar-form__save', event ? 'Save changes' : 'Add event');
    save.type = 'submit';
    actions.append(cancel, save);
    form.appendChild(actions);
    body.appendChild(form);

    function setBusy(busy) {
      [...form.elements].forEach((control) => { control.disabled = busy; });
      form.classList.toggle('is-busy', busy);
    }

    form.addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();
      if (!form.reportValidity()) return;

      status.textContent = '';
      setBusy(true);
      const payload = {title: title.value, date: date.value, time: time.value};
      const url = event ? `/api/events/${encodeURIComponent(event.id)}` : '/api/events';

      try {
        const data = await requestJSON(url, {
          method: event ? 'PATCH' : 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload),
        });
        renderCalendar(body, data.events, event ? 'Event updated.' : 'Event added.');
      } catch (error) {
        status.textContent = error.message;
        setBusy(false);
      }
    });

    requestAnimationFrame(() => title.focus({preventScroll: true}));
  }

  function open() {
    let body;
    Win.open('Calendar', {
      build: (target) => {
        body = target;
        target.classList.add('calendar');
        target.appendChild(el('div', 'calendar__loading', 'Opening calendar…'));
      },
    });

    requestJSON('/api/events')
      .then((data) => {
        if (body && body.isConnected) renderCalendar(body, data.events || []);
      })
      .catch((error) => {
        console.error('[calendar] could not fetch', error);
        if (!body || !body.isConnected) return;
        body.textContent = '';
        body.appendChild(el('div', 'calendar__error', error.message));
      });
  }

  return {open, close: () => Win.close()};
})();
