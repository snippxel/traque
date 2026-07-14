'use strict';
/* Test d'intégration du flux de jeu (à lancer serveur démarré sur :3000). */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect() { return io(URL, { transports: ['websocket'] }); }
const ready = (s) => new Promise((r) => { if (s.connected) return r(); s.once('connect', r); });
function emit(sock, ev, data) {
  return new Promise((res) => sock.emit(ev, data, (r) => res(r)));
}

let failures = 0;
function assert(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failures++;
}

// Paris ~ deux points proches (dans / hors zone)
const CENTER = { lat: 48.8566, lng: 2.3522, accuracy: 8 };
const NEAR = { lat: 48.8568, lng: 2.3524, accuracy: 8 };   // ~28 m
const FAR = { lat: 48.8620, lng: 2.3600, accuracy: 8 };    // ~800 m

(async () => {
  const host = connect();
  const guest = connect();
  const hiderStates = [];
  const hunterStates = [];

  await ready(host);
  await ready(guest);
  console.log('Sockets connectés.');

  // 1. Création
  const created = await emit(host, 'createRoom', { name: 'HOST-CHASSEUR' });
  assert(created.ok && created.code && created.code.length === 5, 'createRoom → code 5 car.');
  const code = created.code;

  // 2. Rejoindre
  const joined = await emit(guest, 'joinRoom', { code, name: 'GUEST-CACHE' });
  assert(joined.ok, 'joinRoom → ok');
  const guestToken = joined.qrToken;

  // Capture des états
  host.on('state', (s) => { if (s.status === 'playing' && s.you.role === 'hunter') hunterStates.push(s); });
  guest.on('state', (s) => { if (s.status === 'playing' && s.you.role === 'hider') hiderStates.push(s); });

  let hunterConverted = false;
  let hiderConvertedByScan = false;
  guest.on('converted', (d) => { if (d.reason === 'scan') hiderConvertedByScan = true; });

  // 3. Rôles manuels : host=chasseur, guest=caché
  const hostId = created.playerId, guestId = joined.playerId;
  host.emit('assignRoles', { mode: 'manual', assignments: { [hostId]: 'hunter', [guestId]: 'hider' } });
  await wait(200);

  // 4. Config courte
  host.emit('updateConfig', { config: { startRadius: 300, finalRadius: 50, durationMin: 1, shrinkSteps: 2, revealIntervalMin: 1, graceSeconds: 4, lastSurvivor: false } });
  await wait(200);

  // 5. Positions (host = centre, guest proche donc dans la zone)
  host.emit('pos', CENTER);
  guest.emit('pos', NEAR);
  await wait(300);

  // 6. Lancement sans sécurité → refus
  const noSafety = await emit(host, 'startGame', { safetyChecked: false });
  assert(!noSafety.ok, 'startGame sans case sécurité → refusé');

  // Lancement par le guest (non-hôte) → refus
  const guestLaunch = await emit(guest, 'startGame', { safetyChecked: true });
  assert(!guestLaunch.ok, 'startGame par non-hôte → refusé (vérif serveur)');

  // Vrai lancement
  const start = await emit(host, 'startGame', { safetyChecked: true });
  assert(start.ok, 'startGame (hôte + sécurité) → ok');
  await wait(1800); // laisse passer un tick de diffusion

  // 7. Visibilité asymétrique
  const hs = hunterStates[hunterStates.length - 1];
  const gs = hiderStates[hiderStates.length - 1];
  assert(hs && Array.isArray(hs.signals), 'Chasseur reçoit un tableau de signaux');
  assert(gs && gs.teammates !== undefined && gs.signals === undefined, 'Caché ne reçoit AUCUN signal/révélation sur les chasseurs');
  assert(gs && gs.reveals === undefined, 'Caché ne reçoit pas de reveals');
  assert(hs && hs.zone && hs.zone.radius <= 300, 'Zone présente côté chasseur');

  // 8. Radar (chasseur, 3 utilisations par partie)
  const radar1 = await emit(host, 'useRadar', {});
  assert(radar1.ok, 'Radar utilisation 1/3 → ok');
  const radar2 = await emit(host, 'useRadar', {});
  assert(radar2.ok, 'Radar utilisation 2/3 → ok');
  const radar3 = await emit(host, 'useRadar', {});
  assert(radar3.ok, 'Radar utilisation 3/3 → ok');
  const radar4 = await emit(host, 'useRadar', {});
  assert(!radar4.ok, 'Radar 4e utilisation → refusé (quota épuisé)');

  // 9. Élimination par scan QR
  const scan = await emit(host, 'scanQR', { token: guestToken });
  assert(scan.ok && scan.name === 'GUEST-CACHE', 'scanQR valide → cible éliminée');
  await wait(300);
  assert(hiderConvertedByScan, 'Cible notifiée de sa conversion (scan)');

  // 10. Fin de partie : tous les cachés attrapés → victoire chasseurs
  await wait(400);
  let ended = null;
  host.on('state', (s) => { if (s.status === 'ended') ended = s; });
  await wait(1800);
  assert(ended && ended.result && ended.result.winner === 'hunters', 'Fin : victoire des chasseurs (tous attrapés)');
  if (ended) {
    const meStat = ended.result.stats.find((p) => p.name === 'HOST-CHASSEUR');
    assert(meStat && meStat.captures === 1, 'Stats : le chasseur a 1 capture');
  }

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' TEST(S) EN ÉCHEC ✗'));
  host.close(); guest.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('Erreur test:', e); process.exit(2); });
