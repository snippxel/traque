'use strict';
/*
 * Test de régression : radar sur un caché à faible précision GPS (cas PC/WiFi)
 * + comportement du cooldown (3 min).
 * Reproduit le bug rapporté : un caché dont la précision > 30 m était injoignable,
 * donc le radar répondait "Aucun caché localisable pour le moment".
 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'] });
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d, (r) => res(r)));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };

const CENTER = { lat: 48.8566, lng: 2.3522, accuracy: 6 };
// Caché "sur PC" : même endroit, mais précision GPS médiocre (150 m)
const LOWACC = { lat: 48.8567, lng: 2.3523, accuracy: 150 };

(async () => {
  const host = connect();   // chasseur (téléphone, bon GPS)
  const guest = connect();  // caché (PC, mauvais GPS)
  await new Promise((r) => host.on('connect', r));
  await new Promise((r) => guest.on('connect', r));

  const created = await emit(host, 'createRoom', { name: 'PHONE-HUNTER' });
  const joined = await emit(guest, 'joinRoom', { code: created.code, name: 'PC-HIDER' });

  let hunterState = null;
  host.on('state', (s) => { if (s.status === 'playing' && s.you.role === 'hunter') hunterState = s; });

  host.emit('assignRoles', { mode: 'manual', assignments: { [created.playerId]: 'hunter', [joined.playerId]: 'hider' } });
  host.emit('updateConfig', { config: { startRadius: 500, finalRadius: 50, durationMin: 20, shrinkSteps: 5, revealIntervalMin: 5, graceSeconds: 10, lastSurvivor: false } });
  await wait(200);

  host.emit('pos', CENTER);
  guest.emit('pos', LOWACC); // précision 150 m — auparavant rejetée
  await wait(300);

  const start = await emit(host, 'startGame', { safetyChecked: true });
  assert(start.ok, 'Partie lancée');
  await wait(300);

  // Régression : le caché imprécis DOIT être localisable
  const radar1 = await emit(host, 'useRadar', {});
  assert(radar1.ok, 'Radar trouve le caché malgré une précision GPS de 150 m (bug corrigé)');

  // Cooldown : réutilisation immédiate refusée
  const radar2 = await emit(host, 'useRadar', {});
  assert(!radar2.ok && /recharge/i.test(radar2.error || ''), 'Radar en recharge → 2e usage immédiat refusé');

  // L'état expose bien la fin de recharge dans le futur (~3 min)
  await wait(1700);
  const readyAt = hunterState && hunterState.you && hunterState.you.radarReadyAt;
  const cd = hunterState && hunterState.you && hunterState.you.radarCooldownMs;
  assert(readyAt && readyAt > Date.now(), 'radarReadyAt est dans le futur (recharge en cours)');
  assert(cd === 180000, 'Cooldown exposé = 3 min (180000 ms)');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); guest.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
