/* ---------------------------------------------------------------------------
   Heart rate, from a fingertip held over the camera.

   window.Heart.open()   opens the window and turns the camera on

   The camera (and its light, where the phone lets us switch it on) watches
   the fingertip for twenty seconds; pulse.js turns the colour of each frame
   into a beat. The answer is spoken through the assistant, so it reaches the
   captions too, and kept on the server so the last few can be shown.

   This is a wellness reading, not a medical one, and the window says so.
--------------------------------------------------------------------------- */

window.Heart = (() => {
  'use strict';

  const MEASURE_MS = 20000;
  const SETTLE_MS = 1500;     // the first moments after the finger lands are mostly movement
  const LOST_MS = 800;        // this long without a finger and the reading starts over
  const LIVE_FROM_MS = 6000;  // a live number before this is mostly guesswork
  const MIN_QUALITY = 0.3;
  const HALVES_AGREE = 0.12;  // the two halves of a good reading are within 12%
  const SAMPLE_W = 48, SAMPLE_H = 36;
  const WAVE_SECONDS = 6;

  let stream = null;
  let video = null;
  let loop = null;
  let ui = null;
  let hasLight = true;

  // One measurement's worth of state.
  let samples = [];
  let fingerSince = 0;
  let lostSince = 0;
  let lastLive = 0;
  let finished = false;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* ── camera ─────────────────────────────────────────────────────────── */

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('no camera');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: {ideal: 'environment'},   // the one with the light, on a phone
        width: {ideal: 320},
        height: {ideal: 240},
        frameRate: {ideal: 30},
      },
    });
    const track = stream.getVideoTracks()[0];
    let torch = false;
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) {
        await track.applyConstraints({advanced: [{torch: true}]});
        torch = true;
      }
    } catch (_) { /* no light; a bright room still works */ }

    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    await video.play();
    return torch;
  }

  function stopCamera() {
    if (loop) loop.stop();
    loop = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
    video = null;
  }

  /* Every new frame, as it arrives where the browser can say so. */
  function eachFrame(fn) {
    let stopped = false;
    const useVideoFrames = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    const tick = () => {
      if (stopped || !video) return;
      fn(performance.now());
      if (useVideoFrames) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    if (useVideoFrames) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
    return {stop: () => { stopped = true; }};
  }

  /* ── measuring ──────────────────────────────────────────────────────── */

  function reset() {
    samples = [];
    fingerSince = 0;
    lostSince = 0;
    lastLive = 0;
    finished = false;
  }

  function measure() {
    reset();
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    show('waiting');

    loop = eachFrame((now) => {
      if (finished || !video || video.readyState < 2) return;
      ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
      const frame = Pulse.sample(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H));

      if (!frame.finger) {
        if (!fingerSince) return;
        if (!lostSince) lostSince = now;
        if (now - lostSince > LOST_MS) {
          const hadStarted = samples.length > 0;
          reset();
          show('waiting', hadStarted ? 'Keep your fingertip on the camera.' : null);
        }
        return;
      }
      lostSince = 0;
      if (!fingerSince) { fingerSince = now; show('settling'); }
      if (now - fingerSince < SETTLE_MS) return;

      if (!samples.length) show('measuring');
      samples.push({t: now, v: frame.value});
      const elapsed = now - samples[0].t;
      progress(elapsed / MEASURE_MS);
      drawWave();

      if (elapsed >= LIVE_FROM_MS && now - lastLive > 1000) {
        lastLive = now;
        const recent = samples.filter((s) => s.t >= now - 8000);
        const live = Pulse.estimate(recent);
        if (live.bpm && live.quality >= MIN_QUALITY) setNumber(Math.round(live.bpm), true);
      }

      if (elapsed >= MEASURE_MS) finish();
    });
  }

  /* The whole twenty seconds, checked against each half of itself. A rate
     read off one half that disagrees with the other is a moving finger or a
     beat counted twice - better to ask again than to say the wrong number. */
  function finish() {
    finished = true;
    const all = Pulse.estimate(samples);
    const mid = samples[0].t + (samples[samples.length - 1].t - samples[0].t) / 2;
    const first = Pulse.estimate(samples.filter((s) => s.t < mid));
    const second = Pulse.estimate(samples.filter((s) => s.t >= mid));
    const agree = first.bpm && second.bpm &&
      Math.abs(first.bpm - second.bpm) / all.bpm <= HALVES_AGREE;

    console.log('[heart] %o', {
      bpm: all.bpm && all.bpm.toFixed(1), quality: all.quality.toFixed(2),
      halves: [first.bpm, second.bpm].map((b) => b && b.toFixed(1)), frames: samples.length,
    });

    if (!all.bpm || all.quality < MIN_QUALITY || !agree) {
      show('unclear');
      say("I couldn't get a steady reading. Rest your fingertip gently over the camera, keep still, and try again.");
      return;
    }

    const bpm = Math.round(all.bpm);
    setNumber(bpm, false);
    show('done', meaning(bpm).text);
    say(`Your heart rate is about ${bpm} beats per minute. ${meaning(bpm).spoken}`);
    save(bpm, all.quality);
  }

  /* Plain words for the number. The usual resting range is 60 to 100; a
     little either side is common (fit people, some heart medicines), so only
     well outside it is a reason to mention the doctor. */
  function meaning(bpm) {
    if (bpm < 50) {
      return {
        text: 'Lower than the usual resting range of 60 to 100.',
        spoken: 'That is lower than usual. If you feel dizzy, faint or unwell, please call your doctor.',
      };
    }
    if (bpm > 110) {
      return {
        text: 'Higher than the usual resting range of 60 to 100.',
        spoken: 'That is higher than usual for resting. Sit quietly for a few minutes and check again. ' +
                'If it stays high or you feel unwell, please call your doctor.',
      };
    }
    if (bpm < 60 || bpm > 100) {
      return {
        text: 'Just outside the usual resting range of 60 to 100, which is normal for many people.',
        spoken: 'That is just outside the usual range, which is normal for many people.',
      };
    }
    return {text: 'Within the usual resting range of 60 to 100.', spoken: 'That is in the usual resting range.'};
  }

  function say(text) {
    if (window.Reminders) window.Reminders.say(text);
  }

  /* ── saved readings ─────────────────────────────────────────────────── */

  async function save(bpm, quality) {
    try {
      const res = await fetch('/api/heart', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({bpm, quality: Number(quality.toFixed(2))}),
      });
      if (res.ok) renderHistory((await res.json()).readings);
    } catch (err) {
      console.warn('[heart] could not save the reading', err);
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/heart', {cache: 'no-store'});
      if (res.ok) renderHistory((await res.json()).readings);
    } catch (_) { /* the history is a nicety */ }
  }

  function when(iso) {
    const d = new Date(iso);
    const today = new Date();
    const time = d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
    if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
    return `${d.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'})}, ${time}`;
  }

  function renderHistory(readings) {
    if (!ui) return;
    ui.history.replaceChildren();
    const recent = (readings || []).slice(-4).reverse();
    ui.historyWrap.hidden = !recent.length;
    recent.forEach((r) => {
      const row = el('li', 'heart__past');
      row.append(el('span', 'heart__past-when', when(r.at)), el('span', 'heart__past-bpm', `${r.bpm} bpm`));
      ui.history.appendChild(row);
    });
    Win.refit();
  }

  /* ── the window ─────────────────────────────────────────────────────── */

  const STATUS = {
    starting: 'Turning the camera on…',
    waiting: 'Gently cover the camera with your fingertip.',
    settling: 'Good. Hold still…',
    measuring: 'Measuring. Keep still and breathe normally.',
    unclear: "I couldn't get a steady reading. Rest your fingertip gently and keep still.",
    blocked: 'The camera is not available. Allow camera access, then press Try again.',
  };

  function show(state, note) {
    if (!ui) return;
    ui.body.dataset.state = state;
    const tip = state === 'waiting' && !hasLight ? ' A bright room helps.' : '';
    ui.status.textContent = note || (STATUS[state] || '') + tip;
    ui.again.hidden = !['done', 'unclear', 'blocked'].includes(state);
    if (state === 'waiting' || state === 'starting' || state === 'blocked') {
      setNumber(null);
      progress(0);
      clearWave();
    }
    if (state === 'unclear') setNumber(null);
    Win.refit();
  }

  function setNumber(bpm, live) {
    if (!ui) return;
    ui.number.textContent = bpm ? String(bpm) : '––';
    ui.reading.dataset.live = !!live;
  }

  function progress(fraction) {
    if (ui) ui.bar.style.setProperty('--done', Math.max(0, Math.min(1, fraction)).toFixed(3));
  }

  function clearWave() {
    if (!ui) return;
    const c = ui.wave;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  /* The last few seconds of the pulse, cleaned, as a moving line. */
  function drawWave() {
    if (!ui || samples.length < Pulse.RATE * 2) return;
    const now = samples[samples.length - 1].t;
    const recent = samples.filter((s) => s.t >= now - WAVE_SECONDS * 1000 - 1500);
    const wave = Pulse.estimate(recent).wave;
    if (wave.length < 2) return;
    const shown = wave.slice(-WAVE_SECONDS * Pulse.RATE);

    const c = ui.wave;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    let lo = Infinity, hi = -Infinity;
    shown.forEach((v) => { if (v < lo) lo = v; if (v > hi) hi = v; });
    const span = hi - lo || 1;
    ctx.beginPath();
    shown.forEach((v, i) => {
      const x = (i / (WAVE_SECONDS * Pulse.RATE - 1)) * w;
      const y = h - 6 - ((v - lo) / span) * (h - 12);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = getComputedStyle(ui.body).getPropertyValue('--heart-ink').trim() || '#b4452f';
    ctx.lineWidth = 2.25;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function build(body) {
    body.classList.add('heart');

    const head = el('div', 'heart__head');
    head.append(el('div', 'heart__title', 'Heart rate'));

    const reading = el('div', 'heart__reading');
    const number = el('span', 'heart__number', '––');
    reading.append(number, el('span', 'heart__unit', 'beats per minute'));

    const wave = el('canvas', 'heart__wave');
    wave.setAttribute('aria-hidden', 'true');

    const track = el('div', 'heart__track');
    const bar = el('div', 'heart__bar');
    track.appendChild(bar);

    const status = el('p', 'heart__status');
    status.setAttribute('role', 'status');

    const again = el('button', 'heart__again', 'Try again');
    again.type = 'button';
    again.hidden = true;
    again.addEventListener('click', begin);

    const historyWrap = el('div', 'heart__history');
    historyWrap.hidden = true;
    const history = el('ul', 'heart__pasts');
    historyWrap.append(el('div', 'heart__history-title', 'Recent'), history);

    const note = el('p', 'heart__note',
      'For general wellness only. This is not a medical device - ask your doctor about anything that worries you.');

    body.append(head, reading, wave, track, status, again, historyWrap, note);
    ui = {body, reading, number, wave, bar, status, again, history, historyWrap};
  }

  async function begin() {
    stopCamera();
    show('starting');
    try {
      hasLight = await startCamera();
      if (!ui) { stopCamera(); return; }   // closed while the camera was starting
      measure();
    } catch (err) {
      console.warn('[heart] camera unavailable', err);
      show('blocked');
    }
  }

  function open() {
    Win.open('Heart', {
      build,
      onClose: () => { stopCamera(); ui = null; },
    });
    loadHistory();
    begin();
  }

  return {open, close: () => Win.close()};
})();
