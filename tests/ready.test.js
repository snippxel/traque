'use strict';
/* Test : la partie ne démarre pas si un joueur n'a pas autorisé le GPS.
 *
 * La position n'était vérifiée que chez l'HÔTE. Un invité ayant refusé la
 * géolocalisation pouvait rejoindre et rester invisible toute la partie — ni
 * révélable, ni capturable, ni convertible hors zone. Le groupe ne s'en
 * apercevait qu'une fois dehors.
 *
 * Le garde-fou vit sur le serveur, pas dans l'interface : c'est le principe
 * « la règle vit sur le serveur, masquer ne suffit pas ».
 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => io(URL, { transports: ['websocket'] });
const emit = (s, ev, d) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, error: 'pas de réponse du serveur' }), 4000);
  s.emit(ev, d, (r) => { clearTimeout(t); res(r); });
});
const ready = (s) => new Promise((r) => { if (s.connected) return r(); s.once('connect', r); });
let failures = 0;
const assert = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++; };

const POS = { lat: 48.8566, lng: 2.3522, accuracy: 8 };

(async () => {
  const host = connect();
  const guest = connect();
  await ready(host);
  await ready(guest);

  const created = await emit(host, 'createRoom', { name: 'HOTE' });
  await emit(guest, 'joinRoom', { code: created.code, name: 'INVITE' });
  await emit(host, 'assignRoles', { mode: 'random' });
  // L'hôte a le GPS, l'INVITÉ l'a refusé : il n'envoie AUCUNE position. C'est
  // exactement ce que le serveur doit constater, sans rien croire sur parole.
  host.emit('pos', POS);
  await wait(300);

  console.log('# L’état des appareils remonte dans le salon');
  let roster = null;
  host.on('state', (s) => { if (s.roster) roster = s.roster; });
  host.emit('ready', { gps: true, wake: true, audio: true, heading: false });
  await wait(400);
  const moi = roster && roster.find((p) => p.name === 'HOTE');
  assert(moi && moi.hasPos === true, 'La position de l’hôte est constatée par le serveur');
  assert(moi && moi.ready.heading === false, 'La boussole absente est vue comme telle');
  assert(moi && moi.ready.wake === true, 'L’écran maintenu est vu comme tel');
  const lui = roster && roster.find((p) => p.name === 'INVITE');
  assert(lui && lui.hasPos === false, 'L’invité sans position est vu sans GPS');

  console.log('# Un client MENTEUR ne débloque rien');
  // Il annonce un GPS autorisé sans jamais envoyer de position : le serveur
  // ne doit pas s'y fier. Masquer ou déclarer ne suffit pas.
  guest.emit('ready', { gps: true });
  await wait(400);

  console.log('# Le serveur REFUSE de lancer tant qu’un joueur n’a pas le GPS');
  const refus = await emit(host, 'startGame', { safetyChecked: true });
  assert(refus && refus.ok === false, 'Lancement refusé');
  assert(/GPS/i.test(refus.error || ''), 'Le refus parle du GPS (a eu : ' + refus.error + ')');
  assert(/INVITE/.test(refus.error || ''), 'Le refus NOMME le joueur en cause');

  console.log('# Une fois une position réellement reçue, la partie part');
  guest.emit('pos', POS);
  await wait(400);
  const ok = await emit(host, 'startGame', { safetyChecked: true });
  assert(ok && ok.ok === true, 'Lancement accepté (a eu : ' + (ok && ok.error) + ')');

  console.log('# Les autorisations non essentielles ne bloquent JAMAIS');
  // wake, audio et heading sont restés faux chez l'invité : la partie a démarré
  // quand même. Les rendre bloquants empêcherait de jouer sur des navigateurs
  // entiers, pour un confort dégradé mais une partie jouable.
  assert(ok && ok.ok === true, 'Écran, son et boussole manquants n’empêchent pas de jouer');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); guest.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
