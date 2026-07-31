'use strict';
/*
 * sensors.js — accès matériel du téléphone :
 * géolocalisation, Wake Lock, vibration, design sonore.
 * Expose window.Sensors.
 */
window.Sensors = (function () {
  // -------------------- Géolocalisation --------------------
  let watchId = null;

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
      // Le code d'erreur remonte aussi : l'appelant doit pouvoir distinguer un
      // refus de permission (état définitif, à afficher en permanence) d'un
      // simple délai dépassé (transitoire).
      (e) => onErr && onErr(geoErrMsg(e), e && e.code),
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

  // -------------------- Orientation (cap du téléphone) --------------------
  // La boussole qui POINTAIT LA ZONE a été retirée : cette direction se lit sur
  // la carte. Ce qui suit répond à un autre besoin — dire au joueur dans quel
  // sens il est tourné, pour qu'il puisse relier une carte nord en haut à ce
  // qu'il a devant les yeux. La carte, elle, ne pivote jamais.
  let headingCb = null, headingHandler = null, headingSmoothed = null;

  function headingFromEvent(e) {
    // iOS expose directement un cap vrai nord, déjà corrigé de la déclinaison.
    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
      return e.webkitCompassHeading;
    }
    // Android : alpha tourne dans l'autre sens. Sans `absolute`, la valeur est
    // relative à une origine arbitraire — inutilisable, on la jette.
    if (e.absolute && typeof e.alpha === 'number' && !Number.isNaN(e.alpha)) {
      return (360 - e.alpha) % 360;
    }
    return null;
  }

  // iOS 13+ exige un appel depuis un geste utilisateur. Android n'a rien à
  // demander : on renvoie true pour que l'appelant n'ait pas à distinguer.
  async function requestHeadingPermission() {
    const D = window.DeviceOrientationEvent;
    if (!D) return false;
    if (typeof D.requestPermission !== 'function') return true;
    try { return (await D.requestPermission()) === 'granted'; } catch (_) { return false; }
  }

  function startHeading(cb) {
    stopHeading();
    headingCb = cb;
    headingHandler = (e) => {
      const h = headingFromEvent(e);
      if (h === null) return;
      // Lissage circulaire. Le magnétomètre saute de 20 à 30° près d'une
      // voiture ou d'un portail ; un cône qui tremble est pire qu'un cône
      // absent, il donne l'illusion d'une précision qui n'existe pas.
      if (headingSmoothed === null) headingSmoothed = h;
      else {
        const d = ((h - headingSmoothed) % 360 + 540) % 360 - 180;
        headingSmoothed = (headingSmoothed + d * 0.18 + 360) % 360;
      }
      headingCb(headingSmoothed);
    };
    window.addEventListener('deviceorientationabsolute', headingHandler, true);
    window.addEventListener('deviceorientation', headingHandler, true);
  }

  function stopHeading() {
    if (headingHandler) {
      window.removeEventListener('deviceorientationabsolute', headingHandler, true);
      window.removeEventListener('deviceorientation', headingHandler, true);
    }
    headingHandler = null; headingCb = null; headingSmoothed = null;
  }

  // -------------------- Wake Lock --------------------
  let wakeLock = null;
  // Retourne true si l'écran est effectivement maintenu allumé. L'appelant peut
  // ainsi prévenir le joueur : écran verrouillé = GPS coupé = position figée.
  async function requestWakeLock() {
    try {
      if (!('wakeLock' in navigator)) return false;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      return true;
    } catch (_) { return false; } // l'API se libère parfois seule, on redemande au retour
  }
  function initWakeLockAutoReacquire() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && wakeLock === null) requestWakeLock();
    });
  }
  function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch (_) {} wakeLock = null; }

  // -------------------- Vibration --------------------
  function vibrate(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch (_) {} }

  // -------------------- Design sonore (WebAudio) --------------------
  // L'ancienne version jouait des ondes CARRÉES à attaque instantanée : c'est la
  // définition technique du bip robotique. Six choses changent ici — plus aucun
  // carré, des enveloppes douces, des cloches à partiels, du bruit filtré, une
  // vraie réverbération, et une tonalité unique (ré mineur) pour que deux sons
  // simultanés s'accordent au lieu de se battre. Toujours zéro fichier audio :
  // tout est synthétisé, donc ça marche hors-ligne et ça ne coûte rien au réseau.
  let audioCtx = null;
  let master = null, revBus = null;
  let alarmTimer = null;

  function makeIR(seconds, decay) {
    const rate = audioCtx.sampleRate, len = Math.floor(rate * seconds);
    const buf = audioCtx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
      master = audioCtx.createGain(); master.gain.value = 0.85;
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.18;
      master.connect(comp); comp.connect(audioCtx.destination);
      const conv = audioCtx.createConvolver(); conv.buffer = makeIR(2.8, 2.4);
      revBus = audioCtx.createGain(); revBus.gain.value = 1;
      revBus.connect(conv); conv.connect(master);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function tone(o) {
    const ctx = ensureAudio(); if (!ctx) return;
    const t0 = (o.at || 0) + ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + (o.glide || o.dur));
    const flt = ctx.createBiquadFilter();
    flt.type = o.ftype || 'lowpass';
    flt.frequency.setValueAtTime(o.fc || 4000, t0);
    if (o.fcTo) flt.frequency.exponentialRampToValueAtTime(Math.max(60, o.fcTo), t0 + o.dur);
    flt.Q.value = o.q || 0.7;
    const g = ctx.createGain();
    const peak = o.g == null ? 0.2 : o.g, a = o.a == null ? 0.012 : o.a;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(flt); flt.connect(g); g.connect(master);
    if (o.rev) { const s = ctx.createGain(); s.gain.value = o.rev; g.connect(s); s.connect(revBus); }
    osc.start(t0); osc.stop(t0 + o.dur + 0.05);
  }

  // Une cloche n'est pas une fréquence : c'est une fondamentale plus ses partiels
  // qui s'éteignent à des vitesses différentes. C'est ça qui fait "beau".
  function bell(f, dur, at, gain, rev) {
    const parts = [[1, 1], [2.01, 0.44], [2.98, 0.26], [4.16, 0.14], [5.43, 0.07]];
    for (let i = 0; i < parts.length; i++) {
      tone({ f: f * parts[i][0], dur: dur * (1 - i * 0.13), at: at || 0, g: (gain || 0.16) * parts[i][1],
             a: 0.006, type: 'sine', fc: 9000, rev: rev == null ? 0.35 : rev });
    }
  }

  function noise(o) {
    const ctx = ensureAudio(); if (!ctx) return;
    const t0 = (o.at || 0) + ctx.currentTime;
    const len = Math.max(1, Math.floor(ctx.sampleRate * o.dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const flt = ctx.createBiquadFilter();
    flt.type = o.ftype || 'bandpass';
    flt.frequency.setValueAtTime(o.f, t0);
    if (o.to) flt.frequency.exponentialRampToValueAtTime(Math.max(60, o.to), t0 + o.dur);
    flt.Q.value = o.q || 1.1;
    const g = ctx.createGain();
    const peak = o.g == null ? 0.12 : o.g;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.a || 0.03));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(flt); flt.connect(g); g.connect(master);
    if (o.rev) { const s = ctx.createGain(); s.gain.value = o.rev; g.connect(s); s.connect(revBus); }
    src.start(t0); src.stop(t0 + o.dur + 0.02);
  }

  function sub(f, to, dur, at, gain) {
    tone({ f: f, to: to, dur: dur, at: at || 0, g: gain == null ? 0.34 : gain, a: 0.01, type: 'sine', fc: 200, rev: 0.12 });
  }

  // Tout en ré mineur : D=146.83 · F=174.61 · A=220 · C=261.63
  const SFX = {
    third:    () => { noise({ f: 2200, to: 420, dur: 0.34, g: 0.075, q: 0.8, rev: 0.2 }); sub(80, 58, 0.26, 0.24, 0.22); },
    tick:     () => tone({ f: 520, dur: 0.075, g: 0.055, a: 0.004, fc: 2400, rev: 0.08 }),
    kickoff:  () => { bell(146.83, 1.5, 0, 0.13, 0.5); bell(220, 1.7, 0.14, 0.13, 0.5); bell(293.66, 2.4, 0.28, 0.15, 0.6);
                      sub(70, 44, 1.1, 0, 0.30); noise({ f: 5200, to: 900, dur: 0.55, g: 0.05, q: 0.6, rev: 0.45 }); },
    spotted:  () => { tone({ f: 110, dur: 1.5, g: 0.16, a: 0.28, type: 'triangle', fc: 280, fcTo: 900, rev: 0.3 });
                      bell(880, 1.6, 0.16, 0.09, 0.55);
                      tone({ f: 146.83, dur: 1.4, g: 0.07, a: 0.3, fc: 400, rev: 0.3 }); },
    outzone:  () => { for (let i = 0; i < 3; i++) { const t = i * 0.46;
                        tone({ f: 392, dur: 0.30, at: t, g: 0.115, a: 0.045, type: 'triangle', fc: 700 + i * 560, q: 2.4, rev: 0.28 });
                        tone({ f: 440, dur: 0.30, at: t + 0.23, g: 0.115, a: 0.045, type: 'triangle', fc: 800 + i * 620, q: 2.4, rev: 0.28 }); }
                      sub(64, 52, 1.5, 0, 0.13); },
    shrink:   () => { tone({ f: 320, to: 180, dur: 0.9, g: 0.10, a: 0.05, type: 'triangle', fc: 1400, fcTo: 420, rev: 0.34 });
                      noise({ f: 900, to: 220, dur: 0.7, g: 0.035, q: 0.9, ftype: 'lowpass', rev: 0.3 }); },
    chat:     () => { tone({ f: 587.33, dur: 0.26, g: 0.075, a: 0.005, fc: 3200, rev: 0.22 });
                      tone({ f: 880, dur: 0.19, g: 0.038, a: 0.005, fc: 3600, rev: 0.22 }); },
    captured: () => { noise({ f: 260, to: 5200, dur: 0.62, g: 0.085, q: 0.7, rev: 0.25 });
                      sub(92, 38, 0.85, 0.60, 0.42); bell(97.99, 3.0, 0.62, 0.15, 0.75);
                      tone({ f: 146.83, dur: 2.4, at: 0.66, g: 0.075, a: 0.02, fc: 700, rev: 0.6 }); },
    tag:      () => { bell(587.33, 0.42, 0, 0.11, 0.3); bell(739.99, 0.42, 0.075, 0.11, 0.3);
                      bell(880, 0.72, 0.15, 0.13, 0.42); sub(120, 96, 0.24, 0, 0.14); },
    down:     () => { bell(293.66, 1.15, 0, 0.10, 0.45); tone({ f: 146.83, dur: 0.9, g: 0.055, a: 0.03, fc: 520, rev: 0.35 }); },
    final:    () => { bell(146.83, 3.2, 0, 0.12, 0.7); bell(174.61, 3.0, 0.05, 0.09, 0.7);
                      bell(220, 3.4, 0.10, 0.10, 0.7); bell(329.63, 3.6, 0.16, 0.07, 0.75); sub(55, 48, 2.0, 0, 0.20); },
  };

  function sfx(name) { const f = SFX[name]; if (f) { try { f(); } catch (_) {} } }

  // L'alerte hors-zone boucle tant que le joueur n'est pas revenu : trois cycles
  // de sirène toutes les 1,5 s, au lieu d'un 880 Hz carré en continu.
  function startAlarm() {
    stopAlarm();
    sfx('outzone');
    alarmTimer = setInterval(() => sfx('outzone'), 1500);
  }
  function stopAlarm() { if (alarmTimer) clearInterval(alarmTimer); alarmTimer = null; }

  // Façades conservées : d'anciens appels ping(freq) subsistent peut-être, ils ne
  // doivent surtout pas lever ni redevenir des bips.
  function ping(freq) {
    const f = freq || 1200;
    bell(f > 1200 ? 587.33 : 440, 0.34, 0, 0.07, 0.25);
  }
  function beep() { /* supprimé : c'était la source du son robotique */ }

  return {
    watchPosition, stopWatch, getOnce,
    requestHeadingPermission, startHeading, stopHeading,
    requestWakeLock, releaseWakeLock, initWakeLockAutoReacquire,
    vibrate, ensureAudio, startAlarm, stopAlarm, ping, beep, sfx,
  };
})();
