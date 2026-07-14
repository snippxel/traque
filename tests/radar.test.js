'use strict';
/*
 * Radar — comportement complet :
 *  - localise un caché même à faible précision GPS (régression PC/WiFi) ;
 *  - vise le caché LE PLUS PROCHE du chasseur ;
 *  - quota de 3 utilisations par partie ;
 *  - révélation visible ~1 min côté chasseur ;
 *  - la cible est alertée (radar:spotted) et voit le chasseur (state.spotted) 30 s.
 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'] });
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d, (r) => res(r)));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };

const HUNTER_POS = { lat: 48.8566, lng: 2.3522, accuracy: 6 };
const NEAR_HIDER = { lat: 48.8569, lng: 2.3525, accuracy: 150 }; // ~40 m, précision médiocre (PC)
const FAR_HIDER = { lat: 48.8620, lng: 2.3600, accuracy: 10 };   // ~800 m

(async () => {
  const host = connect();   // chasseur
  const near = connect();   // caché proche (PC imprécis)
  const far = connect();    // caché loin
  await new Promise((r) => host.on('connect', r));
  await new Promise((r) => near.on('connect', r));
  await new Promise((r) => far.on('connect', r));

  const created = await emit(host, 'createRoom', { name: 'HUNTER' });
  const jNear = await emit(near, 'joinRoom', { code: created.code, name: 'PROCHE' });
  const jFar = await emit(far, 'joinRoom', { code: created.code, name: 'LOIN' });

  let hunterState = null;
  host.on('state', (s) => { if (s.status === 'playing' && s.you.role === 'hunter') hunterState = s; });
  let nearSpottedEvt = null, nearSeesHunter = false, farSpottedEvt = null, nearSpottedLen = 0;
  near.on('radar:spotted', (d) => { nearSpottedEvt = d; });
  near.on('state', (s) => { if (s.spotted) { nearSpottedLen = s.spotted.length; if (s.spotted.length) nearSeesHunter = true; } });
  far.on('radar:spotted', (d) => { farSpottedEvt = d; });

  host.emit('assignRoles', { mode: 'manual', assignments: {
    [created.playerId]: 'hunter', [jNear.playerId]: 'hider', [jFar.playerId]: 'hider',
  } });
  host.emit('updateConfig', { config: { startRadius: 2000, finalRadius: 100, durationMin: 20, shrinkSteps: 4, revealIntervalMin: 5, graceSeconds: 10, lastSurvivor: false } });
  await wait(200);

  host.emit('pos', HUNTER_POS);
  near.emit('pos', NEAR_HIDER); // précision 150 m — auparavant rejetée
  far.emit('pos', FAR_HIDER);
  await wait(300);

  const start = await emit(host, 'startGame', { safetyChecked: true });
  assert(start.ok, 'Partie lancée (3 joueurs)');
  await wait(300);

  // Radar 1/3 : doit viser le caché LE PLUS PROCHE (PROCHE), malgré sa précision 150 m
  const r1 = await emit(host, 'useRadar', {});
  assert(r1.ok, 'Radar 1/3 → ok (caché imprécis localisable)');
  assert(r1.usesLeft === 2, 'Utilisations restantes = 2');
  await wait(200);
  assert(nearSpottedEvt && !farSpottedEvt, 'Cible = le caché le PLUS PROCHE (PROCHE alerté, pas LOIN)');
  assert(nearSpottedEvt && /HUNTER/i.test(nearSpottedEvt.by || ''), 'Cible avertie de l’identité du chasseur');
  assert(nearSpottedEvt && nearSpottedEvt.hunter && nearSpottedEvt.hunter.lat, 'Cible reçoit la position du chasseur');

  // La cible voit le chasseur dans son état (contre-révélation)
  await wait(1600);
  assert(nearSeesHunter, 'Le caché repéré voit le chasseur dans son état (30 s)');

  // Révélation côté chasseur : présente et de durée ~1 min
  const rev = hunterState && hunterState.reveals && hunterState.reveals.find((x) => x.kind === 'radar');
  assert(rev, 'Chasseur voit la révélation radar');
  assert(rev && rev.until - Date.now() > 50 * 1000, 'Révélation visible ~1 min (> 50 s restantes)');

  // Quota : 2e et 3e ok, 4e refusé
  const r2 = await emit(host, 'useRadar', {});
  const r3 = await emit(host, 'useRadar', {});
  assert(r2.ok && r3.ok, 'Radar 2/3 et 3/3 → ok');
  const r4 = await emit(host, 'useRadar', {});
  assert(!r4.ok && /plus de radar/i.test(r4.error || ''), 'Radar 4e → refusé (quota épuisé)');

  // Anti-doublon : après plusieurs radars sur le MÊME caché, une seule position
  await wait(1700);
  const proche = hunterState.reveals.filter((x) => x.name === 'PROCHE');
  assert(proche.length === 1, 'Chasseur : une seule révélation pour PROCHE (pas de doublon)');
  assert(nearSpottedLen === 1, 'Caché repéré : un seul marqueur chasseur (pas de doublon)');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); near.close(); far.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
