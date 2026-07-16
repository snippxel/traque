'use strict';
/*
 * Configuration : nombre de radars par chasseur, et révélation périodique
 * qui s'applique bien avec l'intervalle configuré une fois la partie lancée.
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
const HIDER_START = { lat: 48.8568, lng: 2.3524, accuracy: 8 };
const HIDER_MOVED = { lat: 48.8572, lng: 2.3530, accuracy: 8 }; // ~70 m plus loin, toujours dans la zone

async function scenarioRadars() {
  console.log('# Radars configurables (radarUses = 1)');
  const host = connect(), guest = connect();
  await ready(host); await ready(guest);
  const c = await emit(host, 'createRoom', { name: 'H' });
  const g = await emit(guest, 'joinRoom', { code: c.code, name: 'G' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [g.playerId]: 'hider' } });
  host.emit('updateConfig', { config: { startRadius: 5000, finalRadius: 100, durationMin: 20, shrinkSteps: 3, revealIntervalMin: 5, graceSeconds: 10, radarUses: 1, dispersionSeconds: 0, startRevealSeconds: 0, lastSurvivor: false } });
  await wait(150);
  host.emit('pos', CENTER); guest.emit('pos', HIDER_START);
  await wait(250);
  let youMax = null;
  host.on('state', (s) => { if (s.status === 'playing') youMax = s.you.radarMax; });
  const start = await emit(host, 'startGame', { safetyChecked: true });
  assert(start.ok, 'Partie lancée');
  await wait(1700);
  assert(youMax === 1, 'radarMax reflète la config (1)');
  const r1 = await emit(host, 'useRadar', {});
  assert(r1.ok && r1.usesLeft === 0, 'Radar 1/1 → ok, 0 restant');
  const r2 = await emit(host, 'useRadar', {});
  assert(!r2.ok, 'Radar 2e → refusé (seulement 1 configuré)');
  host.close(); guest.close();
}

async function scenarioReveal() {
  console.log('# Révélation périodique (intervalle 0.1 min = 6 s) appliquée après lancement');
  const host = connect(), guest = connect();
  await ready(host); await ready(guest);
  const c = await emit(host, 'createRoom', { name: 'H2' });
  const g = await emit(guest, 'joinRoom', { code: c.code, name: 'CIBLE' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [g.playerId]: 'hider' } });
  // dispersionSeconds: 0 → phase de chasse immédiate, révélations dès l'intervalle
  host.emit('updateConfig', { config: { startRadius: 5000, finalRadius: 200, durationMin: 20, shrinkSteps: 2, revealIntervalMin: 0.1, graceSeconds: 10, radarUses: 3, dispersionSeconds: 0, startRevealSeconds: 0, lastSurvivor: false } });
  await wait(150);
  host.emit('pos', CENTER); guest.emit('pos', HIDER_START);
  await wait(300);

  let hostState = null;
  host.on('state', (s) => { if (s.status === 'playing') hostState = s; });
  const start = await emit(host, 'startGame', { safetyChecked: true });
  assert(start.ok, 'Partie lancée');
  // Première révélation à l'intervalle (~6 s), pas à t=0.
  // On attend 6 s + un tick de diffusion (1,5 s) + marge : sinon le dernier état
  // reçu peut dater d'avant la révélation (course).
  await wait(8500);
  const sig1 = hostState && hostState.signals && hostState.signals.find((x) => x.name === 'CIBLE');
  assert(sig1, 'Signal gris présent après le 1er intervalle de révélation');
  if (!sig1) { host.close(); guest.close(); return; }

  // Le caché se déplace ; après un nouvel intervalle, le signal doit suivre
  guest.emit('pos', HIDER_MOVED);
  await wait(8500);
  const sig2 = hostState.signals.find((x) => x.name === 'CIBLE');
  assert(sig2 && (Math.abs(sig2.lat - sig1.lat) > 1e-5 || Math.abs(sig2.lng - sig1.lng) > 1e-5),
    'La révélation périodique se met à jour à l’intervalle configuré');
  host.close(); guest.close();
}

(async () => {
  await scenarioRadars();
  await scenarioReveal();
  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
