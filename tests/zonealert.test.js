'use strict';
/* Test : l'échéance de conversion hors-zone doit être portée par l'ÉTAT.
 *
 * Vécu en partie réelle : un joueur sort de la zone, ne reçoit aucune alerte,
 * puis se fait éliminer sans comprendre pourquoi. Cause : `zone:alert` était
 * émis UNE SEULE FOIS, sur la transition dedans -> dehors. Ce message perdu —
 * socket absent une fraction de seconde, reconnexion en cours — le délai de
 * grâce courait quand même et la conversion tombait en silence.
 *
 * Le correctif ne consiste pas à réémettre l'événement, mais à mettre
 * l'échéance dans l'état : un client qui rate l'événement, ou qui se
 * reconnecte au milieu du délai, la retrouve au tick suivant.
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

const CENTRE = { lat: 48.8566, lng: 2.3522, accuracy: 5 };
const LOIN = { lat: 48.8700, lng: 2.3700, accuracy: 5 }; // ~2 km

(async () => {
  const host = connect();
  const guest = connect();
  await ready(host);
  await ready(guest);

  const created = await emit(host, 'createRoom', { name: 'CHASSEUR' });
  const joined = await emit(guest, 'joinRoom', { code: created.code, name: 'FUYARD' });
  await emit(host, 'updateConfig', { config: { graceSeconds: 20, dispersionSeconds: 1, startRadius: 200 } });
  await emit(host, 'assignRoles', { mode: 'manual', assignments: { [created.playerId]: 'hunter', [joined.playerId]: 'hider' } });
  host.emit('pos', CENTRE); guest.emit('pos', CENTRE);
  await wait(400);
  const lance = await emit(host, 'startGame', { safetyChecked: true });
  assert(lance && lance.ok, 'Partie lancée');
  await wait(1600); // fin de dispersion

  console.log('# Le fuyard sort de la zone');
  // On IGNORE volontairement l'événement zone:alert : on simule un client qui
  // ne l'a jamais reçu. Seul l'état doit suffire.
  let etat = null;
  guest.on('state', (s) => { etat = s; });
  guest.emit('pos', LOIN);
  await wait(2500);

  assert(etat && etat.you, 'Le fuyard reçoit son état');
  assert(etat && etat.you.outOfZoneUntil != null, 'L’état porte l’échéance de conversion');
  const reste = etat && etat.you.outOfZoneUntil ? etat.you.outOfZoneUntil - Date.now() : -1;
  assert(reste > 0 && reste <= 20000, 'L’échéance est dans le délai de grâce (reste ' + Math.round(reste / 1000) + ' s)');

  console.log('# Un client qui se reconnecte au milieu du délai la retrouve');
  guest.disconnect();
  await wait(600);
  const retour = connect();
  await ready(retour);
  let etatRetour = null;
  retour.on('state', (s) => { etatRetour = s; });
  await emit(retour, 'resume', { code: created.code, playerId: joined.playerId });
  retour.emit('pos', LOIN);
  await wait(2200);
  assert(etatRetour && etatRetour.you.outOfZoneUntil != null,
    'Après reconnexion, l’échéance est toujours dans l’état');

  console.log('# Le retour dans la zone efface l’échéance');
  retour.emit('pos', CENTRE);
  await wait(2200);
  assert(etatRetour && etatRetour.you.outOfZoneUntil == null, 'Rentré : plus d’échéance');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  host.close(); retour.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
