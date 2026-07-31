'use strict';
/* Test : un message envoyé pendant qu'un joueur est hors réseau doit lui être
 * rejoué à sa reconnexion.
 *
 * Scénario vécu en partie réelle : le PC écrivait, le téléphone — qui venait de
 * perdre le réseau et mettait du temps à revenir — ne voyait jamais ces
 * messages, alors que l'inverse fonctionnait. Le chat était diffusé aux seuls
 * joueurs connectés à l'instant T et n'était jamais rejoué, contrairement à
 * l'état du jeu qui se rattrape au tick suivant.
 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'] });
// Délai de garde : un événement mal nommé n'a pas de gestionnaire, donc pas
// d'accusé — sans ça le test se fige au lieu d'échouer.
const emit = (s, ev, d) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, error: 'pas de réponse du serveur' }), 4000);
  s.emit(ev, d, (r) => { clearTimeout(t); res(r); });
});
const ready = (s) => new Promise((r) => { if (s.connected) return r(); s.once('connect', r); });
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };

(async () => {
  const host = connect();
  const guest = connect();
  await ready(host);
  await ready(guest);

  const created = await emit(host, 'createRoom', { name: 'PC' });
  const joined = await emit(guest, 'joinRoom', { code: created.code, name: 'TEL' });
  assert(created.ok && joined.ok, 'Salle créée et rejointe');

  console.log('# Le message parvient au joueur connecté');
  let recuEnDirect = null;
  guest.on('chat', (m) => { recuEnDirect = m; });
  host.emit('chat', { text: 'premier message' });
  await wait(400);
  assert(recuEnDirect && recuEnDirect.text === 'premier message', 'Message reçu en direct');

  console.log('# Le joueur perd le réseau, l’autre continue d’écrire');
  guest.disconnect();
  await wait(300);
  host.emit('chat', { text: 'pendant la coupure' });
  await wait(700); // au-delà de l'anti-spam de 600 ms
  host.emit('chat', { text: 'toujours pendant la coupure' });
  await wait(400);

  console.log('# À la reconnexion, il retrouve ce qu’il a manqué');
  const retour = connect();
  await ready(retour);
  const recu = [];
  retour.on('chat:history', (liste) => { for (const m of liste) recu.push(m.text); });
  const rep = await emit(retour, 'resume', { code: created.code, playerId: joined.playerId });
  assert(rep.ok, 'Reprise de session acceptée');
  await wait(500);

  assert(recu.includes('pendant la coupure'), 'Le message manqué est rejoué');
  assert(recu.includes('toujours pendant la coupure'), 'Le second message manqué aussi');
  assert(recu.includes('premier message'), 'Le fil complet est restitué, pas seulement le manquant');

  console.log('# Le fil repart à zéro quand la partie est lancée');
  // Deux joueurs, un de chaque rôle, sinon le lancement est refusé.
  await emit(host, 'assignRoles', { mode: 'random' });
  const pos = { lat: 48.8566, lng: 2.3522, accuracy: 8 };
  host.emit('pos', pos); retour.emit('pos', pos);
  await wait(300);
  const lance = await emit(host, 'startGame', { safetyChecked: true });
  await wait(300);
  const tard = connect();
  await ready(tard);
  let histoApres = null;
  tard.on('chat:history', (liste) => { histoApres = liste; });
  await emit(tard, 'resume', { code: created.code, playerId: joined.playerId });
  await wait(400);
  assert(lance && lance.ok, 'Partie lancée');
  assert(histoApres === null, 'Le bavardage du salon n’est pas rejoué en pleine chasse');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); guest.close(); retour.close(); tard.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
