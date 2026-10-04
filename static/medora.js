/* ---------------------------------------------------------------------------
   Medora - the pill dispenser, in the assistant.

   The same three views as the standalone Medora page: the doses coming up,
   the medicines themselves, and the device. The schedule lives on the server
   (medicines.py) so the voice can read and change it too; the Bluetooth link
   to the dispenser can only live in the browser, so it lives here.

   The link is deliberately outside the window. It opens when the page loads
   and stays up while the assistant is running, so the dispenser keeps its
   schedule whether or not anyone has the window open.

   window.Medora.open()   open the window
   window.Medora.connect()  choose a dispenser and pair with it
--------------------------------------------------------------------------- */

window.Medora = (() => {
  'use strict';

  /* The dispenser's Bluetooth service, as medora.ino advertises it. */
  const SERVICE_UUID = '7f71a001-4c7d-4b8d-9c42-7a3e1e7b1000';
  const COMMAND_UUID = '7f71a002-4c7d-4b8d-9c42-7a3e1e7b1000';
  const EVENT_UUID = '7f71a003-4c7d-4b8d-9c42-7a3e1e7b1000';

  const DEVICE_STORAGE_KEY = 'medora.bluetooth-device-id';
  const MTU_STORAGE_KEY = 'medora.bluetooth-mtu';

  const RECONNECT_DELAYS = [250, 600, 1200, 2500, 4000, 6000, 8000];
  const MANUAL_CONNECT_TIMEOUT = 12000;
  const AUTOMATIC_CONNECT_TIMEOUT = 30000;
  const ADVERTISEMENT_TIMEOUT = 12000;
  const SYNC_CONFIRMATION_TIMEOUT = 4000;
  const SYNC_RETRY_DELAYS = [300, 900, 2500, 6000];
  const SYNC_RESULT_WINDOW_MINUTES = 7 * 24 * 60;
  const SYNC_RESULT_LIMIT = 96;
  const DEFAULT_CHUNK_SIZE = 180;
  const MAX_CHUNK_SIZE = 480;

  /* How late a dose may still be answered - the same five minutes the
     device gives an alarm before it gives up on it. */
  const GRACE_MS = 5 * 60 * 1000;
  const REFRESH_MS = 30000;

  const CONTAINERS = [1, 2, 3, 4, 5];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const DAY_INITIALS = {0: 'S', 1: 'M', 2: 'T', 3: 'W', 4: 'T', 5: 'F', 6: 'S'};
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
                      'Friday', 'Saturday'];
  const DEFAULT_TIMES = ['09:00', '18:00', '21:00'];

  /* ── state ───────────────────────────────────────────────────────────── */

  let medicines = [];
  let doses = new Map();          // "container:minute" -> {container, minute, status}
  let activeDoseKey;              // the dose the device is alarming for
  let loaded = false;
  let loadError = '';

  let body = null;                // the open window's body, or null
  let tab = 'doses';
  let formOpen = false;
  let draft = null;               // the half-filled new-medicine form
  let notice = '';
  let noticeTimer;

  const FORM_ID = 'medora-new-medicine';

  let bluetoothDevice;
  let commandCharacteristic;
  let eventCharacteristic;
  let connectionAttempt;
  let reconnectTimer;
  let reconnectIndex = 0;
  let keepConnected = false;
  let needsAdvertisement = false;
  let canWatchAdvertisements = true;
  let mustPickAgain = false;
  let linkQueue = Promise.resolve();
  let chunkSize = loadChunkSize();

  let deviceState = 'idle';       // idle | connecting | reconnecting | connected
  let deviceMessage = '';
  let deviceHint = null;          // {text, code}, under the pair button
  let syncState = '';             // syncing | pending | synced
  let syncMessage = '';
  let syncIndicatorTimer;

  let syncRevision = 0;
  let syncedRevision = 0;
  let syncRunning = false;
  let syncAttempt = 0;
  let syncRetryTimer;
  let syncConfirmation;
  let selfTestScreenTimer;

  const supported = 'bluetooth' in navigator && window.isSecureContext;

  /* ── small helpers ───────────────────────────────────────────────────── */

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', day: 'numeric',
  });
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit',
  });

  function formatClock(date) {
    return timeFormatter.format(date).toLowerCase();
  }

  /* "today", "tomorrow", then "mon 21" - the shortest true thing. */
  function formatDay(date) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const offset = Math.round((day - start) / 86400000);

    if (offset === 0) return 'today';
    if (offset === 1) return 'tomorrow';
    return dateFormatter.format(date).toLowerCase();
  }

  /* Both ends count in local wall-clock minutes since 1970 - what the
     device stores, so neither has to know about time zones. */
  function localMinute(date = new Date()) {
    return Math.floor((date.getTime() - date.getTimezoneOffset() * 60000) / 60000);
  }

  function localEpochSeconds() {
    return Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 1000);
  }

  function localDateValue(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function localTimeValue(date) {
    return `${String(date.getHours()).padStart(2, '0')}:` +
           `${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function formatTime(value) {
    const [hours, minutes] = value.split(':').map(Number);
    return formatClock(new Date(2000, 0, 1, hours, minutes));
  }

  const doseKey = (container, minute) => `${container}:${minute}`;

  function sortedDays(days) {
    return [...new Set(days)].sort(
      (first, second) => DAY_ORDER.indexOf(first) - DAY_ORDER.indexOf(second));
  }

  function describeDays(days) {
    const sorted = sortedDays(days);
    if (sorted.length === 7) return 'every day';
    if (sorted.length === 5 && [1, 2, 3, 4, 5].every((day) => sorted.includes(day))) {
      return 'weekdays';
    }
    if (sorted.length === 2 && sorted.includes(0) && sorted.includes(6)) {
      return 'weekends';
    }
    return sorted.map((day) => DAY_NAMES[day].toLowerCase()).join(', ');
  }

  /* The times say how many doses there are, and the count travels beside
     the name, so neither needs saying here. What is left fits one line. */
  function describeMedicine(medicine) {
    return `${describeDays(medicine.days)} · ` +
           `${medicine.times.map(formatTime).join(', ')}`;
  }

  function freeContainers() {
    const used = new Set(medicines.map((medicine) => medicine.container));
    return CONTAINERS.filter((container) => !used.has(container));
  }

  /* ── the schedule, as the server holds it ────────────────────────────── */

  async function requestJSON(url, options = {}) {
    const response = await fetch(url, options);
    let data = {};
    try { data = await response.json(); } catch (_) { /* handled below */ }
    if (!response.ok) {
      throw new Error(data.message || 'Medora could not save that change.');
    }
    return data;
  }

  function absorb(data) {
    medicines = (data.medicines || []).slice();
    doses = new Map((data.doses || []).map(
      (dose) => [doseKey(dose.container, dose.minute), dose]));
    loaded = true;
    loadError = '';
  }

  /* Anything that changed the schedule has to reach the dispenser too. */
  function absorbAndSync(data) {
    absorb(data);
    requestSync();
  }

  async function refresh({quiet = false} = {}) {
    try {
      absorb(await requestJSON('/api/medicines'));
    } catch (error) {
      console.warn('[medora] could not read the schedule', error);
      if (!loaded) loadError = 'The schedule could not be read.';
      if (!quiet) render();
      return;
    }
    if (!quiet) render();
  }

  /* A dose answered here: written down on the server first, because that is
     what the voice reads, then sent straight to the device. */
  async function answerDose(container, minute, status) {
    const key = doseKey(container, minute);
    doses.set(key, {container, minute, status});
    if (activeDoseKey === key) activeDoseKey = undefined;
    render();

    try {
      const data = await requestJSON('/api/doses', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({container, minute, status}),
      });
      absorb(data);
      pushDoseResult({container, minute, status});
    } catch (error) {
      console.warn('[medora] could not write the dose down', error);
      await refresh({quiet: true});
    }
    render();
  }

  /* A dose the device resolved on its own is already the truth. It is only
     written down here, never echoed back to the device. */
  async function recordDeviceDose(container, minute, status) {
    const key = doseKey(container, minute);
    const existing = doses.get(key);
    if (activeDoseKey === key) activeDoseKey = undefined;
    if (existing && existing.status === status) { render(); return; }

    doses.set(key, {container, minute, status});
    render();

    try {
      absorb(await requestJSON('/api/doses', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({container, minute, status}),
      }));
    } catch (error) {
      console.warn('[medora] could not write down the dose from the device', error);
    }
    render();
  }

  /* ── the doses coming up ─────────────────────────────────────────────── */

  /* Worked out here rather than taken from the server so the list stays
     right between refreshes, and the moment a dose falls due. */
  function upcomingDoses(limit, daysAhead = 62) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const found = [];

    medicines.forEach((medicine) => {
      for (let offset = 0; offset < daysAhead; offset++) {
        const day = new Date(start.getFullYear(), start.getMonth(),
                             start.getDate() + offset);
        if (!medicine.days.includes(day.getDay())) continue;

        medicine.times.forEach((value) => {
          const [hours, minutes] = value.split(':').map(Number);
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                              hours, minutes);
          const minute = localMinute(at);
          const key = doseKey(medicine.container, minute);
          const active = activeDoseKey === key;
          const withinGrace = at <= now && now - at <= GRACE_MS;

          if (!doses.has(key) && (at >= now || withinGrace || active)) {
            found.push({
              id: key,
              name: medicine.name,
              quantity: medicine.quantity,
              container: medicine.container,
              minute,
              at,
            });
          }
        });
      }
    });

    return found
      .sort((first, second) => (first.at - second.at) ||
                               first.name.localeCompare(second.name))
      .slice(0, limit);
  }

  function isDue(dose) {
    const now = new Date();
    return activeDoseKey === dose.id ||
           (dose.at <= now && now - dose.at <= GRACE_MS);
  }

  /* ── wire format ─────────────────────────────────────────────────────── */
  /*
     Records are newline separated so a whole schedule travels in a handful
     of packets instead of one packet per record, and occurrence minutes go
     over the air in base 36 to keep those packets small. This is the format
     medora.ino parses; it is not ours to change on one side only.
  */

  function toBase36(value) {
    return Math.max(0, Math.floor(value)).toString(36);
  }

  function encodeDoseResult(dose) {
    return `DR:${dose.container}|${toBase36(dose.minute)}|${dose.status}`;
  }

  function deviceSafeName(name) {
    return name.replace(/[|\u0000-\u001f\u007f]/g, ' ').trim();
  }

  function clampChunkSize(size) {
    return Math.max(DEFAULT_CHUNK_SIZE, Math.min(size, MAX_CHUNK_SIZE));
  }

  function loadChunkSize() {
    try {
      const stored = Number(localStorage.getItem(MTU_STORAGE_KEY));
      if (Number.isInteger(stored) && stored >= 23 && stored <= 517) {
        return clampChunkSize(stored - 3);
      }
    } catch (error) {
      console.warn('[medora] could not read the packet size', error);
    }
    return DEFAULT_CHUNK_SIZE;
  }

  /* The device reports the packet size it negotiated, so the next sync can
     pack bigger chunks instead of guessing conservatively. */
  function rememberChunkSize(mtu) {
    if (!Number.isInteger(mtu) || mtu < 23 || mtu > 517) return;
    chunkSize = clampChunkSize(mtu - 3);
    try {
      localStorage.setItem(MTU_STORAGE_KEY, String(mtu));
    } catch (error) {
      console.warn('[medora] could not remember the packet size', error);
    }
  }

  function packRecords(records) {
    const chunks = [];
    let current = '';

    records.forEach((record) => {
      const candidate = current ? `${current}\n${record}` : record;
      if (candidate.length > chunkSize && current) {
        chunks.push(current);
        current = record;
        return;
      }
      current = candidate;
    });

    if (current) chunks.push(current);
    return chunks;
  }

  function buildSyncRecords() {
    const nominalWindowStart = localMinute() - SYNC_RESULT_WINDOW_MINUTES;
    const recent = [...doses.values()]
      .filter((dose) => dose.minute >= nominalWindowStart)
      .sort((first, second) => first.minute - second.minute);
    const sent = recent.slice(-SYNC_RESULT_LIMIT);

    /* The window says how far back this app is authoritative, so the device
       can reply with just the doses it resolved on its own. */
    const windowStart = sent.length === recent.length
      ? nominalWindowStart
      : sent[0].minute;
    const next = upcomingDoses(1)[0];

    const records = [
      `TIME:${localEpochSeconds()}`,
      `WIN:${toBase36(windowStart)}`,
    ];

    medicines.forEach((medicine) => {
      const daysMask = medicine.days.reduce((mask, day) => mask | (1 << day), 0);
      records.push([
        `MED:${deviceSafeName(medicine.name)}`,
        medicine.quantity,
        medicine.container,
        daysMask,
        medicine.times.join(','),
      ].join('|'));
    });

    sent.forEach((dose) => records.push(encodeDoseResult(dose)));

    records.push(next ? [
      `NEXT:${deviceSafeName(next.name)}`,
      next.quantity,
      next.container,
      localDateValue(next.at),
      localTimeValue(next.at),
    ].join('|') : 'NEXT:NONE');

    return ['SYNC:BEGIN', ...records, `SYNC:END|${records.length}`];
  }

  /* ── talking to the device ───────────────────────────────────────────── */

  function isLinkReady() {
    return Boolean(commandCharacteristic && bluetoothDevice &&
                   bluetoothDevice.gatt.connected);
  }

  function deviceLabel() {
    return (bluetoothDevice && bluetoothDevice.name) || 'Medora';
  }

  async function writeDeviceCommand(command) {
    if (!isLinkReady()) throw new Error('Medora is not connected');

    const value = new TextEncoder().encode(command);
    if (typeof commandCharacteristic.writeValueWithResponse === 'function') {
      await commandCharacteristic.writeValueWithResponse(value);
    } else {
      await commandCharacteristic.writeValue(value);
    }
  }

  /* Web Bluetooth rejects overlapping GATT operations, so everything that
     talks to the device goes through a single queue. */
  function runExclusive(task) {
    const result = linkQueue.then(task, task);
    linkQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function setDeviceState(state, message, hint = null) {
    deviceState = state;
    deviceMessage = message;
    deviceHint = hint;
    render();
  }

  function showSync(state, message, hideAfter = 0) {
    clearTimeout(syncIndicatorTimer);
    syncState = state;
    syncMessage = message;
    render();

    if (hideAfter > 0) {
      syncIndicatorTimer = setTimeout(() => {
        syncState = '';
        syncMessage = '';
        render();
      }, hideAfter);
    }
  }

  /* ── sync ────────────────────────────────────────────────────────────── */

  function beginSyncConfirmation() {
    if (syncConfirmation) syncConfirmation.finish(false);

    const confirmation = {};
    confirmation.promise = new Promise((resolve) => {
      confirmation.finish = (success) => {
        clearTimeout(confirmation.timer);
        if (syncConfirmation === confirmation) syncConfirmation = undefined;
        resolve(success);
      };
      confirmation.timer = setTimeout(() => confirmation.finish(false),
                                      SYNC_CONFIRMATION_TIMEOUT);
    });
    syncConfirmation = confirmation;
    return confirmation.promise;
  }

  function finishSyncConfirmation(success) {
    if (syncConfirmation) syncConfirmation.finish(success);
  }

  function requestSync() {
    syncRevision++;
    syncAttempt = 0;
    runSyncSoon(0);
  }

  function runSyncSoon(delay) {
    clearTimeout(syncRetryTimer);
    if (syncedRevision >= syncRevision) return;

    if (!isLinkReady()) {
      showSync('pending', 'saved · connect to sync');
      return;
    }

    showSync('syncing', 'syncing…');
    syncRetryTimer = setTimeout(runSync, delay);
  }

  async function runSync() {
    if (syncRunning || !isLinkReady() || syncedRevision >= syncRevision) return;

    syncRunning = true;
    const revision = syncRevision;

    try {
      const chunks = packRecords(buildSyncRecords());
      const confirmed = await runExclusive(async () => {
        const confirmation = beginSyncConfirmation();
        for (const chunk of chunks) await writeDeviceCommand(chunk);
        return confirmation;
      });

      if (!confirmed) throw new Error('Medora did not confirm the schedule sync');

      syncedRevision = Math.max(syncedRevision, revision);
      syncAttempt = 0;

      if (syncedRevision >= syncRevision) showSync('synced', 'synced', 2500);
      else runSyncSoon(0);
    } catch (error) {
      finishSyncConfirmation(false);
      console.warn('[medora] could not sync the schedule', error);
      syncAttempt++;

      if (!isLinkReady()) {
        showSync('pending', 'saved · connect to sync');
      } else if (syncAttempt > SYNC_RETRY_DELAYS.length) {
        /* The link looks up but is no longer carrying data. Dropping it is
           the quickest way back to a working connection. */
        syncAttempt = 0;
        showSync('pending', 'reconnecting to sync');
        dropConnection();
      } else {
        showSync('pending', 'retrying sync…');
        runSyncSoon(SYNC_RETRY_DELAYS[syncAttempt - 1]);
      }
    } finally {
      syncRunning = false;
    }
  }

  /* One answered dose is a single small write, so it lands on the device
     long before the next full sync would. */
  function pushDoseResult(dose) {
    /* A full sync is already owed and will carry this dose as well.
       Acknowledging the single write would wrongly mark that sync done. */
    if (syncedRevision < syncRevision) { requestSync(); return; }

    const revision = ++syncRevision;

    if (!isLinkReady()) {
      showSync('pending', 'saved · connect to sync');
      return;
    }

    showSync('syncing', 'syncing…');
    runExclusive(() => writeDeviceCommand(encodeDoseResult(dose)))
      .then(() => {
        syncedRevision = Math.max(syncedRevision, revision);
        if (syncedRevision >= syncRevision) showSync('synced', 'synced', 2500);
      })
      .catch((error) => {
        console.warn('[medora] could not send the dose to the device', error);
        runSyncSoon(300);
      });
  }

  /* ── what the device says ────────────────────────────────────────────── */

  function handleBluetoothEvent(event) {
    const message = new TextDecoder().decode(event.target.value).trim();
    if (!message) return;

    if (message.startsWith('SYNCED')) {
      rememberChunkSize(Number(message.split('|')[1]));
      finishSyncConfirmation(true);
      return;
    }

    if (message === 'SYNC_ERROR') { finishSyncConfirmation(false); return; }

    if (message.startsWith('HI|')) {
      rememberChunkSize(Number(message.slice(3)));
      return;
    }

    /* Diagnostics traffic belongs to whichever check asked for it. */
    if (deliverDeviceEvent(message)) return;

    if (message.startsWith('PONG') || message.startsWith('DIAG|') ||
        message.startsWith('TEST|') || message.startsWith('BTN|')) {
      return;
    }

    const fields = message.substring(2).split('|');

    if (message.startsWith('A:') && fields.length === 2) {
      const container = Number(fields[0]);
      const minute = Number(fields[1]);
      if (!Number.isInteger(container) || !Number.isInteger(minute)) return;

      const next = container > 0 ? doseKey(container, minute) : undefined;
      if (next === activeDoseKey) return;

      activeDoseKey = next;
      render();
      return;
    }

    if (message.startsWith('R:') && fields.length === 3) {
      const container = Number(fields[0]);
      const minute = Number(fields[1]);
      const status = fields[2];

      if (Number.isInteger(container) && Number.isInteger(minute) &&
          (status === 'T' || status === 'S')) {
        recordDeviceDose(container, minute, status);
      }
      return;
    }

    setDeviceState(deviceState, message.toLowerCase());
  }

  /* ── the remembered dispenser ────────────────────────────────────────── */

  function rememberDevice(deviceId) {
    try {
      localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
    } catch (error) {
      console.warn('[medora] could not remember the dispenser', error);
    }
  }

  function rememberedDeviceId() {
    try {
      return localStorage.getItem(DEVICE_STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  function forgetRememberedDevice() {
    try {
      localStorage.removeItem(DEVICE_STORAGE_KEY);
    } catch (error) { /* storage is optional */ }
  }

  /* ── connecting ──────────────────────────────────────────────────────── */

  function clearLink() {
    commandCharacteristic = undefined;

    if (eventCharacteristic) {
      eventCharacteristic.removeEventListener('characteristicvaluechanged',
                                              handleBluetoothEvent);
      eventCharacteristic = undefined;
    }

    linkQueue = Promise.resolve();
    clearTimeout(syncRetryTimer);
    finishSyncConfirmation(false);
  }

  function dropConnection() {
    try {
      if (bluetoothDevice && bluetoothDevice.gatt.connected) {
        bluetoothDevice.gatt.disconnect();
      }
    } catch (error) {
      console.warn('[medora] could not restart the connection', error);
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (!keepConnected || !bluetoothDevice) return;

    const delay = RECONNECT_DELAYS[
      Math.min(reconnectIndex, RECONNECT_DELAYS.length - 1)];
    reconnectIndex++;

    reconnectTimer = setTimeout(() => {
      if (!keepConnected || !bluetoothDevice) return;
      if (bluetoothDevice.gatt.connected && commandCharacteristic) return;
      connectToDevice(bluetoothDevice, true);
    }, delay);
  }

  /* Anything that means someone is back in front of the assistant resets
     the backoff and retries straight away. */
  function reconnectNow() {
    if (!keepConnected || !bluetoothDevice || connectionAttempt) return;
    if (bluetoothDevice.gatt.connected && commandCharacteristic) return;

    clearTimeout(reconnectTimer);
    reconnectIndex = 0;
    connectToDevice(bluetoothDevice, true);
  }

  function handleDisconnect(event) {
    if (event.target !== bluetoothDevice) return;

    clearLink();
    if (syncedRevision < syncRevision) showSync('pending', 'saved · connect to sync');

    if (keepConnected) {
      setDeviceState('reconnecting', 'reconnecting to Medora…');
      scheduleReconnect();
    } else {
      setDeviceState('idle', 'Medora disconnected');
    }
  }

  /* Chrome will not open a connection to a remembered device until it has
     seen that device advertise since the page loaded, and a reload throws
     that away. Listening for one advert first is what turns the "no longer
     in range" failure into a reconnection. */
  function waitForAdvertisement(selectedDevice, timeout) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let timer;

      const stop = () => {
        if (settled) return true;
        settled = true;
        clearTimeout(timer);
        selectedDevice.removeEventListener('advertisementreceived', onAdvertisement);
        try { controller.abort(); } catch (_) { /* already gone */ }
        return false;
      };

      function onAdvertisement() {
        if (stop()) return;
        resolve();
      }

      const fail = (error) => {
        if (stop()) return;
        reject(error);
      };

      timer = setTimeout(() => {
        const error = new Error('Medora did not advertise in time');
        error.name = 'TimeoutError';
        fail(error);
      }, timeout);

      selectedDevice.addEventListener('advertisementreceived', onAdvertisement);

      try {
        selectedDevice.watchAdvertisements({signal: controller.signal})
          .catch((error) => {
            // Stopping the watch once an advert arrives rejects this promise
            // too, which is not a failure.
            if (settled || selectedDevice.watchingAdvertisements) return;
            fail(error);
          });
      } catch (error) {
        fail(error);
      }
    });
  }

  async function reachDevice(selectedDevice, timeout) {
    const watchable = canWatchAdvertisements &&
      typeof selectedDevice.watchAdvertisements === 'function';

    if (needsAdvertisement && watchable) {
      try {
        await waitForAdvertisement(selectedDevice,
                                   Math.min(timeout, ADVERTISEMENT_TIMEOUT));
        needsAdvertisement = false;
        setDeviceState('connecting', 'found Medora, connecting…');
      } catch (error) {
        if (error.name === 'TimeoutError') throw error;

        // Some browsers cannot watch for adverts at all; a plain connection
        // attempt is still worth a try there.
        console.warn('[medora] could not watch for adverts', error);
        canWatchAdvertisements = false;
      }
    }

    return connectGatt(selectedDevice, timeout);
  }

  function connectGatt(selectedDevice, timeout) {
    let timer;
    const timedOut = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Bluetooth connection timed out');
        error.name = 'TimeoutError';
        reject(error);
      }, timeout);
    });

    return Promise.race([selectedDevice.gatt.connect(), timedOut])
      .finally(() => clearTimeout(timer));
  }

  async function openLink(selectedDevice, timeout) {
    const server = selectedDevice.gatt.connected
      ? selectedDevice.gatt
      : await reachDevice(selectedDevice, timeout);
    const service = await server.getPrimaryService(SERVICE_UUID);
    const commands = await service.getCharacteristic(COMMAND_UUID);
    const events = await service.getCharacteristic(EVENT_UUID);

    // Listen before subscribing so nothing the device sends is missed.
    events.removeEventListener('characteristicvaluechanged', handleBluetoothEvent);
    events.addEventListener('characteristicvaluechanged', handleBluetoothEvent);
    await events.startNotifications();

    commandCharacteristic = commands;
    eventCharacteristic = events;
  }

  function connectToDevice(selectedDevice, automatic = false) {
    if (connectionAttempt) return connectionAttempt;

    clearTimeout(reconnectTimer);

    if (bluetoothDevice && bluetoothDevice !== selectedDevice) {
      bluetoothDevice.removeEventListener('gattserverdisconnected', handleDisconnect);
    }

    bluetoothDevice = selectedDevice;
    selectedDevice.removeEventListener('gattserverdisconnected', handleDisconnect);
    selectedDevice.addEventListener('gattserverdisconnected', handleDisconnect);

    setDeviceState(automatic ? 'reconnecting' : 'connecting',
                   automatic ? 'looking for Medora…' : 'connecting to Medora');

    connectionAttempt = (async () => {
      try {
        await openLink(selectedDevice,
                       automatic ? AUTOMATIC_CONNECT_TIMEOUT : MANUAL_CONNECT_TIMEOUT);

        keepConnected = true;
        reconnectIndex = 0;
        needsAdvertisement = false;
        mustPickAgain = false;
        rememberDevice(selectedDevice.id);
        setDeviceState('connected', `connected to ${deviceLabel()}`);

        /* Hand the device a fresh schedule the moment the link is up,
           whether or not anything changed while it was away. */
        syncedRevision = 0;
        syncRevision = Math.max(syncRevision, 1);
        syncAttempt = 0;
        runSyncSoon(0);

        return true;
      } catch (error) {
        console.warn('[medora] could not reach the dispenser', error);
        clearLink();

        // Cancel a half open attempt so the next try starts clean.
        try { selectedDevice.gatt.disconnect(); } catch (_) { /* already down */ }

        // The browser's view of where Medora is has gone stale, so the next
        // attempt waits for it to advertise before asking again.
        needsAdvertisement = true;

        if (!canWatchAdvertisements) {
          // Without advert watching there is no way back to a remembered
          // device; the picker is the only route.
          mustPickAgain = true;
        }

        if (keepConnected && !mustPickAgain) {
          setDeviceState('reconnecting', 'waiting for Medora…');
          scheduleReconnect();
        } else {
          setDeviceState('idle',
            mustPickAgain ? 'tap connect to choose medora' : 'could not connect',
            mustPickAgain ? {
              text: 'for automatic reconnection, turn this on and restart chrome:',
              code: 'chrome://flags/#enable-experimental-web-platform-features',
            } : null);
        }

        return false;
      } finally {
        connectionAttempt = undefined;
      }
    })();

    return connectionAttempt;
  }

  async function chooseAndConnect() {
    if (!supported) return false;

    if (bluetoothDevice && !mustPickAgain) {
      keepConnected = true;
      reconnectIndex = 0;
      return connectToDevice(bluetoothDevice);
    }

    setDeviceState('connecting', 'choose Medora in the Bluetooth prompt');

    try {
      const selectedDevice = await navigator.bluetooth.requestDevice({
        filters: [{services: [SERVICE_UUID]}],
      });

      keepConnected = true;
      reconnectIndex = 0;
      needsAdvertisement = false;
      mustPickAgain = false;
      return connectToDevice(selectedDevice);
    } catch (error) {
      if (error.name !== 'NotFoundError') console.error('[medora]', error);
      setDeviceState('idle', error.name === 'NotFoundError'
        ? 'pairing cancelled' : 'could not connect');
      return false;
    }
  }

  async function reconnectInBackground() {
    const remembered = rememberedDeviceId();
    if (!remembered) return;

    // Without the permissions backend the browser cannot hand a paired
    // device back after a reload, so say how to turn it on.
    if (typeof navigator.bluetooth.getDevices !== 'function') {
      setDeviceState('idle', 'tap connect to reach medora', {
        text: 'for automatic reconnection, turn this on and restart chrome:',
        code: 'chrome://flags/#enable-web-bluetooth-new-permissions-backend',
      });
      return;
    }

    try {
      const permitted = await navigator.bluetooth.getDevices();
      const device = permitted.find((entry) => entry.id === remembered);

      if (!device) {
        forgetRememberedDevice();
        setDeviceState('idle', 'tap connect to reach Medora');
        return;
      }

      // A device handed back by the browser has never been seen by this page,
      // so it has to be found on the air before it can be reached.
      keepConnected = true;
      reconnectIndex = 0;
      needsAdvertisement = true;
      await connectToDevice(device, true);
    } catch (error) {
      console.warn('[medora] background reconnect failed', error);
    }
  }

  /* ── diagnostics ─────────────────────────────────────────────────────── */
  /*
     Every check either resolves itself from what the device reports, or runs
     the hardware and then asks what you saw. Nothing here writes to the
     schedule or the dose log.
  */

  const TEST_BADGES = {
    idle: 'not run',
    running: 'running',
    waiting: 'your turn',
    pass: 'ok',
    warn: 'check',
    fail: 'failed',
    skipped: 'skipped',
  };

  let deviceWaiters = [];
  let testResults = new Map();
  let testRunning = false;
  let testStopped = false;
  let pendingConfirmation;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function expectDeviceEvent(match, timeout = 5000) {
    const waiter = {match};

    waiter.promise = new Promise((resolve, reject) => {
      waiter.settle = (value, error) => {
        clearTimeout(waiter.timer);
        deviceWaiters = deviceWaiters.filter((entry) => entry !== waiter);
        if (error) reject(error);
        else resolve(value);
      };

      waiter.timer = setTimeout(() => {
        const error = new Error('Medora did not reply');
        error.name = 'TimeoutError';
        waiter.settle(undefined, error);
      }, timeout);
    });

    deviceWaiters.push(waiter);
    return waiter;
  }

  function deliverDeviceEvent(message) {
    const waiter = deviceWaiters.find((entry) => entry.match(message));
    if (!waiter) return false;
    waiter.settle(message);
    return true;
  }

  function cancelDeviceWaiters(reason) {
    [...deviceWaiters].forEach((waiter) => {
      const error = new Error(reason);
      error.name = 'StopError';
      waiter.settle(undefined, error);
    });
  }

  function sendTestCommand(command) {
    if (!isLinkReady()) return Promise.reject(new Error('Medora is not connected'));
    return runExclusive(() => writeDeviceCommand(command));
  }

  /* The waiter is registered before the request goes out, so a reply that
     arrives immediately cannot slip past it. */
  function askDevice(command, match, timeout) {
    const waiter = expectDeviceEvent(match, timeout);
    sendTestCommand(command).catch((error) => waiter.settle(undefined, error));
    return waiter.promise;
  }

  function formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return 'unknown';
    if (seconds < 60) return `${Math.round(seconds)}s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;

    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  const deviceChecks = [
    {
      id: 'link',
      name: 'bluetooth link',
      hint: 'can the assistant reach medora',
      async run() {
        if (!isLinkReady()) throw new Error('not connected');
        return `connected to ${deviceLabel()}`;
      },
    },
    {
      id: 'roundTrip',
      name: 'round trip',
      hint: 'a message there and back',
      async run() {
        const token = Math.random().toString(36).slice(2, 7);
        const started = performance.now();
        await askDevice(`PING:${token}`, (m) => m === `PONG:${token}`, 5000);
        return `${Math.round(performance.now() - started)} ms`;
      },
    },
    {
      id: 'report',
      name: 'device report',
      hint: 'screen, clock, memory, storage',
      async run() {
        const message = await askDevice('DIAG', (m) => m.startsWith('DIAG|'), 5000);
        const [mtu, screen, meds, logged, clock, uptime, freeKb] =
          message.slice(5).split('|').map(Number);
        const detail = [
          screen ? 'screen found' : 'no screen',
          clock ? 'clock set' : 'clock not set',
          `${meds} medicine${meds === 1 ? '' : 's'}`,
          `${logged} dose${logged === 1 ? '' : 's'} logged`,
          `${freeKb} kb free`,
          `up ${formatUptime(uptime)}`,
          `${mtu} byte packets`,
        ].join(' · ');

        if (!screen) return {detail, status: 'warn'};
        return detail;
      },
    },
    {
      id: 'sync',
      name: 'schedule sync',
      hint: 'sends the schedule, waits for a yes',
      async run() {
        const started = performance.now();
        syncedRevision = 0;
        syncRevision = Math.max(syncRevision, 1);
        syncAttempt = 0;
        await runSync();

        if (syncedRevision < syncRevision) {
          throw new Error('Medora did not confirm the schedule');
        }

        const count = medicines.length;
        return `${count} medicine${count === 1 ? '' : 's'} confirmed in ` +
               `${Math.round(performance.now() - started)} ms`;
      },
    },
    {
      id: 'lights',
      name: 'container lights',
      hint: 'all five lights, in turn',
      confirm: 'did all five lights run through green, red and blue?',
      async run() {
        await askDevice('TEST:LEDS', (m) => m === 'TEST|leds', 12000);
        return 'all five lights driven';
      },
    },
    {
      id: 'buzzer',
      name: 'buzzer',
      hint: 'three short beeps',
      confirm: 'did you hear three beeps?',
      async run() {
        for (let index = 0; index < 3; index++) {
          await sendTestCommand('BEEP:150');
          await delay(320);
        }
        return 'three beeps sent';
      },
    },
    {
      id: 'screen',
      name: 'screen',
      hint: 'a test pattern, five seconds',
      confirm: 'did the screen show MEDORA inside a box?',
      async run() {
        await sendTestCommand('TEST:SCREEN');
        return 'test pattern sent';
      },
    },
    {
      id: 'nextScreen',
      name: 'next dose screen',
      hint: 'what the buttons show when nothing is due',
      confirm: "did the screen show the next dose, or 'No medicines'?",
      async run() {
        await sendTestCommand('SCREEN:NEXT');
        return 'next dose screen sent';
      },
    },
    {
      id: 'buttons',
      name: 'buttons',
      hint: 'press taken, then skip, on medora',
      async run(report) {
        const seen = new Set();

        while (seen.size < 2) {
          report(seen.size === 0
            ? 'press either button on Medora'
            : seen.has('T') ? 'taken works · now press skip'
                            : 'skip works · now press taken');
          const message = await expectDeviceEvent(
            (m) => m.startsWith('BTN|'), 45000).promise;
          seen.add(message.split('|')[1]);
        }

        return 'taken and skip both report';
      },
    },
    {
      id: 'alarm',
      name: 'alarm',
      hint: 'a practice alarm, cleared on the device',
      async run(report) {
        const container = medicines.length ? medicines[0].container : 1;
        report(`container ${container} should flash and beep · ` +
               'clear it with taken or skip');
        const message = await askDevice(`TEST:ALARM:${container}`,
                                        (m) => m.startsWith('TEST|alarm:'), 65000);
        const outcome = message.split(':')[1];

        if (outcome === 'timeout') throw new Error('no button was pressed');
        return outcome === 'T' ? 'cleared with taken' : 'cleared with skip';
      },
    },
  ];

  function setTestState(id, status, detail) {
    testResults.set(id, {status, detail});
    renderTestsOnly();
  }

  function awaitConfirmation(id) {
    return new Promise((resolve) => { pendingConfirmation = {id, resolve}; });
  }

  function answerConfirmation(answer) {
    if (!pendingConfirmation) return;
    const {resolve} = pendingConfirmation;
    pendingConfirmation = undefined;
    resolve(answer);
  }

  async function runCheck(check) {
    setTestState(check.id, 'running', 'running…');

    try {
      const outcome = await check.run(
        (detail) => setTestState(check.id, 'running', detail));
      const detail = typeof outcome === 'string' ? outcome : outcome.detail;
      const status = typeof outcome === 'string' ? 'pass' : outcome.status || 'pass';

      if (!check.confirm) {
        setTestState(check.id, status, detail);
        return status !== 'fail';
      }

      setTestState(check.id, 'waiting', check.confirm);
      const confirmed = await awaitConfirmation(check.id);

      setTestState(check.id, confirmed ? status : 'fail',
                   confirmed ? detail : 'you reported this did not work');
      return confirmed;
    } catch (error) {
      if (error.name === 'StopError') {
        setTestState(check.id, 'skipped', 'stopped');
        return false;
      }

      setTestState(check.id, 'fail', error.message || String(error));
      return false;
    }
  }

  async function runAllChecks() {
    if (testRunning) return;

    testRunning = true;
    testStopped = false;
    testResults = new Map();
    renderTestsOnly();

    for (const check of deviceChecks) {
      if (testStopped) {
        setTestState(check.id, 'skipped', 'stopped');
        continue;
      }
      await runCheck(check);
    }

    testRunning = false;
    renderTestsOnly();
  }

  async function runSingleCheck(id) {
    if (testRunning) return;

    const check = deviceChecks.find((entry) => entry.id === id);
    if (!check) return;

    testRunning = true;
    testStopped = false;
    renderTestsOnly();
    await runCheck(check);
    testRunning = false;
    renderTestsOnly();
  }

  function stopChecks() {
    testStopped = true;
    answerConfirmation(false);
    cancelDeviceWaiters('stopped');

    if (isLinkReady()) {
      sendTestCommand('TEST:STOP')
        .catch((error) => console.warn('[medora] could not stop the self test', error));
    }
  }

  /* ── the self test ───────────────────────────────────────────────────── */
  /*
     What "test medora" runs: every container light in turn, one beep, and a
     message on the screen. The firmware holds its test screen for five
     seconds and clears it itself, so the three seconds asked for here are
     made by turning the screen off early.

     None of it touches the schedule or the dose log.
  */

  const SELF_TEST_SCREEN_MS = 3000;
  const SELF_TEST_BEEP_MS = 180;

  async function selfTest() {
    if (!isLinkReady()) return false;

    try {
      await sendTestCommand('TEST:SCREEN');
      const shownAt = Date.now();

      await sendTestCommand(`BEEP:${SELF_TEST_BEEP_MS}`);
      // The sweep runs on the device for a couple of seconds; the write
      // itself returns at once, so the beep and the screen are not held up.
      await sendTestCommand('TEST:LEDS');

      clearTimeout(selfTestScreenTimer);
      selfTestScreenTimer = setTimeout(
        () => sendTestCommand('SCREEN:OFF').catch((error) =>
          console.warn('[medora] could not clear the screen', error)),
        Math.max(0, SELF_TEST_SCREEN_MS - (Date.now() - shownAt)),
      );

      return true;
    } catch (error) {
      console.warn('[medora] the self test could not run', error);
      return false;
    }
  }

  /* ── the window ──────────────────────────────────────────────────────── */

  const TABS = ['doses', 'medicines', 'device'];

  /* Line icons in the lucide shape homeroom uses: 24-box, stroke 2, round. */
  const ICONS = {
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
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

  function statusChip() {
    const chip = el('div', 'medora__status');
    chip.dataset.state = deviceState;
    chip.setAttribute('role', 'status');
    chip.append(el('span', 'medora__status-dot'), el('span', null,
      deviceState === 'connected' ? 'paired'
        : deviceState === 'connecting' ? 'connecting'
        : deviceState === 'reconnecting' ? 'reconnecting'
        : 'not paired'));
    return chip;
  }

  function head() {
    const bar = el('div', 'medora__head');
    bar.append(el('h2', 'medora__title', 'medora'), statusChip());
    return bar;
  }

  function tabsRow() {
    const row = el('div', 'medora__tabs');
    row.setAttribute('role', 'tablist');

    TABS.forEach((key) => {
      const item = el('button', 'medora__tab', key);
      item.type = 'button';
      item.classList.toggle('is-active', tab === key);
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(tab === key));
      item.addEventListener('click', () => {
        if (tab === key) return;
        tab = key;
        formOpen = false;
        draft = null;
        render();
      });
      row.appendChild(item);
    });

    return row;
  }

  function view() {
    return el('div', 'medora__body');
  }

  function emptyState(message) {
    return el('p', 'medora__empty', message);
  }

  /* Rows arrive the way homeroom's tiles do - a short rise, one after the
     other, and never more than a few frames of it. */
  function stagger(node, index) {
    node.style.animationDelay = `${Math.min(index, 6) * 45}ms`;
    return node;
  }

  function nameLine(text, quantity) {
    const line = el('p', 'medora-row__name');
    line.append(el('span', null, text));
    if (quantity > 1) line.append(el('span', 'medora-row__tag', `\u00d7${quantity}`));
    return line;
  }

  /* ── doses ───────────────────────────────────────────────────────────── */

  function doseRow(dose, index) {
    const row = stagger(el('div', 'medora-row'), index);
    const due = isDue(dose);
    if (due) row.classList.add('is-due');

    const when = el('div', 'medora-row__when');
    when.append(el('span', 'medora-row__time', formatClock(dose.at)),
                el('span', 'medora-row__day', formatDay(dose.at)));

    const copy = el('div', 'medora-row__copy');
    const meta = `container ${dose.container} · ${dose.quantity} ` +
                 `${dose.quantity === 1 ? 'pill' : 'pills'}`;
    const metaLine = el('p', 'medora-row__meta', meta);
    metaLine.title = meta;
    copy.append(nameLine(dose.name, dose.quantity), metaLine);

    row.append(when, copy);

    if (due) {
      const actions = el('div', 'medora-row__actions');
      actions.append(
        hrButton('taken', {variant: 'solid', size: 'sm',
                           onClick: () => answerDose(dose.container, dose.minute, 'T')}),
        hrButton('skip', {size: 'sm',
                          onClick: () => answerDose(dose.container, dose.minute, 'S')}),
      );
      row.append(actions);
    }

    return row;
  }

  function dosesView() {
    const panel = view();

    if (!loaded) {
      panel.append(emptyState(loadError || 'opening medora…'));
      return panel;
    }

    if (!medicines.length) {
      panel.append(emptyState('nothing in medora yet. add a medicine to get started.'));
      return panel;
    }

    const doseList = upcomingDoses(3);
    if (!doseList.length) {
      panel.append(emptyState('nothing more is scheduled.'));
      return panel;
    }

    const rows = el('div', 'medora__rows');
    doseList.forEach((dose, index) => rows.append(doseRow(dose, index)));
    panel.append(rows);
    return panel;
  }

  /* ── medicines ───────────────────────────────────────────────────────── */

  function medicineRow(medicine, index) {
    const row = stagger(el('div', 'medora-row'), index);

    const slot = el('div', 'medora-row__slot', String(medicine.container));
    slot.title = `container ${medicine.container}`;
    slot.setAttribute('aria-label', `container ${medicine.container}`);

    const copy = el('div', 'medora-row__copy');
    const schedule = describeMedicine(medicine);
    const meta = el('p', 'medora-row__meta', schedule);
    meta.title = schedule;
    copy.append(nameLine(medicine.name, medicine.quantity), meta);

    const remove = hrButton('', {
      variant: 'ghost',
      size: 'icon',
      glyph: 'x',
      label: `remove ${medicine.name}`,
      onClick: async () => {
        remove.disabled = true;
        try {
          absorbAndSync(await requestJSON(
            `/api/medicines/${encodeURIComponent(medicine.id)}`, {method: 'DELETE'}));
          setNotice(`removed ${medicine.name}`);
        } catch (error) {
          setNotice(error.message);
        }
        render();
      },
    });

    row.append(slot, copy, remove);
    return row;
  }

  function medicinesView() {
    const panel = view();

    if (!loaded) {
      panel.append(emptyState(loadError || 'opening medora…'));
      return panel;
    }

    if (formOpen) {
      panel.append(medicineForm());
      return panel;
    }

    if (!medicines.length) {
      panel.append(emptyState('no medicines yet. add one to get started.'));
      return panel;
    }

    const rows = el('div', 'medora__rows');
    medicines.forEach((medicine, index) => rows.append(medicineRow(medicine, index)));
    panel.append(rows);
    return panel;
  }

  /* ── the new medicine form ───────────────────────────────────────────── */

  function openForm() {
    if (!freeContainers().length) return;

    tab = 'medicines';
    formOpen = true;
    notice = '';
    draft = {
      name: '',
      frequency: 1,
      quantity: 1,
      container: freeContainers()[0],
      days: [0, 1, 2, 3, 4, 5, 6],
      times: [...DEFAULT_TIMES],
      error: '',
    };
    render();
  }

  function closeForm() {
    formOpen = false;
    draft = null;
    render();
  }

  function field(labelText, control) {
    const wrap = el('label', 'medora-form__field');
    wrap.append(el('span', 'medora-form__label', labelText), control);
    return wrap;
  }

  function select(options, value, onChange) {
    const node = el('select');
    options.forEach(([optionValue, label]) => {
      const option = el('option', null, label);
      option.value = String(optionValue);
      node.appendChild(option);
    });
    node.value = String(value);
    node.addEventListener('change', () => onChange(node.value));
    return node;
  }

  function medicineForm() {
    const form = el('form', 'medora-form');
    form.id = FORM_ID;
    form.noValidate = true;

    const name = el('input');
    name.type = 'text';
    name.maxLength = 80;
    name.autocomplete = 'off';
    name.placeholder = 'what is it called?';
    name.value = draft.name;
    name.addEventListener('input', () => { draft.name = name.value; });
    form.append(field('medication', name));

    /* A refresh while the form is open can take the container this draft had
       in mind, so it is pinned to one that is still free. */
    const available = freeContainers();
    if (!available.includes(draft.container)) draft.container = available[0];

    const grid = el('div', 'medora-form__grid');
    grid.append(
      field('doses a day', select(
        [[1, 'once'], [2, 'twice'], [3, 'three times']],
        draft.frequency,
        (value) => { draft.frequency = Number(value); render(); },
      )),
      field('pills a dose', select(
        Array.from({length: 10}, (_, index) => [index + 1, String(index + 1)]),
        draft.quantity,
        (value) => { draft.quantity = Number(value); },
      )),
      field('container', select(
        available.map((container) => [container, String(container)]),
        draft.container,
        (value) => { draft.container = Number(value); },
      )),
    );
    form.append(grid);

    const days = el('div', 'medora-form__days');
    days.setAttribute('role', 'group');
    days.setAttribute('aria-label', 'days');
    DAY_ORDER.forEach((day) => {
      const toggle = el('button', 'medora-form__day', DAY_INITIALS[day]);
      toggle.type = 'button';
      toggle.setAttribute('aria-label', DAY_LABELS[day]);
      const paint = () => {
        const on = draft.days.includes(day);
        toggle.classList.toggle('is-on', on);
        toggle.setAttribute('aria-pressed', String(on));
      };
      toggle.addEventListener('click', () => {
        draft.days = draft.days.includes(day)
          ? draft.days.filter((entry) => entry !== day)
          : [...draft.days, day];
        paint();
      });
      paint();
      days.append(toggle);
    });
    form.append(field('days', days));

    const times = el('div', 'medora-form__grid');
    for (let index = 0; index < draft.frequency; index++) {
      const time = el('input');
      time.type = 'time';
      time.value = draft.times[index] || DEFAULT_TIMES[index];
      draft.times[index] = time.value;
      time.addEventListener('input', () => { draft.times[index] = time.value; });
      times.append(field(draft.frequency === 1 ? 'time' : `time ${index + 1}`, time));
    }
    form.append(times);
    form.append(el('p', 'medora-form__error', draft.error));

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitMedicine(form);
    });

    requestAnimationFrame(() => name.focus({preventScroll: true}));
    return form;
  }

  async function submitMedicine(form) {
    draft.error = '';

    const chosen = draft.times.slice(0, draft.frequency);

    if (!draft.name.trim()) draft.error = 'enter a medication name.';
    else if (!draft.days.length) draft.error = 'choose at least one day.';
    else if (chosen.some((value) => !value)) draft.error = 'choose a time for every dose.';
    else if (new Set(chosen).size !== chosen.length) draft.error = 'each dose needs a different time.';

    if (draft.error) { render(); return; }

    [...form.elements].forEach((control) => { control.disabled = true; });

    try {
      const data = await requestJSON('/api/medicines', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          name: draft.name,
          times: chosen,
          days: draft.days,
          quantity: draft.quantity,
          container: draft.container,
        }),
      });
      setNotice(`added ${data.medicine.name} to container ${data.medicine.container}`);
      formOpen = false;
      draft = null;
      absorbAndSync(data);
    } catch (error) {
      draft.error = error.message.toLowerCase();
      [...form.elements].forEach((control) => { control.disabled = false; });
    }

    render();
  }

  /* ── the dispenser ───────────────────────────────────────────────────── */

  function badge(status) {
    const node = el('span', 'medora-test__badge');
    if (status === 'pass') node.append(icon('check'));
    if (status === 'fail') node.append(icon('x'));
    node.append(TEST_BADGES[status]);
    return node;
  }

  function testRow(check, index) {
    const state = testResults.get(check.id) || {status: 'idle'};
    const row = stagger(el('div', 'medora-test'), index);
    row.dataset.status = state.status;

    const copy = el('div', 'medora-test__copy');
    const detail = state.detail || check.hint;
    const detailLine = el('p', 'medora-test__detail', detail);
    detailLine.title = detail;
    copy.append(el('p', 'medora-test__name', check.name), detailLine);

    const side = el('div', 'medora-test__side');
    if (state.status === 'waiting') {
      side.append(
        hrButton('yes', {variant: 'solid', size: 'sm',
                         onClick: () => answerConfirmation(true)}),
        hrButton('no', {size: 'sm', onClick: () => answerConfirmation(false)}),
      );
    } else {
      side.append(badge(state.status), hrButton('run', {
        variant: 'ghost',
        size: 'sm',
        disabled: !isLinkReady() || testRunning,
        onClick: () => runSingleCheck(check.id),
      }));
    }

    row.append(copy, side);
    return row;
  }

  function deviceView() {
    const panel = view();

    if (!supported) {
      panel.append(emptyState('bluetooth' in navigator
        ? 'medora needs a secure page. open the assistant on this machine.'
        : 'this browser cannot reach medora over bluetooth. chrome can.'));
      return panel;
    }

    const connected = deviceState === 'connected';
    const busy = deviceState === 'connecting' || deviceState === 'reconnecting';

    const pairing = el('div', 'medora-pair');
    pairing.append(hrButton(
      connected ? 'paired' : busy ? 'connecting…'
        : bluetoothDevice && !mustPickAgain ? 'reconnect' : 'connect',
      {
        variant: connected ? 'outline' : 'solid',
        disabled: connected || busy,
        onClick: () => chooseAndConnect(),
      },
    ));

    const status = el('p', 'medora-pair__status', deviceMessage || 'ready to connect');
    status.title = deviceMessage || 'ready to connect';
    pairing.append(status);

    if (deviceHint) {
      const hint = el('p', 'medora-pair__hint');
      hint.append(deviceHint.text);
      if (deviceHint.code) hint.append(' ', el('code', null, deviceHint.code));
      pairing.append(hint);
    }
    panel.append(pairing);

    const section = el('div', 'medora__section');
    section.append(el('h3', 'medora__section-title', 'checks'));
    if (!isLinkReady()) {
      section.append(el('p', 'medora__note', 'connect medora first'));
    }
    panel.append(section);

    const rows = el('div', 'medora__rows');
    deviceChecks.forEach((check, index) => rows.append(testRow(check, index)));
    panel.append(rows);
    return panel;
  }

  /* ── the foot ────────────────────────────────────────────────────────── */
  /*
     One line of context on the left, one action on the right - homeroom's
     "total entries / clear" bar. Anything transient (a sync, something just
     saved) takes the left slot while it lasts.
  */

  function setNotice(message) {
    clearTimeout(noticeTimer);
    notice = message;
    noticeTimer = setTimeout(() => {
      notice = '';
      render();
    }, 4000);
  }

  function footText() {
    if (notice) return notice;
    if (syncMessage) return syncMessage;
    if (formOpen) return 'new medicine';
    if (!loaded) return '';

    if (tab === 'medicines') {
      const free = freeContainers().length;
      return `${medicines.length} ${medicines.length === 1 ? 'medicine' : 'medicines'}` +
             ` · ${free} of 5 free`;
    }

    if (tab === 'device') {
      return `${deviceChecks.length} checks`;
    }

    const count = upcomingDoses(3).length;
    return count ? `${count} coming up` : 'nothing due';
  }

  function footAction() {
    if (formOpen) {
      const add = el('button', 'hr-btn hr-btn--solid', 'add medicine');
      add.type = 'submit';
      add.setAttribute('form', FORM_ID);
      return [hrButton('cancel', {variant: 'ghost', onClick: closeForm}), add];
    }

    if (tab === 'doses' && loaded && !medicines.length) {
      return [hrButton('add', {variant: 'solid', glyph: 'plus', onClick: openForm})];
    }

    if (tab === 'medicines') {
      const full = !freeContainers().length;
      return [hrButton('add', {
        variant: 'solid',
        glyph: 'plus',
        disabled: full,
        onClick: openForm,
      })];
    }

    if (tab === 'device' && supported) {
      return testRunning
        ? [hrButton('stop', {onClick: stopChecks})]
        : [hrButton('run all', {
            variant: 'solid',
            disabled: !isLinkReady(),
            onClick: runAllChecks,
          })];
    }

    return [];
  }

  function foot() {
    const bar = el('div', 'medora__foot');

    const text = el('span', 'medora__count', footText());
    if (!notice && syncMessage) text.dataset.state = syncState;
    bar.append(text);

    const actions = el('div', 'medora-row__actions');
    footAction().forEach((node) => actions.append(node));
    bar.append(actions);
    return bar;
  }

  /* ── drawing it ──────────────────────────────────────────────────────── */

  function render() {
    if (!body || !body.isConnected) return;

    body.textContent = '';
    body.append(head(), tabsRow(),
                tab === 'doses' ? dosesView()
                  : tab === 'medicines' ? medicinesView()
                  : deviceView(),
                foot());
  }

  /* A check reporting its progress redraws the list, which must not throw
     away a half-typed form on another tab. */
  function renderTestsOnly() {
    if (!body || !body.isConnected || tab !== 'device') return;
    render();
  }

  /* Background work - a refresh, a dose falling due - redraws only when
     nothing is being typed into. */
  function renderIfIdle() {
    if (formOpen) return;
    render();
  }

  function open(initialTab) {
    if (TABS.includes(initialTab)) {
      tab = initialTab;
      formOpen = false;
      draft = null;
    }

    Win.open('Medora', {
      build: (target) => {
        body = target;
        target.classList.add('hr', 'medora');
        render();
      },
      onClose: () => {
        body = null;
        formOpen = false;
        draft = null;
        notice = '';
      },
    });

    refresh();
    if (supported && !isLinkReady() && bluetoothDevice) reconnectNow();
  }

  /* ── keeping up ──────────────────────────────────────────────────────── */

  setInterval(() => refresh({quiet: true}).then(renderIfIdle), REFRESH_MS);
  // A dose falls due on the minute, not when the server is next asked.
  setInterval(renderIfIdle, 15000);

  if (supported) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reconnectNow();
    });
    window.addEventListener('focus', reconnectNow);
    window.addEventListener('online', reconnectNow);

    window.addEventListener('pagehide', () => {
      clearTimeout(reconnectTimer);
      clearTimeout(syncRetryTimer);
      keepConnected = false;

      // Hanging up now lets Medora advertise again immediately instead of
      // waiting out the connection supervision timeout.
      dropConnection();
    });

    reconnectInBackground();
  } else {
    setDeviceState('idle', 'bluetooth' in navigator
      ? 'a secure connection is required'
      : 'web bluetooth is not supported');
  }

  refresh({quiet: true});

  return {
    open,
    close: () => Win.close(),
    connect: chooseAndConnect,
    refresh,
    selfTest,
    get isConnected() { return isLinkReady(); },
  };
})();
