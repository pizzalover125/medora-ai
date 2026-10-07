window.News = (() => {
  'use strict';

  const STALE_MS = 10 * 60 * 1000;

  let stories = [];
  let catalogue = [];
  let selected = [];
  let loadedAt = 0;
  let loadError = '';
  let busy = false;

  let body = null;
  let view = 'list';
  let filter = null;
  let story = null;
  let notice = '';
  let noticeTimer;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const ICONS = {
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    link: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }

  function hrButton(text, options = {}) {
    const {variant = 'outline', size, glyph, label, onClick, disabled} = options;
    const classes = ['hr-btn', `hr-btn--${variant}`];
    if (size) classes.push(`hr-btn--${size}`);

    const node = el('button', classes.join(' '), text || undefined);
    node.type = 'button';
    if (glyph) node.prepend(icon(glyph));
    if (label) node.setAttribute('aria-label', label);
    if (disabled) node.disabled = true;
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  async function requestJSON(url, options = {}) {
    const response = await fetch(url, options);
    let data = {};
    try { data = await response.json(); } catch (_) {  }
    if (!response.ok) throw new Error(data.message || 'The news could not be fetched.');
    return data;
  }

  function absorb(data) {
    if (data.stories) stories = data.stories;
    if (data.categories) catalogue = data.categories;
    if (data.selected) selected = data.selected;
    loadedAt = Date.now();
    loadError = '';
  }

  async function load({category = filter, force = false} = {}) {
    busy = true;
    render();

    const query = [];
    if (category) query.push(`category=${encodeURIComponent(category)}`);
    if (force) query.push('refresh=1');

    try {
      absorb(await requestJSON(`/api/news${query.length ? `?${query.join('&')}` : ''}`));
    } catch (error) {
      console.warn('[news] could not load', error);
      if (!stories.length) loadError = error.message;
    } finally {
      busy = false;
      render();
    }
  }

  function setNotice(message) {
    clearTimeout(noticeTimer);
    notice = message;
    noticeTimer = setTimeout(() => { notice = ''; render(); }, 4000);
  }

  async function toggleCategory(key) {
    const next = catalogue
      .filter((entry) => (entry.key === key ? !entry.following : entry.following))
      .map((entry) => entry.key);

    if (!next.length) {
      setNotice('keep at least one kind of news');
      return;
    }

    catalogue = catalogue.map((entry) => ({...entry, following: next.includes(entry.key)}));
    render();

    try {
      absorb(await requestJSON('/api/news/settings', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({categories: next}),
      }));
      filter = null;
      await load({category: null});
      setNotice('saved');
    } catch (error) {
      setNotice(error.message.toLowerCase());
      await load({category: null});
    }
  }

  function head() {
    const bar = el('div', 'news__head');
    bar.append(el('h2', 'news__title', 'news'));

    bar.append(view === 'settings'
      ? hrButton('done', {size: 'sm', onClick: () => { view = 'list'; render(); }})
      : hrButton('settings', {
          size: 'sm',
          glyph: 'settings',
          onClick: () => { view = 'settings'; render(); },
        }));
    return bar;
  }

  function chips() {
    if (view !== 'list') return null;

    const row = el('div', 'news__chips');
    const keys = catalogue.filter((entry) => entry.following).map((entry) => entry.key);
    if (filter && !keys.includes(filter)) keys.unshift(filter);

    const add = (key, label) => {
      const chip = el('button', 'news__chip', label);
      chip.type = 'button';
      chip.classList.toggle('is-active', filter === key);
      chip.setAttribute('aria-pressed', String(filter === key));
      chip.addEventListener('click', () => {
        if (filter === key) return;
        filter = key;
        load({category: key});
      });
      row.append(chip);
    };

    add(null, 'latest');
    keys.forEach((key) => {
      const entry = catalogue.find((item) => item.key === key);
      add(key, (entry ? entry.label : key).toLowerCase());
    });
    return row;
  }

  function storyRow(item, index) {
    const row = el('button', 'news-story');
    row.type = 'button';
    row.style.animationDelay = `${Math.min(index, 6) * 45}ms`;

    const meta = el('div', 'news-story__meta');
    meta.append(el('span', null, `${item.source}${item.ago ? ` · ${item.ago}` : ''}`),
                el('span', 'news-story__tag', item.category_label.toLowerCase()));

    const headline = el('p', 'news-story__title', item.title);
    row.append(meta, headline);
    row.addEventListener('click', () => {
      story = item;
      view = 'story';
      render();
    });
    return row;
  }

  function listView() {
    const panel = el('div', 'news__body');

    if (loadError && !stories.length) {
      panel.append(el('p', 'news__empty', loadError.toLowerCase()));
      return panel;
    }
    if (busy && !stories.length) {
      panel.append(el('p', 'news__empty', 'reading the news…'));
      return panel;
    }
    if (!stories.length) {
      panel.append(el('p', 'news__empty', 'no stories just now. try refreshing.'));
      return panel;
    }

    const list = el('div', 'news__rows');
    stories.forEach((item, index) => list.append(storyRow(item, index)));
    panel.append(list);
    return panel;
  }

  function storyView() {
    const panel = el('div', 'news__body');

    panel.append(hrButton('back', {
      variant: 'ghost', size: 'sm', glyph: 'back',
      onClick: () => { view = 'list'; story = null; render(); },
    }));

    const article = el('article', 'news-full');
    article.append(
      el('p', 'news-full__meta',
         `${story.source}${story.ago ? ` · ${story.ago}` : ''} · ` +
         `${story.category_label.toLowerCase()}`),
      el('h3', 'news-full__title', story.title),
    );

    if (story.summary) article.append(el('p', 'news-full__summary', story.summary));

    if (story.url) {
      const link = el('a', 'news-full__link');
      link.href = story.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.append(icon('link'), `read it at ${hostOf(story.url)}`);
      article.append(link);
    }

    panel.append(article);
    return panel;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return 'the source';
    }
  }

  function settingsView() {
    const panel = el('div', 'news__body');
    panel.append(el('p', 'news__note', 'the news you want to hear about'));

    const list = el('div', 'news__rows');
    catalogue.forEach((entry, index) => {
      const row = el('button', 'news-pick');
      row.type = 'button';
      row.style.animationDelay = `${Math.min(index, 6) * 45}ms`;
      row.classList.toggle('is-on', entry.following);
      row.setAttribute('aria-pressed', String(entry.following));

      const mark = el('span', 'news-pick__mark');
      if (entry.following) mark.append(icon('check'));

      row.append(mark, el('span', 'news-pick__label', entry.label.toLowerCase()));
      row.addEventListener('click', () => toggleCategory(entry.key));
      list.append(row);
    });

    panel.append(list);
    return panel;
  }

  function footText() {
    if (notice) return notice;
    if (view === 'settings') {
      const on = catalogue.filter((entry) => entry.following).length;
      return `${on} of ${catalogue.length} chosen`;
    }
    if (view === 'story') return story.source.toLowerCase();
    if (busy) return 'reading the news…';
    if (!stories.length) return '';

    const where = filter
      ? (catalogue.find((entry) => entry.key === filter) || {}).label
      : selected.map((key) =>
          (catalogue.find((entry) => entry.key === key) || {}).label).join(', ');
    return `${stories.length} stories · ${(where || '').toLowerCase()}`;
  }

  function foot() {
    const bar = el('div', 'news__foot');
    bar.append(el('span', 'news__count', footText()));

    if (view === 'list') {
      bar.append(hrButton('refresh', {
        size: 'sm', glyph: 'refresh', disabled: busy,
        onClick: () => load({force: true}),
      }));
    }
    return bar;
  }

  function render() {
    if (!body || !body.isConnected) return;

    body.textContent = '';
    const parts = [head()];
    const chipRow = chips();
    if (chipRow) parts.push(chipRow);
    parts.push(view === 'settings' ? settingsView()
      : view === 'story' && story ? storyView()
      : listView());
    parts.push(foot());
    body.append(...parts);
  }

  function open(options = {}) {
    if (options.view === 'settings') {
      view = 'settings';
    } else if (options.story) {
      story = options.story;
      view = 'story';
    } else {
      view = 'list';
      story = null;
    }

    if (options.category !== undefined && options.category !== null) {
      filter = options.category;
    }

    Win.open('News', {
      build: (target) => {
        body = target;
        target.classList.add('hr', 'news');
        render();
      },
      onClose: () => {
        body = null;
        notice = '';
      },
    });

    const stale = !loadedAt || (Date.now() - loadedAt) > STALE_MS;
    if (stale || (options.category !== undefined && options.category !== null)) {
      load({category: filter});
    }
  }

  return {
    open,
    close: () => Win.close(),
    refresh: () => load({force: true}),
    get stories() { return stories.slice(); },
  };
})();
