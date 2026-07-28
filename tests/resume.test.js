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

  // --- Reprise de place avec le CODE (session locale perdue) ---
  // Cas réel : téléphone redémarré / cache vidé -> plus de session, mais le
  // joueur doit pouvoir revenir en entrant le code et son nom.
  const host2 = connect(), lost = connect();
  await ready(host2); await ready(lost);
  const c2 = await emit(host2, 'createRoom', { name: 'H2' });
  const jl = await emit(lost, 'joinRoom', { code: c2.code, name: 'PERDU' });
  host2.emit('assignRoles', { mode: 'manual', assignments: { [c2.playerId]: 'hunter', [jl.playerId]: 'hider' } });
  host2.emit('updateConfig', { config: { startRadius: 5000, finalRadius: 200, durationMin: 20, shrinkSteps: 2, revealIntervalMin: 5, graceSeconds: 10, radarUses: 3, dispersionSeconds: 0, startRevealSeconds: 0, lastSurvivor: false } });
  await wait(200);
  host2.emit('pos', CENTER); lost.emit('pos', HIDER);
  await wait(300);
  await emit(host2, 'startGame', { safetyChecked: true });
  await wait(300);

  lost.close(); // perte totale (comme un téléphone éteint)
  await wait(1200);

  // Un nouveau socket, SANS session : il rejoint avec le code + le même nom
  const back = connect();
  await ready(back);
  const rej = await emit(back, 'joinRoom', { code: c2.code, name: 'PERDU' });
  assert(rej && rej.ok && rej.reclaimed, 'Rejoindre avec le code en pleine partie reprend la place');
  assert(rej.playerId === jl.playerId, 'Même joueur (place exacte reprise, pas un nouveau)');
  assert(rej.qrToken === jl.qrToken, 'Token QR conservé après reprise par le code');
  const backSt = await new Promise((r) => { back.on('state', (s) => { if (s.status === 'playing') r(s); }); });
  assert(backSt.you.role === 'hider', 'Rôle conservé après reprise par le code');

  // Nom inconnu en pleine partie -> refusé avec une consigne claire
  const stranger = connect();
  await ready(stranger);
  const no = await emit(stranger, 'joinRoom', { code: c2.code, name: 'INCONNU' });
  assert(no && !no.ok && /même nom/i.test(no.error || ''), 'Un inconnu ne peut pas entrer en pleine partie (message clair)');

  // Un nom déjà utilisé par un joueur ACTIF ne peut pas être volé
  const thief = connect();
  await ready(thief);
  const stolen = await emit(thief, 'joinRoom', { code: c2.code, name: 'PERDU' });
  assert(stolen && !stolen.ok, 'Impossible de voler la place d’un joueur actif');
  host2.close(); back.close(); stranger.close(); thief.close();

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); guest.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
