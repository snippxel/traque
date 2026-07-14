'use strict';

/*
 * game.js — Moteur de jeu de Traque, 100% en mémoire.
 * Une partie = une instance de Room stockée dans une Map. Aucune base de données.
 * La Room ne connaît rien du réseau : elle expose des méthodes et retourne des
 * événements que server.js se charge d'émettre via Socket.io.
 */

// ----------------------------------------------------------------------------
// Constantes de réglage (assumées par le cahier des charges)
// ----------------------------------------------------------------------------
const ACCURACY_MAX_M = 30; // précision "fiable" (stats de distance, tolérance zone)
const ACCURACY_HARD_MAX_M = 3000; // au-delà, lecture absurde : on rejette
const MOVE_MIN_M = 2; // en-deçà, on ne recalcule pas la distance parcourue
const MOVE_MAX_M = 150; // au-delà (saut GPS), on ignore pour la distance cumulée
const ZONE_TOLERANCE_MAX_M = 50; // marge d'incertitude GPS avant conversion hors-zone
const RECONNECT_GRACE_MS = 90 * 1000; // fenêtre de reconnexion
const FLASH_MS = 6000; // durée d'un flash de sortie de zone chez les chasseurs
const RADAR_USES = 3; // nombre de radars par partie et par chasseur
const RADAR_REVEAL_MS = 60 * 1000; // la position révélée reste visible 1 min (chasseurs)
const COUNTER_REVEAL_MS = 30 * 1000; // le caché repéré voit le chasseur 30 s
const HUNTER_RATIO = 0.25; // ~25% de chasseurs en répartition aléatoire

const CHAT_MESSAGES = ['À l’aide \u{1F198}', 'Je suis coincé', 'RAS', 'Par ici \u{1F449}'];

// Réglages par défaut d'une partie
function defaultConfig() {
  return {
    startRadius: 500, // m
    finalRadius: 50, // m
    durationMin: 20, // minutes
    shrinkSteps: 5, // paliers (1..10)
    revealIntervalMin: 5, // minutes entre deux révélations
    graceSeconds: 10, // délai de grâce hors-zone
    lastSurvivor: false,
  };
}

