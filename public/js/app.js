'use strict';
/*
 * app.js — orchestrateur client. Relie le serveur (Socket.io), les capteurs,
 * la carte et le QR, et pilote les 4 écrans (accueil / lobby / jeu / fin).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = 'traque:session';

  const socket = io({ transports: ['websocket', 'polling'] });

  const state = {
    code: null,
    playerId: null,
    name: '',
    role: null,
    joined: false,
    last: null,          // dernier état serveur
    lastAt: 0,           // horodatage client de réception
    selfPos: null,       // dernière position GPS locale (même si imprécise)
    sentPos: null,
    sentAt: 0,
    inGame: false,
    alertDeadline: null,
    spottedUntil: 0,     // fin de la fenêtre "chasseur visible" (repéré au radar)
    zoneClosingAt: 0,    // heure du prochain rétrécissement annoncé (alerte -1 min)
    manualRoles: {},     // cache local pour l'attribution manuelle
    roleMode: 'random',
  };

  // ------------------------------------------------------------------ Sessions
  function saveSession() {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code: state.code, playerId: state.playerId, name: state.name })); } catch (_) {}
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (_) { return null; }
  }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (_) {} }

  // ------------------------------------------------------------------ Écrans
  function show(screenId) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(screenId).classList.add('active');
    if (screenId === 'screen-game') GameMap.invalidate();
  }

  // ------------------------------------------------------------------ Toasts
  function toast(msg, kind, ms) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms || 3200);
  }

  // ================================================================ CONNEXION
  // À CHAQUE (re)connexion : on reprend la session si on en a une. Indispensable
  // après une coupure réseau en pleine partie — le serveur indexe par socket, et
  // un socket reconnecté a un nouvel id : sans resume, tous les envois seraient
  // ignorés jusqu'au refresh.
  socket.on('connect', () => {
    const sess = state.code && state.playerId
      ? { code: state.code, playerId: state.playerId, name: state.name }
      : loadSession();
    if (!sess || !sess.code || !sess.playerId) return;
    socket.emit('resume', { code: sess.code, playerId: sess.playerId }, (res) => {
      if (res && res.ok) {
        state.code = res.code; state.playerId = res.playerId;
        state.name = state.name || sess.name || '';
        const firstJoin = !state.joined;
        state.joined = true;
        if (firstJoin) startGeo();
        else toast('Reconnecté.', '', 2000);
      } else if (!state.joined) {
        clearSession();
      }
    });
  });

  socket.on('disconnect', () => { if (state.inGame) toast('Connexion perdue — reconnexion…', 'amber'); });

  // ================================================================ ÉVÉNEMENTS
  socket.on('state', (s) => {
    state.last = s; state.lastAt = Date.now();
    state.role = s.you.role;
    route(s);
  });

  socket.on('zone:alert', ({ deadline }) => {
    state.alertDeadline = deadline;
    $('zone-alert').classList.remove('hidden');
    Sensors.startAlarm();
    Sensors.vibrate([300, 150, 300, 150, 600]);
  });
  socket.on('zone:alertCancelled', () => clearZoneAlert());

  // La zone va se fermer (~1 min) et je ne suis pas dans la prochaine zone
  socket.on('zone:closing', ({ atTime }) => {
    state.zoneClosingAt = atTime;
    $('zone-closing').classList.remove('hidden');
    Sensors.vibrate([200, 100, 200]);
    Sensors.ping(1300); Sensors.ping(1000);
  });

  socket.on('converted', ({ reason, by }) => {
    clearZoneAlert();
    // Le QR d'identité et les alertes "caché" n'ont plus de sens : on nettoie
    $('modal-qr').classList.add('hidden');
    $('zone-closing').classList.add('hidden');
    state.zoneClosingAt = 0;
    if (reason === 'scan') toast('Capturé par ' + (by || 'un chasseur') + ' — tu passes chasseur.', 'danger', 4000);
    else toast('Hors zone trop longtemps — tu passes chasseur.', 'danger', 4000);
    Sensors.vibrate([600]);
  });

  socket.on('hunter:flash', ({ name }) => {
    // Le marqueur exact est affiché par l'état serveur (reveals) — pas de doublon ici.
    Sensors.ping(1400);
    Sensors.vibrate(120);
    toast('SORTIE DE ZONE : ' + name, 'amber', 4000);
  });

  socket.on('radar:result', ({ name }) => {
    // Le marqueur exact est affiché par l'état serveur (reveals) — pas de doublon ici.
    Sensors.ping(1600);
    toast('RADAR : cible localisée (' + name + ')', 'amber', 4000);
  });

  // Le caché a été repéré au radar : alerte marquée (son + vibration répétés,
  // flash prolongé), et il voit le chasseur en direct pendant 30 s.
  socket.on('radar:spotted', ({ by, hunter, until }) => {
    state.spottedUntil = until;
    showSpotAlert(by);
    Sensors.vibrate([300, 150, 300, 150, 300, 150, 600]);
    let beeps = 0;
    const bz = setInterval(() => { Sensors.ping(1500); Sensors.ping(1050); if (++beeps >= 6) clearInterval(bz); }, 450);
    if (hunter) GameMap.setSpotted([{ name: hunter.name, lat: hunter.lat, lng: hunter.lng, until }]);
  });

  // Chat global (texte libre) : reçu par tous
  socket.on('chat', ({ from, text }) => {
    addChatMessage(from, text);
    const log = $('chat-log');
    const b = document.createElement('div');
    b.className = 'chat-bubble';
    b.innerHTML = '<b>' + escapeHtml(from) + '</b> ' + escapeHtml(text);
    log.appendChild(b);
    Sensors.ping(900);
    setTimeout(() => { b.style.opacity = '0'; b.style.transition = 'opacity .4s'; setTimeout(() => b.remove(), 420); }, 6000);
  });

  // Historique du chat dans la modale (persiste le temps de la session)
  function addChatMessage(from, text) {
    const box = $('chat-messages');
    if (!box) return;
    const empty = box.querySelector('.chat-empty');
    if (empty) empty.remove();
    const line = document.createElement('div');
    line.className = 'chat-msg';
    line.innerHTML = '<span class="cm-from">' + escapeHtml(from) + '</span>' + escapeHtml(text);
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function escapeHtml(s) { return (s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  // ================================================================ ROUTAGE
  function route(s) {
    if (s.status === 'lobby') { renderLobby(s); show('screen-lobby'); }
    else if (s.status === 'playing') { enterGame(s); renderGame(s); }
    else if (s.status === 'ended') { renderEnd(s); show('screen-end'); teardownGame(); }
  }

  // ---------------------------------------------------------------- LOBBY
  function renderLobby(s) {
    $('lobby-code').textContent = s.code;
    // Roster
    const roster = $('roster');
    roster.innerHTML = '';
    (s.roster || []).forEach((p) => {
      const li = document.createElement('li');
      if (p.connected) li.classList.add('on');
      li.innerHTML =
        '<span class="dot"></span>' +
        '<span class="r-name">' + escapeHtml(p.name) + (p.isHost ? ' <span class="r-host">HÔTE</span>' : '') + '</span>' +
        '<span class="r-role ' + p.role + '">' + (p.role === 'hunter' ? 'CHASSEUR' : 'CACHÉ') + '</span>';
      roster.appendChild(li);
    });
    $('roster-count').textContent = (s.roster || []).length;

    if (s.isHost) {
      $('host-panel').classList.remove('hidden');
      $('guest-panel').classList.add('hidden');
      fillConfig(s.config);
      renderManual(s);
      // mode d'attribution
      state.roleMode = s.roleMode;
      $('btn-role-random').classList.toggle('active', s.roleMode === 'random');
      $('btn-role-manual').classList.toggle('active', s.roleMode === 'manual');
      $('manual-assign').classList.toggle('hidden', s.roleMode !== 'manual');
    } else {
      $('host-panel').classList.add('hidden');
      $('guest-panel').classList.remove('hidden');
      $('guest-role').textContent = s.you.role === 'hunter' ? 'CHASSEUR' : 'CACHÉ';
    }
  }

  function fillConfig(cfg) {
    // Une saisie locale est en cours ou vient d'être envoyée : ne PAS écraser les
    // champs avec l'état serveur (qui peut encore contenir l'ancienne config).
    if (configDirty) return;
    const map = {
      'cfg-startRadius': cfg.startRadius, 'cfg-finalRadius': cfg.finalRadius,
      'cfg-durationMin': cfg.durationMin, 'cfg-shrinkSteps': cfg.shrinkSteps,
      'cfg-revealIntervalMin': cfg.revealIntervalMin, 'cfg-graceSeconds': cfg.graceSeconds,
      'cfg-radarUses': cfg.radarUses,
      'cfg-dispersionSeconds': cfg.dispersionSeconds, 'cfg-startRevealSeconds': cfg.startRevealSeconds,
    };
    for (const [id, v] of Object.entries(map)) {
      const el = $(id);
      if (el && document.activeElement !== el) el.value = v;
    }
    const ls = $('cfg-lastSurvivor');
    if (document.activeElement !== ls) ls.checked = !!cfg.lastSurvivor;
  }

  function renderManual(s) {
    const wrap = $('manual-assign');
    wrap.innerHTML = '';
    (s.roster || []).forEach((p) => {
      const row = document.createElement('div');
      row.className = 'ma-row';
      const btn = document.createElement('button');
      btn.className = 'ma-toggle ' + p.role;
      btn.textContent = p.role === 'hunter' ? 'CHASSEUR' : 'CACHÉ';
      btn.onclick = () => {
        const assignments = {};
        (s.roster || []).forEach((q) => { assignments[q.id] = q.id === p.id ? (p.role === 'hunter' ? 'hider' : 'hunter') : q.role; });
        socket.emit('assignRoles', { mode: 'manual', assignments });
      };
      row.innerHTML = '<span class="ma-name">' + escapeHtml(p.name) + '</span>';
      row.appendChild(btn);
      wrap.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- JEU
  function enterGame(s) {
    if (state.inGame) return;
    state.inGame = true;
    show('screen-game');
    GameMap.init();
    GameMap.invalidate();
    Sensors.requestWakeLock();
    Sensors.ensureAudio();
    if (s.you.role === 'hider') startCompass();
    startHudTicker();
  }

  function renderGame(s) {
    if (!state.inGame) enterGame(s);
    const role = s.you.role;
    // HUD rôle
    const roleEl = $('hud-role');
    roleEl.textContent = role === 'hunter' ? 'CHASSEUR' : 'CACHÉ';
    roleEl.className = 'hud-v ' + role;
    $('hud-targets').textContent = s.counts.hiders;

    // Zone
    if (s.zone) {
      $('hud-radius').textContent = Math.round(s.zone.radius) + 'm';
      GameMap.setZone(s.zone);
      $('hud-shrink').classList.toggle('hidden', !s.zone.nextShrinkAt);
    }

    // Position perso sur la carte
    if (state.selfPos) GameMap.setSelf(state.selfPos, role);

    // Coéquipiers
    GameMap.setTeammates(s.teammates || [], role);

    // Chasseur : signaux + révélations. Caché : chasseur(s) si repéré au radar.
    if (role === 'hunter') {
      // Le signal gris affiche son âge : "KARL · 3min" = position vieille de 3 min
      const now = Date.now();
      GameMap.setSignals((s.signals || []).map((sig) => ({
        ...sig,
        name: sig.name + ' · ' + Math.max(0, Math.round((now - sig.time) / 60000)) + 'min',
      })));
      GameMap.setReveals(s.reveals || []);
      GameMap.setSpotted([]);
    } else {
      GameMap.clearSignals();
      GameMap.setSpotted(s.spotted || []);
      // Synchronise la fin de fenêtre "chasseur visible" depuis l'état serveur
      if (s.spotted && s.spotted.length) {
        state.spottedUntil = Math.max(state.spottedUntil || 0, s.spotted[0].until);
      }
    }

    // Phase de départ (dispersion) : timer/zone gelés, chasseur bloqué
    const dispersion = s.dispersionEndsAt && Date.now() < s.dispersionEndsAt;

    // Boutons d'action selon rôle
    $('btn-code').classList.toggle('hidden', role !== 'hider');
    $('btn-scan').classList.toggle('hidden', role !== 'hunter');
    $('btn-radar').classList.toggle('hidden', role !== 'hunter');
    updateRadarButton();
    if (dispersion && role === 'hunter') {
      // Le chasseur attend : actions verrouillées jusqu'à la fin de la dispersion
      $('btn-scan').classList.add('locked');
      $('btn-radar').classList.add('locked'); $('btn-radar').disabled = true;
    } else {
      $('btn-scan').classList.remove('locked');
      $('btn-radar').classList.remove('locked');
    }
    $('compass').classList.toggle('hidden', role !== 'hider');
    // Timer de révélation : caché seulement en phase de chasse (masqué au départ)
    const rt = $('reveal-timer');
    rt.classList.toggle('hidden', dispersion);
    rt.classList.toggle('hider', role === 'hider');
    $('rt-label').textContent = role === 'hunter' ? 'RÉVÉLATION' : 'TON SIGNAL';
    // Bandeau rétrécissement masqué pendant la dispersion (la zone ne bouge pas encore)
    if (dispersion) $('hud-shrink').classList.add('hidden');
    if (role === 'hunter') stopCompass();

    // Interface de départ
    updateStartBanner();

    updateTimers();
  }

  // Ticker local pour fluidifier minuteurs entre deux états serveur
  let hudTimer = null;
  function startHudTicker() {
    if (hudTimer) return;
    hudTimer = setInterval(() => { updateTimers(); updateZoneCountdown(); updateRadarButton(); updateSpotBanner(); updateZoneClosing(); updateStartBanner(); }, 250);
  }
  // Bouton radar : nombre d'utilisations restantes (3 par partie)
  function updateRadarButton() {
    const s = state.last;
    const btn = $('btn-radar');
    if (!s || !s.you || s.you.role !== 'hunter') return;
    // Pendant la dispersion, le radar est verrouillé (le chasseur attend)
    if (s.dispersionEndsAt && Date.now() < s.dispersionEndsAt) {
      btn.disabled = true; btn.textContent = 'RADAR ⏸'; return;
    }
    const left = s.you.radarUsesLeft != null ? s.you.radarUsesLeft : 0;
    btn.disabled = left <= 0;
    btn.textContent = left > 0 ? 'RADAR ×' + left : 'RADAR ✕';
  }
  function updateTimers() {
    const s = state.last;
    if (!s || s.status !== 'playing') return;
    const now = Date.now();
    // Temps : pendant la dispersion, le HUD montre le compte à rebours de départ
    const tk = $('hud-timer-k'), tv = $('hud-timer');
    if (s.dispersionEndsAt && now < s.dispersionEndsAt) {
      tk.textContent = 'DÉPART'; tv.textContent = fmt(s.dispersionEndsAt - now);
      tv.classList.remove('danger');
    } else if (s.config && s.config.lastSurvivor) {
      tk.textContent = 'MODE'; tv.textContent = 'SURVIE'; tv.classList.remove('danger');
    } else if (s.timeLeft != null) {
      const left = Math.max(0, s.timeLeft - (now - state.lastAt));
      tk.textContent = 'TEMPS'; tv.textContent = fmt(left);
      tv.classList.toggle('danger', left < 60000);
    }
    // Prochain rétrécissement
    if (s.zone && s.zone.nextShrinkAt) {
      const d = Math.max(0, s.zone.nextShrinkAt - Date.now());
      $('shrink-timer').textContent = fmt(d);
    }
    // Prochaine révélation périodique (les deux rôles) — intervalle configuré
    if (s.nextRevealAt) {
      const left = Math.max(0, s.nextRevealAt - Date.now());
      $('rt-value').textContent = fmt(left);
      $('reveal-timer').classList.toggle('soon', left < 15000);
    } else {
      $('rt-value').textContent = '--:--';
    }
    // Boussole (cachés)
    if (state.role === 'hider' && s.zone && s.zone.center && state.selfPos) {
      const brg = GameMap.bearing(state.selfPos, s.zone.center);
      const head = Sensors.heading();
      const rot = head == null ? brg : (brg - head);
      $('compass-needle').style.transform = 'translate(-50%, -100%) rotate(' + rot + 'deg)';
    }
  }
  function updateZoneCountdown() {
    if (!state.alertDeadline) return;
    const left = Math.max(0, Math.ceil((state.alertDeadline - Date.now()) / 1000));
    $('za-countdown').textContent = left;
  }
  // Alerte "repéré au radar" : flash prolongé (6 s) pour être bien remarqué,
  // puis on laisse la carte + la bannière décomptée (chasseur visible 30 s).
  let spotAlertTimer = null;
  function showSpotAlert(by) {
    $('sa-sub').textContent = by ? by.toUpperCase() + ' T’A LOCALISÉ AU RADAR' : 'UN CHASSEUR T’A LOCALISÉ AU RADAR';
    const el = $('spot-alert');
    el.classList.remove('hidden');
    if (spotAlertTimer) clearTimeout(spotAlertTimer);
    spotAlertTimer = setTimeout(() => el.classList.add('hidden'), 6000);
  }
  // Interface de départ (phase de dispersion) — recalculée à chaque tick
  function updateStartBanner() {
    const s = state.last;
    const banner = $('start-banner');
    const now = Date.now();
    if (!s || s.status !== 'playing' || !s.dispersionEndsAt || now >= s.dispersionEndsAt) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
    const hunter = state.role === 'hunter';
    banner.classList.toggle('hunter', hunter);
    $('sb-title').textContent = hunter ? 'ATTENDEZ' : 'FUYEZ !';
    $('sb-sub').textContent = hunter ? 'La chasse démarre bientôt' : 'Éloignez-vous et cachez-vous';
    $('sb-timer').textContent = fmt(s.dispersionEndsAt - now);
    const note = $('sb-note');
    const liveLeft = (s.startRevealEndsAt || 0) - now;
    if (liveLeft > 0) {
      if (hunter) { note.textContent = 'Tu vois les cachés en direct : ' + fmt(liveLeft); note.className = 'sb-note live'; }
      else { note.textContent = '⚠ Le chasseur te voit encore ' + fmt(liveLeft); note.className = 'sb-note live'; }
    } else {
      if (hunter) { note.textContent = 'Cachés masqués — patiente'; note.className = 'sb-note safe'; }
      else { note.textContent = 'Tu es masqué ✓'; note.className = 'sb-note safe'; }
    }
  }

  // Bannière décomptée avant la fermeture de la zone (cachés hors prochaine zone)
  function updateZoneClosing() {
    const banner = $('zone-closing');
    const left = (state.zoneClosingAt || 0) - Date.now();
    if (left > 0) {
      banner.classList.remove('hidden');
      $('zc-timer').textContent = fmt(left);
    } else {
      banner.classList.add('hidden');
      state.zoneClosingAt = 0;
    }
  }

  // Bannière décomptée pendant que la position du chasseur reste visible (30 s)
  function updateSpotBanner() {
    const banner = $('spot-banner');
    const left = (state.spottedUntil || 0) - Date.now();
    if (left > 0) {
      banner.classList.remove('hidden');
      $('spot-timer').textContent = fmt(left);
    } else {
      banner.classList.add('hidden');
      if (state.spottedUntil) { state.spottedUntil = 0; GameMap.setSpotted([]); }
    }
  }
  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function clearZoneAlert() {
    state.alertDeadline = null;
    $('zone-alert').classList.add('hidden');
    Sensors.stopAlarm();
  }

  function teardownGame() {
    state.inGame = false;
    if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
    stopCompass();
    Sensors.stopAlarm();
    Sensors.releaseWakeLock();
    clearZoneAlert();
    state.spottedUntil = 0;
    state.zoneClosingAt = 0;
    $('spot-alert').classList.add('hidden');
    $('spot-banner').classList.add('hidden');
    $('zone-closing').classList.add('hidden');
    $('reveal-timer').classList.add('hidden');
    $('start-banner').classList.add('hidden');
    $('btn-scan').classList.remove('locked');
    $('btn-radar').classList.remove('locked');
    $('modal-chat').classList.add('hidden');
    $('chat-messages').innerHTML = '';
  }

  // ---------------------------------------------------------------- FIN
  function renderEnd(s) {
    const r = s.result;
    if (!r) return;
    const banner = $('end-banner');
    banner.className = 'end-banner ' + r.winner;
    banner.textContent = r.winner === 'hunters' ? 'VICTOIRE DES CHASSEURS' : 'VICTOIRE DES CACHÉS';
    const tbody = $('stats-table').querySelector('tbody');
    tbody.innerHTML = '';
    r.stats.forEach((p) => {
      const tr = document.createElement('tr');
      if (p.name === state.name) tr.classList.add('me');
      if (p.neverCaught) tr.classList.add('survivor');
      const survie = p.survivedMs == null ? '—' : fmt(p.survivedMs) + (p.neverCaught ? ' ✓' : '');
      tr.innerHTML =
        '<td>' + escapeHtml(p.name) + '</td>' +
        '<td class="role-cell ' + p.startRole + '">' + (p.startRole === 'hunter' ? 'CHASSEUR' : 'CACHÉ') + '</td>' +
        '<td>' + survie + '</td>' +
        '<td>' + p.distance + ' m</td>' +
        '<td>' + p.captures + '</td>';
      tbody.appendChild(tr);
    });
  }

  // ================================================================ GPS
  function startGeo() {
    Sensors.watchPosition(onPos, (err) => { toast(err, 'danger', 5000); });
  }
  function onPos(pos) {
    state.selfPos = pos;
    // Badge de précision
    const badge = $('gps-badge'), acc = $('gps-acc');
    acc.textContent = Math.round(pos.accuracy) + 'm';
    badge.className = 'gps-badge' + (pos.accuracy > 30 ? ' bad' : pos.accuracy > 15 ? ' warn' : '');
    // Affichage local même si imprécis
    if (state.inGame && state.role) GameMap.setSelf(pos, state.role);
    // Envoi réseau : on envoie même une position imprécise (PC/WiFi) pour rester
    // localisable ; le badge indique la précision. Throttle 1.5s sauf mouvement > 2m.
    const now = Date.now();
    const moved = state.sentPos ? haversine(state.sentPos, pos) : Infinity;
    const due = !state.sentPos || (now - state.sentAt) >= 1500 || (moved >= 2 && (now - state.sentAt) >= 500);
    if (due) {
      socket.emit('pos', { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy });
      state.sentPos = pos; state.sentAt = now;
    }
  }
  function haversine(a, b) {
    const R = 6371000, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ================================================================ BOUSSOLE
  let compassOn = false;
  async function startCompass() {
    if (compassOn) return;
    // iOS 13+ : la permission peut être refusée hors geste utilisateur.
    // On ne verrouille compassOn que si l'activation a réellement réussi,
    // pour pouvoir retenter au prochain toucher.
    const ok = await Sensors.startCompass(() => {});
    compassOn = ok !== false;
  }
  function stopCompass() { if (compassOn) { Sensors.stopCompass(); compassOn = false; } }
  // Nouvelle tentative boussole au toucher (contexte de geste requis par iOS)
  document.addEventListener('pointerdown', () => {
    if (state.inGame && state.role === 'hider' && !compassOn) startCompass();
  });

  // ================================================================ UI HANDLERS
  // --- Accueil ---
  $('btn-create').onclick = () => {
    const name = ($('input-name').value || '').trim();
    if (!name) return homeError('Entre un identifiant.');
    homeError('');
    socket.emit('createRoom', { name }, (res) => {
      if (!res || !res.ok) return homeError((res && res.error) || 'Erreur.');
      state.code = res.code; state.playerId = res.playerId; state.name = name; state.joined = true;
      saveSession(); startGeo();
    });
  };
  $('btn-join').onclick = () => {
    const name = ($('input-name').value || '').trim();
    const code = ($('input-code').value || '').trim().toUpperCase();
    if (!name) return homeError('Entre un identifiant.');
    if (code.length !== 5) return homeError('Le code fait 5 caractères.');
    homeError('');
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res || !res.ok) return homeError((res && res.error) || 'Erreur.');
      state.code = res.code; state.playerId = res.playerId; state.name = name; state.joined = true;
      saveSession(); startGeo();
    });
  };
  function homeError(msg) { $('home-error').textContent = msg; }
  $('input-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

  // --- Lobby : config ---
  const cfgIds = ['cfg-startRadius', 'cfg-finalRadius', 'cfg-durationMin', 'cfg-shrinkSteps', 'cfg-revealIntervalMin', 'cfg-graceSeconds', 'cfg-radarUses', 'cfg-dispersionSeconds', 'cfg-startRevealSeconds', 'cfg-lastSurvivor'];
  let cfgTimer = null;
  let configDirty = false; // vrai entre une saisie locale et sa prise en compte serveur
  let configDirtyTimer = null;
  function readConfig() {
    return {
      startRadius: +$('cfg-startRadius').value,
      finalRadius: +$('cfg-finalRadius').value,
      durationMin: +$('cfg-durationMin').value,
      shrinkSteps: +$('cfg-shrinkSteps').value,
      revealIntervalMin: +$('cfg-revealIntervalMin').value,
      graceSeconds: +$('cfg-graceSeconds').value,
      radarUses: +$('cfg-radarUses').value,
      dispersionSeconds: +$('cfg-dispersionSeconds').value,
      startRevealSeconds: +$('cfg-startRevealSeconds').value,
      lastSurvivor: $('cfg-lastSurvivor').checked,
    };
  }
  function pushConfig() {
    configDirty = true;
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => {
      socket.emit('updateConfig', { config: readConfig() });
      // On laisse le temps au serveur de renvoyer un état avec la nouvelle config,
      // puis fillConfig reprend la main (resynchronisation normale).
      clearTimeout(configDirtyTimer);
      configDirtyTimer = setTimeout(() => { configDirty = false; }, 2500);
    }, 250);
  }
  cfgIds.forEach((id) => { const el = $(id); if (el) {
    el.addEventListener('change', pushConfig);
    el.addEventListener('input', () => { configDirty = true; }); // protège dès la frappe
  } });

  $('btn-role-random').onclick = () => socket.emit('assignRoles', { mode: 'random' });
  $('btn-role-manual').onclick = () => {
    // bascule l'affichage manuel : on renvoie l'état courant en mode manuel
    const s = state.last;
    const assignments = {};
    (s && s.roster || []).forEach((p) => { assignments[p.id] = p.role; });
    socket.emit('assignRoles', { mode: 'manual', assignments });
  };

  // Safety + launch
  $('chk-safety').addEventListener('change', updateLaunchState);
  function updateLaunchState() {
    $('btn-launch').disabled = !$('chk-safety').checked;
  }
  $('btn-launch').onclick = () => {
    if (!state.selfPos) { $('lobby-error').textContent = 'Position GPS non acquise (nécessaire pour centrer la zone).'; return; }
    // On envoie la config à jour AVANT de lancer (les messages socket sont ordonnés),
    // sinon une modif de dernière seconde encore débouncée serait perdue au lancement.
    clearTimeout(cfgTimer);
    socket.emit('updateConfig', { config: readConfig() });
    socket.emit('startGame', { safetyChecked: $('chk-safety').checked }, (res) => {
      if (!res || !res.ok) $('lobby-error').textContent = (res && res.error) || 'Impossible de lancer.';
    });
  };

  $('btn-copy-code').onclick = () => {
    const code = $('lobby-code').textContent;
    navigator.clipboard && navigator.clipboard.writeText(code).then(() => toast('Code copié : ' + code)).catch(() => {});
  };
  $('btn-leave-lobby').onclick = leaveToHome;

  // --- Jeu : actions ---
  $('btn-code').onclick = () => {
    if (!state.last) return;
    $('modal-qr').classList.remove('hidden');
    QR.render($('qr-canvas'), state.last.you.qrToken);
  };
  $('btn-scan').onclick = () => {
    const s = state.last;
    if (s && s.dispersionEndsAt && Date.now() < s.dispersionEndsAt) {
      toast('Attends la fin de la dispersion pour éliminer.', 'amber');
      return;
    }
    openScan();
  };
  $('btn-radar').onclick = () => {
    const btn = $('btn-radar');
    if (btn.disabled) return;
    btn.disabled = true; // désactivation optimiste
    socket.emit('useRadar', {}, (res) => {
      if (!res || !res.ok) { toast((res && res.error) || 'Radar indisponible.', 'amber'); updateRadarButton(); return; }
      // Applique tout de suite le décompte à l'état local : sinon le ticker (250 ms)
      // réactiverait le bouton depuis un état périmé jusqu'au prochain état serveur (1.5 s)
      if (state.last && state.last.you && res.usesLeft != null) state.last.you.radarUsesLeft = res.usesLeft;
      updateRadarButton();
    });
  };
  $('btn-chat').onclick = () => {
    $('modal-chat').classList.remove('hidden');
    const box = $('chat-messages');
    if (box && !box.children.length) {
      box.innerHTML = '<div class="chat-empty">Aucun message. Écris le premier.</div>';
    }
    setTimeout(() => $('chat-input').focus(), 50);
  };

  // Chat global : envoi de texte libre
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = (input.value || '').trim();
    if (!text) return;
    socket.emit('chat', { text });
    input.value = '';
    input.focus();
  });

  // --- Scan modal ---
  function openScan() {
    $('modal-scan').classList.remove('hidden');
    $('scan-status').textContent = 'Vise le QR code de la cible…';
    QR.startScan($('scan-video'), onScanDetect, (err) => { $('scan-status').textContent = err; });
  }
  function onScanDetect(token) {
    socket.emit('scanQR', { token }, (res) => {
      if (res && res.ok) {
        $('scan-status').textContent = 'CIBLE ÉLIMINÉE : ' + res.name;
        Sensors.ping(1800); Sensors.vibrate([100, 60, 100]);
        setTimeout(closeScan, 1200);
      } else {
        $('scan-status').textContent = (res && res.error) || 'Échec.';
        setTimeout(() => QR.resumeScan($('scan-video'), onScanDetect, () => {}), 900);
      }
    });
  }
  function closeScan() { QR.stopScan(); $('modal-scan').classList.add('hidden'); }

  // Fermeture des modales
  document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.onclick = () => {
      const modal = btn.closest('.modal');
      modal.classList.add('hidden');
      if (modal.id === 'modal-scan') QR.stopScan();
    };
  });

  // --- Fin ---
  $('btn-home').onclick = leaveToHome;

  function leaveToHome() {
    socket.emit('leave');
    clearSession();
    teardownGame();
    Sensors.stopWatch();
    GameMap.reset();
    state.joined = false; state.code = null; state.playerId = null; state.last = null; state.selfPos = null; state.sentPos = null;
    $('input-code').value = '';
    show('screen-home');
  }

  // Recentrer la carte sur soi
  $('btn-recenter').onclick = () => { if (state.selfPos) GameMap.recenter(state.selfPos); };

  // iOS/Safari : l'audio ne peut démarrer qu'après un geste utilisateur.
  // On déverrouille le contexte au premier toucher, sinon les alertes seraient muettes.
  document.addEventListener('pointerdown', function unlock() {
    Sensors.ensureAudio();
    document.removeEventListener('pointerdown', unlock);
  }, { once: true });

  // Wake lock auto-réacquisition
  Sensors.initWakeLockAutoReacquire();
  updateLaunchState();

  // Service worker (installabilité PWA) + mise à jour automatique.
  // Quand une nouvelle version est déployée, on recharge tout seul : plus besoin
  // de vider le cache à la main.
  if ('serviceWorker' in navigator) {
    let reloading = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return; // pas de reload à la toute première prise de contrôle
      reloading = true;
      window.location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => { reg.update().catch(() => {}); })
        .catch(() => {});
    });
  }
})();
