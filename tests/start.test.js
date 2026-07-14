'use strict';
/*
 * Phase de départ (dispersion) :
 *  - le chasseur voit les cachés en DIRECT pendant startRevealSeconds, puis masqué ;
 *  - actions chasseur (radar/scan) bloquées jusqu'à la fin de la dispersion ;
 *  - le timer de chasse est gelé pendant la dispersion.
 * Durées courtes pour le test : dispersion 4 s, visibilité départ 2 s.
 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'] });
const ready = (s) => new Promise((r) => { if (s.connected) return r(); s.once('connect', r); });
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d, (r) => res(r)));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };

const CENTER = { lat: 48.8566, lng: 2.3522, accuracy: 6 };
const HIDER = { lat: 48.8569, lng: 2.3525, accuracy: 8 };

(async () => {
  const host = connect();   // chasseur
  const guest = connect();  // caché
  await ready(host); await ready(guest);
  const c = await emit(host, 'createRoom', { name: 'CHASSEUR' });
  const g = await emit(guest, 'joinRoom', { code: c.code, name: 'CIBLE' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [g.playerId]: 'hider' } });
  host.emit('updateConfig', { config: { startRadius: 5000, finalRadius: 200, durationMin: 20, shrinkSteps: 2, revealIntervalMin: 5, graceSeconds: 10, radarUses: 3, dispersionSeconds: 4, startRevealSeconds: 2, lastSurvivor: false } });
  await wait(150);
  host.emit('pos', CENTER); guest.emit('pos', HIDER);
  await wait(300);

  // Classification robuste via les horodatages serveur (indépendant du timing des ticks)
  let sawStartLive = false, sawMasked = false;
  const timeLefts = [];
  host.on('state', (s) => {
    if (s.status !== 'playing') return;
    const now = Date.now();
    const startLive = now < s.startRevealEndsAt;
    const disp = now < s.dispersionEndsAt;
    if (startLive && (s.reveals || []).some((r) => r.kind === 'start' && r.name === 'CIBLE')) sawStartLive = true;
    if (disp && !startLive && !(s.reveals || []).length && !(s.signals || []).length) sawMasked = true;
    if (disp) timeLefts.push(s.timeLeft);
  });

  const start = await emit(host, 'startGame', { safetyChecked: true });
  assert(start.ok, 'Partie lancée (dispersion 4 s)');

  await wait(1000); // ~t+1s : dans la fenêtre live
  const r1 = await emit(host, 'useRadar', {});
  assert(!r1.ok && /dispersion/i.test(r1.error || ''), 'Radar bloqué pendant la dispersion');
  const sc = await emit(host, 'scanQR', { token: g.qrToken });
  assert(!sc.ok && /dispersion/i.test(sc.error || ''), 'Scan (éliminer) bloqué pendant la dispersion');

  await wait(2200); // ~t+3.2s : dispersion mais hors fenêtre live (masqué)
  const r2 = await emit(host, 'useRadar', {});
  assert(!r2.ok, 'Radar encore bloqué jusqu’à la fin de la dispersion');

  await wait(1600); // ~t+4.8s : chasse démarrée
  const r3 = await emit(host, 'useRadar', {});
  assert(r3.ok, 'Radar débloqué après la dispersion');

  assert(sawStartLive, 'Le chasseur voit les cachés en direct au départ (kind "start")');
  assert(sawMasked, 'Après la fenêtre live, les cachés sont masqués (ni signal ni révélation)');
  // Timer gelé pendant la dispersion (tous les timeLeft quasi égaux)
  const spread = timeLefts.length ? Math.max(...timeLefts) - Math.min(...timeLefts) : 0;
  assert(timeLefts.length >= 2 && spread < 1500, 'Le timer de chasse est gelé pendant la dispersion');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); guest.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
