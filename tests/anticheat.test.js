'use strict';
/* Test anti-triche : aucune élimination ni usurpation à distance.
 *
 * Deux attaques fonctionnaient, sans outil particulier :
 *   1. L'identifiant de SESSION de chaque joueur circulait chez tout le monde
 *      (liste du salon, chaque message de chat, signaux, coéquipiers). Avec lui,
 *      `resume` rendait la session de la victime — donc son QR — et un chasseur
 *      l'éliminait sans jamais l'approcher.
 *   2. Un caché qui verrouille son téléphone est déconnecté. Rejoindre la partie
 *      sous son NOM rendait sa place, son QR compris, à n'importe qui.
 * Plus deux règles qui en découlent : le radar ne doit pas ignorer un caché
 * déconnecté (couper son téléphone rendait invisible), et la même personne
 * revenant du MÊME appareil récupère sa place sans formalité.
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
const P_LOIN = { lat: 48.8580, lng: 2.3540, accuracy: 8 }; // ~200 m

(async () => {
  const H = connect(), A = connect(), B = connect();
  await Promise.all([ready(H), ready(A), ready(B)]);

  // Tout ce que le chasseur reçoit, quel que soit le canal
  const recu = [];
  H.onAny((ev, ...args) => recu.push(JSON.stringify([ev, args])));

  const h = await emit(H, 'createRoom', { name: 'CHASSEUR', deviceId: 'dev-h' });
  const a = await emit(A, 'joinRoom', { code: h.code, name: 'ALICE', deviceId: 'dev-a' });
  const b = await emit(B, 'joinRoom', { code: h.code, name: 'BOB', deviceId: 'dev-b' });

  let chatFromId = null;
  H.on('chat', (m) => { chatFromId = m.fromId; });

  H.emit('pos', P); A.emit('pos', P); B.emit('pos', P_LOIN);
  H.emit('assignRoles', { mode: 'manual', assignments: { [h.playerId]: 'hunter', [a.playerId]: 'hider', [b.playerId]: 'hider' } });
  H.emit('updateConfig', { config: { dispersionSeconds: 0, startRevealSeconds: 0, durationMin: 5 } });
  A.emit('chat', { text: 'salut' });
  await wait(1800);

  const st = await emit(H, 'startGame', { safetyChecked: true });
  assert(st && st.ok, 'Partie lancée');
  await wait(1800);

  console.log('# Aucun identifiant de session ne sort du serveur');
  const tout = recu.join('\n');
  assert(!tout.includes(a.playerId), 'Le chasseur n’a jamais reçu la session d’ALICE');
  assert(!tout.includes(b.playerId), 'Le chasseur n’a jamais reçu la session de BOB');
  assert(!tout.includes(a.qrToken) && !tout.includes(b.qrToken), 'Le chasseur n’a jamais reçu un QR de caché');
  assert(!!chatFromId && chatFromId !== a.playerId, 'Le chat désigne l’auteur par un identifiant public');

  console.log('# Attaque 1 : reprendre la session avec l’identifiant vu dans le chat');
  const H2 = connect(); await ready(H2);
  const vol = await emit(H2, 'resume', { code: h.code, playerId: chatFromId });
  assert(vol && vol.ok === false, 'La reprise avec l’identifiant public est refusée');
  assert(!(vol && vol.qrToken), 'Aucun QR rendu');

  console.log('# Attaque 2 : prendre la place de BOB par son nom, depuis un autre appareil');
  let demande = null;
  H.on('reclaim:request', (r) => { demande = r; });
  B.close();
  await wait(600);
  const H3 = connect(); await ready(H3);
  let resultatH3 = null;
  H3.on('reclaim:result', (r) => { resultatH3 = r; });
  const rec = await emit(H3, 'joinRoom', { code: h.code, name: 'bob', deviceId: 'dev-pirate' });
  assert(rec && rec.ok === false && rec.pending === true, 'La reprise par le nom attend la validation de l’hôte');
  assert(!(rec && rec.qrToken), 'Aucun QR rendu avant validation');
  await wait(300);
  assert(demande && demande.name === 'BOB', 'L’hôte reçoit la demande, avec le nom du joueur');
  const refus = await emit(H, 'reclaim:answer', { reqId: demande && demande.reqId, accept: false });
  assert(refus && refus.ok, 'L’hôte peut refuser');
  await wait(300);
  assert(resultatH3 && resultatH3.ok === false, 'Le demandeur est informé du refus, sans QR');

  console.log('# Le vrai BOB revient du même téléphone : place rendue sans formalité');
  const B2 = connect(); await ready(B2);
  const retour = await emit(B2, 'joinRoom', { code: h.code, name: 'BOB', deviceId: 'dev-b' });
  assert(retour && retour.ok && retour.reclaimed, 'Même appareil : place reprise directement');
  assert(retour && retour.qrToken === b.qrToken, 'Même QR qu’avant');

  console.log('# Le radar ne laisse pas un caché déconnecté devenir invisible');
  A.close();
  await wait(600);
  const radar = await new Promise((res) => {
    H.once('radar:result', (r) => res(r));
    H.emit('useRadar', {}, (r) => { if (!r || !r.ok) res(null); });
  });
  assert(radar && radar.name === 'ALICE', 'Le radar trouve ALICE (la plus proche) même téléphone éteint');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  for (const s of [H, H2, H3, B2]) s.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