// ----------------------------------------------------------------------------
// Utilitaires
// ----------------------------------------------------------------------------
function haversine(a, b) {
  if (!a || !b) return 0;
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I,O,0,1 ambigus
function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

function randomToken(n = 24) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ----------------------------------------------------------------------------
// Room
// ----------------------------------------------------------------------------
class Room {
  constructor(code) {
    this.code = code;
    this.hostId = null;
    this.status = 'lobby'; // 'lobby' | 'playing' | 'ended'
    this.createdAt = Date.now();
    this.config = defaultConfig();
    this.players = new Map(); // playerId -> player
    this.roleMode = 'random'; // 'random' | 'manual'
    this.center = null; // {lat,lng} fixé au lancement
    this.startTime = null;
    this.endTime = null;
    this.shrinkSchedule = []; // [{atTime, radius}]
    this.lastReveal = new Map(); // hiderId -> {lat,lng,time}
    this.tempReveals = []; // révélations exactes temporaires {playerId,name,lat,lng,until,kind}
    this.counterReveals = []; // {hiderId, hunterId, until} : le caché repéré voit le chasseur
    this.nextRevealAt = null;
    this.result = null; // {winner, stats} une fois terminé
  }

  // --- Gestion des joueurs -------------------------------------------------
  addPlayer(name) {
    const id = randomToken(16);
    const player = {
      id,
      socketId: null,
      name: (name || 'Joueur').toString().slice(0, 20).trim() || 'Joueur',
      role: 'hider',
      startRole: null,
      qrToken: randomToken(24),
      pos: null, // {lat,lng,accuracy,time}
      connected: true,
      disconnectAt: null,
      captures: 0,
      distance: 0,
      capturedAt: null,
      outOfZoneSince: null,
      radarUsesLeft: RADAR_USES, // radars restants pour ce chasseur
      lastPosForDistance: null,
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    return player;
  }

  isHost(playerId) {
    return this.hostId === playerId;
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  // --- Attribution des rôles (lobby) --------------------------------------
  assignRandom() {
    const ids = [...this.players.keys()];
    const nbHunters = Math.max(1, Math.round(ids.length * HUNTER_RATIO));
    // mélange Fisher-Yates
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    ids.forEach((id, idx) => {
      this.players.get(id).role = idx < nbHunters ? 'hunter' : 'hider';
    });
    this.roleMode = 'random';
  }

  assignManual(assignments) {
    // assignments: { playerId: 'hunter' | 'hider' }
    for (const [id, role] of Object.entries(assignments || {})) {
      const p = this.players.get(id);
      if (p && (role === 'hunter' || role === 'hider')) p.role = role;
    }
    this.roleMode = 'manual';
  }

  // --- Configuration -------------------------------------------------------
  updateConfig(cfg) {
    const c = this.config;
    if (cfg == null) return;
    const num = (v, d) => (Number.isFinite(+v) ? +v : d);
    c.startRadius = clamp(num(cfg.startRadius, c.startRadius), 20, 20000);
    c.finalRadius = clamp(num(cfg.finalRadius, c.finalRadius), 10, c.startRadius);
    c.durationMin = clamp(num(cfg.durationMin, c.durationMin), 1, 600);
    c.shrinkSteps = clamp(Math.round(num(cfg.shrinkSteps, c.shrinkSteps)), 1, 10);
    c.revealIntervalMin = clamp(num(cfg.revealIntervalMin, c.revealIntervalMin), 0.5, 60);
    c.graceSeconds = clamp(Math.round(num(cfg.graceSeconds, c.graceSeconds)), 3, 120);
    c.lastSurvivor = !!cfg.lastSurvivor;
    if (c.finalRadius > c.startRadius) c.finalRadius = c.startRadius;
  }

  // --- Lancement -----------------------------------------------------------
  start(hostPos) {
    if (this.status !== 'lobby') return { ok: false, error: 'Partie déjà lancée.' };
    if (!hostPos || !Number.isFinite(hostPos.lat) || !Number.isFinite(hostPos.lng)) {
      return { ok: false, error: 'Position de l’hôte indisponible. Active le GPS.' };
    }
    if (this.players.size < 2) {
      return { ok: false, error: 'Il faut au moins 2 joueurs.' };
    }
    const hunters = [...this.players.values()].filter((p) => p.role === 'hunter');
    const hiders = [...this.players.values()].filter((p) => p.role === 'hider');
    if (hunters.length === 0 || hiders.length === 0) {
      return { ok: false, error: 'Il faut au moins 1 chasseur et 1 caché.' };
    }

    this.center = { lat: hostPos.lat, lng: hostPos.lng };
    this.startTime = Date.now();
    const durationMs = this.config.durationMin * 60 * 1000;
    this.endTime = this.startTime + durationMs;

    // Paliers de rétrécissement : N événements répartis linéairement
    const { startRadius, finalRadius, shrinkSteps } = this.config;
    this.shrinkSchedule = [];
    for (let k = 1; k <= shrinkSteps; k++) {
      const radius = startRadius + ((finalRadius - startRadius) * k) / shrinkSteps;
      const atTime = this.startTime + (durationMs * k) / shrinkSteps;
      this.shrinkSchedule.push({ atTime, radius });
    }

    // Révélations : première à t=0, puis toutes les X minutes
    this.snapshotReveals();
    this.nextRevealAt = this.startTime + this.config.revealIntervalMin * 60 * 1000;

    // Fige les rôles de départ pour les stats
    for (const p of this.players.values()) p.startRole = p.role;

    this.status = 'playing';
    return { ok: true };
  }

  // --- Zone ----------------------------------------------------------------
  currentRadius(now = Date.now()) {
    let r = this.config.startRadius;
    for (const s of this.shrinkSchedule) {
      if (s.atTime <= now) r = s.radius;
      else break;
    }
    return r;
  }

  nextShrink(now = Date.now()) {
    for (const s of this.shrinkSchedule) {
      if (s.atTime > now) return s; // {atTime, radius}
    }
    return null;
  }

  distanceFromCenter(pos) {
    if (!pos || !this.center) return 0;
    return haversine(this.center, pos);
  }

  // --- Révélations périodiques --------------------------------------------
  snapshotReveals() {
    const now = Date.now();
    for (const p of this.players.values()) {
      if (p.role === 'hider' && p.pos) {
        this.lastReveal.set(p.id, { lat: p.pos.lat, lng: p.pos.lng, time: now });
      }
    }
  }

  // --- Position ------------------------------------------------------------
  updatePosition(playerId, pos) {
    const p = this.players.get(playerId);
    if (!p || !pos) return;
    if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
    const acc = Number.isFinite(pos.accuracy) ? pos.accuracy : 999;
    // On rejette seulement les lectures absurdes. Les positions imprécises
    // (PC/WiFi) sont acceptées : sinon un joueur devient un "fantôme" que le
    // radar et les révélations ne peuvent jamais localiser.
    if (acc > ACCURACY_HARD_MAX_M) return;

    const newPos = { lat: pos.lat, lng: pos.lng, accuracy: acc, time: Date.now() };

    // Distance cumulée : pendant la partie, et uniquement sur des lectures fiables
    // (au-delà de 30 m, le delta est du bruit qu'on n'accumule pas).
    if (this.status === 'playing' && p.lastPosForDistance && acc <= ACCURACY_MAX_M) {
      const d = haversine(p.lastPosForDistance, newPos);
      if (d >= MOVE_MIN_M && d <= MOVE_MAX_M) p.distance += d;
    }
    if (acc <= ACCURACY_MAX_M) p.lastPosForDistance = newPos;
    p.pos = newPos;
  }

  // --- Élimination QR ------------------------------------------------------
  scanQR(hunterId, token) {
    const hunter = this.players.get(hunterId);
    if (!hunter || hunter.role !== 'hunter') return { ok: false, error: 'Action réservée aux chasseurs.' };
    if (this.status !== 'playing') return { ok: false, error: 'La partie n’est pas en cours.' };
    const target = [...this.players.values()].find((p) => p.qrToken === token);
    if (!target) return { ok: false, error: 'QR code invalide.' };
    if (target.id === hunterId) return { ok: false, error: 'Tu ne peux pas te scanner toi-même.' };
    if (target.role === 'hunter') return { ok: false, error: 'Cette cible est déjà chasseur.' };

    this.convert(target, 'scan');
    hunter.captures += 1;
    return { ok: true, target, hunter };
  }

  // Convertit un caché en chasseur (par scan ou par sortie de zone)
  convert(target, reason) {
    target.role = 'hunter';
    target.capturedAt = Date.now();
    target.outOfZoneSince = null;
    this.lastReveal.delete(target.id);
    // Le joueur devient chasseur : ses contre-révélations en tant que caché n'ont plus de sens
    this.counterReveals = this.counterReveals.filter((r) => r.hiderId !== target.id);
    return reason;
  }

  // --- Radar ---------------------------------------------------------------
  useRadar(hunterId) {
    const hunter = this.players.get(hunterId);
    if (!hunter || hunter.role !== 'hunter') return { ok: false, error: 'Action réservée aux chasseurs.' };
    if (this.status !== 'playing') return { ok: false, error: 'La partie n’est pas en cours.' };
    if (hunter.radarUsesLeft <= 0) return { ok: false, error: 'Plus de radar disponible.' };

    const candidates = [...this.players.values()].filter(
      (p) => p.role === 'hider' && p.pos && p.connected
    );
    // On ne consomme PAS d'utilisation si le radar n'a rien trouvé : pas de pénalité.
    if (candidates.length === 0) return { ok: false, error: 'Aucun caché localisable pour le moment.' };

    // Cible = le caché le plus proche du chasseur (repli aléatoire si pas de position hôte)
    let target;
    if (hunter.pos) {
      let bestD = Infinity;
      for (const p of candidates) {
        const d = haversine(hunter.pos, p.pos);
        if (d < bestD) { bestD = d; target = p; }
      }
    } else {
      target = candidates[Math.floor(Math.random() * candidates.length)];
    }

    const now = Date.now();
    hunter.radarUsesLeft -= 1;
    // Révélation exacte visible par les chasseurs pendant 1 min.
    // On dédoublonne : une seule révélation par cible (remplace l'ancienne).
    this.tempReveals = this.tempReveals.filter((r) => r.playerId !== target.id);
    const reveal = {
      playerId: target.id,
      name: target.name,
      lat: target.pos.lat,
      lng: target.pos.lng,
      until: now + RADAR_REVEAL_MS,
      kind: 'radar',
    };
    this.tempReveals.push(reveal);
    // Contre-révélation : la cible voit le chasseur qui l'a repérée pendant 30 s.
    // Une seule entrée par paire (caché, chasseur) : on prolonge au lieu de dupliquer.
    const counterUntil = now + COUNTER_REVEAL_MS;
    this.counterReveals = this.counterReveals.filter((r) => !(r.hiderId === target.id && r.hunterId === hunter.id));
    this.counterReveals.push({ hiderId: target.id, hunterId: hunter.id, until: counterUntil });
    return { ok: true, reveal, target, hunter, counterUntil };
  }

  addTempReveal(player, kind, ms) {
    if (!player.pos) return null;
    // Une seule révélation exacte par joueur à la fois (pas de doublon).
    this.tempReveals = this.tempReveals.filter((r) => r.playerId !== player.id);
    const reveal = {
      playerId: player.id,
      name: player.name,
      lat: player.pos.lat,
      lng: player.pos.lng,
      until: Date.now() + ms,
      kind,
    };
    this.tempReveals.push(reveal);
    return reveal;
  }

  pruneTempReveals(now = Date.now()) {
    this.tempReveals = this.tempReveals.filter((r) => r.until > now);
    this.counterReveals = this.counterReveals.filter((r) => r.until > now);
  }

  // --- Comptages -----------------------------------------------------------
  counts() {
    let hunters = 0;
    let hiders = 0;
    for (const p of this.players.values()) {
      if (p.role === 'hunter') hunters++;
      else hiders++;
    }
    return { hunters, hiders, total: this.players.size };
  }

  // --- Fin de partie -------------------------------------------------------
  checkEnd(now = Date.now()) {
    if (this.status !== 'playing') return null;
    const { hiders } = this.counts();
    const startedWithHiders = [...this.players.values()].some((p) => p.startRole === 'hider');

    if (startedWithHiders && hiders === 0) {
      return this.finish('hunters');
    }
    if (!this.config.lastSurvivor && now >= this.endTime) {
      return this.finish(hiders > 0 ? 'hiders' : 'hunters');
    }
    return null;
  }

  finish(winner) {
    if (this.status === 'ended') return this.result;
    this.status = 'ended';
    const end = Date.now();
    const stats = [...this.players.values()].map((p) => {
      let survivedMs = null;
      if (p.startRole === 'hider') {
        survivedMs = (p.capturedAt || end) - this.startTime;
      }
      return {
        name: p.name,
        startRole: p.startRole || p.role,
        finalRole: p.role,
        survivedMs,
        neverCaught: p.startRole === 'hider' && !p.capturedAt,
        distance: Math.round(p.distance),
        captures: p.captures,
      };
    });
    // Tri : cachés survivants d'abord, puis par temps de survie décroissant, puis captures
    stats.sort((a, b) => {
      const av = a.survivedMs == null ? -1 : a.survivedMs;
      const bv = b.survivedMs == null ? -1 : b.survivedMs;
      if (bv !== av) return bv - av;
      return b.captures - a.captures;
    });
    this.result = { winner, stats, endTime: end };
    return this.result;
  }

  // --- Sérialisation par joueur (visibilité asymétrique) -------------------
  // Retourne l'état tel que CE joueur a le droit de le voir.
  stateFor(playerId, now = Date.now()) {
    const me = this.players.get(playerId);
    if (!me) return null;

    const base = {
      code: this.code,
      status: this.status,
      isHost: this.hostId === playerId,
      you: {
        id: me.id,
        name: me.name,
        role: me.role,
        qrToken: me.qrToken,
        radarUsesLeft: me.radarUsesLeft,
        radarMax: RADAR_USES,
        pos: me.pos,
      },
      counts: this.counts(),
    };

    if (this.status === 'lobby') {
      base.roleMode = this.roleMode;
      base.config = this.config;
      base.roster = [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        connected: p.connected,
        isHost: p.id === this.hostId,
      }));
      return base;
    }

    if (this.status === 'ended') {
      base.result = this.result;
      return base;
    }

    // --- En jeu ---
    base.config = {
      graceSeconds: this.config.graceSeconds,
      revealIntervalMin: this.config.revealIntervalMin,
      lastSurvivor: this.config.lastSurvivor,
    };
    base.zone = {
      center: this.center,
      radius: this.currentRadius(now),
    };
    const next = this.nextShrink(now);
    base.zone.nextRadius = next ? next.radius : this.currentRadius(now);
    base.zone.nextShrinkAt = next ? next.atTime : null;
    base.timeLeft = this.config.lastSurvivor ? null : Math.max(0, this.endTime - now);
    base.startTime = this.startTime;

    // Coéquipiers en temps réel (même rôle que moi)
    const teammates = [];
    for (const p of this.players.values()) {
      if (p.id === me.id) continue;
      if (p.role === me.role && p.pos) {
        teammates.push({ id: p.id, name: p.name, lat: p.pos.lat, lng: p.pos.lng, connected: p.connected });
      }
    }
    base.teammates = teammates;

    if (me.role === 'hunter') {
      // Révélations exactes en cours (radar + sorties de zone)
      const activeReveals = this.tempReveals.filter((r) => r.until > now);
      const revealedIds = new Set(activeReveals.map((r) => r.playerId));
      // Signaux gris : dernières positions révélées des cachés encore en course.
      // On masque le signal d'un caché dont la position EXACTE est déjà affichée
      // (sinon il apparaît deux fois : un point gris + un point rouge).
      const signals = [];
      for (const [hiderId, rev] of this.lastReveal) {
        if (revealedIds.has(hiderId)) continue;
        const h = this.players.get(hiderId);
        if (h && h.role === 'hider') {
          signals.push({ id: hiderId, name: h.name, lat: rev.lat, lng: rev.lng, time: rev.time });
        }
      }
      base.signals = signals;
      base.reveals = activeReveals.map((r) => ({ name: r.name, lat: r.lat, lng: r.lng, until: r.until, kind: r.kind }));
    } else {
      // Un caché ne voit AUCUN chasseur — SAUF s'il vient d'être repéré au radar :
      // il voit alors le(s) chasseur(s) qui l'ont repéré, en direct, pendant 30 s.
      const spotted = [];
      for (const cr of this.counterReveals) {
        if (cr.hiderId === me.id && cr.until > now) {
          const h = this.players.get(cr.hunterId);
          if (h && h.pos) spotted.push({ name: h.name, lat: h.pos.lat, lng: h.pos.lng, until: cr.until });
        }
      }
      if (spotted.length) base.spotted = spotted;
    }

    return base;
  }
}

// ----------------------------------------------------------------------------
// Gestionnaire global de rooms
// ----------------------------------------------------------------------------
class GameManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
  }

  createRoom() {
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  deleteRoom(code) {
    this.rooms.delete(code);
  }
}

module.exports = {
  GameManager,
  Room,
  CHAT_MESSAGES,
  RECONNECT_GRACE_MS,
  FLASH_MS,
  RADAR_USES,
  RADAR_REVEAL_MS,
  COUNTER_REVEAL_MS,
  ACCURACY_MAX_M,
  ZONE_TOLERANCE_MAX_M,
  MOVE_MIN_M,
  haversine,
};
