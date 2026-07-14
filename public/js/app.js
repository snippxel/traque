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
  socket.on('connect', () => {
    const s = loadSession();
    if (s && s.code && s.playerId && !state.joined) {
      socket.emit('resume', { code: s.code, playerId: s.playerId }, (res) => {
        if (res && res.ok) {
          state.code = res.code; state.playerId = res.playerId; state.name = s.name || '';
          state.joined = true;
          startGeo();
        } else {
          clearSession();
        }
      });
    }
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

  socket.on('converted', ({ reason, by }) => {
    clearZoneAlert();
    if (reason === 'scan') toast('Capturé par ' + (by || 'un chasseur') + ' — tu passes chasseur.', 'danger', 4000);
    else toast('Hors zone trop longtemps — tu passes chasseur.', 'danger', 4000);
    Sensors.vibrate([600]);
  });

  socket.on('hunter:flash', ({ name, lat, lng }) => {
    GameMap.pulse(lat, lng, name, 6000);
    Sensors.ping(1400);
    Sensors.vibrate(120);
    toast('SORTIE DE ZONE : ' + name, 'amber', 4000);
  });

  socket.on('radar:result', ({ name, lat, lng }) => {
    GameMap.pulse(lat, lng, name, 8000);
    Sensors.ping(1600);
    toast('RADAR : cible localisée (' + name + ')', 'amber', 4000);
  });

  socket.on('chat', ({ from, text, role }) => {
    const log = $('chat-log');
    const b = document.createElement('div');
    b.className = 'chat-bubble' + (role === 'hunter' ? ' hunter' : '');
    b.innerHTML = '<b>' + escapeHtml(from) + '</b> ' + escapeHtml(text);
    log.appendChild(b);
    Sensors.ping(900);
    setTimeout(() => { b.style.opacity = '0'; b.style.transition = 'opacity .4s'; setTimeout(() => b.remove(), 420); }, 6000);
  });

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
    const map = {
      'cfg-startRadius': cfg.startRadius, 'cfg-finalRadius': cfg.finalRadius,
      'cfg-durationMin': cfg.durationMin, 'cfg-shrinkSteps': cfg.shrinkSteps,
      'cfg-revealIntervalMin': cfg.revealIntervalMin, 'cfg-graceSeconds': cfg.graceSeconds,
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

    // Chasseur : signaux + révélations
    if (role === 'hunter') {
      GameMap.setSignals(s.signals || []);
      GameMap.setReveals(s.reveals || []);
    } else {
      GameMap.clearSignals();
    }

    // Boutons d'action selon rôle
    $('btn-code').classList.toggle('hidden', role !== 'hider');
    $('btn-scan').classList.toggle('hidden', role !== 'hunter');
    $('btn-radar').classList.toggle('hidden', role !== 'hunter');
    updateRadarButton();
    $('compass').classList.toggle('hidden', role !== 'hider');
    if (role === 'hunter') stopCompass();

    updateTimers();
  }

  // Ticker local pour fluidifier minuteurs entre deux états serveur
  let hudTimer = null;
  function startHudTicker() {
    if (hudTimer) return;
    hudTimer = setInterval(() => { updateTimers(); updateZoneCountdown(); updateRadarButton(); }, 250);
  }
  // Bouton radar : disponible, ou en recharge avec compte à rebours (cooldown 3 min)
  function updateRadarButton() {
    const s = state.last;
    const btn = $('btn-radar');
    if (!s || !s.you || s.you.role !== 'hunter') return;
    const left = (s.you.radarReadyAt || 0) - Date.now();
    if (left > 0) {
      btn.disabled = true;
      btn.textContent = 'RADAR ' + fmt(left);
    } else {
      btn.disabled = false;
      btn.textContent = 'RADAR';
    }
  }
  function updateTimers() {
    const s = state.last;
    if (!s || s.status !== 'playing') return;
    // Temps restant
    const tk = $('hud-timer-k'), tv = $('hud-timer');
    if (s.config && s.config.lastSurvivor) {
      tk.textContent = 'MODE'; tv.textContent = 'SURVIE'; tv.classList.remove('danger');
    } else if (s.timeLeft != null) {
      const left = Math.max(0, s.timeLeft - (Date.now() - state.lastAt));
      tk.textContent = 'TEMPS'; tv.textContent = fmt(left);
      tv.classList.toggle('danger', left < 60000);
    }
    // Prochain rétrécissement
    if (s.zone && s.zone.nextShrinkAt) {
      const d = Math.max(0, s.zone.nextShrinkAt - Date.now());
      $('shrink-timer').textContent = fmt(d);
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
    compassOn = true;
    await Sensors.startCompass(() => {});
  }
  function stopCompass() { if (compassOn) { Sensors.stopCompass(); compassOn = false; } }

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
  const cfgIds = ['cfg-startRadius', 'cfg-finalRadius', 'cfg-durationMin', 'cfg-shrinkSteps', 'cfg-revealIntervalMin', 'cfg-graceSeconds', 'cfg-lastSurvivor'];
  let cfgTimer = null;
  function pushConfig() {
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => {
      socket.emit('updateConfig', { config: {
        startRadius: +$('cfg-startRadius').value,
        finalRadius: +$('cfg-finalRadius').value,
        durationMin: +$('cfg-durationMin').value,
        shrinkSteps: +$('cfg-shrinkSteps').value,
        revealIntervalMin: +$('cfg-revealIntervalMin').value,
        graceSeconds: +$('cfg-graceSeconds').value,
        lastSurvivor: $('cfg-lastSurvivor').checked,
      }});
    }, 250);
  }
  cfgIds.forEach((id) => { const el = $(id); if (el) el.addEventListener('change', pushConfig); });

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
  $('btn-scan').onclick = openScan;
  $('btn-radar').onclick = () => {
    const btn = $('btn-radar');
    if (btn.disabled) return;
    btn.disabled = true; // désactivation optimiste ; l'état serveur confirme le cooldown
    socket.emit('useRadar', {}, (res) => {
      if (!res || !res.ok) { toast((res && res.error) || 'Radar indisponible.', 'amber'); updateRadarButton(); }
    });
  };
  $('btn-chat').onclick = () => $('modal-chat').classList.remove('hidden');

  // Chat prédéfini
  const CHAT_LABELS = ['À l’aide 🆘', 'Je suis coincé', 'RAS', 'Par ici 👉'];
  const chatBtns = $('chat-buttons');
  CHAT_LABELS.forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'btn'; b.textContent = label;
    b.onclick = () => { socket.emit('chat', { index: i }); $('modal-chat').classList.add('hidden'); };
    chatBtns.appendChild(b);
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

  // Wake lock auto-réacquisition
  Sensors.initWakeLockAutoReacquire();
  updateLaunchState();

  // Service worker (installabilité PWA)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }
})();
