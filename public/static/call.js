window.VideoCall = (() => {
  'use strict';

  const IDLE_POLL_MS = 2500;
  const PUSHED_POLL_MS = 20000;
  const LIVE_POLL_MS = 450;
  const ENDED_MS = 1500;

  let RTC = {iceServers: [{urls: 'stun:stun.l.google.com:19302'}]};
  const MEDIA = {
    audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
    video: {
      facingMode: 'user',
      width: {ideal: 640},
      height: {ideal: 480},
      frameRate: {ideal: 24, max: 30},
    },
  };

  const OPENING_BITRATE = 280000;
  const SETTLED_BITRATE = 1200000;
  const SHARPEN_AFTER_MS = 5000;

  let me = null;
  let token = null;
  let pushed = false;
  let stopped = false;
  let onchange = null;

  let call = null;
  let stage = 'idle';
  let pc = null;
  let localStream = null;
  let cursor = 0;
  let queued = [];
  let seenSignals = new Set();
  let iceQueue = [];
  let draining = false;
  let timer = null;
  let ringer = null;
  let sharpening = null;
  let screen = null;
  let els = {};

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const peerName = () => {
    if (!call) return '';
    return me === 'senior' ? call.contact.name : call.contact.calls;
  };

  let audio = null;

  function tone(freq, ms) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, audio.currentTime);
      gain.gain.linearRampToValueAtTime(0.2, audio.currentTime + 0.02);
      gain.gain.setValueAtTime(0.2, audio.currentTime + ms / 1000 - 0.04);
      gain.gain.linearRampToValueAtTime(0, audio.currentTime + ms / 1000);
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + ms / 1000);
    } catch (_) {  }
  }

  function ring(on) {
    if (!on) {
      clearInterval(ringer);
      ringer = null;
      return;
    }
    if (ringer) return;
    const beep = () => { tone(660, 340); setTimeout(() => tone(550, 340), 430); };
    beep();
    ringer = setInterval(beep, 2400);
  }

  const ICONS = {
    end: 'M5.5 13.2c3.6-3.4 9.4-3.4 13 0l1.2-1.9a2 2 0 0 0-.5-2.6 11.6 11.6 0 0 0-14.4 0 2 2 0 0 0-.5 2.6Z',
    answer: 'M6.8 4.6 9 8.2l-1.8 2a12 12 0 0 0 6.6 6.6l2-1.8 3.6 2.2a1.6 1.6 0 0 1 .5 2.2l-1 1.5a2.4 2.4 0 0 1-2.6 1C10.6 20.4 3.6 13.4 2.1 7.3a2.4 2.4 0 0 1 1-2.6l1.5-1a1.6 1.6 0 0 1 2.2.5Z',
    mic: 'M12 3.8a2.6 2.6 0 0 1 2.6 2.6v5.2a2.6 2.6 0 0 1-5.2 0V6.4A2.6 2.6 0 0 1 12 3.8ZM5.8 11.2a6.2 6.2 0 0 0 12.4 0M12 17.4V20.5',
    camera: 'M4.5 7.5h9a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Zm11 3.2 4-2.4v7.4l-4-2.4',
    slash: 'M4 20 20 4',
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<path d="${ICONS[name]}"></path>`;
    return svg;
  }

  function button(cls, name, label, onClick) {
    const wrap = el('button', `call-button ${cls}`);
    wrap.type = 'button';
    wrap.setAttribute('aria-label', label);
    const disc = el('span', 'call-button__disc');
    disc.appendChild(icon(name));
    wrap.append(disc, el('span', 'call-button__label', label));
    wrap.addEventListener('click', onClick);
    return wrap;
  }

  function build() {
    screen = el('div', 'call-screen');
    screen.setAttribute('role', 'dialog');
    screen.setAttribute('aria-modal', 'true');
    screen.setAttribute('aria-label', 'Video call');
    screen.hidden = true;

    els.remote = document.createElement('video');
    els.remote.className = 'call-screen__remote';
    els.remote.autoplay = true;
    els.remote.playsInline = true;
    els.remote.addEventListener('playing', () => {
      screen.classList.add('has-remote', 'is-soft');
      setStatus('');
      setTimeout(() => screen.classList.remove('is-soft'), 900);
      sharpen();
    });

    els.local = document.createElement('video');
    els.local.className = 'call-screen__local';
    els.local.autoplay = true;
    els.local.playsInline = true;
    els.local.muted = true;

    els.avatar = el('div', 'call-screen__avatar');

    els.who = el('p', 'call-screen__who');
    els.status = el('p', 'call-screen__status');
    els.status.setAttribute('role', 'status');
    els.status.setAttribute('aria-live', 'polite');
    const head = el('div', 'call-screen__head');
    head.append(els.who, els.status);

    els.note = el('p', 'call-screen__note');
    els.controls = el('div', 'call-screen__controls');

    screen.append(els.remote, els.avatar, els.local, head, els.note, els.controls);
    document.body.appendChild(screen);
  }

  function show() {
    if (!screen) build();
    screen.hidden = false;
    document.body.classList.add('is-calling');
  }

  function hide() {
    if (!screen) return;
    screen.hidden = true;
    screen.classList.remove('has-remote');
    els.note.textContent = '';
    document.body.classList.remove('is-calling');
  }

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  function render() {
    if (!screen) build();
    screen.dataset.stage = stage;
    els.who.textContent = peerName();
    els.avatar.textContent = (peerName().replace(/^dr\.?\s*/i, '')[0] || '?').toUpperCase();
    els.controls.textContent = '';

    if (stage === 'incoming') {
      setStatus('Video call');
      els.controls.append(
        button('is-answer', 'answer', 'Answer', accept),
        button('is-end', 'end', 'Decline', () => hangUp('declined')),
      );
    } else if (stage === 'calling') {
      setStatus('Calling…');
      els.controls.append(button('is-end', 'end', 'Cancel', () => hangUp()));
    } else if (stage === 'live') {
      els.controls.append(
        toggle('mic', 'Mute', 'Unmute'),
        button('is-end', 'end', 'End call', () => hangUp()),
        toggle('camera', 'Camera off', 'Camera on'),
      );
    } else {
      els.controls.append(button('is-end', 'end', 'Close', () => teardown()));
    }
  }

  function track(kind) {
    if (!localStream) return null;
    return (kind === 'mic'
      ? localStream.getAudioTracks()
      : localStream.getVideoTracks())[0] || null;
  }

  function toggle(kind, offLabel, onLabel) {
    const current = track(kind);
    const live = !current || current.enabled;
    const node = button(live ? 'is-quiet' : 'is-quiet is-off', kind,
      live ? offLabel : onLabel, () => {
        const it = track(kind);
        if (!it) return;
        it.enabled = !it.enabled;
        render();
      });
    if (!live) node.querySelector('.call-button__disc').appendChild(icon('slash'));
    return node;
  }

  async function request(body) {
    const response = await fetch('/api/calls', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token, ...body}),
    });
    let data = {};
    try { data = await response.json(); } catch (_) {  }
    if (!response.ok) throw new Error(data.message || 'The call could not be placed.');
    return data;
  }

  function send(kind, data) {
    if (!call) return;
    request({action: 'signal', slug: call.slug, kind, data})
      .catch((error) => console.warn('[call] could not signal', kind, error.message));
  }

  function media() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new DOMException('insecure context', 'NotSupportedError'));
    }
    return navigator.mediaDevices.getUserMedia(MEDIA);
  }

  function mediaMessage(error) {
    if (error.name === 'NotSupportedError' || !window.isSecureContext) {
      return location.protocol === 'https:'
        ? 'This browser will not open the camera on this page.'
        : 'The camera only opens on a secure (https://) page.';
    }
    if (error.name === 'NotAllowedError') {
      return 'The camera and microphone are blocked for this page. Allow them and try again.';
    }
    if (error.name === 'NotFoundError') return 'No camera was found on this device.';
    return 'The camera could not be opened.';
  }

  async function bitrate(limit) {
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;

    const params = sender.getParameters();
    params.encodings = (params.encodings && params.encodings.length)
      ? params.encodings : [{}];
    params.encodings[0].maxBitrate = limit;
    params.encodings[0].maxFramerate = 24;
    params.degradationPreference = 'maintain-framerate';
    try {
      await sender.setParameters(params);
    } catch (error) {
      console.warn('[call] could not set the bitrate', error);
    }
  }

  function sharpen() {
    if (sharpening) return;
    sharpening = setTimeout(() => bitrate(SETTLED_BITRATE), SHARPEN_AFTER_MS);
  }

  async function startPeer(isCaller) {
    try {
      localStream = await media();
    } catch (error) {
      console.error('[call] no media', error);
      els.note.textContent = mediaMessage(error);
      stage = 'ended';
      render();
      setStatus('Call failed');
      if (call) request({action: 'end', slug: call.slug, reason: 'failed'}).catch(() => {});
      return;
    }

    els.local.srcObject = localStream;
    pc = new RTCPeerConnection(RTC);
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    const camera = localStream.getVideoTracks()[0];
    if (camera) camera.contentHint = 'motion';
    bitrate(OPENING_BITRATE);

    pc.ontrack = (event) => {
      els.remote.srcObject = event.streams[0];
      setStatus('Connecting…');
      const playing = els.remote.play();
      if (playing) playing.catch(() => {  });
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) send('candidate', event.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'failed') {
        setStatus('The connection dropped');
        hangUp('failed');
      }
    };

    render();
    if (isCaller) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send('offer', {type: offer.type, sdp: offer.sdp});
    }
    drain();
  }

  async function drain() {
    if (!pc || draining) return;
    draining = true;
    try {
      while (queued.length) {
        const signal = queued.shift();
        try {
          if (signal.kind === 'offer') {
            await pc.setRemoteDescription(signal.data);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            send('answer', {type: answer.type, sdp: answer.sdp});
          } else if (signal.kind === 'answer') {
            if (pc.signalingState !== 'stable') await pc.setRemoteDescription(signal.data);
          } else if (signal.kind === 'candidate') {
            if (pc.remoteDescription) await pc.addIceCandidate(signal.data);
            else iceQueue.push(signal.data);
          }
        } catch (error) {
          console.warn('[call] %s signal failed', signal.kind, error);
        }
      }

      if (pc.remoteDescription && iceQueue.length) {
        const waiting = iceQueue;
        iceQueue = [];
        for (const candidate of waiting) {
          try { await pc.addIceCandidate(candidate); } catch (_) {  }
        }
      }
    } finally {
      draining = false;
    }
  }

  async function place(slug) {
    if (stage !== 'idle' || stopped) return;
    stage = 'calling';
    call = null;
    cursor = 0;
    show();
    render();
    setStatus('Calling…');

    try {
      const data = await request({action: 'start', slug});
      call = data.call;
      render();
      schedule();
      await startPeer(true);
    } catch (error) {
      stage = 'ended';
      els.note.textContent = error.message;
      render();
      setStatus('Not connected');
      setTimeout(teardown, 2600);
    }
  }

  function incoming(next) {
    call = next;
    stage = 'incoming';
    show();
    render();
    ring(true);
  }

  async function accept() {
    if (stage !== 'incoming' || !call) return;
    ring(false);
    stage = 'live';
    render();
    setStatus('Connecting…');

    try {
      const data = await request({action: 'answer', slug: call.slug});
      call = data.call;
      await startPeer(false);
    } catch (error) {
      els.note.textContent = error.message;
      stage = 'ended';
      render();
      setTimeout(teardown, 2000);
    }
  }

  function hangUp(reason) {
    const slug = call && call.slug;
    stopMedia();
    ring(false);
    stage = 'ended';
    render();
    setStatus(reason === 'declined' ? 'Declined' : 'Call ended');
    if (slug) request({action: 'end', slug, reason}).catch(() => {});
    setTimeout(teardown, ENDED_MS);
  }

  function stopMedia() {
    if (pc) {
      pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null;
      try { pc.close(); } catch (_) {  }
      pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }
    if (els.local) els.local.srcObject = null;
    if (els.remote) els.remote.srcObject = null;
    clearTimeout(sharpening);
    sharpening = null;
    queued = [];
    iceQueue = [];
  }

  function teardown() {
    const had = stage !== 'idle';
    stopMedia();
    ring(false);
    hide();
    stage = 'idle';
    call = null;
    cursor = 0;
    seenSignals = new Set();
    schedule();
    if (had && onchange) onchange();
  }

  function apply(next) {
    if (!next) {
      if (stage !== 'idle' && stage !== 'ended') {
        setStatus('Call ended');
        stopMedia();
        stage = 'ended';
        render();
        setTimeout(teardown, ENDED_MS);
      }
      return;
    }

    if (next.state === 'ringing' && next.caller !== me && stage === 'idle') {
      incoming(next);
      return;
    }

    call = next;
    if (next.state === 'connected' && stage === 'calling') {
      stage = 'live';
      render();
      setStatus('Connecting…');
    }
    if (next.state === 'ended' && stage !== 'idle' && stage !== 'ended') {
      stopMedia();
      ring(false);
      stage = 'ended';
      render();
      setStatus({
        declined: 'Declined',
        no_answer: 'No answer',
        failed: 'The call could not connect',
      }[next.reason] || 'Call ended');
      setTimeout(teardown, ENDED_MS);
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    const idle = pushed ? PUSHED_POLL_MS : IDLE_POLL_MS;
    timer = setTimeout(tick, stage === 'idle' ? idle : LIVE_POLL_MS);
  }

  async function tick() {
    try {
      const params = new URLSearchParams({since: String(cursor)});
      if (token) params.set('token', token);
      const response = await fetch(`/api/calls?${params}`, {cache: 'no-store'});
      if (response.status === 404 && token) { stopped = true; return; }
      if (!response.ok) throw new Error(`calls returned ${response.status}`);
      const data = await response.json();

      cursor = data.cursor || cursor;
      apply(data.call);
      const fresh = (data.signals || []).filter((signal) => !seenSignals.has(signal.seq));
      fresh.forEach((signal) => seenSignals.add(signal.seq));
      if (fresh.length) {
        queued.push(...fresh);
        drain();
      }
    } catch (error) {
      console.warn('[call] poll failed', error);
    } finally {
      schedule();
    }
  }

  function init(options) {
    me = options.me;
    token = options.token || null;
    onchange = options.onchange || null;

    if (window.Push) {
      Push.status().then((state) => { pushed = state === 'on'; }).catch(() => {});
      Push.on((payload) => {
        if (payload.kind === 'call' || payload.kind === 'missed') check();
      });
    }

    fetch(`/api/ice${token ? `?token=${encodeURIComponent(token)}` : ''}`, {cache: 'no-store'})
      .then((response) => response.json())
      .then((data) => {
        if (data.iceServers && data.iceServers.length) RTC = {iceServers: data.iceServers};
      })
      .catch(() => {  });

    tick();

    window.addEventListener('pagehide', () => {
      if (stage === 'idle' || !call) return;
      const body = JSON.stringify({token, action: 'end', slug: call.slug});
      try {
        navigator.sendBeacon('/api/calls', new Blob([body], {type: 'application/json'}));
      } catch (_) {  }
    });
  }

  function check() {
    if (stopped || !me) return;
    clearTimeout(timer);
    tick();
  }

  return {
    init,
    place,
    check,
    set pushed(on) { pushed = !!on; },
    get stage() { return stage; },
    get busy() { return stage !== 'idle'; },
    get connection() {
      return pc ? {peer: pc.connectionState, ice: pc.iceConnectionState,
                   signalling: pc.signalingState} : null;
    },
  };
})();
