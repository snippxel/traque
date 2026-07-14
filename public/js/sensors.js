'use strict';
/*
 * sensors.js — accès matériel du téléphone :
 * géolocalisation, orientation (boussole), Wake Lock, vibration, alarme audio.
 * Expose window.Sensors.
 */
window.Sensors = (function () {
  // -------------------- Géolocalisation --------------------
  let watchId = null;
  let lastHeading = null;

  function watchPosition(onPos, onErr) {
    if (!('geolocation' in navigator)) {
      onErr && onErr('Géolocalisation non supportée par ce navigateur.');
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (p) => onPos({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy: p.coords.accuracy,
        time: p.timestamp,
      }),
      (e) => onErr && onErr(geoErrMsg(e)),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }
  function stopWatch() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  function geoErrMsg(e) {
    if (e.code === 1) return 'Permission GPS refusée. Autorise la localisation.';
    if (e.code === 2) return 'Position indisponible.';
    if (e.code === 3) return 'Délai GPS dépassé.';
    return 'Erreur GPS.';
  }
  function getOnce() {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        (e) => reject(geoErrMsg(e)),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  // -------------------- Orientation (boussole) --------------------
  let orientationCb = null;
  function handleOrientation(e) {
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number') {
      heading = e.webkitCompassHeading; // iOS : 0 = nord, sens horaire
    } else if (e.absolute && typeof e.alpha === 'number') {
      heading = 360 - e.alpha; // alpha : 0 = nord, sens antihoraire
    }
    if (heading != null) {
      lastHeading = heading;
      orientationCb && orientationCb(heading);
    }
  }
  async function startCompass(cb) {
    orientationCb = cb;
    // iOS 13+ : permission explicite
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch (_) { /* ignore */ }
    window.addEventListener('deviceorientationabsolute', handleOrientation, true);
    window.addEventListener('deviceorientation', handleOrientation, true);
    return true;
  }
  function stopCompass() {
    window.removeEventListener('deviceorientationabsolute', handleOrientation, true);
    window.removeEventListener('deviceorientation', handleOrientation, true);
    orientationCb = null;
  }
  function heading() { return lastHeading; }

  // -------------------- Wake Lock --------------------
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (_) { /* l'API se libère parfois seule, on redemande au retour */ }
  }
  function initWakeLockAutoReacquire() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && wakeLock === null) requestWakeLock();
    });
  }
  function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch (_) {} wakeLock = null; }

  // -------------------- Vibration --------------------
  function vibrate(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch (_) {} }

  // -------------------- Alarme audio (WebAudio) --------------------
  let audioCtx = null;
  let alarmTimer = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function beep(freq, dur, gainVal) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.value = gainVal == null ? 0.06 : gainVal;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  }
  function startAlarm() {
    stopAlarm();
    beep(880, 0.18); beep(660, 0.18, 0.05);
    alarmTimer = setInterval(() => { beep(880, 0.18); }, 500);
  }
  function stopAlarm() { if (alarmTimer) clearInterval(alarmTimer); alarmTimer = null; }
  function ping(freq) { beep(freq || 1200, 0.12, 0.05); }

  return {
    watchPosition, stopWatch, getOnce,
    startCompass, stopCompass, heading,
    requestWakeLock, releaseWakeLock, initWakeLockAutoReacquire,
    vibrate, ensureAudio, startAlarm, stopAlarm, ping,
  };
})();
