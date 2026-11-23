'use strict';
/* Test des contrôles de l'hôte : passer la main, exclure, terminer.
 * Avant, l'hôte n'avait aucun levier une fois la partie lancée, et un joueur
 * fantôme (parti sans quitter) pouvait empêcher une partie de finir.
 * Vérifie aussi que l'état porte l'heure du serveur (synchro des horloges).
 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'], forceNew: true });
const ready = (s) => new Promise((r) => (s.connected ? r() : s.once('connect', r)));
const emit = (s, ev, d) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, error: 'pas de réponse' }), 4000);
  s.emit(ev, d, (x) => { clearTimeout(t); res(x); });
});
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };
const P = { lat: 48.8566, lng: 2.3522, accuracy: 8 };

(async () => {
  const H = connect(), X = connect(), Y = connect(), Z = connect();
  await Promise.all([ready(H), ready(X), ready(Y), ready(Z)]);
  const h = await emit(H, 'createRoom', { name: 'HOTE' });
  const x = await emit(X, 'joinRoom', { code: h.code, name: 'XAVIER' });
  await emit(Y, 'joinRoom', { code: h.code, name: 'YANN' });
  await emit(Z, 'joinRoom', { code: h.code, name: 'ZOE' });

  let etatH = null, etatX = null, kickedZ = false;
  H.on('state', (s) => { etatH = s; });
  X.on('state', (s) => { etatX = s; });
  Z.on('kicked', () => { kickedZ = true; });
  await wait(1700);

  console.log('# Heure du serveur dans l’état');
  assert(etatH && Number.isFinite(etatH.serverNow) && Math.abs(etatH.serverNow - Date.now()) < 5000, 'L’état porte serverNow');
  const pid = (nom) => etatH.roster.find((p) => p.name === nom).id;

  console.log('# Un invité ne peut rien faire de tout ça');
  const pirate = await emit(X, 'host:kick', { pid: pid('YANN') });
  assert(pirate && pirate.ok === false, 'Exclusion refusée à un non-hôte');

  console.log('# Exclure un joueur');
  const k = await emit(H, 'host:kick', { pid: pid('ZOE') });
  assert(k && k.ok, 'L’hôte exclut ZOE');
  await wait(300);
  assert(kickedZ, 'ZOE est prévenue');
  await wait(1600);
  assert(!etatH.roster.some((p) => p.name === 'ZOE'), 'ZOE n’est plus dans la liste');

  console.log('# Passer la main, puis la reprendre');
  const t = await emit(H, 'host:transfer', { pid: pid('XAVIER') });
  assert(t && t.ok, 'L’hôte passe la main à XAVIER');
  await wait(1700);
  assert(etatX && etatX.isHost === true && etatH.isHost === false, 'XAVIER est hôte, HOTE ne l’est plus');
  const back = await emit(X, 'host:transfer', { pid: pid('HOTE') });
  assert(back && back.ok, 'XAVIER rend la main');

  console.log('# Terminer la partie en cours');
  for (const s of [H, X, Y]) s.emit('pos', P);
  H.emit('assignRoles', { mode: 'manual', assignments: { [h.playerId]: 'hunter', [x.playerId]: 'hider' } });
  H.emit('updateConfig', { config: { dispersionSeconds: 0, startRevealSeconds: 0, durationMin: 10 } });
  await wait(400);
  const go = await emit(H, 'startGame', { safetyChecked: true });
  assert(go && go.ok, 'Partie lancée');
  await wait(1600);
  assert(etatH && etatH.roster.every((p) => typeof p.id === 'string' && p.id.length === 10), 'En jeu, la liste désigne chacun par un identifiant public');
  const fin = await emit(H, 'host:end', {});
  assert(fin && fin.ok, 'L’hôte termine la partie');
  await wait(1700);
  assert(etatX && etatX.status === 'ended' && etatX.result && etatX.result.reason === 'host', 'Tout le monde voit la fin, avec sa raison');
  assert(etatX.result.winner === 'hiders', 'Des cachés en jeu : victoire des cachés');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  for (const s of [H, X, Y, Z]) s.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
