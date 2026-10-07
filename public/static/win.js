window.Win = (() => {
  'use strict';

  let win = null;
  let onClose = null;
  let currentLabel = null;

  function announce(label) {
    window.dispatchEvent(new CustomEvent('winchange', {detail: {label}}));
  }

  function flash(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  let ac = null;
  function tone(freq, ms = 300, volume = 0.16) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ac.currentTime);
      gain.gain.linearRampToValueAtTime(volume, ac.currentTime + 0.02);
      gain.gain.setValueAtTime(volume, ac.currentTime + ms / 1000 - 0.04);
      gain.gain.linearRampToValueAtTime(0, ac.currentTime + ms / 1000);
      osc.connect(gain).connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + ms / 1000);
    } catch (e) {  }
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function close(instant) {
    const cb = onClose;
    onClose = null;
    if (cb) cb();
    document.removeEventListener('keydown', onKey);

    const dying = win;
    win = null;
    currentLabel = null;
    if (dying) announce(null);

    if (instant) {
      document.querySelectorAll('.win').forEach((w) => w.remove());
      return;
    }
    if (!dying) return;
    dying.style.setProperty('--o', '0');
    dying.style.setProperty('--s', '.94');
    setTimeout(() => dying.remove(), 240);
  }

  function intersectionArea(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
  }

  function randomSpot(el) {
    const margin = window.innerWidth <= 560 ? 8 : 16;
    const origin = el.getBoundingClientRect();
    const width = origin.width;
    const height = origin.height;
    const minLeft = margin;
    const maxLeft = Math.max(minLeft, window.innerWidth - margin - width);
    const minTop = margin;
    const maxTop = Math.max(minTop, window.innerHeight - margin - height);
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const narrow = window.innerWidth <= 560;

    const specs = [
      {node: document.getElementById('orb'), gap: narrow ? 10 : 18, weight: 1},
      {node: document.querySelector('.app-dock'), gap: narrow ? 8 : 12, weight: 1000},
      ...[...document.querySelectorAll('.win')]
        .filter((node) => node !== el)
        .map((node) => ({node, gap: 12, weight: 100})),
    ];

    const blockers = specs.flatMap(({node, gap, weight}) => {
      if (!node || getComputedStyle(node).display === 'none') return [];
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) return [];
      return [{
        left: r.left - gap,
        right: r.right + gap,
        top: r.top - gap,
        bottom: r.bottom + gap,
        weight,
      }];
    });

    const candidates = [];
    const add = (left, top) => {
      left = clamp(left, minLeft, maxLeft);
      top = clamp(top, minTop, maxTop);
      candidates.push({
        left,
        top,
        right: left + width,
        bottom: top + height,
      });
    };

    for (let i = 0; i < 240; i++) {
      add(
        minLeft + Math.random() * (maxLeft - minLeft),
        minTop + Math.random() * (maxTop - minTop),
      );
    }

    const xs = [minLeft, maxLeft];
    const ys = [minTop, maxTop];
    blockers.forEach((blocker) => {
      xs.push(blocker.left - width, blocker.right);
      ys.push(blocker.top - height, blocker.bottom);
    });
    xs.forEach((left) => ys.forEach((top) => add(left, top)));

    const scored = candidates.map((candidate) => ({
      candidate,
      score: blockers.reduce(
        (total, blocker) => total + intersectionArea(candidate, blocker) * blocker.weight,
        0,
      ),
    }));
    const clear = scored.filter(({score}) => score === 0);
    let choices = clear;

    if (!choices.length) {
      const best = Math.min(...scored.map(({score}) => score));
      choices = scored.filter(({score}) => score === best);
    }

    const {candidate} = choices[Math.floor(Math.random() * choices.length)];
    return [
      Math.round(candidate.left - origin.left),
      Math.round(candidate.top - origin.top),
    ];
  }

  function open(label, opts = {}) {
    close(true);
    onClose = opts.onClose || null;

    const el = document.createElement('div');
    el.className = 'win is-placing';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', label);
    el.innerHTML =
      '<div class="win__bar"><button class="win__close" aria-label="Close">×</button></div>' +
      '<div class="win__body"></div>';

    el.style.setProperty('--o', '0');
    el.style.setProperty('--s', '1');
    document.body.appendChild(el);

    const body = el.querySelector('.win__body');
    const result = opts.build ? opts.build(body) : undefined;

    const [x, y] = randomSpot(el);
    el.style.setProperty('--x', x + 'px');
    el.style.setProperty('--y', y + 'px');
    el.style.setProperty('--s', '.94');
    void el.offsetWidth;
    requestAnimationFrame(() => {
      el.classList.remove('is-placing');
      requestAnimationFrame(() => {
        el.style.setProperty('--o', '1');
        el.style.setProperty('--s', '1');
      });
    });

    el.querySelector('.win__close').addEventListener('click', () => close());
    drag(el, el.querySelector('.win__bar'), x, y);
    document.addEventListener('keydown', onKey);

    win = el;
    currentLabel = label;
    announce(label);
    return opts.build ? result : body;
  }

  function drag(el, handle, initX = 0, initY = 0) {
    let x = initX, y = initY, startX = 0, startY = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.win__close')) return;
      e.preventDefault();
      el.classList.add('is-dragging');
      startX = e.clientX - x;
      startY = e.clientY - y;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    });

    handle.addEventListener('pointermove', (e) => {
      if (!el.classList.contains('is-dragging')) return;
      x = e.clientX - startX;
      y = e.clientY - startY;
      const r = el.getBoundingClientRect();
      const maxX = window.innerWidth / 2 + r.width / 2 - 40;
      const maxY = window.innerHeight / 2 + r.height / 2 - 30;
      x = Math.max(-maxX, Math.min(maxX, x));
      y = Math.max(-maxY, Math.min(maxY, y));
      el.style.setProperty('--x', x + 'px');
      el.style.setProperty('--y', y + 'px');
    });

    const end = (e) => {
      el.classList.remove('is-dragging');
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  return {
    open,
    close,
    flash,
    tone,
    get isOpen() { return !!win; },
    get label() { return currentLabel; },
  };
})();
