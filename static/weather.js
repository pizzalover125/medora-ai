/* ---------------------------------------------------------------------------
   The forecast, in the same draggable window as the games.

   window.Weather.open(report)   report as sent by /api/ask or /api/weather
   window.Weather.open()         fetches it first

   Today sits at the top, the six days after it below. The speaking is done by
   app.js, which reads today's line only - a whole week read aloud is a lot to
   hold in your head, and the point of the window is that you don't have to.
--------------------------------------------------------------------------- */

window.Weather = (() => {
  'use strict';

  /* Line drawings in currentColor - the page has no colour to spare. */
  const ICONS = {
    sun: '<circle cx="12" cy="12" r="4.6"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4' +
         'M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7' +
         'M6.6 17.4l-1.7 1.7"/>',
    'sun-cloud':
         '<path d="M7.6 8.2a3.4 3.4 0 0 1 6.2-1.6M5.2 4.4l1.2 1.2M4 9.2h1.7' +
         'M10.8 1.6v1.7M15.6 4.4l-1.2 1.2"/>' +
         '<path d="M8.4 20.5a4 4 0 0 1-.4-8 5.3 5.3 0 0 1 10.2 1.3 3.4 3.4 0 0 1-.6 6.7Z"/>',
    cloud: '<path d="M7.6 19.5a4.3 4.3 0 0 1-.4-8.6 5.7 5.7 0 0 1 11 1.4 3.6 3.6 0 0 1-.7 7.2Z"/>',
    drizzle:
         '<path d="M7.6 15.5a4.3 4.3 0 0 1-.4-8.6 5.7 5.7 0 0 1 11 1.4 3.6 3.6 0 0 1-.7 7.2Z"/>' +
         '<path d="M9 18.4v1.8M13 18v2.6M17 18.4v1.8"/>',
    rain: '<path d="M7.6 14.5a4.3 4.3 0 0 1-.4-8.6 5.7 5.7 0 0 1 11 1.4 3.6 3.6 0 0 1-.7 7.2Z"/>' +
         '<path d="M8.6 17.2 7.4 21M12.6 17.2 11.4 21M16.6 17.2 15.4 21"/>',
    storm: '<path d="M7.6 14.5a4.3 4.3 0 0 1-.4-8.6 5.7 5.7 0 0 1 11 1.4 3.6 3.6 0 0 1-.7 7.2Z"/>' +
         '<path d="M13.4 16.4 10 19.2h3l-1.4 3.2"/>',
    snow: '<path d="M7.6 14.5a4.3 4.3 0 0 1-.4-8.6 5.7 5.7 0 0 1 11 1.4 3.6 3.6 0 0 1-.7 7.2Z"/>' +
         '<path d="M8.6 18.4v.02M12 17.6v.02M15.4 18.4v.02M10.3 21v.02M13.7 21v.02"/>',
    fog:  '<path d="M7.6 13.5a4.3 4.3 0 0 1-.4-8.6 5.7 5.7 0 0 1 11 1.4 3.6 3.6 0 0 1-.7 7.2Z"/>' +
         '<path d="M5 17h14M7 20.4h10"/>',
  };

  function icon(name, size) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || ICONS.cloud;
    return svg;
  }

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* ── the window ─────────────────────────────────────────────────────── */

  function build(body, data) {
    const days = data.days || [];
    const today = days[0];
    if (!today) return;

    body.classList.add('wx');

    /* Today, large. */
    const head = el('div', 'wx__now');
    const mark = el('div', 'wx__mark');
    mark.appendChild(icon(data.now.icon, 54));
    head.appendChild(mark);

    const lead = el('div', 'wx__lead');
    const temp = el('div', 'wx__temp');
    temp.append(el('span', null, String(data.now.temp)), el('sup', null, '°'));
    lead.append(temp, el('div', 'wx__cond', data.now.text));
    lead.appendChild(el('div', 'wx__place',
      data.place + (data.region ? ', ' + data.region : '')));
    head.appendChild(lead);

    const range = el('div', 'wx__range');
    range.append(
      el('div', 'wx__hi', today.high + '°'),
      el('div', 'wx__lo', today.low + '°'),
    );
    head.appendChild(range);
    body.appendChild(head);

    /* Today's detail, as three plain readings. */
    const facts = el('div', 'wx__facts');
    [
      ['Rain', today.rain + '%'],
      ['Wind', today.wind + ' mph'],
      ['Humidity', data.now.humidity + '%'],
    ].forEach(([name, value]) => {
      const f = el('div', 'wx__fact');
      f.append(el('div', 'wx__fact-v', value), el('div', 'wx__fact-k', name));
      facts.appendChild(f);
    });
    body.appendChild(facts);

    /* The week. The bar under each row is the day's range against the week's,
       so a cold snap is visible without reading a single number. */
    const highs = days.map(d => d.high);
    const lows = days.map(d => d.low);
    const top = Math.max(...highs);
    const bottom = Math.min(...lows);
    const span = Math.max(1, top - bottom);

    const list = el('div', 'wx__week');
    days.forEach((day, i) => {
      const row = el('div', 'wx__day');
      if (i === 0) row.classList.add('is-today');

      row.appendChild(el('div', 'wx__name', day.label));

      const glyph = el('div', 'wx__glyph');
      glyph.appendChild(icon(day.icon, 22));
      glyph.title = day.text;
      row.appendChild(glyph);

      const wet = el('div', 'wx__wet', day.rain >= 20 ? day.rain + '%' : '');
      if (day.rain >= 50) wet.classList.add('is-likely');
      row.appendChild(wet);

      row.appendChild(el('div', 'wx__lo', day.low + '°'));

      const track = el('div', 'wx__track');
      const bar = el('div', 'wx__bar');
      bar.style.setProperty('--from', ((day.low - bottom) / span * 100) + '%');
      bar.style.setProperty('--to', ((top - day.high) / span * 100) + '%');
      track.appendChild(bar);
      row.appendChild(track);

      row.appendChild(el('div', 'wx__hi', day.high + '°'));

      const label = `${day.weekday}, ${day.text}, high ${day.high}, low ${day.low}`;
      row.setAttribute('aria-label', label);
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  async function open(data) {
    if (!data) {
      try {
        const res = await fetch('/api/weather');
        data = await res.json();
      } catch (err) {
        console.error('[weather] could not fetch', err);
        return null;
      }
    }
    if (!data || !data.days) { console.warn('[weather] nothing to show'); return null; }

    Win.open('Weather', {build: (body) => build(body, data)});
    return data;
  }

  return {open, close: () => Win.close()};
})();
