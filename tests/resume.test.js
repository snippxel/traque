'use strict';
/*
 * Reconnexion (le cas qui lâche le plus en extérieur) :
 *  - un joueur qui perd le réseau en pleine partie et revient reprend sa place
 *    exacte (rôle, token QR) via `resume` ;
 *  - une session inconnue (serveur redémarré / grâce expirée) est refusée
 *    proprement, ce qui permet au client de ne pas rester figé.
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
  const host = connect();
  let guest = connect();
  await ready(host); await ready(guest);
  const c = await emit(host, 'createRoom', { name: 'CHASSEUR' });
  const g = await emit(guest, 'joinRoom', { code: c.code, name: 'FUYARD' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [g.playerId]: 'hider' } });
  host.emit('updateConfig', { config: { startRadius: 5000, finalRadius: 200, durationMin: 20, shrinkSteps: 2, revealIntervalMin: 5, graceSeconds: 10, radarUses: 3, dispersionSeconds: 0, startRevealSeconds: 0, lastSurvivor: false } });
  await wait(200);
  host.emit('pos', CENTER); guest.emit('pos', HIDER);
  await wait(300);
  const start = await emit(host, 'startGame', { safetyChecked: true });
  assert(start.ok, 'Partie lancée');
  await wait(300);

  // Coupure réseau du caché en pleine partie
  guest.close();
  await wait(1200);

  // Il revient : nouveau socket, même session
  guest = connect();
  await ready(guest);
  const res = await emit(guest, 'resume', { code: c.code, playerId: g.playerId });
  assert(res && res.ok, 'Reconnexion acceptée après coupure réseau');
  assert(res && res.qrToken === g.qrToken, 'Le token QR est conservé (le chasseur peut toujours le scanner)');

  // Il retrouve bien sa place et son rôle
  const st = await new Promise((r) => { guest.on('state', (s) => { if (s.status === 'playing') r(s); }); });
  assert(st.you.role === 'hider', 'Rôle conservé (toujours caché)');
  assert(st.you.id === g.playerId, 'Même identité de joueur');

  // Le chasseur peut toujours l'éliminer après sa reconnexion
  const scan = await emit(host, 'scanQR', { token: g.qrToken });
  assert(scan.ok, 'Le chasseur peut éliminer le joueur reconnecté');

  // Session inconnue (serveur redémarré) -> refus propre, pas de plantage
  const bad = await emit(host, 'resume', { code: 'ZZZZZ', playerId: 'inexistant' });
  assert(bad && !bad.ok && bad.error, 'Session inconnue refusée proprement (avec message)');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); guest.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
