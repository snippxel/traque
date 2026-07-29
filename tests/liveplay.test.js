'use strict';
/*
 * Améliorations issues des vraies parties :
 *  1. resync : le client peut redemander son état à tout moment (écran figé
 *     après une mise en arrière-plan -> plus besoin de recharger la page) ;
 *  2. zone finale JOUABLE : le dernier rétrécissement ne tombe plus à la fin de
 *     la partie, il reste du temps de jeu dans la zone finale ;
 *  3. teammate:down : les cachés sont prévenus quand un des leurs tombe, avec
 *     le lieu exact de la capture.
 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'] });
const ready = (s) => new Promise((r) => { if (s.connected) return r(); s.once('connect', r); });
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d, (r) => res(r)));
const nextState = (s, pred) => new Promise((r) => {
  const h = (st) => { if (pred(st)) { s.off('state', h); r(st); } };
  s.on('state', h);
});
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };

const CENTER = { lat: 48.8566, lng: 2.3522, accuracy: 6 };
const NEAR = { lat: 48.85665, lng: 2.35225, accuracy: 6 };

const CFG = (o) => Object.assign({
  startRadius: 5000, finalRadius: 200, durationMin: 20, shrinkSteps: 2,
  revealIntervalMin: 5, graceSeconds: 10, radarUses: 3,
  dispersionSeconds: 0, startRevealSeconds: 0, finalZoneMinutes: 3, lastSurvivor: false,
}, o);

// ---------------------------------------------------------------- 1
async function scenarioResync() {
  console.log('# resync : réponse immédiate sur demande du client');
  const host = connect(), g = connect();
  await ready(host); await ready(g);
  const c = await emit(host, 'createRoom', { name: 'H' });
  const jg = await emit(g, 'joinRoom', { code: c.code, name: 'G' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [jg.playerId]: 'hider' } });
  host.emit('updateConfig', { config: CFG({}) });
  await wait(200);
  host.emit('pos', CENTER); g.emit('pos', NEAR);
  await wait(300);
  await emit(host, 'startGame', { safetyChecked: true });
  await nextState(host, (s) => s.status === 'playing');

  // On demande un état hors du cycle de diffusion : il doit arriver tout de suite
  const t0 = Date.now();
  const got = await Promise.race([
    nextState(host, (s) => s.status === 'playing'),
    wait(1200).then(() => null),
  ]);
  host.emit('resync');
  const fresh = await Promise.race([
    nextState(host, (s) => s.status === 'playing'),
    wait(1000).then(() => null),
  ]);
  assert(fresh, 'Le serveur répond à resync par un état frais (< 1 s)');
  assert(fresh && fresh.zone && fresh.you, 'L’état renvoyé par resync est complet (zone + you)');
  host.close(); g.close();
}

// ---------------------------------------------------------------- 2
async function scenarioFinalZonePlayable() {
  console.log('# Zone finale jouable (~35 s)');
  const host = connect(), g = connect();
  await ready(host); await ready(g);
  const c = await emit(host, 'createRoom', { name: 'H' });
  const jg = await emit(g, 'joinRoom', { code: c.code, name: 'G' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [jg.playerId]: 'hider' } });
  // 1 min de chasse, 2 paliers, 0.5 min de jeu final -> paliers à 15 s et 30 s
  host.emit('updateConfig', { config: CFG({ startRadius: 1000, finalRadius: 200, durationMin: 1, shrinkSteps: 2, finalZoneMinutes: 0.5 }) });
  await wait(200);
  host.emit('pos', CENTER); g.emit('pos', NEAR);
  await wait(300);
  const t0 = Date.now();
  await emit(host, 'startGame', { safetyChecked: true });

  const s1 = await nextState(host, (s) => s.status === 'playing' && s.zone);
  const lastShrinkIn = s1.zone.nextShrinkAt - t0;
  assert(lastShrinkIn < 20000, 'Premier palier tôt (~15 s), pas étalé sur toute la partie');

  // À t≈38 s : tous les paliers sont passés, mais la partie CONTINUE
  await wait(38000);
  const s2 = await nextState(host, (s) => s.status === 'playing' && s.zone);
  assert(s2.status === 'playing', 'La partie est toujours en cours après le dernier rétrécissement');
  assert(Math.round(s2.zone.radius) === 200, 'On joue bien dans la zone finale (rayon final atteint)');
  assert(!s2.zone.nextShrinkAt, 'Plus aucun rétrécissement prévu : la zone finale est stable');
  assert(s2.timeLeft > 10000, 'Il reste du temps de jeu dans la zone finale (' + Math.round(s2.timeLeft / 1000) + ' s)');
  host.close(); g.close();
}

// ---------------------------------------------------------------- 3
async function scenarioTeammateDown() {
  console.log('# Notification aux cachés quand un coéquipier tombe');
  const host = connect(), a = connect(), b = connect();
  await ready(host); await ready(a); await ready(b);
  const c = await emit(host, 'createRoom', { name: 'CHASSEUR' });
  const ja = await emit(a, 'joinRoom', { code: c.code, name: 'ALPHA' });
  const jb = await emit(b, 'joinRoom', { code: c.code, name: 'BRAVO' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [ja.playerId]: 'hider', [jb.playerId]: 'hider' } });
  host.emit('updateConfig', { config: CFG({}) });
  await wait(200);
  host.emit('pos', CENTER); a.emit('pos', NEAR); b.emit('pos', NEAR);
  await wait(300);

  let bDown = null, hunterGotIt = false, victimGotIt = false;
  b.on('teammate:down', (d) => { bDown = d; });
  host.on('teammate:down', () => { hunterGotIt = true; });
  a.on('teammate:down', () => { victimGotIt = true; });

  await emit(host, 'startGame', { safetyChecked: true });
  await wait(400);
  const scan = await emit(host, 'scanQR', { token: ja.qrToken });
  assert(scan.ok, 'ALPHA est capturé');
  await wait(500);

  assert(bDown && bDown.name === 'ALPHA', 'BRAVO (caché) est prévenu de la chute d’ALPHA');
  assert(bDown && Number.isFinite(bDown.lat) && Number.isFinite(bDown.lng), 'La notification contient le LIEU de la capture');
  assert(bDown && bDown.reason === 'scan' && bDown.by === 'CHASSEUR', 'La notification dit comment et par qui');
  // BRAVO est le seul caché restant : le comptage doit valoir 1 (et pas 2)
  assert(bDown && bDown.hidersLeft === 1, 'Cachés restants correctement compté après un scan (a eu ' + (bDown && bDown.hidersLeft) + ')');
  assert(!hunterGotIt, 'Les chasseurs ne reçoivent PAS cette notification d’équipe');
  assert(!victimGotIt, 'La victime ne se reçoit pas sa propre notification');
  host.close(); a.close(); b.close();
}

// ---------------------------------------------------------------- 3 bis
async function scenarioTeammateDownByZone() {
  console.log('# Notification quand un coéquipier sort de la zone (autre chemin)');
  const host = connect(), a = connect(), b = connect();
  await ready(host); await ready(a); await ready(b);
  const c = await emit(host, 'createRoom', { name: 'CH' });
  const ja = await emit(a, 'joinRoom', { code: c.code, name: 'ALPHA' });
  const jb = await emit(b, 'joinRoom', { code: c.code, name: 'BRAVO' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [ja.playerId]: 'hider', [jb.playerId]: 'hider' } });
  host.emit('updateConfig', { config: CFG({ startRadius: 200, finalRadius: 100, graceSeconds: 3 }) });
  await wait(200);
  host.emit('pos', CENTER); a.emit('pos', NEAR); b.emit('pos', NEAR);
  await wait(300);

  let bDown = null;
  b.on('teammate:down', (d) => { bDown = d; });
  await emit(host, 'startGame', { safetyChecked: true });
  await wait(400);

  a.emit('pos', { lat: 48.8700, lng: 2.3700, accuracy: 6 }); // hors zone
  await wait(6000); // sortie + délai de grâce

  assert(bDown && bDown.name === 'ALPHA' && bDown.reason === 'zone', 'BRAVO est prévenu de la sortie de zone d’ALPHA');
  assert(bDown && bDown.hidersLeft === 1, 'Cachés restants correct sur ce chemin aussi (a eu ' + (bDown && bDown.hidersLeft) + ')');
  host.close(); a.close(); b.close();
}

// ---------------------------------------------------------------- 4
async function scenarioReplay() {
  console.log('# Rejouer : nouvelle partie avec les mêmes joueurs');
  const host = connect(), g = connect();
  await ready(host); await ready(g);
  const c = await emit(host, 'createRoom', { name: 'HOTE' });
  const jg = await emit(g, 'joinRoom', { code: c.code, name: 'JOUEUR' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [jg.playerId]: 'hider' } });
  host.emit('updateConfig', { config: CFG({ startRadius: 300, finalRadius: 100 }) });
  await wait(200);
  host.emit('pos', CENTER); g.emit('pos', NEAR);
  await wait(300);
  await emit(host, 'startGame', { safetyChecked: true });
  await wait(400);

  // Rejouer refusé tant que la partie n'est pas finie
  const tooEarly = await emit(host, 'restartGame', {});
  assert(!tooEarly.ok, 'Rejouer refusé pendant une partie en cours');

  // On termine : le chasseur capture l'unique caché
  await emit(host, 'scanQR', { token: jg.qrToken });
  const ended = await nextState(host, (s) => s.status === 'ended');
  assert(ended.status === 'ended', 'Partie terminée');

  // Un non-hôte ne peut pas relancer
  const notHost = await emit(g, 'restartGame', {});
  assert(!notHost.ok && /hôte/i.test(notHost.error || ''), 'Rejouer réservé à l’hôte (vérifié serveur)');

  // L'hôte relance : retour au lobby, mêmes joueurs, même code
  const rr = await emit(host, 'restartGame', {});
  assert(rr.ok, 'L’hôte peut relancer');
  const lobby = await nextState(host, (s) => s.status === 'lobby');
  assert(lobby.code === c.code, 'Même code de partie : personne n’a besoin de re-rejoindre');
  assert(lobby.roster.length === 2, 'Les deux joueurs sont toujours là');
  assert(lobby.counts.hiders === 2, 'Tout le monde repasse caché (rôles à réattribuer)');
  assert(lobby.you.radarUsesLeft === lobby.config.radarUses, 'Radars réinitialisés');

  // Le joueur invité voit aussi le lobby, avec un NOUVEAU token QR
  const gLobby = await nextState(g, (s) => s.status === 'lobby');
  assert(gLobby.you.qrToken !== jg.qrToken, 'Nouveau QR : les anciens scans ne valent plus');

  // Et on peut relancer une vraie partie derrière
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [jg.playerId]: 'hider' } });
  await wait(300);
  host.emit('pos', CENTER); g.emit('pos', NEAR);
  await wait(300);
  const again = await emit(host, 'startGame', { safetyChecked: true });
  assert(again.ok, 'La partie suivante se lance normalement');
  host.close(); g.close();
}

(async () => {
  await scenarioReplay();
  await scenarioResync();
  await scenarioTeammateDown();
  await scenarioTeammateDownByZone();
  await scenarioFinalZonePlayable();
  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
