'use strict';
/*
 * Alerte "la zone va se fermer" : ~1 min avant un rétrécissement, envoyée
 * UNIQUEMENT aux cachés qui ne sont pas déjà dans la prochaine (plus petite) zone.
 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'] });
const ready = (s) => new Promise((r) => { if (s.connected) return r(); s.once('connect', r); });
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d, (r) => res(r)));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };

const CENTER = { lat: 48.8566, lng: 2.3522, accuracy: 8 };
const OUT_NEXT = { lat: 48.8566 + 0.0054, lng: 2.3522, accuracy: 8 }; // ~600 m : dans la zone (1000), hors prochaine (525)
const IN_NEXT = { lat: 48.8566 + 0.001, lng: 2.3522, accuracy: 8 };    // ~110 m : déjà dans la prochaine zone

(async () => {
  const host = connect();   // chasseur
  const out = connect();    // caché hors prochaine zone
  const inside = connect(); // caché déjà dans la prochaine zone
  await ready(host); await ready(out); await ready(inside);

  const c = await emit(host, 'createRoom', { name: 'H' });
  const gOut = await emit(out, 'joinRoom', { code: c.code, name: 'DEHORS' });
  const gIn = await emit(inside, 'joinRoom', { code: c.code, name: 'DEDANS' });

  let outWarned = null, inWarned = false;
  out.on('zone:closing', (d) => { outWarned = d; });
  inside.on('zone:closing', () => { inWarned = true; });

  host.emit('assignRoles', { mode: 'manual', assignments: {
    [c.playerId]: 'hunter', [gOut.playerId]: 'hider', [gIn.playerId]: 'hider',
  } });
  // durée 1 min, 2 paliers → 1er rétrécissement à t=30 s (≤ 60 s) : alerte dès le lancement
  host.emit('updateConfig', { config: { startRadius: 1000, finalRadius: 50, durationMin: 1, shrinkSteps: 2, revealIntervalMin: 5, graceSeconds: 10, radarUses: 3, lastSurvivor: false } });
  await wait(150);
  host.emit('pos', CENTER);
  out.emit('pos', OUT_NEXT);
  inside.emit('pos', IN_NEXT);
  await wait(300);

  const start = await emit(host, 'startGame', { safetyChecked: true });
  assert(start.ok, 'Partie lancée');
  await wait(1800); // laisse passer un tick

  assert(outWarned, 'Le caché hors de la prochaine zone est averti (zone:closing)');
  assert(outWarned && outWarned.radius > 0 && outWarned.radius < 1000, 'L’alerte donne le rayon de la prochaine zone');
  assert(!inWarned, 'Le caché déjà dans la prochaine zone n’est PAS averti');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); out.close(); inside.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
