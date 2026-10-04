/* ---------------------------------------------------------------------------
   Video calls, shared by both ends of a conversation.

   VideoCall.init({me, slug, onchange})   start watching for calls
   VideoCall.place(slug)                  ring the other end

   The picture and the sound go straight from one browser to the other over
   WebRTC. The server only carries the introductions - an offer, an answer,
   and the network candidates - which this polls for, so there is no socket
   to keep alive.

   The camera needs a secure page. That is localhost on the machine the
   assistant runs on, and https:// on a phone (./run.sh --lan --https), so
   the call screen says as much rather than failing quietly.
--------------------------------------------------------------------------- */

window.VideoCall = (() => {
  'use strict';

  const IDLE_POLL_MS = 1500;   // enough to hear the phone ring
  const LIVE_POLL_MS = 450;    // candidates should not wait in a mailbox
  const ENDED_MS = 1500;       // how long "Call ended" stays on screen

  // Replaced at startup by whatever the server is configured with; this is
  // the sane default if that request never lands.
  let RTC = {iceServers: [{urls: 'stun:stun.l.google.com:19302'}]};
  /* Small on purpose. A soft picture that arrives in a second beats a sharp
     one that arrives in five: there is far less for the encoder to get
     through before the first frame, and it sharpens by itself once the call
     has settled. */
  const MEDIA = {
    audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
    video: {
      facingMode: 'user',
      width: {ideal: 640},
      height: {ideal: 480},
      frameRate: {ideal: 24, max: 30},
    },
  };

  const OPENING_BITRATE = 280000;    // while the first frames are getting through
  const SETTLED_BITRATE = 1200000;   // once there is a picture to improve
  const SHARPEN_AFTER_MS = 5000;

  let me = null;          // 'senior' | 'contact'
  let onlySlug = null;    // a contact page may only see its own thread
  let onchange = null;    // the host page, so it can refresh the conversation

  let call = null;        // the call as the server sees it
  let stage = 'idle';     // idle | calling | incoming | live | ended
  let pc = null;
  let localStream = null;
  let cursor = 0;
  let queued = [];        // signals that arrived before the connection existed
  let iceQueue = [];      // candidates that arrived before the description
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
    // Each end calls the other something different: he sees "Danny", Danny
    // sees "Grandpa".
    return me === 'senior' ? call.contact.name : call.contact.calls;
  };

  /* ── the ring ─────────────────────────────────────────────────────────── */

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
    } catch (_) { /* a ring is a nicety, never a requirement */ }
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

  /* ── the call screen ──────────────────────────────────────────────────── */

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
    // A <video> holding a track it has not decoded yet is a black rectangle,
    // which reads as a hang. Their name stays up until there is a picture.
    els.remote.addEventListener('playing', () => {
      screen.classList.add('has-remote', 'is-soft');
      setStatus('');
      // The first frames are the coarse ones. Letting them arrive softly and
      // come into focus looks deliberate, which pixels never do.
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

  /* Mute and camera flip the track that is already being sent, which the
     other end sees at once - no renegotiation. The track is looked up when
     the button is pressed, not when it is drawn: the controls go up while
     the camera is still opening. */
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

  /* ── talking to the server ────────────────────────────────────────────── */

  async function request(body) {
    const response = await fetch('/api/calls', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({as: me, ...body}),
    });
    let data = {};
    try { data = await response.json(); } catch (_) { /* handled below */ }
    if (!response.ok) throw new Error(data.message || 'The call could not be placed.');
    return data;
  }

  function send(kind, data) {
    if (!call) return;
    request({action: 'signal', slug: call.slug, kind, data})
      .catch((error) => console.warn('[call] could not signal', kind, error.message));
  }

  /* ── the connection ───────────────────────────────────────────────────── */

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
        : 'The camera only opens on a secure page. Restart the app with ' +
          './run.sh --tunnel and open the https:// link it prints.';
    }
    if (error.name === 'NotAllowedError') {
      return 'The camera and microphone are blocked for this page. Allow them and try again.';
    }
    if (error.name === 'NotFoundError') return 'No camera was found on this device.';
    return 'The camera could not be opened.';
  }

  /* WebRTC finds its own level, but it starts cautiously and climbs, and the
     climb is exactly the part being waited on. So it opens low and is let go
     once a picture is actually through. */
  async function bitrate(limit) {
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;

    const params = sender.getParameters();
    params.encodings = (params.encodings && params.encodings.length)
      ? params.encodings : [{}];
    params.encodings[0].maxBitrate = limit;
    params.encodings[0].maxFramerate = 24;
    // Rather drop detail than motion: a still face that stutters looks worse
    // than a soft one that moves.
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
      // Autoplay is allowed here - answering or dialling was a tap - but a
      // rejected promise must not become an unhandled one.
      const playing = els.remote.play();
      if (playing) playing.catch(() => { /* the poster stays until it plays */ });
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) send('candidate', event.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      // Connected is not the same as visible - the picture clears the status.
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
          try { await pc.addIceCandidate(candidate); } catch (_) { /* stale */ }
        }
      }
    } finally {
      draining = false;
    }
  }

  /* ── the call itself ──────────────────────────────────────────────────── */

  async function place(slug) {
    if (stage !== 'idle') return;
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
      try { pc.close(); } catch (_) { /* already gone */ }
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
    schedule();
    // The conversation now has a line about the call in it.
    if (had && onchange) onchange();
  }

  /* ── watching for calls ───────────────────────────────────────────────── */

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
    timer = setTimeout(tick, stage === 'idle' ? IDLE_POLL_MS : LIVE_POLL_MS);
  }

  async function tick() {
    try {
      const params = new URLSearchParams({as: me, since: String(cursor)});
      if (onlySlug) params.set('slug', onlySlug);
      const response = await fetch(`/api/calls?${params}`, {cache: 'no-store'});
      if (!response.ok) throw new Error(`calls returned ${response.status}`);
      const data = await response.json();

      cursor = data.cursor || cursor;
      apply(data.call);
      if (data.signals && data.signals.length) {
        queued.push(...data.signals);
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
    onlySlug = options.slug || null;
    onchange = options.onchange || null;

    fetch('/api/ice', {cache: 'no-store'})
      .then((response) => response.json())
      .then((data) => {
        if (data.iceServers && data.iceServers.length) RTC = {iceServers: data.iceServers};
      })
      .catch(() => { /* the default stands */ });

    tick();

    // Closing the tab mid-call should not leave the other end ringing.
    window.addEventListener('pagehide', () => {
      if (stage === 'idle' || !call) return;
      const body = JSON.stringify({as: me, action: 'end', slug: call.slug});
      try {
        navigator.sendBeacon('/api/calls', new Blob([body], {type: 'application/json'}));
      } catch (_) { /* the ring timeout catches it instead */ }
    });
  }

  return {
    init,
    place,
    get stage() { return stage; },
    get busy() { return stage !== 'idle'; },
    // Handy from the console when a call will not connect.
    get connection() {
      return pc ? {peer: pc.connectionState, ice: pc.iceConnectionState,
                   signalling: pc.signalingState} : null;
    },
  };
})();
