'use strict';
/*
 * Modération du chat : filtrage, signalement, blocage.
 *
 * Les trois recours exigés pour un chat en texte libre ouvert au public. Le
 * point qui compte vraiment ici est le blocage : il doit couper à L'ÉMISSION,
 * pas à l'affichage. Un test qui vérifierait seulement que le message n'est pas
 * visible laisserait passer une implémentation où il arrive quand même sur
 * l'appareil — c'est-à-dire une implémentation qui ne bloque rien.
 */
const { io } = require('socket.io-client');
const { censurer } = require('../game');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'] });
const ready = (s) => new Promise((r) => { if (s.connected) return r(); s.once('connect', r); });
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d, (r) => res(r)));
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };

(async () => {
  // --- Filtre, hors réseau : c'est une fonction pure, on la teste comme telle
  assert(censurer('espèce de connard').texte.includes('█'), 'Insulte censurée');
  assert(censurer('c0nn4rd').texte.includes('█'), 'Insulte déguisée en chiffres censurée');
  assert(censurer('connnnnard').texte.includes('█'), 'Lettres répétées censurées');
  assert(censurer('ta gueule').texte.includes('█'), 'Insulte en deux mots censurée');
  assert(censurer('rendez-vous au second point').texte === 'rendez-vous au second point', '« second » n’est pas censuré');
  assert(censurer('je pars en reconnaissance').texte === 'je pars en reconnaissance', '« reconnaissance » n’est pas censuré');
  assert(censurer('il est rapide').texte === 'il est rapide', '« rapide » n’est pas censuré');
  assert(censurer('').censure === false, 'Message vide : rien à censurer');

  const a = connect(); const b = connect(); const c = connect();
  await ready(a); await ready(b); await ready(c);

  const salle = await emit(a, 'createRoom', { name: 'ALPHA', deviceId: 'appareil-de-test-alpha' });
  const jB = await emit(b, 'joinRoom', { code: salle.code, name: 'BRAVO', deviceId: 'appareil-de-test-bravo' });
  await emit(c, 'joinRoom', { code: salle.code, name: 'CHARLIE', deviceId: 'appareil-de-test-charlie' });

  const recusA = [], recusC = [];
  a.on('chat', (m) => recusA.push(m));
  c.on('chat', (m) => recusC.push(m));
  await wait(150);

  // --- Filtrage de bout en bout
  b.emit('chat', { text: 'salut bande de connards' });
  await wait(300);
  const filtre = recusA.find((m) => m.from === 'BRAVO');
  assert(!!filtre && filtre.text.includes('█'), 'Insulte censurée avant diffusion');
  assert(!!filtre && !!filtre.id && !!filtre.fromId, 'Le message porte un id et un fromId');

  // --- Signalement
  const rapport = await emit(a, 'chat:report', { id: filtre.id });
  assert(rapport && rapport.ok === true, 'Signalement accepté');
  const fantome = await emit(a, 'chat:report', { id: 'inexistant' });
  assert(fantome && fantome.ok === false, 'Signalement d’un message inconnu refusé');

  // --- Blocage : A bloque B. C, lui, ne bloque personne.
  const bloc = await emit(a, 'chat:block', { playerId: jB.playerId, bloquer: true });
  assert(bloc && bloc.ok === true, 'Blocage accepté');

  await wait(700); // laisse passer l'anti-spam de B
  const avantA = recusA.length, avantC = recusC.length;
  b.emit('chat', { text: 'toujours la' });
  await wait(350);
  assert(recusA.length === avantA, 'Le bloqueur ne reçoit RIEN de la personne bloquée');
  assert(recusC.length > avantC, 'Les autres joueurs continuent de la recevoir');

  // --- Le blocage vaut aussi pour le rejeu à la reconnexion
  // Il faut du fil NON bloqué pour que le test ait un sens : sans message de
  // Charlie, un historique vide passerait pour un filtrage réussi alors qu'il
  // ne prouverait rien du tout.
  c.emit('chat', { text: 'position tenue' });
  await wait(300);
  const histo = [];
  a.on('chat:history', (l) => histo.push(...l));
  const repris = await emit(a, 'resume', { code: salle.code, playerId: salle.playerId });
  assert(repris && repris.ok === true, 'Reprise de session acceptée');
  await wait(300);
  assert(histo.some((m) => m.from === 'CHARLIE'), 'L’historique rejoué contient bien les messages non bloqués');
  assert(!histo.some((m) => m.fromId === jB.playerId), 'L’historique rejoué ne contient aucun message de la personne bloquée');

  // --- Déblocage
  const debloc = await emit(a, 'chat:block', { playerId: jB.playerId, bloquer: false });
  assert(debloc && debloc.ok === true, 'Déblocage accepté');
  await wait(700);
  const avant2 = recusA.length;
  b.emit('chat', { text: 'de retour' });
  await wait(350);
  assert(recusA.length > avant2, 'Après déblocage, les messages repassent');

  // --- On ne peut pas se bloquer soi-même
  const soi = await emit(a, 'chat:block', { playerId: salle.playerId, bloquer: true });
  assert(soi && soi.ok === false, 'Se bloquer soi-même est refusé');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  a.close(); b.close(); c.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
