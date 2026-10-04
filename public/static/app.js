/* ---------------------------------------------------------------------------
   One button. Press to speak, press again to stop, listen to the answer.

   States: idle -> listening -> thinking -> speaking -> idle
   A press in any state is always meaningful: it starts, it stops, or it
   interrupts. The button is never dead.
--------------------------------------------------------------------------- */

(() => {
  'use strict';

  const orb  = document.getElementById('orb');
  const body = document.body;
  const root = document.documentElement;

  const MIN_CLIP_MS = 350;   // below this it was a stray double-tap, not speech
  const MAX_CLIP_MS = 60000; // safety net if a press-to-stop never comes
  const REMINDER_INTERVAL_MS = 60000;
  const REMINDER_LOOKBACK_MS = 5 * 60000;
  const REMINDER_HISTORY_MS = 7 * 24 * 60 * 60000;
  const REMINDER_STORE_KEY = 'ask.calendar.reminders.v1';

  let state      = 'idle';
  let stream     = null;
  let recorder   = null;
  let chunks     = [];
  let startedAt  = 0;
  let stopTimer  = null;
  let inflight   = null;     // AbortController for the in-flight request

  let audioCtx   = null;
  let analyser   = null;
  let timeData   = null;

  let amp        = 0;        // smoothed 0..1, drives every reactive transform
  let sessionPeak = 0;       // loudest the mic got during this recording
  let speechAmp  = 0;        // synthetic envelope while the answer is spoken
  let primed     = false;
  let reminderTimer = null;
  let reminderCheckInFlight = false;
  let pendingReminders = [];
  const deliveredReminders = loadDeliveredReminders();

  /* ── state ────────────────────────────────────────────────────────────── */

  function setState(next) {
    state = next;
    body.dataset.state = next;
    if (next === 'idle' || next === 'blocked') {
      queueMicrotask(flushReminders);
    }
  }

  /* ── the animation loop ───────────────────────────────────────────────── */
  /* One rAF loop owns --amp for the whole page. Attack is fast so the orb
     answers your voice immediately; release is slow so it never flickers. */

  function frame() {
    let target = 0;

    if (state === 'listening' && analyser) {
      analyser.getByteTimeDomainData(timeData);
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) {
        const v = (timeData[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / timeData.length);
      // Expand the quiet end of the range: a soft, older voice should still
      // visibly move the orb.
      target = Math.min(1, Math.pow(rms * 5.2, 0.72));
      if (rms > sessionPeak) sessionPeak = rms;
    } else if (state === 'speaking') {
      speechAmp *= 0.90;
      target = speechAmp;
    }

    const k = target > amp ? 0.35 : 0.08;
    amp += (target - amp) * k;
    if (amp < 0.0008) amp = 0;

    root.style.setProperty('--amp', amp.toFixed(4));
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ── microphone ───────────────────────────────────────────────────────── */

  async function getStream() {
    if (stream) return stream;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    timeData = new Uint8Array(analyser.fftSize);
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    return stream;
  }

  function pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  /* ── record ───────────────────────────────────────────────────────────── */

  async function startListening() {
    try {
      await getStream();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
    } catch (err) {
      console.error('microphone unavailable', err);
      setState('blocked');
      return;
    }

    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = handleClip;
    recorder.start();
    startedAt = performance.now();
    sessionPeak = 0;
    const track = stream.getAudioTracks()[0];
    console.log('[ask] recording as %s from "%s" (muted=%s)',
                recorder.mimeType, track.label, track.muted);

    stopTimer = setTimeout(stopListening, MAX_CLIP_MS);
    setState('listening');
  }

  function stopListening() {
    clearTimeout(stopTimer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function handleClip() {
    const duration = performance.now() - startedAt;
    const chunkCount = chunks.length;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    recorder = null;
    chunks = [];

    // A stray double-tap isn't a question. Go quiet rather than scold.
    if (duration < MIN_CLIP_MS || blob.size < 1024) {
      setState('idle');
      return;
    }

    setState('thinking');
    console.log('[ask] recorded %dms, %d bytes, type=%s, chunks=%d, micPeak=%s',
                Math.round(duration), blob.size, blob.type, chunkCount,
                sessionPeak.toFixed(4));
    if (sessionPeak < 0.004) {
      console.warn('[ask] the microphone never registered any sound — ' +
                   'check the input device in System Settings → Sound');
    }

    const form = new FormData();
    inflight = new AbortController();
    // The model on the other end is given 16 kHz mono WAV - small, and a
    // format every audio model reads. If this browser cannot decode its own
    // recording, the original goes instead and the server names its format.
    const wav = await toWav(blob);
    if (wav) {
      form.append('audio', wav.blob, 'clip.wav');
      form.append('peak', wav.peak.toFixed(5));
    } else {
      form.append('audio', blob, 'clip.webm');
    }

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        body: form,
        signal: inflight.signal,
      });
      const data = await res.json();
      inflight = null;
      console.log('[ask] %d %o', res.status, data);

      if (data.action === 'game' && window.Games) {
        window.Games.open(data.game);
      }

      // The window shows the whole week; data.speak is today's line only.
      if (data.action === 'weather' && window.Weather) {
        window.Weather.open(data.weather);
      }

      // The spoken line is the schedule; the window is the whole of it, and
      // it opens on the doses so the two say the same thing. (The dock icon
      // opens it wherever it was left instead.)
      if (data.action === 'medora' && window.Medora) {
        window.Medora.open('doses');
      }

      // The headlines are spoken; the window holds the rest of them, and
      // lands on whatever was just read - a section, or one story.
      if (data.action === 'news' && window.News) {
        window.News.open({category: data.category || null, story: data.story || null});
      }

      if (data.action === 'news-settings' && window.News) {
        window.News.open({view: 'settings'});
      }

      // "Test Medora" runs the dispenser's hardware, which only this end can
      // reach. With no link there is nothing to test, so say so instead.
      if (data.action === 'medora-test' && window.Medora) {
        if (!window.Medora.isConnected) {
          window.Medora.open('device');
          fail('Medora is not connected. Open Medora and press connect.');
          return;
        }
        window.Medora.selfTest();
      }

      if (data.speak) {
        if (res.ok) speak(data.speak);
        else fail(data.speak);
      } else {
        fail("Something went wrong. Please try again.");
      }
    } catch (err) {
      inflight = null;
      if (err.name === 'AbortError') return;   // the user cancelled; stay quiet
      console.error('request failed', err);
      fail("I can't reach my connection right now. Please try again.");
    }
  }

  /* ── 16 kHz WAV ───────────────────────────────────────────────────────── */

  async function toWav(blob) {
    try {
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const rate = 16000;
      const offline = new Offline(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const pcm = (await offline.startRendering()).getChannelData(0);

      let peak = 0;
      const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
      const text = (offset, value) => {
        for (let i = 0; i < value.length; i++) out.setUint8(offset + i, value.charCodeAt(i));
      };
      text(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); text(8, 'WAVE');
      text(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
      out.setUint16(22, 1, true); out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true);
      out.setUint16(32, 2, true); out.setUint16(34, 16, true);
      text(36, 'data'); out.setUint32(40, pcm.length * 2, true);
      for (let i = 0; i < pcm.length; i++) {
        const v = Math.max(-1, Math.min(1, pcm[i]));
        if (Math.abs(v) > peak) peak = Math.abs(v);
        out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      }
      return {blob: new Blob([out], {type: 'audio/wav'}), peak};
    } catch (error) {
      console.warn('[ask] could not convert the clip to WAV', error);
      return null;
    }
  }

  /* ── speak ────────────────────────────────────────────────────────────── */

  let voice = null;

  function pickVoice() {
    const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
    if (!voices.length) return null;
    // Prefer the platform's high-quality voices; they are far kinder on the
    // ear than the default robotic fallbacks.
    const preferred = [
      /premium|enhanced|neural|natural/i,
      /samantha|ava|allison|serena|karen|daniel|siri/i,
      /google (us|uk) english/i,
    ];
    for (const re of preferred) {
      const hit = voices.find((v) => re.test(v.name));
      if (hit) return hit;
    }
    return voices.find((v) => v.default) || voices[0];
  }

  if ('speechSynthesis' in window) {
    voice = pickVoice();
    speechSynthesis.onvoiceschanged = () => { voice = pickVoice(); };
  }

  /* Chrome silently stops utterances longer than ~15s, so the answer is split
     into sentences and queued. It also gives the orb a pulse per word. */
  function sentences(text) {
    const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const out = [];
    let buf = '';
    for (const p of parts) {
      if ((buf + p).length > 180 && buf) { out.push(buf.trim()); buf = p; }
      else buf += p;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) { setState('idle'); return; }

    speechSynthesis.cancel();
    setState('speaking');
    speechAmp = 0.5;

    const queue = sentences(text);
    let done = 0;

    queue.forEach((part) => {
      const u = new SpeechSynthesisUtterance(part);
      if (voice) u.voice = voice;
      u.lang   = (voice && voice.lang) || 'en-US';
      u.rate   = 0.94;   // unhurried, for an older listener
      u.pitch  = 1.0;
      u.volume = 1.0;

      // Each word kicks the envelope, so the orb pulses in time with speech.
      u.onboundary = () => { speechAmp = Math.min(1, speechAmp + 0.42); };
      u.onend = u.onerror = () => {
        if (++done >= queue.length && state === 'speaking') {
          speechAmp = 0;
          setState('idle');
        }
      };
      speechSynthesis.speak(u);
    });
  }

  function stopSpeaking() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    speechAmp = 0;
  }

  /* ── calendar reminders ─────────────────────────────────────────────── */

  function loadDeliveredReminders() {
    const reminders = new Map();
    try {
      const stored = JSON.parse(localStorage.getItem(REMINDER_STORE_KEY) || '{}');
      const cutoff = Date.now() - REMINDER_HISTORY_MS;
      Object.entries(stored).forEach(([key, announcedAt]) => {
        if (Number(announcedAt) >= cutoff) reminders.set(key, Number(announcedAt));
      });
    } catch (_) { /* storage is optional; the in-memory map still de-duplicates */ }
    return reminders;
  }

  function saveDeliveredReminders() {
    try {
      localStorage.setItem(
        REMINDER_STORE_KEY,
        JSON.stringify(Object.fromEntries(deliveredReminders)),
      );
    } catch (_) { /* private browsing can disable storage */ }
  }

  function reminderKey(event) {
    return `${event.id || event.title}|${event.date}|${event.time}`;
  }

  function reminderMessage(events) {
    const titles = events.map((event) => event.title.replace(/[.!?]+$/, ''));
    const list = typeof Intl.ListFormat === 'function'
      ? new Intl.ListFormat('en', {style: 'long', type: 'conjunction'}).format(titles)
      : titles.join(', ');
    return `Reminder. It's time for ${list}.`;
  }

  function flushReminders() {
    if (!pendingReminders.length || !['idle', 'blocked'].includes(state)) return;
    const ready = pendingReminders;
    pendingReminders = [];
    // Lines from Messages are said as they are; due events get "Reminder."
    const lines = ready.filter((item) => item.say).map((item) => item.say);
    const due = ready.filter((item) => !item.say);
    if (due.length) lines.push(reminderMessage(due));
    speak(lines.join(' '));
  }

  /* Timed calendar events that have just come due. */
  async function dueEvents() {
    const response = await fetch('/api/events', {cache: 'no-store'});
    if (!response.ok) throw new Error(`calendar returned ${response.status}`);
    const data = await response.json();
    const now = Date.now();
    const earliest = now - REMINDER_LOOKBACK_MS;
    return (data.events || []).filter((event) => {
      if (!event.time || !event.date || !event.title) return false;
      const dueAt = new Date(`${event.date}T${event.time}:00`).getTime();
      return Number.isFinite(dueAt) && dueAt >= earliest && dueAt <= now + 1000;
    });
  }

  /* Doses Medora is waiting on. The server decides what counts as due - the
     same few minutes the dispenser gives an alarm before it gives up. */
  async function dueDoses() {
    const response = await fetch('/api/medicines/due', {cache: 'no-store'});
    if (!response.ok) throw new Error(`medora returned ${response.status}`);
    const data = await response.json();
    return (data.due || []).map((dose) => ({
      id: `dose-${dose.container}-${dose.minute}`,
      date: dose.date,
      time: dose.time,
      title: dose.quantity > 1 ? `${dose.quantity} ${dose.name}` : `your ${dose.name}`,
    }));
  }

  async function checkReminders() {
    if (reminderCheckInFlight) return;
    reminderCheckInFlight = true;

    try {
      // One of the two failing is no reason to miss the other.
      const results = await Promise.allSettled([dueEvents(), dueDoses()]);
      results.forEach((result) => {
        if (result.status === 'rejected') {
          console.warn('[reminders] check failed', result.reason);
        }
      });

      const now = Date.now();
      const due = results
        .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
        .filter((item) => !deliveredReminders.has(reminderKey(item)));

      if (due.length) {
        due.forEach((item) => deliveredReminders.set(reminderKey(item), now));
        saveDeliveredReminders();
        pendingReminders.push(...due);
        console.log('[reminders] %d reminder(s) due', due.length);
        flushReminders();
      }
    } finally {
      reminderCheckInFlight = false;
    }
  }

  function fail(message) {
    setState('error');
    // Let the shake finish before speaking - but if the user has already
    // pressed again in that window, their new question wins.
    setTimeout(() => {
      if (state === 'error') speak(message);
    }, 620);
  }

  /* ── input ────────────────────────────────────────────────────────────── */

  function press() {
    switch (state) {
      case 'idle':
      case 'error':
        startListening();
        break;
      case 'listening':
        stopListening();
        break;
      case 'thinking':
        if (inflight) inflight.abort();
        setState('idle');
        break;
      case 'speaking':
        stopSpeaking();
        setState('idle');
        break;
      case 'blocked':
        startListening();   // let them retry after granting permission
        break;
    }
  }

  orb.addEventListener('pointerdown', () => {
    root.style.setProperty('--press', '1');
    // Safari only allows speech that descends from a user gesture, so burn a
    // silent utterance on the very first touch.
    if (!primed && 'speechSynthesis' in window) {
      primed = true;
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  });

  const release = () => root.style.setProperty('--press', '0');
  orb.addEventListener('pointerup', release);
  orb.addEventListener('pointercancel', release);
  orb.addEventListener('pointerleave', release);

  orb.addEventListener('click', press);

  // Keep a stray Space from scrolling the page, without cancelling the native
  // Space-to-activate behaviour of the orb or the app-dock buttons.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) e.preventDefault();
  });

  // Check once at startup, once every minute, and once after returning to a
  // backgrounded tab. Timed events are announced once; all-day events remain
  // visual calendar entries because they have no specific moment to announce.
  checkReminders();
  reminderTimer = setInterval(checkReminders, REMINDER_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkReminders();
  });
  window.Reminders = {
    check: checkReminders,
    // Said as soon as the assistant is not listening, thinking or speaking.
    say: (text) => {
      pendingReminders.push({say: text});
      flushReminders();
    },
    intervalMs: REMINDER_INTERVAL_MS,
  };

  window.addEventListener('beforeunload', () => {
    clearInterval(reminderTimer);
    stopSpeaking();
  });
})();
