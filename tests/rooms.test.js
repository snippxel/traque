'use strict';
/* Test : un socket ne tient qu'UNE place, et créer une partie coûte quelque chose.
 *
 * `createRoom` est le seul point d'entrée qui alloue de la mémoire sans qu'on ait
 * rien à prouver — pas de compte, pas d'auth, un lien public. Deux trous s'y
 * touchaient :
 *
 *   1. Rattacher un socket à une nouvelle salle ne libérait pas l'ancienne. Le
 *      joueur laissé derrière restait marqué `connected` avec un socketId mort,
 *      donc sa salle ne se vidait jamais, donc n'était jamais supprimée — et
 *      continuait d'être tickée toutes les 1,5 s à vie. Mesuré avant correction :
 *      50 créations sur un seul socket → 49 salles orphelines permanentes.
 *   2. Rien ne limitait la cadence : la boucle tenait dans une ligne.
 *
 * On sonde des CODES précis, jamais le compteur de /health : les autres suites
 * laissent des salles en fenêtre de grâce qui expirent pendant notre attente, et
 * un test qui compte un total partagé mesure surtout le bruit des voisins.
 * La sonde est `resume` avec un playerId bidon — elle distingue « salle absente »
 * de « salle présente » sans rien y ajouter, contrairement à un joinRoom qui
 * ressusciterait la salle qu'il vient d'observer.
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

// Le frein serveur est à 1,5 s ; on prend un peu de marge.
const COOLDOWN_MS = 1700;

// true = la salle existe encore côté serveur.
async function exists(sonde, code) {
  const r = await emit(sonde, 'resume', { code, playerId: 'ce-joueur-nexiste-pas' });
  return /Session expirée/.test((r && r.error) || '');
}

(async () => {
  const s = connect();
  const sonde = connect();
  await ready(s);
  await ready(sonde);

  console.log('# Une rafale de créations est refusée');
  const codes = [];
  for (let i = 0; i < 20; i++) {
    const res = await emit(s, 'createRoom', { name: 'RAFALE' + i });
    if (res && res.ok) codes.push(res.code);
  }
  assert(codes.length === 1, 'Une seule création passe sur 20 tentatives d’affilée (a eu ' + codes.length + ')');

  console.log('# Créer une deuxième partie libère la première');
  await wait(COOLDOWN_MS);
  const deux = await emit(s, 'createRoom', { name: 'DEUX' });
  assert(deux && deux.ok === true, 'La création espacée est acceptée');
  if (deux && deux.ok) codes.push(deux.code);
  await wait(COOLDOWN_MS);
  const trois = await emit(s, 'createRoom', { name: 'TROIS' });
  assert(trois && trois.ok === true, 'La troisième aussi');
  if (trois && trois.ok) codes.push(trois.code);

  const avant = [];
  for (const c of codes) avant.push(await exists(sonde, c));
  assert(avant.every(Boolean), 'Les trois salles existent encore (fenêtre de grâce en cours)');

  console.log('# Aucune ne survit à la fenêtre de grâce');
  // Le tick tourne toutes les 1,5 s et la grâce en salon est de 90 s. Les places
  // rendues par les deux premières créations expirent avec la dernière, celle que
  // la déconnexion vient de libérer. Avant correction, seule cette dernière
  // repartait : les deux autres tenaient jusqu'au redémarrage du serveur.
  s.disconnect();
  await wait(95000);
  const restantes = [];
  for (let i = 0; i < codes.length; i++) {
    if (await exists(sonde, codes[i])) restantes.push(codes[i]);
  }
  assert(restantes.length === 0, 'Toutes les salles ouvertes par ce socket ont disparu (restait : ' + (restantes.join(', ') || 'aucune') + ')');

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  s.close(); sonde.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
