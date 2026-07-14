'use strict';
/*
 * Chat global (texte libre) : un message envoyé par n'importe qui est reçu par
 * TOUS les joueurs de la salle, quel que soit leur rôle.
 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'] });
// Robuste contre la course : résout tout de suite si déjà connecté
const ready = (s) => new Promise((r) => { if (s.connected) return r(); s.once('connect', r); });
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d, (r) => res(r)));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };

(async () => {
  const host = connect();   // chasseur
  const guest = connect();  // caché
  await ready(host);
  await ready(guest);

  const created = await emit(host, 'createRoom', { name: 'CHASSEUR' });
  const joined = await emit(guest, 'joinRoom', { code: created.code, name: 'CACHE' });

  const hostMsgs = [], guestMsgs = [];
  host.on('chat', (m) => hostMsgs.push(m));
  guest.on('chat', (m) => guestMsgs.push(m));

  host.emit('assignRoles', { mode: 'manual', assignments: { [created.playerId]: 'hunter', [joined.playerId]: 'hider' } });
  await wait(150);

  // Le caché écrit : le chasseur (autre équipe) doit recevoir → chat GLOBAL
  guest.emit('chat', { text: 'salut à tous' });
  await wait(250);
  assert(hostMsgs.some((m) => m.text === 'salut à tous' && m.from === 'CACHE'), 'Message du caché reçu par le chasseur (global)');
  assert(guestMsgs.some((m) => m.text === 'salut à tous'), 'L’émetteur reçoit aussi son message');

  // Le chasseur répond : le caché doit recevoir
  host.emit('chat', { text: 'je te vois pas 😏' });
  await wait(250);
  assert(guestMsgs.some((m) => m.text === 'je te vois pas 😏' && m.from === 'CHASSEUR'), 'Message du chasseur reçu par le caché (global)');

  // Anti-spam : un message envoyé < 600 ms après le précédent est ignoré
  host.emit('chat', { text: 'spam immédiat' });
  await wait(250);
  assert(!hostMsgs.some((m) => m.text === 'spam immédiat'), 'Message spammé (< 600 ms) ignoré');

  // Message vide ignoré, message trop long tronqué à 200
  await wait(700); // laisse passer le rate-limit
  const longText = 'a'.repeat(500);
  host.emit('chat', { text: '   ' });
  host.emit('chat', { text: longText });
  await wait(250);
  assert(!hostMsgs.some((m) => m.text === ''), 'Message vide ignoré');
  const longMsg = hostMsgs.find((m) => m.from === 'CHASSEUR' && m.text[0] === 'a');
  assert(longMsg && longMsg.text.length === 200, 'Message tronqué à 200 caractères');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); guest.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
