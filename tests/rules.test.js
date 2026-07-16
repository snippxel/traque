'use strict';
/*
 * Règles de jeu du cahier des charges qui n'étaient pas couvertes :
 *  1. contrôles réservés à l'hôte, vérifiés SERVEUR (infalsifiable) ;
 *  2. répartition aléatoire ~25 % de chasseurs (min 1) ;
 *  3. la vue se recalcule immédiatement à la capture (règle centrale) ;
 *  4. conversion par sortie de zone ≠ capture "faite" par quelqu'un ;
 *  5. rétrécissement de la zone par paliers ;
 *  6. victoire des cachés au temps écoulé + stats (survie, distance, jamais pris) ;
 *  7. mode "dernier survivant" : pas de limite de temps.
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
const FAR = { lat: 48.8700, lng: 2.3700, accuracy: 6 }; // ~2 km : hors zone

const CFG = (o) => Object.assign({
  startRadius: 5000, finalRadius: 200, durationMin: 20, shrinkSteps: 2,
  revealIntervalMin: 5, graceSeconds: 10, radarUses: 3,
  dispersionSeconds: 0, startRevealSeconds: 0, lastSurvivor: false,
}, o);

// ---------------------------------------------------------------- 1 + 2
async function scenarioHostAndRoles() {
  console.log('# Contrôles hôte (vérif serveur) + répartition aléatoire');
  const socks = [];
  for (let i = 0; i < 8; i++) { const s = connect(); socks.push(s); }
  await Promise.all(socks.map(ready));
  const host = socks[0];
  const c = await emit(host, 'createRoom', { name: 'HOTE' });
  const joins = [];
  for (let i = 1; i < 8; i++) joins.push(await emit(socks[i], 'joinRoom', { code: c.code, name: 'J' + i }));
  await wait(200);

  // Un non-hôte tente de changer la config -> doit être ignoré côté serveur
  const intruder = socks[1];
  intruder.emit('updateConfig', { config: CFG({ durationMin: 99 }) });
  await wait(400);
  let st = await nextState(host, (s) => s.status === 'lobby');
  assert(st.config.durationMin !== 99, 'Un non-hôte ne peut PAS changer la config (ignoré serveur)');

  // Un non-hôte tente d'attribuer les rôles -> ignoré
  const all = {};
  st.roster.forEach((p) => { all[p.id] = 'hunter'; });
  intruder.emit('assignRoles', { mode: 'manual', assignments: all });
  await wait(400);
  st = await nextState(host, (s) => s.status === 'lobby');
  assert(st.counts.hunters !== 8, 'Un non-hôte ne peut PAS attribuer les rôles (ignoré serveur)');

  // L'hôte lance la répartition aléatoire : ~25 % de 8 = 2 chasseurs, min 1
  host.emit('assignRoles', { mode: 'random' });
  await wait(400);
  st = await nextState(host, (s) => s.status === 'lobby');
  assert(st.counts.hunters === 2, 'Répartition aléatoire : 2 chasseurs sur 8 (~25 %), a eu ' + st.counts.hunters);
  assert(st.counts.hiders === 6, 'Répartition aléatoire : 6 cachés');
  socks.forEach((s) => s.close());
}

// ---------------------------------------------------------------- 3
async function scenarioViewRecalc() {
  console.log('# La vue se recalcule immédiatement à la capture');
  const host = connect(), a = connect(), b = connect();
  await Promise.all([ready(host), ready(a), ready(b)]);
  const c = await emit(host, 'createRoom', { name: 'CHASSEUR' });
  const ja = await emit(a, 'joinRoom', { code: c.code, name: 'A' });
  const jb = await emit(b, 'joinRoom', { code: c.code, name: 'B' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [ja.playerId]: 'hider', [jb.playerId]: 'hider' } });
  host.emit('updateConfig', { config: CFG({}) });
  await wait(200);
  host.emit('pos', CENTER); a.emit('pos', NEAR); b.emit('pos', NEAR);
  await wait(300);
  await emit(host, 'startGame', { safetyChecked: true });

  // Avant capture : A (caché) voit B (caché) comme coéquipier, et aucun chasseur
  let sa = await nextState(a, (s) => s.status === 'playing' && s.teammates && s.teammates.length > 0);
  assert(sa.teammates.some((t) => t.name === 'B'), 'Avant capture : le caché A voit le caché B');
  assert(sa.signals === undefined, 'Avant capture : A (caché) ne reçoit aucun signal de chasseur');

  // Capture de A par scan
  const scan = await emit(host, 'scanQR', { token: ja.qrToken });
  assert(scan.ok, 'A est capturé au scan');

  // Après capture : A est chasseur, voit le chasseur HOST, ne voit plus le caché B
  sa = await nextState(a, (s) => s.status === 'playing' && s.you.role === 'hunter');
  assert(sa.teammates.some((t) => t.name === 'CHASSEUR'), 'Après capture : A voit désormais ses coéquipiers chasseurs');
  assert(!sa.teammates.some((t) => t.name === 'B'), 'Après capture : A ne voit PLUS le caché B en direct');
  assert(Array.isArray(sa.signals), 'Après capture : A reçoit la vue chasseur (signaux)');
  host.close(); a.close(); b.close();
}

// ---------------------------------------------------------------- 4
async function scenarioZoneNotACapture() {
  console.log('# Conversion par sortie de zone ≠ capture "faite"');
  const host = connect(), g = connect();
  await Promise.all([ready(host), ready(g)]);
  const c = await emit(host, 'createRoom', { name: 'CHASSEUR' });
  const jg = await emit(g, 'joinRoom', { code: c.code, name: 'FUYARD' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [jg.playerId]: 'hider' } });
  host.emit('updateConfig', { config: CFG({ startRadius: 200, finalRadius: 50, graceSeconds: 3 }) });
  await wait(200);
  host.emit('pos', CENTER); g.emit('pos', NEAR);
  await wait(300);
  await emit(host, 'startGame', { safetyChecked: true });
  await wait(300);

  g.emit('pos', FAR); // sort de la zone -> conversion après 3 s -> plus de cachés -> fin
  const ended = await nextState(host, (s) => s.status === 'ended');
  assert(ended.result.winner === 'hunters', 'Tous les cachés convertis -> victoire des chasseurs');
  const hunterStat = ended.result.stats.find((p) => p.name === 'CHASSEUR');
  assert(hunterStat && hunterStat.captures === 0, 'La conversion par zone ne compte PAS comme une capture du chasseur');
  host.close(); g.close();
}

// ---------------------------------------------------------------- 5
async function scenarioShrink() {
  console.log('# Rétrécissement de la zone par paliers');
  const host = connect(), g = connect();
  await Promise.all([ready(host), ready(g)]);
  const c = await emit(host, 'createRoom', { name: 'H' });
  const jg = await emit(g, 'joinRoom', { code: c.code, name: 'G' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [jg.playerId]: 'hider' } });
  // 1 min / 4 paliers -> rétrécissements à 15/30/45/60 s ; rayons 800/600/400/200
  host.emit('updateConfig', { config: CFG({ startRadius: 1000, finalRadius: 200, durationMin: 1, shrinkSteps: 4 }) });
  await wait(200);
  host.emit('pos', CENTER); g.emit('pos', NEAR);
  await wait(300);
  const t0 = Date.now();
  await emit(host, 'startGame', { safetyChecked: true });

  const s1 = await nextState(host, (s) => s.status === 'playing' && s.zone);
  assert(Math.round(s1.zone.radius) === 1000, 'Rayon de départ = 1000 m');
  assert(Math.round(s1.zone.nextRadius) === 800, 'Prochain palier annoncé à 800 m');
  const dt = s1.zone.nextShrinkAt - t0;
  assert(dt > 12000 && dt < 18000, 'Premier rétrécissement planifié à ~15 s (a eu ' + Math.round(dt / 1000) + ' s)');

  await wait(17000); // passe le 1er palier
  const s2 = await nextState(host, (s) => s.status === 'playing' && s.zone);
  assert(Math.round(s2.zone.radius) === 800, 'Après le 1er palier, le rayon est bien 800 m (a eu ' + Math.round(s2.zone.radius) + ')');
  assert(Math.round(s2.zone.nextRadius) === 600, 'Le palier suivant est annoncé à 600 m');
  host.close(); g.close();
}

// ---------------------------------------------------------------- 6 + 7
async function scenarioTimeWinAndStats() {
  console.log('# Victoire des cachés au temps + stats (≈65 s)');
  const host = connect(), g = connect();
  await Promise.all([ready(host), ready(g)]);
  const c = await emit(host, 'createRoom', { name: 'CHASSEUR' });
  const jg = await emit(g, 'joinRoom', { code: c.code, name: 'SURVIVANT' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [jg.playerId]: 'hider' } });
  host.emit('updateConfig', { config: CFG({ durationMin: 1 }) });
  await wait(200);
  host.emit('pos', CENTER); g.emit('pos', NEAR);
  await wait(300);
  await emit(host, 'startGame', { safetyChecked: true });

  const ended = await new Promise((r) => {
    const h = (s) => { if (s.status === 'ended') { host.off('state', h); r(s); } };
    host.on('state', h);
    setTimeout(() => r(null), 70000);
  });
  assert(ended, 'La partie se termine bien au temps écoulé');
  if (ended) {
    assert(ended.result.winner === 'hiders', 'Temps écoulé avec un caché en vie -> victoire des cachés');
    const st = ended.result.stats.find((p) => p.name === 'SURVIVANT');
    assert(st && st.neverCaught === true, 'Stats : le survivant est marqué "jamais attrapé"');
    assert(st && st.survivedMs > 55000, 'Stats : temps de survie ≈ la durée de la partie');
    assert(st && typeof st.distance === 'number', 'Stats : distance parcourue présente');
    assert(st && st.startRole === 'hider', 'Stats : rôle de départ conservé');
  }
  host.close(); g.close();
}

async function scenarioLastSurvivor() {
  console.log('# Mode "dernier survivant" : pas de limite de temps');
  const host = connect(), g = connect();
  await Promise.all([ready(host), ready(g)]);
  const c = await emit(host, 'createRoom', { name: 'H' });
  const jg = await emit(g, 'joinRoom', { code: c.code, name: 'G' });
  host.emit('assignRoles', { mode: 'manual', assignments: { [c.playerId]: 'hunter', [jg.playerId]: 'hider' } });
  host.emit('updateConfig', { config: CFG({ lastSurvivor: true }) });
  await wait(200);
  host.emit('pos', CENTER); g.emit('pos', NEAR);
  await wait(300);
  await emit(host, 'startGame', { safetyChecked: true });
  const s = await nextState(host, (x) => x.status === 'playing');
  assert(s.config.lastSurvivor === true, 'Mode dernier survivant actif');
  assert(s.timeLeft === null, 'Aucune limite de temps envoyée (timeLeft null)');
  host.close(); g.close();
}

(async () => {
  await scenarioHostAndRoles();
  await scenarioViewRecalc();
  await scenarioZoneNotACapture();
  await scenarioLastSurvivor();
  await scenarioShrink();
  await scenarioTimeWinAndStats();
  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT ✓' : failures + ' ÉCHEC(S) ✗'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
