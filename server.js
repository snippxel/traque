'use strict';

/*
 * server.js — Express + Socket.io.
 * Sert le front statique et pilote les parties (game.js). Aucune persistance :
 * tout vit en RAM le temps d'une partie et disparaît quand la salle se vide.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const {
  GameManager,
  CHAT_MAX_LEN,
  RECONNECT_GRACE_MS,
  RECONNECT_GRACE_PLAYING_MS,
  FLASH_MS,
  ZONE_TOLERANCE_MAX_M,
  POS_STALE_MS,
  POS_LOST_MAX_MS,
  LOBBY_KEEP_MS,
  HOST_AWAY_MS,
  censurer,
} = require('./game');
const { randomUUID } = require('crypto');
const tele = require('./telemetrie');

const app = express();
const server = http.createServer(app);
// pings rapprochés : sur mobile une connexion peut mourir sans que rien ne le
// signale. Des pings courts détectent la coupure en ~12 s au lieu de ~45 s,
// ce qui déclenche la reconnexion (et donc le resume) bien plus tôt.
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 8000,
  pingTimeout: 12000,
});

// Compression : 409 ko partaient sur le fil sans être compressés, alors qu'un
// joueur ouvre le lien partagé sur le terrain, en 4G incertaine. style.css et
// app.js tombent à ~un quart. Chargement tolérant : si le module manque
// (installation partielle), le serveur démarre quand même, sans compression —
// jamais un écran blanc pour une dépendance d'optimisation.
try { app.use(require('compression')()); }
catch (_) { console.warn('compression indisponible — réponses non compressées'); }

// Cache : le service worker est en network-first et sert explicitement à ne
// JAMAIS figer une version périmée. Une durée de vie longue sur la coquille
// entrerait en conflit direct avec ça — un déploiement en pleine soirée de jeu
// ne toucherait plus les téléphones. On ne met donc en cache long que ce qui ne
// change jamais (libs et icônes), et on revalide tout le reste : un 304 coûte
// un aller-retour d'en-têtes, pas 110 ko.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    const long = /[\\/](vendor|icons)[\\/]/.test(filePath);
    res.setHeader('Cache-Control', long ? 'public, max-age=604800, immutable' : 'no-cache');
  },
}));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: gm.rooms.size }));

// Remontée des plantages côté téléphone. Corps minuscule et volontairement
// plafonné : ce point d'entrée est public, il ne doit pouvoir ni saturer la
// mémoire ni servir de mégaphone. Il ne reçoit que ce qu'il faut pour
// reproduire — jamais de position, jamais de nom de joueur.
app.post('/client-error', express.json({ limit: '4kb' }), (req, res) => {
  const b = req.body || {};
  tele.noteErreur({
    source: 'client',
    message: b.message,
    ou: b.ou,
    code: b.code,
    appareil: String(req.get('user-agent') || '').slice(0, 160),
  });
  res.status(204).end();
});

// Le tableau de bord : des nombres, pas des personnes. Ouvert par défaut pour
// être consultable depuis un téléphone en trente secondes ; définir ADMIN_KEY
// sur l'hébergeur le referme sans rien changer d'autre.
app.get('/stats', (req, res) => {
  const cle = process.env.ADMIN_KEY;
  if (cle && req.query.key !== cle) return res.status(404).end();
  res.json(tele.resume());
});

const gm = new GameManager();

// Plafonds de la salle des machines. Voir le handler `createRoom` pour le pourquoi.
const MAX_ROOMS = 500;
const CREATE_COOLDOWN_MS = 1500;

// Index socketId -> { code, playerId } pour retrouver le joueur à la déconnexion
const socketIndex = new Map();

// ----------------------------------------------------------------------------
// Helpers d'émission
// ----------------------------------------------------------------------------
// Rejoue le fil de discussion à un socket qui arrive ou revient. L'état du jeu
// se rattrapait déjà tout seul au tick suivant ; le chat, lui, ne se rattrapait
// jamais — un joueur qui perdait le réseau ne voyait plus jamais ce qui avait
// été dit pendant sa coupure.
function sendChatHistory(socket, room, player) {
  if (!room.chat || !room.chat.length) return;
  // Un blocage vaut aussi pour le rejeu : sinon la moindre reconnexion
  // ressert au joueur tout ce qu'il avait justement choisi de ne plus voir.
  const bloques = player && player.blocked;
  const fil = bloques && bloques.size
    ? room.chat.filter((m) => !bloques.has(m.fromId))
    : room.chat;
  if (fil.length) io.to(socket.id).emit('chat:history', fil);
}

function emitStateToRoom(room) {
  // Isolation par joueur : si stateFor() plante pour l'un d'eux, les autres
  // reçoivent quand même leur état (sinon toute la salle se fige en silence).
  for (const p of room.players.values()) {
    if (!p.connected || !p.socketId) continue;
    try {
      const s = room.stateFor(p.id);
      if (s) io.to(p.socketId).emit('state', s);
    } catch (err) {
      console.error(`[state] échec pour le joueur ${p.name} (${p.id}) salle ${room.code} :`, err);
    }
  }
}

function socketOfPlayer(p) {
  return p.connected && p.socketId ? io.to(p.socketId) : null;
}

// ----------------------------------------------------------------------------
// Boucle de jeu (tick régulier) — diffusion groupée toutes les 1.5s
// ----------------------------------------------------------------------------
const TICK_MS = 1500;
setInterval(() => {
  const now = Date.now();
  for (const room of gm.rooms.values()) {
    // Une salle en erreur ne doit JAMAIS empêcher les autres salles (ni les
    // ticks suivants) de continuer à recevoir leurs mises à jour.
    try {
      // Nettoyage des joueurs déconnectés au-delà de la fenêtre de grâce.
      // En pleine partie la fenêtre est très longue : on préfère garder la place
      // d'un joueur qui a perdu le réseau plutôt que de casser la partie.
      // En salon, la place d'un joueur qui a verrouillé son téléphone est gardée
      // 10 min TANT QUE quelqu'un est encore connecté. Une salle où plus personne
      // ne l'est garde la purge courte : c'est ce qui protège la mémoire.
      const someoneOn = [...room.players.values()].some((p) => p.connected);
      const grace = room.status === 'playing'
        ? RECONNECT_GRACE_PLAYING_MS
        : (someoneOn ? LOBBY_KEEP_MS : RECONNECT_GRACE_MS);
      for (const p of [...room.players.values()]) {
        if (!p.connected && p.disconnectAt && now - p.disconnectAt > grace) {
          room.removePlayer(p.id);
        }
      }
      // Salle vide -> suppression (aucune persistance)
      if (room.players.size === 0) {
        gm.deleteRoom(room.code);
        continue;
      }
      // Réattribution de l'hôte : parti, OU hors ligne depuis 30 s alors que
      // d'autres sont là. Un hôte au téléphone verrouillé bloquait tout le
      // salon : personne d'autre ne pouvait lancer, régler ou valider.
      const host = room.players.get(room.hostId);
      const hostAway = !host || (!host.connected && host.disconnectAt && now - host.disconnectAt > HOST_AWAY_MS);
      if (hostAway) {
        const next = [...room.players.values()].find((p) => p.connected);
        if (next) room.hostId = next.id;
        else if (!host) room.hostId = [...room.players.values()][0].id;
      }
      // Demandes de reprise de place expirées (hôte qui n'a jamais répondu)
      expireReclaims(room, now);

      if (room.status === 'playing') {
        tickGame(room, now);
      }
      // Une partie peut se terminer dans tickGame comme au scan d'un QR : on
      // constate la bascule ici plutôt que d'aller poser un compteur dans
      // chacun des chemins qui peuvent conclure une partie.
      if (room.status === 'ended' && !room.statTerminee) {
        room.statTerminee = true;
        tele.partieTerminee(room.startTime ? Date.now() - room.startTime : 0);
      }
      // Diffusion groupée : un seul envoi d'état par tick, quel que soit le statut
      emitStateToRoom(room);
    } catch (err) {
      console.error(`[tick] erreur dans la salle ${room.code} :`, err);
    }
  }
}, TICK_MS);

function tickGame(room, now) {
  room.pruneTempReveals(now);

  // Révélations périodiques
  if (room.nextRevealAt && now >= room.nextRevealAt) {
    room.snapshotReveals();
    room.nextRevealAt = now + room.config.revealIntervalMin * 60 * 1000;
  }

  // Phase de départ : ni rétrécissement, ni conversion hors-zone, ni alerte de zone.
  // Les cachés fuient tranquillement, seule la visibilité live du chasseur est active.
  if (room.inDispersion(now)) return;

  const radius = room.currentRadius(now);

  // Alerte "la zone va se fermer" : ~1 min avant chaque rétrécissement, une seule
  // fois, et UNIQUEMENT aux cachés qui ne sont pas déjà dans la prochaine zone.
  const next = room.nextShrink(now);
  if (next && next.atTime - now <= 60000 && !room.shrinkWarned.has(next.atTime)) {
    room.shrinkWarned.add(next.atTime);
    for (const p of room.players.values()) {
      if (p.role !== 'hider' || !p.pos || !p.connected || !p.socketId) continue;
      const tol = Math.min(p.pos.accuracy || 0, ZONE_TOLERANCE_MAX_M);
      if (room.distanceFromCenter(p.pos) - tol > next.radius) {
        io.to(p.socketId).emit('zone:closing', { atTime: next.atTime, radius: Math.round(next.radius) });
      }
    }
  }

  // Sorties de zone (cachés uniquement)
  for (const p of room.players.values()) {
    if (p.role !== 'hider' || !p.pos) continue;

    // Position périmée (écran verrouillé, tunnel, GPS coupé) : on ne juge pas
    // un joueur sur l'endroit où il était il y a deux minutes. La conversion
    // est SUSPENDUE, et à son retour il récupère un délai de grâce complet s'il
    // est toujours dehors. Au-delà de 2 min sans signal, plus de pause : sans
    // ce plafond, couper son GPS hors zone rendrait intouchable.
    const age = now - (p.pos.time || 0);
    if (age > POS_STALE_MS && age <= POS_LOST_MAX_MS) {
      if (p.outOfZoneSince != null) p.zonePause = true;
      continue;
    }
    if (p.zonePause) {
      p.zonePause = false;
      // De retour avec un point frais : le compte à rebours repart de zéro.
      if (p.outOfZoneSince != null && age <= POS_STALE_MS) p.outOfZoneSince = null;
    }

    const dist = room.distanceFromCenter(p.pos);
    // Marge d'incertitude GPS : on ne convertit pas sur du bruit. Un joueur n'est
    // "hors zone" que s'il l'est même en tenant compte de sa précision GPS.
    const tolerance = Math.min(p.pos.accuracy || 0, ZONE_TOLERANCE_MAX_M);
    const outside = dist - tolerance > radius;

    if (outside && p.outOfZoneSince == null) {
      // Transition dedans -> dehors
      p.outOfZoneSince = now;
      const deadline = now + room.config.graceSeconds * 1000;
      const sock = socketOfPlayer(p);
      if (sock) sock.emit('zone:alert', { deadline, graceSeconds: room.config.graceSeconds });
      // Flash chez les chasseurs : nom + position exacte (seule exception hors cycle)
      flashHunters(room, p);
    } else if (!outside && p.outOfZoneSince != null) {
      // Retour à temps
      p.outOfZoneSince = null;
      const sock = socketOfPlayer(p);
      if (sock) sock.emit('zone:alertCancelled');
    } else if (outside && p.outOfZoneSince != null) {
      // Toujours dehors : conversion si le délai de grâce est dépassé
      if (now - p.outOfZoneSince >= room.config.graceSeconds * 1000) {
        // On prévient les cachés AVANT la conversion : après, le joueur est
        // chasseur et ne fait plus partie de leur équipe.
        notifyHidersOfCapture(room, p, 'zone', null);
        room.convert(p, 'zone');
        const sock = socketOfPlayer(p);
        if (sock) sock.emit('converted', { reason: 'zone' });
      }
    }
  }

  room.checkEnd(now);
}

// Un caché vient de tomber : on prévient ses ex-coéquipiers encore en course,
// avec le lieu exact de la capture — c'est une information tactique (zone
// dangereuse, chasseur dans le secteur) et un vrai moment de jeu.
function notifyHidersOfCapture(room, victim, reason, byName) {
  const pos = victim.pos ? { lat: victim.pos.lat, lng: victim.pos.lng } : null;
  // Comptage fiable : on exclut toujours la victime explicitement. Selon la
  // cause, elle est déjà convertie (scan) ou pas encore (hors-zone) — sans ça,
  // le nombre de cachés restants serait faux dans l'un des deux cas.
  let hidersLeft = 0;
  for (const p of room.players.values()) {
    if (p.role === 'hider' && p.id !== victim.id) hidersLeft++;
  }
  const payload = {
    name: victim.name, reason, by: byName || null,
    lat: pos && pos.lat, lng: pos && pos.lng, hidersLeft,
  };
  for (const p of room.players.values()) {
    if (p.role !== 'hider' || p.id === victim.id) continue;
    if (p.connected && p.socketId) io.to(p.socketId).emit('teammate:down', payload);
  }
}

function flashHunters(room, hider) {
  if (!hider.pos) return;
  room.addTempReveal(hider, 'flash', FLASH_MS);
  const payload = { name: hider.name, lat: hider.pos.lat, lng: hider.pos.lng, kind: 'flash' };
  for (const h of room.players.values()) {
    if (h.role === 'hunter' && h.connected && h.socketId) {
      io.to(h.socketId).emit('hunter:flash', payload);
    }
  }
}

// ----------------------------------------------------------------------------
// Socket.io
// ----------------------------------------------------------------------------
io.on('connection', (socket) => {
  // --- Création de partie ---
  socket.on('createRoom', ({ name, deviceId } = {}, cb) => {
    // Seul point d'entrée qui alloue de la mémoire sans qu'on ait rien à
    // prouver : pas de compte, pas d'auth, un lien de partage public. N'importe
    // qui peut ouvrir un socket et boucler.
    // C'est le PLAFOND qui protège réellement l'instance (Render tier gratuit,
    // 512 Mo) : il tient quel que soit le nombre de sockets. Le frein, lui, est
    // par socket — on en ouvre d'autres, il ne prétend pas à mieux ; il évite
    // simplement qu'une boucle distraite y arrive en une seconde.
    // 500 salles, c'est déjà cinquante fois un samedi soir chargé.
    if (gm.rooms.size >= MAX_ROOMS) {
      return ack(cb, { ok: false, error: 'Serveur saturé, réessaie dans un instant.' });
    }
    const now = Date.now();
    if (now - (socket.data.lastCreateAt || 0) < CREATE_COOLDOWN_MS) {
      return ack(cb, { ok: false, error: 'Attends une seconde avant de recréer une partie.' });
    }
    socket.data.lastCreateAt = now;

    const room = gm.createRoom();
    const player = room.addPlayer(name, deviceId);
    player.socketId = socket.id;
    bind(socket, room.code, player.id);
    tele.partieCreee();
    tele.appareilVu(deviceId);
    ack(cb, { ok: true, code: room.code, playerId: player.id, qrToken: player.qrToken });
    sendChatHistory(socket, room, player);
    emitStateToRoom(room);
  });

  // --- Rejoindre une partie (ou REPRENDRE sa place avec le code) ---
  socket.on('joinRoom', ({ code, name, deviceId } = {}, cb) => {
    tele.appareilVu(deviceId);
    const room = gm.getRoom(code);
    if (!room) return ack(cb, { ok: false, error: 'Aucune partie avec ce code.' });
    if (room.status === 'ended') return ack(cb, { ok: false, error: 'Cette partie est terminée.' });

    // Reprise par le nom : filet de sécurité quand la session locale est perdue
    // (téléphone redémarré, cache vidé, autre navigateur). On rend au joueur sa
    // place exacte — rôle, token QR, stats — au lieu de le laisser dehors.
    //
    // MAIS en pleine partie, le nom seul ne prouve rien : les noms sont
    // affichés à tous, et un caché se déconnecte dès qu'il verrouille son
    // téléphone. N'importe qui pouvait « rejoindre » sous son nom, récupérer
    // son QR et le faire éliminer. En partie, la place n'est donc rendue
    // directement qu'au MÊME appareil ; sinon l'hôte doit valider.
    const reclaim = room.findReclaimable(name);
    if (reclaim) {
      const memeAppareil = !!deviceId && !!reclaim.deviceId && deviceId === reclaim.deviceId;
      if (room.status === 'lobby' || memeAppareil) {
        grantReclaim(socket, room, reclaim);
        ack(cb, { ok: true, code: room.code, playerId: reclaim.id, qrToken: reclaim.qrToken, reclaimed: true });
        sendChatHistory(socket, room, reclaim);
        emitStateToRoom(room);
        return;
      }
      return requestReclaim(socket, room, reclaim, cb);
    }

    // Partie en cours : on n'accepte que les reprises, pas les nouveaux arrivants
    // (sinon on fausserait l'équilibre des équipes en pleine chasse).
    if (room.status !== 'lobby') {
      return ack(cb, { ok: false, error: 'Partie en cours. Pour reprendre ta place, entre exactement le même nom qu’au départ.' });
    }
    if (room.isNameTaken(name)) return ack(cb, { ok: false, error: 'Ce nom est déjà pris dans cette partie.' });
    if (room.players.size >= 40) return ack(cb, { ok: false, error: 'Partie complète.' });

    const player = room.addPlayer(name, deviceId);
    player.socketId = socket.id;
    bind(socket, room.code, player.id);
    ack(cb, { ok: true, code: room.code, playerId: player.id, qrToken: player.qrToken });
    sendChatHistory(socket, room, player);
    emitStateToRoom(room);
  });

  // --- Reprise de session (refresh / coupure réseau) ---
  socket.on('resume', ({ code, playerId } = {}, cb) => {
    const room = gm.getRoom(code);
    if (!room) return ack(cb, { ok: false, error: 'Partie introuvable.' });
    const player = room.players.get(playerId);
    if (!player) return ack(cb, { ok: false, error: 'Session expirée.' });
    player.socketId = socket.id;
    player.connected = true;
    player.disconnectAt = null;
    bind(socket, room.code, player.id);
    ack(cb, { ok: true, code: room.code, playerId: player.id, qrToken: player.qrToken });
    sendChatHistory(socket, room, player);
    emitStateToRoom(room);
  });

  // --- Attribution des rôles (hôte) ---
  socket.on('assignRoles', ({ mode, assignments } = {}) => {
    const ctx = ctxOf(socket);
    if (!ctx || !ctx.room.isHost(ctx.playerId)) return;
    if (ctx.room.status !== 'lobby') return;
    if (mode === 'manual') ctx.room.assignManual(assignments);
    else ctx.room.assignRandom();
    emitStateToRoom(ctx.room);
  });

  // --- Mise à jour de la configuration (hôte) ---
  socket.on('updateConfig', ({ config } = {}) => {
    const ctx = ctxOf(socket);
    if (!ctx || !ctx.room.isHost(ctx.playerId)) return;
    if (ctx.room.status !== 'lobby') return;
    ctx.room.updateConfig(config);
    emitStateToRoom(ctx.room);
  });

  // --- Lancement (hôte) ---
  socket.on('startGame', ({ safetyChecked } = {}, cb) => {
    const ctx = ctxOf(socket);
    if (!ctx) return ack(cb, { ok: false, error: 'Hors partie.' });
    const { room, player } = ctx;
    if (!room.isHost(ctx.playerId)) return ack(cb, { ok: false, error: 'Réservé à l’hôte.' });
    if (!safetyChecked) return ack(cb, { ok: false, error: 'Coche la case de sécurité.' });
    const res = room.start(player.pos);
    if (!res.ok) return ack(cb, { ok: false, error: res.error });
    room.statTerminee = false; // « Rejouer » relance la même salle : nouvelle partie, nouveau décompte
    tele.partieLancee();
    ack(cb, { ok: true });
    emitStateToRoom(room);
  });

  // --- Rejouer (hôte, après la fin) ---
  socket.on('restartGame', (_d, cb) => {
    const ctx = ctxOf(socket);
    if (!ctx) return ack(cb, { ok: false, error: 'Hors partie.' });
    if (!ctx.room.isHost(ctx.playerId)) return ack(cb, { ok: false, error: 'Réservé à l’hôte.' });
    if (ctx.room.status !== 'ended') return ack(cb, { ok: false, error: 'La partie n’est pas terminée.' });
    ctx.room.resetForNewGame();
    ack(cb, { ok: true });
    emitStateToRoom(ctx.room);
  });

  // --- Resynchronisation immédiate ---
  // Le client la demande au retour au premier plan ou s'il détecte un silence
  // anormal : sur mobile la connexion peut mourir sans événement 'disconnect',
  // laissant l'écran figé (positions et timers bloqués) jusqu'à un refresh manuel.
  socket.on('resync', () => {
    if (tropTot(socket, 'resync', 1000)) return;
    const ctx = ctxOf(socket);
    if (!ctx) return;
    try {
      const s = ctx.room.stateFor(ctx.playerId);
      if (s) socket.emit('state', s);
    } catch (err) {
      console.error('[resync]', err);
    }
  });

  // --- Position GPS ---
  // --- État des autorisations de l'appareil, rapporté par chaque client ---
  // Chaque appel renvoyait l'état à TOUTE la salle : un téléphone qui boucle
  // sur cet envoi faisait recalculer et réexpédier l'état de douze joueurs en
  // rafale. On ne diffuse plus que sur un vrai changement, et le tick suivant
  // rattrape de toute façon l'affichage.
  socket.on('ready', (patch) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const avant = JSON.stringify(ctx.player.ready);
    ctx.room.setReady(ctx.playerId, patch);
    if (JSON.stringify(ctx.player.ready) === avant) return;
    if (tropTot(socket, 'ready', 400)) return;
    emitStateToRoom(ctx.room);
  });

  socket.on('pos', (pos) => {
    // Le client envoie au plus toutes les 0,5 s ; au-delà c'est un bug ou un abus.
    if (tropTot(socket, 'pos', 250)) return;
    const ctx = ctxOf(socket);
    if (!ctx) return;
    ctx.room.updatePosition(ctx.playerId, pos);
  });

  // --- Élimination par scan QR (chasseur) ---
  socket.on('scanQR', ({ token } = {}, cb) => {
    const ctx = ctxOf(socket);
    if (!ctx) return ack(cb, { ok: false, error: 'Hors partie.' });
    const res = ctx.room.scanQR(ctx.playerId, token);
    if (!res.ok) return ack(cb, { ok: false, error: res.error });
    ack(cb, { ok: true, name: res.target.name });
    // Notifie la cible
    const sock = socketOfPlayer(res.target);
    if (sock) sock.emit('converted', { reason: 'scan', by: res.hunter.name });
    // ...et ses ex-coéquipiers cachés (avec le lieu de la capture)
    notifyHidersOfCapture(ctx.room, res.target, 'scan', res.hunter.name);
    ctx.room.checkEnd();
    emitStateToRoom(ctx.room);
  });

  // --- Radar (chasseur) ---
  socket.on('useRadar', (_data, cb) => {
    const ctx = ctxOf(socket);
    if (!ctx) return ack(cb, { ok: false, error: 'Hors partie.' });
    const res = ctx.room.useRadar(ctx.playerId);
    if (!res.ok) return ack(cb, { ok: false, error: res.error });
    ack(cb, { ok: true, usesLeft: res.hunter.radarUsesLeft });
    // Le résultat exact est poussé au chasseur qui a déclenché (visible 1 min)
    socket.emit('radar:result', { name: res.reveal.name, lat: res.reveal.lat, lng: res.reveal.lng, until: res.reveal.until });
    // La cible est alertée (son + vibration + interface) et voit le chasseur 30 s
    const target = res.target;
    if (target.connected && target.socketId) {
      io.to(target.socketId).emit('radar:spotted', {
        by: res.hunter.name,
        hunter: res.hunter.pos ? { name: res.hunter.name, lat: res.hunter.pos.lat, lng: res.hunter.pos.lng } : null,
        until: res.counterUntil,
      });
    }
    emitStateToRoom(ctx.room);
  });

  // --- Chat global (texte libre) ---
  socket.on('chat', ({ text } = {}) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    const msg = (typeof text === 'string' ? text : '').trim().slice(0, CHAT_MAX_LEN);
    if (!msg) return;
    // Anti-spam : 1 message max toutes les 600 ms par joueur
    const now = Date.now();
    if (now - (player.lastChatAt || 0) < 600) return;
    player.lastChatAt = now;
    const { texte } = censurer(msg);
    // `id` et `fromId` ne sont pas décoratifs : sans eux on ne peut ni désigner
    // un message à signaler, ni savoir qui bloquer.
    // `fromId` est l'identifiant PUBLIC. C'était l'identifiant de session :
    // chaque message offrait à toute la salle de quoi usurper son auteur.
    const payload = { id: randomUUID().slice(0, 12), fromId: player.pid, from: player.name, role: player.role, text: texte, at: now };
    // On archive AVANT de diffuser : un joueur hors réseau à cet instant ne
    // recevra rien, mais retrouvera le message à sa reconnexion.
    room.addChat(payload);
    // Chat GLOBAL : diffusé à tous les joueurs connectés de la salle, sauf à
    // ceux qui ont bloqué l'auteur — le filtrage est fait ICI, à l'émission :
    // un message écarté à l'affichage serait quand même arrivé sur l'appareil.
    for (const p of room.players.values()) {
      if (!p.connected || !p.socketId) continue;
      if (p.blocked && p.blocked.has(player.pid)) continue;
      io.to(p.socketId).emit('chat', payload);
    }
  });

  // --- Signaler un message ---
  // Apple demande de pouvoir agir sous 24 h (règle 1.2). Le signalement part
  // donc dans les journaux du serveur, là où on le verra, et l'auteur n'en est
  // jamais informé : prévenir un harceleur qu'il a été signalé le renseigne.
  socket.on('chat:report', ({ id } = {}, cb) => {
    const ctx = ctxOf(socket);
    if (!ctx) return ack(cb, { ok: false });
    const { room, player } = ctx;
    const msg = (room.chat || []).find((m) => m.id === id);
    if (!msg) return ack(cb, { ok: false, error: 'Message introuvable.' });
    tele.noteSignalement({ code: room.code, auteur: msg.from, texte: msg.text, par: player.name });
    ack(cb, { ok: true });
  });

  // --- Bloquer / débloquer un joueur ---
  socket.on('chat:block', ({ playerId, bloquer } = {}, cb) => {
    const ctx = ctxOf(socket);
    if (!ctx) return ack(cb, { ok: false });
    const { room, player } = ctx;
    // `playerId` désigne ici l'identifiant PUBLIC du joueur visé (celui du chat).
    const cible = room.byPid(playerId);
    if (!cible) return ack(cb, { ok: false, error: 'Joueur introuvable.' });
    if (cible.id === player.id) return ack(cb, { ok: false });
    if (bloquer === false) player.blocked.delete(cible.pid);
    else player.blocked.add(cible.pid);
    ack(cb, { ok: true, bloques: [...player.blocked] });
  });

  // --- Quitter volontairement ---
  socket.on('leave', () => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    ctx.room.removePlayer(ctx.playerId);
    socketIndex.delete(socket.id);
    ctx.room.checkEnd();
    emitStateToRoom(ctx.room);
  });

  // --- Contrôles de l'hôte ---------------------------------------------------
  // L'hôte n'avait AUCUN levier une fois la partie lancée : ni terminer, ni
  // écarter un joueur fantôme qui bloque la fin, ni passer la main.
  socket.on('host:end', (_d, cb) => {
    const ctx = ctxOf(socket);
    if (!ctx || !ctx.room.isHost(ctx.playerId)) return ack(cb, { ok: false, error: 'Réservé à l’hôte.' });
    if (!ctx.room.endByHost()) return ack(cb, { ok: false, error: 'La partie n’est pas en cours.' });
    ack(cb, { ok: true });
    emitStateToRoom(ctx.room);
  });

  socket.on('host:kick', ({ pid } = {}, cb) => {
    const ctx = ctxOf(socket);
    if (!ctx || !ctx.room.isHost(ctx.playerId)) return ack(cb, { ok: false, error: 'Réservé à l’hôte.' });
    const cible = ctx.room.byPid(pid);
    if (!cible) return ack(cb, { ok: false, error: 'Joueur introuvable.' });
    if (cible.id === ctx.playerId) return ack(cb, { ok: false, error: 'Tu ne peux pas t’exclure toi-même.' });
    if (cible.socketId) {
      io.to(cible.socketId).emit('kicked');
      socketIndex.delete(cible.socketId);
    }
    ctx.room.removePlayer(cible.id);
    ctx.room.checkEnd();
    ack(cb, { ok: true, name: cible.name });
    emitStateToRoom(ctx.room);
  });

  socket.on('host:transfer', ({ pid } = {}, cb) => {
    const ctx = ctxOf(socket);
    if (!ctx || !ctx.room.isHost(ctx.playerId)) return ack(cb, { ok: false, error: 'Réservé à l’hôte.' });
    const cible = ctx.room.byPid(pid);
    if (!cible || !cible.connected) return ack(cb, { ok: false, error: 'Ce joueur n’est pas en ligne.' });
    ctx.room.hostId = cible.id;
    ack(cb, { ok: true, name: cible.name });
    emitStateToRoom(ctx.room);
  });

  // Réponse de l'hôte à une demande de reprise de place (voir requestReclaim)
  socket.on('reclaim:answer', ({ reqId, accept } = {}, cb) => {
    const ctx = ctxOf(socket);
    if (!ctx || !ctx.room.isHost(ctx.playerId)) return ack(cb, { ok: false, error: 'Réservé à l’hôte.' });
    const room = ctx.room;
    const req = room.reclaims && room.reclaims.get(reqId);
    if (!req) return ack(cb, { ok: false, error: 'Demande expirée.' });
    room.reclaims.delete(reqId);
    const demandeur = io.sockets.sockets.get(req.socketId);
    const place = room.players.get(req.playerId);
    if (!demandeur || !place) return ack(cb, { ok: false, error: 'Le joueur n’est plus là.' });
    if (!accept) {
      demandeur.emit('reclaim:result', { ok: false, error: 'L’hôte a refusé la reprise de cette place.' });
      return ack(cb, { ok: true });
    }
    if (place.connected) {
      demandeur.emit('reclaim:result', { ok: false, error: 'Cette place est de nouveau occupée.' });
      return ack(cb, { ok: false, error: 'Le joueur est déjà revenu.' });
    }
    grantReclaim(demandeur, room, place);
    demandeur.emit('reclaim:result', { ok: true, code: room.code, playerId: place.id, qrToken: place.qrToken, reclaimed: true });
    sendChatHistory(demandeur, room, place);
    ack(cb, { ok: true });
    emitStateToRoom(room);
  });

  // --- Déconnexion ---
  // On garde le joueur : fenêtre de grâce pour reconnexion (voir releaseSocket).
  socket.on('disconnect', () => releaseSocket(socket));
});

// ----------------------------------------------------------------------------
// Petits helpers
// ----------------------------------------------------------------------------
// Un socket ne tient QU'UNE place à la fois. Rattacher un socket libère donc
// d'abord celle qu'il occupait — sinon `createRoom` appelé deux fois sur le même
// socket laissait derrière lui une salle dont l'unique joueur restait marqué
// `connected` avec un socketId mort. Cette salle ne se vidait jamais, donc
// n'était jamais supprimée, et continuait d'être tickée toutes les 1,5 s à vie :
// une simple boucle `emit('createRoom')` sur un seul socket, sans aucune
// authentification, saturait la mémoire du service.
// (Mesuré avant correction : 50 créations → 49 salles orphelines permanentes.)
function bind(socket, code, playerId) {
  const ref = socketIndex.get(socket.id);
  // Déjà en place (resume sur la même place) : surtout ne rien libérer, l'appelant
  // vient tout juste de remettre le joueur en ligne.
  if (ref && ref.code === code && ref.playerId === playerId) return;
  releaseSocket(socket);
  socketIndex.set(socket.id, { code, playerId });
}

// Rend la place tenue par ce socket, exactement comme une déconnexion : le
// joueur garde sa fenêtre de grâce pour revenir, et la salle redevient
// susceptible d'être vidée puis supprimée par le tick.
function releaseSocket(socket) {
  const ref = socketIndex.get(socket.id);
  socketIndex.delete(socket.id);
  if (!ref) return;
  const room = gm.getRoom(ref.code);
  if (!room) return;
  const player = room.players.get(ref.playerId);
  // Un autre socket a déjà repris ce joueur (reconnexion plus rapide que la
  // notification de coupure) : il est en ligne, ce n'est plus à nous de le sortir.
  if (!player || player.socketId !== socket.id) return;
  player.connected = false;
  player.disconnectAt = Date.now();
  player.socketId = null;
}

function ctxOf(socket) {
  const ref = socketIndex.get(socket.id);
  if (!ref) return null;
  const room = gm.getRoom(ref.code);
  if (!room) return null;
  const player = room.players.get(ref.playerId);
  if (!player) return null;
  return { room, player, playerId: ref.playerId };
}

function ack(cb, data) {
  if (typeof cb === 'function') cb(data);
}

// Frein par socket et par type d'action. Renvoie true si l'appel arrive trop tôt.
function tropTot(socket, cle, ms) {
  const now = Date.now();
  const t = socket.data.freins || (socket.data.freins = {});
  if (now - (t[cle] || 0) < ms) return true;
  t[cle] = now;
  return false;
}

// --- Reprise de place --------------------------------------------------------
function grantReclaim(socket, room, player) {
  player.socketId = socket.id;
  player.connected = true;
  player.disconnectAt = null;
  bind(socket, room.code, player.id);
}

const RECLAIM_TTL_MS = 90 * 1000;
// En partie, un autre appareil qui réclame une place par le nom attend la
// validation de l'hôte : c'est lui qui voit la personne en face.
function requestReclaim(socket, room, place, cb) {
  const host = room.players.get(room.hostId);
  if (!host || !host.connected || !host.socketId || host.id === place.id) {
    return ack(cb, { ok: false, error: 'L’hôte doit être en ligne pour valider ta reprise. Réessaie dans un instant.' });
  }
  if (!room.reclaims) room.reclaims = new Map();
  // Une seule demande en attente par place et par socket
  for (const [k, r] of room.reclaims) if (r.playerId === place.id || r.socketId === socket.id) room.reclaims.delete(k);
  const reqId = randomUUID().slice(0, 12);
  room.reclaims.set(reqId, { socketId: socket.id, playerId: place.id, at: Date.now() });
  io.to(host.socketId).emit('reclaim:request', { reqId, name: place.name });
  ack(cb, { ok: false, pending: true, error: 'Demande envoyée à l’hôte : il doit confirmer que c’est bien toi.' });
}

function expireReclaims(room, now) {
  if (!room.reclaims || !room.reclaims.size) return;
  for (const [k, r] of room.reclaims) {
    if (now - r.at > RECLAIM_TTL_MS) {
      room.reclaims.delete(k);
      io.to(r.socketId).emit('reclaim:result', { ok: false, error: 'L’hôte n’a pas répondu. Réessaie.' });
    }
  }
}

// ----------------------------------------------------------------------------
// Robustesse : ne JAMAIS mourir en pleine partie
// ----------------------------------------------------------------------------
// L'état des parties vit uniquement en RAM : si le process tombe, tout est perdu
// et Render relance à froid. Une exception isolée (bug dans un handler, socket
// bizarre) ne doit donc pas tuer le serveur : on log et on continue.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] partie préservée, on continue :', err);
  tele.noteErreur({ source: 'serveur', message: err && err.message, ou: err && err.stack });
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  tele.noteErreur({ source: 'serveur-promesse', message: err && err.message, ou: err && err.stack });
});

// Anti-mise en veille (Render tier gratuit) : le service s'endort après ~15 min
// sans requête entrante. On se ping soi-même pour rester chaud entre les parties
// et éviter le démarrage à froid de ~30 s au moment de jouer.
// Ce garde-fou était strictement indémontrable : aucune trace au démarrage,
// aucune trace en cas d'échec. Si RENDER_EXTERNAL_URL manque, ou si le ping
// échoue, le service s'endort et le prochain joueur attend le démarrage à froid
// — sans que rien, nulle part, ne l'ait signalé. On le rend diagnosticable :
// c'est la première chose à regarder dans les journaux Render quand un groupe
// dit « ça n'ouvrait pas ».
//
// Rester chaud 24 h/24 coûte cher là où on ne joue pas : le tier gratuit
// plafonne à ~750 h d'instance par mois et un mois de 31 jours en compte 744.
// Six heures de marge, partagées avec tout autre service gratuit du compte —
// un dépassement suspend le service jusqu'au mois suivant. On ne paie donc le
// réveil qu'aux heures où un groupe peut se réunir, et à toute heure tant
// qu'une partie tourne : on n'endort jamais un service en cours d'usage.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
const KEEPALIVE_MS = 10 * 60 * 1000; // < 15 min : la fenêtre avant mise en veille
const EVEIL_DEBUT = 9, EVEIL_FIN = 1; // 9 h → 1 h du matin, heure de Paris
function enHeuresDeJeu() {
  const h = tele.heureParis();
  // Fenêtre à cheval sur minuit : l'intervalle est l'union, pas l'intersection.
  return EVEIL_DEBUT <= EVEIL_FIN
    ? (h >= EVEIL_DEBUT && h < EVEIL_FIN)
    : (h >= EVEIL_DEBUT || h < EVEIL_FIN);
}
if (SELF_URL) {
  const client = SELF_URL.startsWith('https') ? require('https') : require('http');
  let echecs = 0;
  let veille = null; // null = état initial, pour tracer la première bascule
  setInterval(() => {
    const actif = enHeuresDeJeu() || gm.rooms.size > 0;
    if (veille !== !actif) {
      veille = !actif;
      console.log(veille
        ? '[keepalive] en pause — hors heures de jeu, le service peut s’endormir'
        : '[keepalive] repris — heures de jeu ou partie en cours');
    }
    if (!actif) return;
    client.get(SELF_URL + '/health', (res) => {
      res.resume();
      if (echecs) console.log(`[keepalive] ping rétabli après ${echecs} échec(s)`);
      echecs = 0;
    }).on('error', (err) => {
      // Plafonné : un service coupé du réseau ne doit pas noyer les journaux.
      if (++echecs <= 3) console.warn(`[keepalive] ping en échec (${echecs}) :`, err.message);
    });
  }, KEEPALIVE_MS);
  console.log(`[keepalive] armé — ${SELF_URL}/health toutes les 10 min, entre ${EVEIL_DEBUT} h et ${EVEIL_FIN} h (Paris) ou dès qu'une partie tourne`);
} else {
  console.warn('[keepalive] RENDER_EXTERNAL_URL absente : le service s’endormira après ~15 min sans trafic, et le prochain joueur attendra le démarrage à froid.');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Traque en écoute sur le port ${PORT}`);
});
