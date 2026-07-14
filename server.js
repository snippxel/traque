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
  CHAT_MESSAGES,
  RECONNECT_GRACE_MS,
  FLASH_MS,
  ZONE_TOLERANCE_MAX_M,
} = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: gm.rooms.size }));

const gm = new GameManager();

// Index socketId -> { code, playerId } pour retrouver le joueur à la déconnexion
const socketIndex = new Map();

// ----------------------------------------------------------------------------
// Helpers d'émission
// ----------------------------------------------------------------------------
function emitStateToRoom(room) {
  for (const p of room.players.values()) {
    if (p.connected && p.socketId) {
      const s = room.stateFor(p.id);
      if (s) io.to(p.socketId).emit('state', s);
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
    // Nettoyage des joueurs déconnectés au-delà de la fenêtre de grâce
    let removed = false;
    for (const p of [...room.players.values()]) {
      if (!p.connected && p.disconnectAt && now - p.disconnectAt > RECONNECT_GRACE_MS) {
        room.players.delete(p.id);
        room.lastReveal.delete(p.id);
        removed = true;
      }
    }
    // Salle vide -> suppression (aucune persistance)
    if (room.players.size === 0) {
      gm.deleteRoom(room.code);
      continue;
    }
    // Réattribution de l'hôte si l'hôte est parti
    if (!room.players.has(room.hostId)) {
      const next = [...room.players.values()][0];
      room.hostId = next ? next.id : null;
    }

    if (room.status === 'playing') {
      tickGame(room, now);
    }
    if (room.status !== 'lobby' || removed) {
      emitStateToRoom(room);
    } else {
      // en lobby, on pousse aussi l'état régulièrement (roster, positions hôte)
      emitStateToRoom(room);
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

  const radius = room.currentRadius(now);

  // Sorties de zone (cachés uniquement)
  for (const p of room.players.values()) {
    if (p.role !== 'hider' || !p.pos) continue;
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
        room.convert(p, 'zone');
        const sock = socketOfPlayer(p);
        if (sock) sock.emit('converted', { reason: 'zone' });
      }
    }
  }

  room.checkEnd(now);
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
  socket.on('createRoom', ({ name } = {}, cb) => {
    const room = gm.createRoom();
    const player = room.addPlayer(name);
    player.socketId = socket.id;
    bind(socket, room.code, player.id);
    ack(cb, { ok: true, code: room.code, playerId: player.id, qrToken: player.qrToken });
    emitStateToRoom(room);
  });

  // --- Rejoindre une partie ---
  socket.on('joinRoom', ({ code, name } = {}, cb) => {
    const room = gm.getRoom(code);
    if (!room) return ack(cb, { ok: false, error: 'Aucune partie avec ce code.' });
    if (room.status !== 'lobby') return ack(cb, { ok: false, error: 'La partie a déjà commencé.' });
    if (room.players.size >= 40) return ack(cb, { ok: false, error: 'Partie complète.' });
    const player = room.addPlayer(name);
    player.socketId = socket.id;
    bind(socket, room.code, player.id);
    ack(cb, { ok: true, code: room.code, playerId: player.id, qrToken: player.qrToken });
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
    ack(cb, { ok: true });
    emitStateToRoom(room);
  });

  // --- Position GPS ---
  socket.on('pos', (pos) => {
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

  // --- Chat rapide d'équipe ---
  socket.on('chat', ({ index } = {}) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= CHAT_MESSAGES.length) return;
    const { room, player } = ctx;
    const payload = { from: player.name, index: i, text: CHAT_MESSAGES[i], role: player.role, at: Date.now() };
    // Uniquement aux membres de la même équipe (rôle)
    for (const p of room.players.values()) {
      if (p.role === player.role && p.connected && p.socketId) {
        io.to(p.socketId).emit('chat', payload);
      }
    }
  });

  // --- Quitter volontairement ---
  socket.on('leave', () => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    ctx.room.players.delete(ctx.playerId);
    socketIndex.delete(socket.id);
    emitStateToRoom(ctx.room);
  });

  // --- Déconnexion ---
  socket.on('disconnect', () => {
    const ref = socketIndex.get(socket.id);
    socketIndex.delete(socket.id);
    if (!ref) return;
    const room = gm.getRoom(ref.code);
    if (!room) return;
    const player = room.players.get(ref.playerId);
    if (!player) return;
    // On garde le joueur : fenêtre de grâce de 90s pour reconnexion
    player.connected = false;
    player.disconnectAt = Date.now();
    player.socketId = null;
  });
});

// ----------------------------------------------------------------------------
// Petits helpers
// ----------------------------------------------------------------------------
function bind(socket, code, playerId) {
  socketIndex.set(socket.id, { code, playerId });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Traque en écoute sur le port ${PORT}`);
});
