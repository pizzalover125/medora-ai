/* ---------------------------------------------------------------------------
   Four small games in one draggable window.

   window.Games.open('simon' | 'difference' | 'scramble' | 'multi')

   Each game gets a <div> to fill and returns an optional stop() for anything
   that needs tearing down (Simon's timers).
--------------------------------------------------------------------------- */

window.Games = (() => {
  'use strict';

  let stopCurrent = null;

  const rand = n => Math.floor(Math.random() * n);
  const shuffle = a => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const flash = (el, cls) => Win.flash(el, cls);
  const tone = (f, ms) => Win.tone(f, ms);

  /* ── Simon ────────────────────────────────────────────────────────────── */

  const SIMON = [
    {c: '#64C5EB', f: 329.63},
    {c: '#FEB326', f: 261.63},
    {c: '#e84d8a', f: 220.00},
    {c: '#7f58af', f: 164.81},
  ];

  function simon(body) {
    const note = document.createElement('div');
    note.className = 'win__note';
    note.textContent = 'Watch';        // set now; the first round starts shortly
    const grid = document.createElement('div');
    grid.className = 'simon';
    grid.dataset.locked = '1';
    body.append(note, grid);

    const pads = SIMON.map(({c}) => {
      const b = document.createElement('button');
      b.style.setProperty('--c', c);
      grid.appendChild(b);
      return b;
    });

    let seq = [], step = 0, timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

    const light = (i, ms = 420) => {
      pads[i].classList.add('lit');
      tone(SIMON[i].f, ms);
      later(() => pads[i].classList.remove('lit'), ms);
    };

    function playBack() {
      grid.dataset.locked = '1';
      note.textContent = 'Watch';
      seq.forEach((v, n) => later(() => light(v), 300 + n * 620));
      later(() => {
        grid.dataset.locked = '0';
        step = 0;
        note.textContent = `Your turn · round ${seq.length}`;
      }, 300 + seq.length * 620);
    }

    function nextRound() {
      seq.push(rand(4));
      playBack();
    }

    pads.forEach((pad, i) => pad.addEventListener('click', () => {
      if (grid.dataset.locked === '1') return;
      light(i, 240);

      if (seq[step] !== i) {
        grid.dataset.locked = '1';
        flash(grid, 'shake');
        note.textContent = 'Not quite · watch again';
        clearTimers();
        later(playBack, 900);
        return;
      }

      if (++step === seq.length) {
        grid.dataset.locked = '1';
        note.textContent = 'Good';
        later(nextRound, 800);
      }
    }));

    later(nextRound, 400);
    return clearTimers;
  }

  /* ── Difference ───────────────────────────────────────────────────────── */

  // Pairs that genuinely need a second look.
  const PAIRS = [
    ['\u{1F600}', '\u{1F603}'], ['\u{1F610}', '\u{1F611}'],
    ['\u{1F34E}', '\u{1F34F}'], ['⭐', '\u{1F31F}'],
    ['\u{1F315}', '\u{1F31D}'], ['\u{1F436}', '\u{1F415}'],
    ['\u{1F642}', '\u{1F60A}'], ['\u{1F638}', '\u{1F63A}'],
    ['\u{1F534}', '\u{1F7E0}'], ['\u{1F430}', '\u{1F407}'],
  ];

  function difference(body) {
    const note = document.createElement('div');
    note.className = 'win__note';
    const grid = document.createElement('div');
    grid.className = 'diff';
    body.append(note, grid);

    let round = 0;

    function deal() {
      round++;
      note.textContent = `Find the odd one · round ${round}`;
      grid.textContent = '';

      const [a, b] = PAIRS[rand(PAIRS.length)];
      const odd = rand(100);
      const flip = Math.random() < 0.5;          // which of the pair is the many

      for (let i = 0; i < 100; i++) {
        const cell = document.createElement('button');
        cell.textContent = i === odd ? (flip ? a : b) : (flip ? b : a);
        cell.addEventListener('click', () => {
          if (i === odd) {
            cell.classList.add('found');
            tone(660, 160);
            note.textContent = 'Found it';
            setTimeout(deal, 800);
          } else {
            flash(grid, 'shake');
            tone(150, 140);
          }
        });
        grid.appendChild(cell);
      }
    }

    deal();
  }

  /* ── Scramble ─────────────────────────────────────────────────────────── */

  const WORDS = (
    'table chair water bread music river green happy light house ' +
    'money paper apple smile cloud stone dance field night sugar ' +
    'grass beach clock horse plant sweet north dream train heart'
  ).split(' ');

  function scramble(body) {
    const note = document.createElement('div');
    note.className = 'win__note';
    const letters = document.createElement('div');
    letters.className = 'scramble__letters';
    const input = document.createElement('input');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', 'Your answer');
    body.append(note, letters, input);

    let word = '', solved = 0;

    function deal() {
      word = WORDS[rand(WORDS.length)];
      let mixed;
      do {
        mixed = shuffle(word.split('')).join('');
      } while (mixed === word);            // never hand them the answer

      letters.textContent = '';
      for (const ch of mixed) {
        const s = document.createElement('span');
        s.textContent = ch;
        letters.appendChild(s);
      }
      input.value = '';
      input.className = '';
      note.textContent = `Unscramble · ${solved} solved`;
      input.focus();
    }

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (input.value.trim().toLowerCase() === word) {
        input.className = 'right';
        tone(660, 180);
        solved++;
        setTimeout(deal, 750);
      } else {
        input.className = 'wrong';
        flash(letters, 'shake');
        tone(150, 140);
      }
    });

    input.addEventListener('input', () => {
      if (input.className === 'wrong') input.className = '';
    });

    deal();
    setTimeout(() => input.focus(), 120);
  }

  /* ── Multi ────────────────────────────────────────────────────────────── */

  function multi(body) {
    const note = document.createElement('div');
    note.className = 'win__note';
    const prompt = document.createElement('div');
    prompt.className = 'win__prompt';
    const grid = document.createElement('div');
    grid.className = 'multi';
    body.append(note, prompt, grid);

    let score = 0;

    function deal() {
      const a = 2 + rand(8), b = 2 + rand(8);
      const answer = a * b;
      prompt.textContent = `${a} × ${b}`;
      note.textContent = `${score} correct`;

      // Plausible wrong answers: neighbouring products, never negative.
      const options = new Set([answer]);
      while (options.size < 4) {
        const off = [a, -a, b, -b, 1, -1, 2, -2][rand(8)];
        const alt = answer + off;
        if (alt > 0 && alt !== answer) options.add(alt);
      }

      grid.textContent = '';
      shuffle([...options]).forEach((v) => {
        const btn = document.createElement('button');
        btn.textContent = v;
        btn.addEventListener('click', () => {
          if (grid.dataset.locked === '1') return;
          if (v === answer) {
            grid.dataset.locked = '1';
            btn.className = 'right';
            flash(btn, 'pop');
            tone(660, 180);
            score++;
            setTimeout(() => { grid.dataset.locked = '0'; deal(); }, 700);
          } else {
            btn.className = 'wrong';
            flash(btn, 'shake');
            tone(150, 140);
          }
        });
        grid.appendChild(btn);
      });
    }

    deal();
  }

  /* ── registry ─────────────────────────────────────────────────────────── */

  const GAMES = {
    simon:      {label: 'Simon',      desc: 'Remember the pattern', build: simon},
    difference: {label: 'Difference', desc: 'Find the odd one',     build: difference},
    scramble:   {label: 'Scramble',   desc: 'Untangle the word',    build: scramble},
    multi:      {label: 'Multi',      desc: 'Practice times tables', build: multi},
  };

  function gameIcon(name) {
    const icon = document.createElement('span');
    icon.className = 'game-picker__icon';
    icon.setAttribute('aria-hidden', 'true');

    if (name === 'simon') {
      icon.innerHTML = '<span class="game-picker__dots"><i></i><i></i><i></i><i></i></span>';
    } else if (name === 'difference') {
      icon.textContent = '••·';
    } else if (name === 'scramble') {
      icon.textContent = 'ABC';
    } else {
      icon.textContent = '×';
    }
    return icon;
  }

  function menu(body) {
    body.classList.add('game-picker');
    body.append(
      Object.assign(document.createElement('p'), {
        className: 'app-panel__eyebrow',
        textContent: 'Take a break',
      }),
      Object.assign(document.createElement('h2'), {
        className: 'app-panel__title',
        textContent: 'Games',
      }),
    );

    const grid = document.createElement('div');
    grid.className = 'game-picker__grid';
    Object.entries(GAMES).forEach(([key, game]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'game-picker__game';
      button.setAttribute('aria-label', `${game.label}: ${game.desc}`);

      const copy = document.createElement('span');
      copy.append(
        Object.assign(document.createElement('span'), {
          className: 'game-picker__name',
          textContent: game.label,
        }),
        Object.assign(document.createElement('span'), {
          className: 'game-picker__desc',
          textContent: game.desc,
        }),
      );
      button.append(gameIcon(key), copy);
      button.addEventListener('click', () => open(key));
      grid.appendChild(button);
    });
    body.appendChild(grid);
  }

  function openMenu() {
    stopCurrent = Win.open('Games', {build: menu});
  }

  function open(name) {
    const game = GAMES[name];
    if (!game) { console.warn('[games] unknown game', name); return; }
    stopCurrent = Win.open(game.label, {
      onClose: () => { if (stopCurrent) { stopCurrent(); stopCurrent = null; } },
      build: (body) => game.build(body) || null,
    });
  }

  return {open, openMenu, close: () => Win.close()};
})();
