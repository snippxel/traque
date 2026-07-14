'use strict';
/* Test : sortie de zone → alerte → conversion forcée après délai de grâce. */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'] });
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d, (r) => res(r)));
const ready = (s) => new Promise((r) => { if (s.connected) return r(); s.once('connect', r); });
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };

const CENTER = { lat: 48.8566, lng: 2.3522, accuracy: 8 };
const NEAR = { lat: 48.85665, lng: 2.35225, accuracy: 8 };  // ~7 m → dans zone 200m
const FAR = { lat: 48.8700, lng: 2.3700, accuracy: 8 };     // ~2 km → hors zone

(async () => {
  const host = connect();   // chasseur
  const guest = connect();  // caché
  await ready(host);
  await ready(guest);

  const created = await emit(host, 'createRoom', { name: 'CHASSEUR' });
  const joined = await emit(guest, 'joinRoom', { code: created.code, name: 'FUYARD' });

  let gotAlert = false, gotFlash = false, convertedByZone = false;
  guest.on('zone:alert', () => { gotAlert = true; });
  guest.on('converted', (d) => { if (d.reason === 'zone') convertedByZone = true; });
  host.on('hunter:flash', () => { gotFlash = true; });

  host.emit('assignRoles', { mode: 'manual', assignments: { [created.playerId]: 'hunter', [joined.playerId]: 'hider' } });
  host.emit('updateConfig', { config: { startRadius: 200, finalRadius: 50, durationMin: 10, shrinkSteps: 2, revealIntervalMin: 5, graceSeconds: 3, lastSurvivor: false } });
  await wait(200);
  host.emit('pos', CENTER);
  guest.emit('pos', NEAR);
  await wait(300);

  const start = await emit(host, 'startGame', { safetyChecked: true });
  assert(start.ok, 'Partie lancée');
  await wait(300);

  // Le caché sort de la zone
  guest.emit('pos', FAR);
  await wait(1800); // > 1 tick : détection de sortie
  assert(gotAlert, 'Caché reçoit l’alerte hors-zone');
  assert(gotFlash, 'Chasseur reçoit le flash de sortie (position exacte)');
  assert(!convertedByZone, 'Pas encore converti (délai de grâce en cours)');

  // Il ne revient pas → conversion après le délai de grâce (3s)
  await wait(3500);
  assert(convertedByZone, 'Converti en chasseur après expiration du délai de grâce');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); guest.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
