'use strict';
/*
 * app.js — orchestrateur client. Relie le serveur (Socket.io), les capteurs,
 * la carte et le QR, et pilote les 4 écrans (accueil / lobby / jeu / fin).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = 'traque:session';

  // Reconnexion agressive : en extérieur le réseau saute souvent, on veut
  // revenir vite et sans limite de tentatives.
  const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 10000,
  });

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
    targetUntil: 0,      // fin de la fenêtre "cible visible" (côté chasseur, après radar)
    zoneClosingAt: 0,    // heure du prochain rétrécissement annoncé (alerte -1 min)
    wasDispersing: false, // pour détecter le passage dispersion -> chasse
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
  // Plafonné à 2. En fin de partie, huit cachés qui tombent produisaient seize
  // toasts empilés sur 238 px — 29 % de l'écran — par-dessus la boussole et le
  // badge GPS, exactement au moment où il faut décider où courir.
  const TOAST_MAX = 2;
  function toast(msg, kind, ms) {
    const box = $('toasts');
    // Message identique déjà affiché : on incrémente un compteur au lieu d'empiler
    const twin = [...box.children].find((el) => el.dataset.msg === msg);
    if (twin) {
      twin.dataset.n = String((+twin.dataset.n || 1) + 1);
      twin.textContent = msg + ' ×' + twin.dataset.n;
      return;
    }
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    t.dataset.msg = msg;
    t.dataset.n = '1';
    box.appendChild(t);
    while (box.children.length > TOAST_MAX) box.firstElementChild.remove();
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms || 3200);
  }

  // Le serveur répond en prose ("Il faut au moins 2 joueurs."), l'interface parle
  // en capitales sans ponctuation. On remet ses messages dans la voix du jeu.
  const SERVER_VOICE = {
    'Il faut au moins 2 joueurs.': 'IL FAUT AU MOINS 2 JOUEURS',
    'Partie déjà lancée.': 'PARTIE DÉJÀ LANCÉE',
    'Partie introuvable.': 'PARTIE INTROUVABLE — VÉRIFIE LE CODE',
    'Sécurité non validée.': 'COCHE LA VÉRIFICATION DE SÉCURITÉ',
    'Réservé à l’hôte.': 'RÉSERVÉ À L’HÔTE',
    'Ce nom est déjà pris.': 'CE NOM EST DÉJÀ PRIS',
  };
  function voice(msg, fallback) {
    if (!msg) return fallback;
    return SERVER_VOICE[msg] || msg.replace(/\.$/, '').toUpperCase();
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
        renvoyerEtat();
      } else {
        // Reprise impossible par l'identifiant de session. On ne laisse SURTOUT
        // pas le joueur sur un écran figé : retour à l'accueil avec le code et le
        // nom déjà remplis, il lui suffit d'appuyer sur REJOINDRE pour reprendre
        // sa place exacte (le serveur le reconnaît à son nom).
        const lostCode = sess.code, lostName = sess.name || state.name || '';
        clearSession();
        if (state.joined) {
          sessionLost(lostCode, lostName, (res && res.error) || 'Session expirée.');
        }
      }
    });
  });

  socket.on('disconnect', () => { if (state.inGame) toast('Connexion perdue — reconnexion…'); });

  // ---------------------------------------------------------------- WATCHDOG
  // Sur mobile, la connexion peut mourir SANS événement 'disconnect' (écran
  // verrouillé, app en arrière-plan, changement de réseau) : le client croit
  // être connecté mais ne reçoit plus rien. Résultat vécu en partie : positions
  // des autres figées et timers bloqués à 00:00, jusqu'à un refresh manuel.
  // On surveille donc le silence et on se resynchronise tout seul.
  const SILENCE_MS = 6000; // > 3 ticks serveur (1.5 s) : le silence est anormal
  function forceResync() {
    if (!state.joined) return;
    if (!socket.connected) socket.connect(); // le handler 'connect' fera le resume
    else socket.emit('resync');
  }
  setInterval(() => {
    updateNetBadge();
    updateGpsBadge(); // fait vieillir "GPS PERDU 0:42" même hors partie
    if (!state.joined || !state.lastAt) return;
    if (Date.now() - state.lastAt > SILENCE_MS) forceResync();
  }, 2500);

  // Indicateur de liaison : le joueur voit en un coup d'œil si ses données sont
  // fraîches, plutôt que de se demander si l'écran est figé.
  function updateNetBadge() {
    const el = $('net-badge');
    if (!el) return;
    const silence = state.lastAt ? Date.now() - state.lastAt : Infinity;
    let cls = '', txt = 'LIÉ';
    if (!socket.connected) { cls = 'down'; txt = 'HORS LIGNE'; }
    else if (silence > SILENCE_MS) { cls = 'warn'; txt = 'RESYNC…'; }
    el.className = 'net-badge' + (cls ? ' ' + cls : '');
    $('net-text').textContent = txt;
    // Le badge ne vivait que dans l'écran de jeu : sur l'accueil et dans le
    // lobby, un joueur dans une zone morte appuyait sur un bouton et n'obtenait
    // rien du tout — pas de message, pas d'état, rien. Bandeau global ici.
    $('offline-banner').classList.toggle('hidden', socket.connected || state.inGame);
  }

  // Retour au premier plan : on resynchronise immédiatement, sans attendre le
  // watchdog, pour que l'écran soit à jour dès que le joueur regarde son téléphone.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') forceResync();
  });
  window.addEventListener('focus', forceResync);
  window.addEventListener('online', forceResync);

  // ================================================================ ÉVÉNEMENTS
  socket.on('state', (s) => {
    state.last = s; state.lastAt = Date.now();
    state.role = s.you.role;
    route(s);
  });

  socket.on('zone:alert', ({ deadline }) => {
    state.alertDeadline = deadline;
    $('zone-alert').classList.remove('hidden');
    $('zone-frame').classList.remove('hidden');
    updateZoneBearing(true);
    Sensors.startAlarm();
    Sensors.vibrate([300, 150, 300, 150, 600]);
  });
  socket.on('zone:alertCancelled', () => clearZoneAlert());

  // La zone va se fermer (~1 min) et je ne suis pas dans la prochaine zone
  socket.on('zone:closing', ({ atTime }) => {
    state.zoneClosingAt = atTime;
    wantBanner('zone-closing', true);
    updateAlertLane();
    Sensors.vibrate([300, 130, 300, 130, 460]);
    Sensors.sfx('shrink');
  });

  // Le climax du jeu. Il recevait un toast de 13 px et un buzz de 600 ms pendant
  // que toute l'interface se réorganisait en silence : rôle vert -> ambre,
  // boussole et MON CODE qui disparaissent, ÉLIMINER et RADAR qui apparaissent.
  // Un joueur qui baissait les yeux en courant voyait une autre application.
  socket.on('converted', ({ reason, by }) => {
    clearZoneAlert();
    // Le QR d'identité et les alertes "caché" n'ont plus de sens : on nettoie
    $('modal-qr').classList.add('hidden');
    $('spot-alert').classList.add('hidden');
    wantBanner('zone-closing', false);
    wantBanner('spot-banner', false);
    updateAlertLane();
    state.zoneClosingAt = 0;
    state.spottedUntil = 0;
    showCaptureTakeover(reason, by);
  });

  let captureTimer = null;
  function showCaptureTakeover(reason, by) {
    const el = $('capture-alert');
    $('ca-by').textContent = reason === 'scan'
      ? 'PAR ' + (by ? by.toUpperCase() : 'UN CHASSEUR')
      : 'SORTI DE LA ZONE TROP LONGTEMPS';
    $('ca-note').textContent = reason === 'scan'
      ? 'Ta cible : les cachés encore en jeu. Scanne leur QR code.'
      : 'Tu chasses maintenant. Scanne le QR code des cachés.';
    el.classList.remove('hidden');
    // Trois canaux, comme l'alerte REPÉRÉ qui est le moment le mieux conçu du jeu
    Sensors.sfx('captured');
    // La vibration est calée sur la chute de sub, pas sur le début du son.
    setTimeout(() => Sensors.vibrate([500, 130, 400]), 600);
    trapFocus(el);
    if (captureTimer) clearTimeout(captureTimer);
    // Filet : si le joueur ne touche rien (téléphone en poche), on referme seul
    captureTimer = setTimeout(hideCaptureTakeover, 9000);
  }
  function hideCaptureTakeover() {
    if (captureTimer) { clearTimeout(captureTimer); captureTimer = null; }
    $('capture-alert').classList.add('hidden');
    releaseFocus();
  }
  $('ca-ok').onclick = hideCaptureTakeover;

  socket.on('hunter:flash', ({ name, lat, lng }) => {
    // Le marqueur exact est affiché par l'état serveur (reveals) — pas de doublon ici.
    // Mais s'il est loin de la vue actuelle, il reste invisible sans recadrage :
    // le joueur voyait le toast sans jamais voir le point apparaître.
    // Un caché qui sort est une occasion de capture, et elle est brève. Elle
    // avait le souffle de transition générique et 120 ms de buzz : ratable en
    // courant. Son propre, et un motif long en trois temps — sur iPhone, où
    // l'API Vibration n'existe pas, c'est le nombre de secousses qui porte,
    // pas leur durée.
    Sensors.sfx('breach');
    Sensors.vibrate([260, 110, 260, 110, 520]);
    toast('SORTIE DE ZONE : ' + name, 'danger', 4000);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const pts = [[lat, lng]];
      if (state.selfPos) pts.push([state.selfPos.lat, state.selfPos.lng]);
      GameMap.focus(pts);
    }
  });

  socket.on('radar:result', ({ name, lat, lng }) => {
    // Le marqueur exact est affiché par l'état serveur (reveals) — pas de doublon ici.
    // Même recadrage que hunter:flash : sinon la cible révélée loin du chasseur
    // n'apparaît jamais à l'écran malgré le toast de confirmation.
    Sensors.sfx('third');
    toast('RADAR : cible localisée (' + name + ')', 'hunter', 4000);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const pts = [[lat, lng]];
      if (state.selfPos) pts.push([state.selfPos.lat, state.selfPos.lng]);
      GameMap.focus(pts);
    }
  });

  // Le caché a été repéré au radar : alerte marquée (son + vibration répétés,
  // flash prolongé), et il voit le chasseur en direct pendant 30 s.
  socket.on('radar:spotted', ({ by, hunter, until }) => {
    state.spottedUntil = until;
    showSpotAlert(by);
    Sensors.vibrate([300, 150, 300, 150, 300, 150, 600]);
    Sensors.sfx('spotted');
    if (hunter) {
      GameMap.setSpotted([{ name: hunter.name, lat: hunter.lat, lng: hunter.lng, until }]);
      const pts = [[hunter.lat, hunter.lng]];
      if (state.selfPos) pts.push([state.selfPos.lat, state.selfPos.lng]);
      GameMap.focus(pts);
    }
  });

  // Un coéquipier caché vient de tomber : alerte + lieu exact sur la carte.
  socket.on('teammate:down', ({ name, reason, by, lat, lng, hidersLeft }) => {
    const how = reason === 'zone' ? 'sorti de la zone' : (by ? 'pris par ' + by : 'capturé');
    toast('⚠ ' + name + ' est tombé (' + how + ')', 'danger', 5000);
    Sensors.vibrate([280, 120, 280, 120, 400]);
    Sensors.sfx('down');
    GameMap.addDown(lat, lng, name, 120000);
    // hidersLeft vient du serveur : seul comptage fiable au moment de la capture
    if (typeof hidersLeft === 'number') {
      setTimeout(() => toast('Cachés restants : ' + hidersLeft, '', 3500), 900);
    }
  });

  // Compteur de messages non lus (remis à zéro à l'ouverture du chat)
  let unreadChat = 0;
  function updateChatBadge() {
    const b = $('chat-badge');
    b.textContent = unreadChat > 9 ? '9+' : String(unreadChat);
    b.classList.toggle('hidden', unreadChat === 0);
  }

  // Clés des messages déjà affichés : l'historique rejoué à la reconnexion
  // recoupe forcément ce qui a été reçu en direct juste avant la coupure.
  const chatVus = new Set();
  const cleChat = (m) => m.at + '|' + m.from + '|' + m.text;

  // Rejeu à l'arrivée ou au retour. On remplit UNIQUEMENT le fil de la modale :
  // pas de bulles, pas de sons. Faire surgir vingt bulles et vingt sons d'un
  // coup à la reconnexion serait pire que le silence qu'on répare.
  socket.on('chat:history', (liste) => {
    if (!Array.isArray(liste)) return;
    for (const m of liste) {
      const k = cleChat(m);
      if (chatVus.has(k)) continue;
      chatVus.add(k);
      addChatMessage(m.from, m.text);
    }
  });

  // Chat global (texte libre) : reçu par tous
  socket.on('chat', (m) => {
    const { from, text } = m;
    const k = cleChat(m);
    if (chatVus.has(k)) return;
    chatVus.add(k);
    if ($('modal-chat').classList.contains('hidden') && from !== state.name) {
      unreadChat++; updateChatBadge();
    }
    addChatMessage(from, text);
    const log = $('chat-log');
    const b = document.createElement('div');
    b.className = 'chat-bubble';
    b.innerHTML = '<b>' + escapeHtml(from) + '</b><span>' + escapeHtml(text) + '</span>';
    log.appendChild(b);
    Sensors.sfx('chat');
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
    // Retour au lobby après une partie (Rejouer) : on efface la carte précédente
    if (s.status === 'lobby' && state.wasPlaying) {
      state.wasPlaying = false;
      safeMapReset();
      teardownGame();
      state.endChimed = false;
      // La vérification de sécurité est refaite à CHAQUE partie. Le groupe a
      // bougé, la lumière a changé, le terrain n'est plus le même : une case
      // cochée il y a une heure ne certifie rien.
      resetSafety();
    }
    if (s.status === 'playing' || s.status === 'ended') state.wasPlaying = true;
    if (s.status === 'lobby') { renderLobby(s); show('screen-lobby'); armHeading(); }
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
    const count = (s.roster || []).length;
    $('roster-count').textContent = count;
    $('lb-count').textContent = count;
    $('lb-code').textContent = s.code;

    if (s.isHost) {
      $('host-panel').classList.remove('hidden');
      $('launch-bar').classList.remove('hidden');
      $('guest-panel').classList.add('hidden');
      // Aperçu de la zone : l'hôte doit pouvoir vérifier le terrain avant de lancer
      $('zone-preview-panel').classList.remove('hidden');
      updateZonePreview(s.config);
      fillConfig(s.config);
      renderManual(s);
      renderReady(s);
      // mode d'attribution
      state.roleMode = s.roleMode;
      const rnd = s.roleMode === 'random';
      $('btn-role-random').classList.toggle('active', rnd);
      $('btn-role-random').setAttribute('aria-pressed', String(rnd));
      $('btn-role-manual').classList.toggle('active', !rnd);
      $('btn-role-manual').setAttribute('aria-pressed', String(!rnd));
      $('manual-assign').classList.toggle('hidden', rnd);
      // Les rôles affichés doivent être les VRAIS rôles. Tant que personne n'a
      // appuyé sur ALÉATOIRE, le serveur laissait tout le monde caché pendant
      // que le bouton se disait actif.
      if (!rolesEverAssigned && rnd && count >= 2 && !(s.roster || []).some((p) => p.role === 'hunter')) {
        rolesEverAssigned = true;
        socket.emit('assignRoles', { mode: 'random' });
      }
      updateLaunchState();
    } else {
      $('host-panel').classList.add('hidden');
      $('launch-bar').classList.add('hidden');
      $('zone-preview-panel').classList.add('hidden');
      $('guest-panel').classList.remove('hidden');
      $('guest-role').textContent = s.you.role === 'hunter' ? 'CHASSEUR' : 'CACHÉ';
      $('guest-role').className = s.you.role === 'hunter' ? 'c-hunter' : 'c-hider';
    }
  }

  // Aperçu de la zone dans le lobby, centré sur la position de l'hôte (c'est
  // exactement là que la zone sera créée au lancement).
  function updateZonePreview(cfg) {
    const hint = $('preview-hint');
    const empty = $('preview-empty');
    if (!state.selfPos) {
      // Sans position, Leaflet n'était jamais initialisé : un rectangle noir de
      // 190 px, "Acquisition GPS…" indéfiniment, aucun réessai — et la case de
      // sécurité restait cochable. On certifiait un terrain qu'on ne voyait pas.
      empty.classList.remove('hidden');
      $('preview-radius').textContent = '—';
      hint.textContent = geoState.denied
        ? 'GPS refusé : autorise la localisation pour vérifier le terrain.'
        : 'Acquisition GPS… la zone se centrera sur ta position au lancement.';
      hint.className = 'preview-hint' + (geoState.denied ? ' bad' : '');
      return;
    }
    empty.classList.add('hidden');
    const radius = (cfg && cfg.startRadius) || 500;
    $('preview-radius').textContent = radius + ' m';
    hint.textContent = 'Vérifie : routes passantes, plans d’eau, propriétés privées.';
    hint.className = 'preview-hint ok';
    GameMap.previewUpdate(state.selfPos, radius);
  }
  $('btn-preview-retry').onclick = () => {
    $('preview-hint').textContent = 'Nouvelle acquisition GPS…';
    geoState.denied = false;
    Sensors.stopWatch();
    startGeo();
  };

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
      'cfg-finalZoneMinutes': cfg.finalZoneMinutes,
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
    // Sans Leaflet, GameMap.init() levait dans enterGame() et l'écran de jeu ne
    // s'affichait tout simplement jamais — écran blanc, aucun message. Les libs
    // sont auto-hébergées et mises en cache maintenant, mais on garde la garde :
    // un échec silencieux au lancement d'une partie est le pire scénario.
    if (typeof L === 'undefined') {
      toast('RESSOURCES MANQUANTES — recharge la page', 'danger', 15000);
      $('lobby-error') && lobbyError('CARTE INDISPONIBLE — RECHARGE LA PAGE');
      return;
    }
    state.inGame = true;
    show('screen-game');
    GameMap.init();
    GameMap.invalidate();
    startHeadingTracking();
    // Si l'écran peut se verrouiller, le GPS s'arrête et la position se fige :
    // mieux vaut prévenir le joueur une fois au début.
    Sensors.requestWakeLock().then((ok) => {
      rapporterEtat({ wake: !!ok });
      if (!ok) toast('⚠ L’écran peut se verrouiller : garde l’app ouverte, sinon ta position se fige.', 'danger', 8000);
    });
    Sensors.ensureAudio();
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
      // Le palier lui-même n'avait AUCUN retour : seul son avertissement une
      // minute avant en avait un. Le terrain rétrécissait donc en silence, au
      // moment précis où il fallait bouger. On ne le signale qu'à la
      // CONTRACTION — un rayon qui remonte est une resynchronisation, pas un
      // événement de jeu.
      if (state.lastRadius != null && s.zone.radius < state.lastRadius - 1) {
        Sensors.sfx('shrink');
        Sensors.vibrate([300, 120, 300, 120, 560]);
      }
      state.lastRadius = s.zone.radius;
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
      // Le serveur donne un 'until' par révélation : on garde la plus lointaine
      // pour savoir combien de temps la cible reste encore affichée.
      const ends = (s.reveals || []).map((r) => r.until).filter(Boolean);
      state.targetUntil = ends.length ? Math.max(...ends) : 0;
    } else {
      GameMap.clearSignals();
      state.targetUntil = 0;
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
    // Timer de révélation : caché seulement en phase de chasse (masqué au départ)
    const rt = $('reveal-timer');
    rt.classList.toggle('hidden', dispersion);
    rt.classList.toggle('hider', role === 'hider');
    $('rt-label').textContent = role === 'hunter' ? 'RÉVÉLATION' : 'TON SIGNAL';
    // Bandeau rétrécissement masqué pendant la dispersion (la zone ne bouge pas encore)
    if (dispersion) $('hud-shrink').classList.add('hidden');

    // Interface de départ
    updateStartBanner();
    renderPlayersPanel(); // liste des joueurs si elle est ouverte

    updateTimers();
  }

  // Ticker local pour fluidifier minuteurs entre deux états serveur
  let hudTimer = null;
  function startHudTicker() {
    if (hudTimer) return;
    hudTimer = setInterval(() => { updateTimers(); updateZoneCountdown(); updateRadarButton(); updateSpotBanner(); updateTargetBanner(); updateZoneClosing(); updateStartBanner(); updateGpsBadge(); updateAlertLane(); }, 250);
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
  }

  // Un seul bandeau d'alerte à la fois, par priorité décroissante. Ils étaient
  // en position absolue à des offsets fixes et se recouvraient : pendant
  // "FUYEZ !", start-banner masquait la boussole ET le badge GPS — les deux
  // instruments dont un caché a besoin pour décider où courir.
  const LANE_PRIORITY = ['zone-closing', 'start-banner', 'spot-banner', 'target-banner'];
  function updateAlertLane() {
    let taken = false;
    for (const id of LANE_PRIORITY) {
      const el = $(id);
      if (!el) continue;
      const wants = el.dataset.want === '1';
      const showIt = wants && !taken;
      el.classList.toggle('hidden', !showIt);
      if (showIt) taken = true;
    }
  }
  // Les fonctions de mise à jour déclarent leur intention ici ; l'arbitre
  // ci-dessus décide qui s'affiche réellement.
  function wantBanner(id, on) { $(id).dataset.want = on ? '1' : '0'; }
  function updateZoneCountdown() {
    if (!state.alertDeadline) return;
    const left = Math.max(0, Math.ceil((state.alertDeadline - Date.now()) / 1000));
    $('za-countdown').textContent = left;
    updateZoneBearing();
  }

  // Cap et distance vers la zone : c'est l'information qui manquait totalement.
  // Le joueur recevait un ordre ("REVIENS") et un décompte, mais rien qui dise
  // où aller. Le cap est donné nord en haut, comme la carte : les deux se lisent
  // dans le même repère, et aucune permission boussole n'est nécessaire.
  // Angle cumulé, volontairement NON borné à [0,360[ : voir plus bas.
  let arrowAngle = null;
  function updateZoneBearing(reset) {
    const z = state.last && state.last.zone;
    const p = state.selfPos;
    const arrow = $('za-arrow');
    const dist = $('za-dist');
    if (!z || !z.center || !p) {
      arrow.classList.add('hidden');
      dist.textContent = 'CAP INCONNU';
      return;
    }
    arrow.classList.remove('hidden');
    const target = GameMap.bearing(p, z.center);
    if (reset || arrowAngle === null) {
      // Première pose : sans transition, sinon la flèche balaierait depuis 0°
      // à l'ouverture de l'alerte.
      arrowAngle = target;
      arrow.style.transition = 'none';
      arrow.style.transform = 'rotate(' + target.toFixed(1) + 'deg)';
      void arrow.offsetWidth;
      arrow.style.transition = '';
    } else {
      // rotate() s'interpole numériquement : passer de 358° à 2° faisait
      // repartir la flèche en arrière sur 356°, en pleine alerte hors-zone.
      // On n'ajoute donc que le plus court chemin angulaire.
      const delta = ((target - arrowAngle) % 360 + 540) % 360 - 180;
      arrowAngle += delta;
      arrow.style.transform = 'rotate(' + arrowAngle.toFixed(1) + 'deg)';
    }
    // Distance jusqu'au BORD de la zone, pas jusqu'au centre : c'est ce que le
    // joueur doit réellement parcourir pour être de nouveau en sécurité.
    const toEdge = Math.round(haversine(p, z.center) - z.radius);
    dist.textContent = toEdge > 0 ? toEdge + ' M' : 'ZONE ATTEINTE';
  }
  // Cap du téléphone : oriente le cône de visée du marqueur « MOI ».
  // iOS 13+ exige que requestPermission() parte d'un geste. On l'arme donc au
  // premier appui APRÈS l'entrée en partie : demander une permission sur
  // l'écran d'accueil, avant que le joueur ait vu la moindre carte, ne veut
  // rien dire pour lui. Sur Android il n'y a pas de fenêtre du tout.
  // « Pas de cône » pouvait signifier quatre choses — geste jamais capté,
  // permission refusée, appareil sans magnétomètre, ou capteur muet — et rien
  // ne les distinguait à l'écran. Cet état est affiché dans le panneau
  // ÉQUIPES : c'est ce qui rend le problème diagnosticable au lieu de devinable.
  const GESTES = ['pointerdown', 'touchend', 'click'];
  let headingGranted = false, headingGo = null, headingWarned = false, headingTracking = false;

  function setHeadingStatus(txt, cls) {
    const el = $('pp-heading');
    if (!el) return;
    el.textContent = 'CAP : ' + txt;
    el.className = 'pp-heading' + (cls ? ' ' + cls : '');
  }

  // Armé dès le SALON : le joueur y est à l'arrêt, en train de regarder son
  // écran. Demander l'autorisation une fois la chasse lancée tombait au pire
  // moment — il court, il ne lit pas, il balaie la fenêtre sans la voir.
  // PAS `once` : un refus, ou un geste qu'iOS ne reconnaît pas comme
  // intentionnel, condamnait le cône pour toute la partie. Trois types de
  // gestes écoutés — c'est un `click` sur un vrai bouton qui a fini par
  // marcher en test, `pointerdown` seul ne suffisait pas.
  function armHeading() {
    if (headingGranted || headingGo) return;
    setHeadingStatus('EN ATTENTE D’UN APPUI');
    headingGo = async () => {
      if (headingGranted) return;
      const ok = await Sensors.requestHeadingPermission();
      if (!ok) { setHeadingStatus('AUTORISATION REFUSÉE', 'ko'); return; }
      headingGranted = true;
      GESTES.forEach((g) => document.removeEventListener(g, headingGo));
      headingGo = null;
      setHeadingStatus('AUTORISÉ');
      rapporterEtat({ heading: true });
      if (state.inGame) startHeadingTracking();
    };
    GESTES.forEach((g) => document.addEventListener(g, headingGo));
  }

  // Le capteur ne tourne QU'EN partie : le faire tourner pendant que l'hôte
  // règle le salon ne sert à rien et coûte de la batterie.
  function startHeadingTracking() {
    if (headingTracking) return;
    if (!headingGranted) { armHeading(); return; }
    headingTracking = true;
    setHeadingStatus('AUTORISÉ — EN ATTENTE DU CAPTEUR');
    Sensors.startHeading(
      (h) => { GameMap.setHeading(h); setHeadingStatus('ACTIF · ' + Math.round(h) + '°', 'ok'); },
      (st) => { if (st === 'none') headingUnavailable(); }
    );
  }

  function headingUnavailable() {
    GameMap.setHeading(null);
    setHeadingStatus('CAPTEUR MUET OU ABSENT', 'ko');
    rapporterEtat({ heading: false });
    if (headingWarned) return;
    headingWarned = true;
    toast('Boussole indisponible sur ce téléphone — pas de cône d’orientation.', '', 6000);
  }

  // On arrête le capteur, mais on GARDE l'autorisation : une fois accordée,
  // elle vaut pour toute la session. Redemander à chaque partie serait une
  // fenêtre de plus entre le groupe et le lancement.
  function disarmHeading() {
    headingTracking = false; headingWarned = false;
    setHeadingStatus('—');
    Sensors.stopHeading();
  }

  // Ouverture de la chasse. Le son et la vibration étaient déjà calés ; il
  // manquait l'image. ~1,46 s au total, contre ~2 s pour la capture : ce n'est
  // pas la conclusion de la partie, c'est son coup d'envoi.
  let kickoffTimers = [];
  function showKickoff(role) {
    const el = $('kickoff');
    if (!el) return;
    kickoffTimers.forEach(clearTimeout); kickoffTimers = [];
    const hunter = role === 'hunter';
    el.classList.toggle('hider', !hunter);
    $('ko-title').textContent = hunter ? 'CHASSEZ' : 'FUYEZ';
    $('ko-sub').textContent = hunter ? 'TROUVE-LES AVANT LA FIN' : 'METS-TOI À COUVERT';
    el.classList.remove('hidden', 'out');
    void el.offsetWidth; // relance les animations si le bandeau est rejoué
    kickoffTimers.push(setTimeout(() => {
      el.classList.add('out');
      kickoffTimers.push(setTimeout(() => el.classList.add('hidden'), 300));
    }, 2600));
  }
  function hideKickoff() {
    kickoffTimers.forEach(clearTimeout); kickoffTimers = [];
    const el = $('kickoff');
    if (el) el.classList.add('hidden');
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
      wantBanner('start-banner', false);
      // Transition dispersion -> chasse : son + vibration pour que tout le monde
      // le sente sans avoir les yeux sur l'écran.
      if (state.wasDispersing && s && s.status === 'playing') {
        state.wasDispersing = false;
        // Vibration calée sur les frappes de l'écran, pas envoyée en bloc au
        // début : une secousse qui ne correspond à rien de visible se ressent
        // comme une notification, pas comme un événement de jeu. Même principe
        // que la capture, dont le buzz est décalé pour tomber sur la basse.
        // [attente, frappe...] — 300 surtitre · 460 titre · 720 barre · 880 consigne
        Sensors.vibrate([0, 300, 45, 115, 70, 190, 55, 105, 280]);
        Sensors.sfx('kickoff');
        showKickoff(state.role);
      }
      return;
    }
    state.wasDispersing = true;
    wantBanner('start-banner', true);
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
    const left = (state.zoneClosingAt || 0) - Date.now();
    if (left > 0) {
      wantBanner('zone-closing', true);
      $('zc-timer').textContent = fmt(left);
    } else {
      wantBanner('zone-closing', false);
      state.zoneClosingAt = 0;
    }
  }

  // Bannière décomptée pendant que la position du chasseur reste visible (30 s)
  function updateSpotBanner() {
    const left = (state.spottedUntil || 0) - Date.now();
    if (left > 0) {
      wantBanner('spot-banner', true);
      $('spot-timer').textContent = fmt(left);
    } else {
      wantBanner('spot-banner', false);
      if (state.spottedUntil) { state.spottedUntil = 0; GameMap.setSpotted([]); }
    }
  }
  // Symétrique de updateSpotBanner : le chasseur voit combien de temps il lui
  // reste avant que le point de sa cible disparaisse.
  function updateTargetBanner() {
    const left = (state.targetUntil || 0) - Date.now();
    if (left > 0) {
      wantBanner('target-banner', true);
      $('target-timer').textContent = fmt(left);
    } else {
      wantBanner('target-banner', false);
      if (state.targetUntil) state.targetUntil = 0;
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
    $('zone-frame').classList.add('hidden');
    Sensors.stopAlarm();
  }

  function teardownGame() {
    state.inGame = false;
    // Sinon le premier état de la partie suivante, ou d'une reprise de session,
    // serait lu comme un rétrécissement.
    state.lastRadius = null;
    hideKickoff();
    disarmHeading();
    if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
    Sensors.stopAlarm();
    Sensors.releaseWakeLock();
    clearZoneAlert();
    state.spottedUntil = 0;
    state.zoneClosingAt = 0;
    state.wasDispersing = false;
    $('spot-alert').classList.add('hidden');
    hideCaptureTakeover();
    wantBanner('spot-banner', false);
    wantBanner('target-banner', false);
    wantBanner('zone-closing', false);
    wantBanner('start-banner', false);
    state.targetUntil = 0;
    updateAlertLane();
    $('reveal-timer').classList.add('hidden');
    $('btn-scan').classList.remove('locked');
    $('btn-radar').classList.remove('locked');
    $('modal-chat').classList.add('hidden');
    $('chat-messages').innerHTML = '';
    chatVus.clear(); // sinon un rejeu après REJOUER serait filtré comme déjà vu
    $('players-panel').classList.add('hidden');
    $('modal-confirm').classList.add('hidden');
    unreadChat = 0; updateChatBadge();
  }

  // ---------------------------------------------------------------- FIN
  function renderEnd(s) {
    const r = s.result;
    // Sans résultat, on sortait en laissant le bandeau de la partie PRÉCÉDENTE
    // et une table vide à l'écran.
    if (!r) {
      $('end-personal').textContent = 'RÉSULTAT INDISPONIBLE';
      $('end-personal').className = 'end-personal';
      $('end-banner').className = 'end-banner';
      $('end-banner').textContent = 'FIN DE PARTIE';
      $('stats-table').querySelector('tbody').innerHTML = '';
      $('btn-replay').classList.toggle('hidden', !s.isHost);
      return;
    }
    // Seul l'hôte peut relancer une partie avec les mêmes joueurs
    $('btn-replay').classList.toggle('hidden', !s.isHost);

    // Comme un caché capturé DEVIENT chasseur, un joueur éliminé à la deuxième
    // minute lisait "VICTOIRE DES CHASSEURS" et avait donc techniquement gagné.
    // Le bandeau ne disait jamais ce qui t'était arrivé à TOI.
    const me = (r.stats || []).find((p) => p.name === state.name);
    const pers = $('end-personal');
    if (me) {
      if (me.neverCaught && me.startRole === 'hider') {
        pers.textContent = 'TU AS SURVÉCU';
        pers.className = 'end-personal survived';
      } else if (me.startRole === 'hider') {
        pers.textContent = 'CAPTURÉ' + (me.survivedMs != null ? ' À ' + fmt(me.survivedMs) : '');
        pers.className = 'end-personal caught';
      } else {
        pers.textContent = me.captures > 0
          ? me.captures + (me.captures > 1 ? ' CAPTURES' : ' CAPTURE')
          : 'AUCUNE CAPTURE';
        pers.className = 'end-personal hunted';
      }
    } else {
      pers.textContent = '—';
      pers.className = 'end-personal';
    }

    const banner = $('end-banner');
    banner.className = 'end-banner ' + r.winner;
    banner.textContent = r.winner === 'hunters' ? 'VICTOIRE DES CHASSEURS' : 'VICTOIRE DES CACHÉS';
    // Accord qui se résout : après 25 minutes de tension, l'oreille a besoin
    // qu'on lui dise que c'est terminé. Une seule fois par partie.
    if (!state.endChimed) { state.endChimed = true; Sensors.sfx('final'); }
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
  // Le badge affichait `GPS --` en VERT PHOSPHORE — la couleur "tout va bien" —
  // tant qu'aucune précision numérique n'était arrivée. Position refusée, écran
  // verrouillé, iOS qui suspend la géoloc en arrière-plan : dans les trois cas
  // le joueur lisait "sain" alors que l'app ne savait pas où il était. Un caché
  // s'arrête de courir en se croyant à jour ; un chasseur poursuit un signal
  // mort. C'est la visibilité asymétrique — le cœur du produit — qui tombe.
  const geoState = { lastFixAt: 0, denied: false, started: false };
  const FIX_STALE_MS = 10000;

  function startGeo() {
    geoState.started = true;
    Sensors.watchPosition(onPos, onGeoError);
    updateGpsBadge();
  }
  function onGeoError(err, code) {
    if (code === 1) geoState.denied = true;
    rapporterEtat({ gps: false });
    updateGpsBadge();
    updateLaunchState();
    updateZonePreview(state.last && state.last.config);
    toast(err, 'danger', 5000);
  }

  // Seuils alignés sur la réalité documentée : en extérieur le GPS d'un
  // téléphone donne 5 à 30 m, et le principe produit dit que cette imprécision
  // est une donnée, pas un bug. L'ancien seuil peignait un fix urbain normal de
  // 20 m en ambre d'alerte — l'app criait au loup sur sa propre ligne de base.
  function updateGpsBadge() {
    const badge = $('gps-badge'), acc = $('gps-acc');
    if (!badge) return;
    const age = geoState.lastFixAt ? Date.now() - geoState.lastFixAt : Infinity;
    if (geoState.denied) {
      badge.className = 'gps-badge bad';
      acc.textContent = 'REFUSÉ';
      return;
    }
    if (!geoState.lastFixAt) {
      badge.className = 'gps-badge warn';
      acc.textContent = 'ACQUISITION…';
      return;
    }
    if (age > FIX_STALE_MS) {
      // Le motif d'âge existait déjà, mais appliqué aux AUTRES ("KARL · 3min").
      // Jamais à soi. C'est pourtant la seule position dont tout dépend.
      badge.className = 'gps-badge bad';
      acc.textContent = 'PERDU ' + fmt(age);
      return;
    }
    const a = state.selfPos ? state.selfPos.accuracy : 0;
    badge.className = 'gps-badge' + (a > 60 ? ' bad' : a > 35 ? ' warn' : '');
    acc.textContent = Math.round(a) + 'm';
  }
  function gpsFresh() {
    return !!geoState.lastFixAt && (Date.now() - geoState.lastFixAt) <= FIX_STALE_MS;
  }

  // État des autorisations de CET appareil, rapporté au serveur. Émis
  // uniquement au changement : c'est une information rare, pas un flux.
  const monEtat = { gps: false, wake: false, audio: false, heading: false };
  function rapporterEtat(patch) {
    let change = false;
    for (const k in patch) {
      if (monEtat[k] !== patch[k]) { monEtat[k] = patch[k]; change = true; }
    }
    if (change && state.joined) socket.emit('ready', monEtat);
  }
  // À l'arrivée et à chaque reconnexion : le serveur repart d'un état vierge
  // pour ce joueur, et un fix GPS obtenu AVANT la connexion n'aurait jamais
  // été rapporté sans ça.
  function renvoyerEtat() {
    if (state.joined) socket.emit('ready', monEtat);
  }

  function onPos(pos) {
    state.selfPos = pos;
    geoState.lastFixAt = Date.now();
    geoState.denied = false;
    rapporterEtat({ gps: true });
    updateGpsBadge();
    updateLaunchState();
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

  // ================================================================ UI HANDLERS
  // --- Accueil ---
  // Aucun état de chargement n'existait : hors réseau, on appuyait sur CRÉER et
  // il ne se passait strictement rien — pas de spinner, pas de désactivation,
  // pas de timeout, pas d'erreur. Le bouton avait juste l'air normal.
  let homeBusy = false;
  function setHomeBusy(btn, on, label) {
    homeBusy = on;
    $('btn-create').disabled = on;
    $('btn-join').disabled = on;
    btn.textContent = on ? label : btn.dataset.label;
  }
  ['btn-create', 'btn-join'].forEach((id) => { $(id).dataset.label = $(id).textContent; });

  // Filet : si le serveur ne répond pas (Render endormi, zone morte), on rend
  // la main au bout de 12 s avec un message, au lieu de figer les boutons.
  function withTimeout(btn, label, run) {
    setHomeBusy(btn, true, label);
    let done = false;
    const to = setTimeout(() => {
      if (done) return;
      done = true;
      setHomeBusy(btn, false);
      homeError('PAS DE RÉPONSE DU SERVEUR — vérifie ta connexion et réessaie.');
    }, 12000);
    return (res) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      setHomeBusy(btn, false);
      run(res);
    };
  }

  function doCreate() {
    if (homeBusy) return;
    const name = ($('input-name').value || '').trim();
    if (!name) { homeError('ENTRE UN IDENTIFIANT'); $('input-name').focus(); return; }
    homeError('');
    socket.emit('createRoom', { name }, withTimeout($('btn-create'), '[ CRÉATION… ]', (res) => {
      if (!res || !res.ok) return homeError(voice(res && res.error, 'ERREUR'));
      state.code = res.code; state.playerId = res.playerId; state.name = name; state.joined = true;
      saveSession(); startGeo();
      renvoyerEtat();
    }));
  }
  function doJoin() {
    if (homeBusy) return;
    const name = ($('input-name').value || '').trim();
    const code = ($('input-code').value || '').trim().toUpperCase();
    if (!name) { homeError('ENTRE UN IDENTIFIANT'); $('input-name').focus(); return; }
    if (!code) { homeError('ENTRE LE CODE, OU APPUIE SUR CRÉER UNE PARTIE'); $('input-code').focus(); return; }
    if (code.length !== 5) { homeError('LE CODE FAIT 5 CARACTÈRES'); $('input-code').focus(); return; }
    homeError('');
    socket.emit('joinRoom', { code, name }, withTimeout($('btn-join'), '[ CONNEXION… ]', (res) => {
      if (!res || !res.ok) return homeError(voice(res && res.error, 'ERREUR'));
      state.code = res.code; state.playerId = res.playerId; state.name = name; state.joined = true;
      saveSession(); startGeo();
      renvoyerEtat();
      if (res.reclaimed) toast('Place reprise — ton rôle et ton code QR sont conservés.', '', 5000);
    }));
  }
  $('btn-create').onclick = doCreate;
  // Le clavier mobile affiche "OK" / "Go" : il ne faisait rien, il n'y avait
  // aucun <form>. Il fallait viser REJOINDRE au pouce, clavier ouvert.
  $('home-form').addEventListener('submit', (e) => { e.preventDefault(); doJoin(); });
  function homeError(msg) { $('home-error').textContent = msg; }
  $('input-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

  // --- Lobby : config ---
  const cfgIds = ['cfg-startRadius', 'cfg-finalRadius', 'cfg-durationMin', 'cfg-shrinkSteps', 'cfg-revealIntervalMin', 'cfg-graceSeconds', 'cfg-radarUses', 'cfg-dispersionSeconds', 'cfg-startRevealSeconds', 'cfg-finalZoneMinutes', 'cfg-lastSurvivor'];
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
      finalZoneMinutes: +$('cfg-finalZoneMinutes').value,
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
    el.addEventListener('change', () => { pushConfig(); validateConfig(); updateLaunchState(); });
    el.addEventListener('input', () => { configDirty = true; validateConfig(); updateLaunchState(); }); // protège dès la frappe
  } });

  // Le roster affichait tout le monde en CACHÉ alors que le bouton ALÉATOIRE
  // se rendait déjà comme actif : l'interface annonçait un mode qu'elle n'avait
  // pas appliqué, et quelqu'un finissait par demander pourquoi il n'y a pas de
  // chasseur. On applique donc l'attribution dès l'entrée de l'hôte dans le lobby.
  let rolesEverAssigned = false;
  $('btn-role-random').onclick = () => { rolesEverAssigned = true; socket.emit('assignRoles', { mode: 'random' }); };
  $('btn-role-manual').onclick = () => {
    rolesEverAssigned = true;
    // bascule l'affichage manuel : on renvoie l'état courant en mode manuel
    const s = state.last;
    const assignments = {};
    (s && s.roster || []).forEach((p) => { assignments[p.id] = p.role; });
    socket.emit('assignRoles', { mode: 'manual', assignments });
  };

  // ---------------------------------------------------------- Préréglages
  // Dix champs numériques dépliés en permanence, pour des valeurs qu'un groupe
  // d'amis change peut-être deux fois dans sa vie. L'hôte règle ça debout au
  // milieu du groupe, avec onze personnes qui attendent.
  const PRESETS = {
    fast:    { durationMin: 10, startRadius: 300, finalRadius: 60,  shrinkSteps: 3, revealIntervalMin: 1.5, graceSeconds: 15, radarUses: 2, dispersionSeconds: 45,  startRevealSeconds: 15, finalZoneMinutes: 2 },
    classic: { durationMin: 25, startRadius: 500, finalRadius: 80,  shrinkSteps: 4, revealIntervalMin: 2,   graceSeconds: 20, radarUses: 3, dispersionSeconds: 60,  startRevealSeconds: 20, finalZoneMinutes: 3 },
    long:    { durationMin: 45, startRadius: 900, finalRadius: 120, shrinkSteps: 6, revealIntervalMin: 3,   graceSeconds: 25, radarUses: 4, dispersionSeconds: 90,  startRevealSeconds: 25, finalZoneMinutes: 5 },
  };
  function applyPreset(key) {
    const p = PRESETS[key];
    if (!p) return;
    for (const [k, v] of Object.entries(p)) {
      const el = $('cfg-' + k);
      if (el) el.value = v;
    }
    [...document.querySelectorAll('.preset')].forEach((b) => b.classList.remove('active'));
    $('btn-preset-' + key).classList.add('active');
    configDirty = true;
    pushConfig();
    validateConfig();
    updateZonePreview(readConfig());
    toast('FORMAT ' + (key === 'fast' ? 'RAPIDE' : key === 'long' ? 'LONGUE' : 'CLASSIQUE') + ' APPLIQUÉ', '', 2200);
  }
  $('btn-preset-fast').onclick = () => applyPreset('fast');
  $('btn-preset-classic').onclick = () => applyPreset('classic');
  $('btn-preset-long').onclick = () => applyPreset('long');

  // Le formulaire acceptait un rayon final PLUS GRAND que le rayon de départ :
  // une zone qui s'agrandit en rétrécissant. Aucune validation croisée.
  function validateConfig() {
    const c = readConfig();
    const warn = $('cfg-warning');
    let msg = '';
    if (c.finalRadius >= c.startRadius) msg = 'Le rayon final doit être plus petit que le rayon de départ.';
    else if (c.dispersionSeconds >= c.durationMin * 60) msg = 'La dispersion dure plus longtemps que la partie.';
    else if (c.finalZoneMinutes * 60 >= c.durationMin * 60) msg = 'Le jeu en zone finale dépasse la durée de la partie.';
    warn.textContent = msg;
    warn.classList.toggle('hidden', !msg);
    return !msg;
  }

  // ---------------------------------------------------------- Safety + launch
  $('chk-safety').addEventListener('change', updateLaunchState);

  // Le lancement dépendait de la SEULE case à cocher. Le GPS — le vrai bloquant —
  // n'était révélé qu'après le tap, en rouge 13 px, 55 px sous le bouton, devant
  // onze personnes. Et la case n'était jamais décochée : après REJOUER, la
  // partie suivante — jouée depuis un autre endroit — n'avait aucune
  // vérification de sécurité du tout.
  // En mode ALÉATOIRE les rôles sont attribués automatiquement (voir plus haut),
  // donc ce garde-fou ne se déclenche que sur une répartition manuelle réellement
  // invalide : tout le monde chasseur, ou tout le monde caché.
  function hasBothRoles(roster) {
    return roster.some((p) => p.role === 'hunter') && roster.some((p) => p.role === 'hider');
  }

  // Une ligne par opérateur, quatre pastilles lettrées. La lettre compte : la
  // couleur seule ne dit pas DE QUELLE autorisation il s'agit, et cet écran se
  // lit en deux secondes avant d'envoyer des gens courir dehors.
  const AUTORISATIONS = [
    { cle: 'gps', lettre: 'GPS', requis: true },
    { cle: 'wake', lettre: 'ÉCR', requis: false },
    { cle: 'audio', lettre: 'SON', requis: false },
    { cle: 'heading', lettre: 'CAP', requis: false },
  ];

  function renderReady(s) {
    const panel = $('ready-panel');
    if (!panel) return;
    const rs = (s && s.roster) || [];
    panel.classList.toggle('hidden', !s || !s.isHost || rs.length === 0);
    if (!s || !s.isHost) return;
    const ul = $('rp-list');
    ul.innerHTML = '';
    let prets = 0;
    for (const p of rs) {
      // La pastille GPS montre ce que le serveur CONSTATE (une position reçue),
      // pas ce que l'appareil déclare : c'est ce constat-là qui bloque.
      const r = Object.assign({}, p.ready, { gps: !!p.hasPos });
      if (r.gps) prets++;
      const li = document.createElement('li');
      const nom = document.createElement('span');
      nom.className = 'rp-name';
      nom.textContent = p.name + (p.connected ? '' : ' (hors ligne)');
      const dots = document.createElement('span');
      dots.className = 'rp-dots';
      for (const a of AUTORISATIONS) {
        const d = document.createElement('span');
        const ok = !!r[a.cle];
        d.className = 'rp-dot' + (ok ? ' on' : (a.requis ? ' req-off' : ''));
        d.textContent = a.lettre;
        d.title = a.lettre + (ok ? ' : autorisé' : a.requis ? ' : MANQUANT — bloque le lancement' : ' : indisponible');
        dots.appendChild(d);
      }
      li.appendChild(nom); li.appendChild(dots);
      ul.appendChild(li);
    }
    const c = $('rp-count');
    c.textContent = prets + '/' + rs.length;
    c.className = 'rp-count' + (prets === rs.length ? '' : ' ko');
  }

  // Noms des joueurs sans GPS, pour nommer le blocage au lieu de le subir.
  function sansGps(roster) {
    return roster.filter((p) => p.connected && !p.hasPos).map((p) => p.name);
  }

  function updateLaunchState() {
    const btn = $('btn-launch');
    const block = $('launch-block');
    const chk = $('chk-safety');
    const rs = (state.last && state.last.roster) || [];
    const count = rs.length;
    const canVerify = !!state.selfPos;

    // Sans terrain affiché, il n'y a rien à certifier : la case est verrouillée.
    chk.disabled = !canVerify;
    if (!canVerify && chk.checked) chk.checked = false;

    let why = '';
    if (!canVerify) why = geoState.denied
      ? '⚠ GPS REFUSÉ — impossible de vérifier la zone. Autorise la localisation.'
      : '⚠ POSITION REQUISE POUR VÉRIFIER LA ZONE';
    else if (!gpsFresh()) why = '⚠ POSITION PÉRIMÉE — attends un nouveau point GPS';
    else if (count < 2) why = 'IL FAUT AU MOINS 2 OPÉRATEURS';
    // Le serveur refuse déjà ce cas (game.js), mais il le refusait APRÈS le tap :
    // l'hôte, debout au milieu du groupe, appuyait sur un bouton vert et
    // récupérait une erreur en 13 px. Un blocage ne se découvre pas après coup.
    else if (!hasBothRoles(rs)) why = 'IL FAUT AU MOINS 1 CHASSEUR ET 1 CACHÉ';
    // Le serveur refuse aussi ce cas (game.js). On le dit AVANT le tap, et on
    // nomme les joueurs concernés : « quelqu'un n'a pas le GPS » n'aide pas
    // l'hôte, « GPS MANQUANT : LOU, RAF » lui dit à qui parler.
    else if (sansGps(rs).length) why = 'GPS MANQUANT : ' + sansGps(rs).join(', ').toUpperCase();
    else if (!validateConfig()) why = 'RÉGLAGES INCOHÉRENTS — VOIR RÉGLAGES AVANCÉS';
    else if (!chk.checked) why = 'COCHE LA VÉRIFICATION DE SÉCURITÉ POUR LANCER';

    block.textContent = why;
    btn.disabled = !!why || launching;
  }

  let launching = false;
  $('btn-launch').onclick = () => {
    if (launching) return;
    lobbyError('');
    // On envoie la config à jour AVANT de lancer (les messages socket sont ordonnés),
    // sinon une modif de dernière seconde encore débouncée serait perdue au lancement.
    clearTimeout(cfgTimer);
    socket.emit('updateConfig', { config: readConfig() });
    launching = true;
    $('btn-launch').textContent = '[ LANCEMENT… ]';
    updateLaunchState();
    socket.emit('startGame', { safetyChecked: $('chk-safety').checked }, (res) => {
      launching = false;
      $('btn-launch').textContent = '[ LANCER LA PARTIE ]';
      if (!res || !res.ok) lobbyError(voice(res && res.error, 'IMPOSSIBLE DE LANCER'));
      updateLaunchState();
    });
  };

  // Le message d'erreur du lobby n'était effacé NULLE PART : un "Il faut au
  // moins 2 joueurs." périmé restait affiché à travers un lancement réussi.
  let lobbyErrTimer = null;
  function lobbyError(msg) {
    $('lobby-error').textContent = msg || '';
    clearTimeout(lobbyErrTimer);
    if (msg) lobbyErrTimer = setTimeout(() => { $('lobby-error').textContent = ''; }, 6000);
  }

  // --- QR de partie : l'hôte lève son téléphone, le groupe scanne ---
  // Le QR encode le LIEN de partage, pas le code seul : l'appareil photo natif
  // du téléphone l'ouvre directement, donc personne n'a besoin d'avoir déjà
  // l'app installée ni ouverte pour rejoindre.
  function joinUrl() { return location.origin + '/?c=' + $('lobby-code').textContent; }
  $('btn-show-qr').onclick = () => {
    openModal('modal-join-qr');
    $('joinqr-code').textContent = $('lobby-code').textContent;
    const ok = QR.render($('joinqr-canvas'), joinUrl());
    const err = $('joinqr-error');
    err.classList.toggle('hidden', ok);
    if (!ok) err.textContent = 'QR indisponible — utilise le code ci-dessous ou le bouton PARTAGER.';
  };

  // Le bouton COPIER a été retiré : trois boutons ne tenaient pas dans la
  // largeur, et PARTAGER fait déjà mieux (il propose la copie en repli).

  // Partage : un lien avec le code déjà rempli, plus besoin de le dicter
  $('btn-share').onclick = async () => {
    const code = $('lobby-code').textContent;
    const url = location.origin + '/?c=' + code;
    const data = { title: 'TRAQUE', text: 'Rejoins ma partie de Traque (code ' + code + ')', url };
    try {
      if (navigator.share) { await navigator.share(data); return; }
    } catch (_) { return; } // partage annulé par l'utilisateur : on ne fait rien
    try {
      await navigator.clipboard.writeText(url);
      toast('Lien copié : ' + url, '', 4500);
    } catch (_) { toast('Lien : ' + url, '', 5000); }
  };
  $('btn-leave-lobby').onclick = () => confirmAction('QUITTER LA PARTIE', 'Tu vas libérer ta place. Les autres continuent sans toi.', leaveToHome);

  // --- Confirmation générique ---
  let confirmCb = null;
  function confirmAction(title, text, onYes) {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    confirmCb = onYes;
    openModal('modal-confirm');
  }
  $('confirm-yes').onclick = () => {
    closeModal($('modal-confirm'));
    const cb = confirmCb; confirmCb = null;
    if (cb) cb();
  };
  $('confirm-no').onclick = () => { closeModal($('modal-confirm')); confirmCb = null; };

  // --- Jeu : actions ---
  $('btn-code').onclick = () => {
    if (!state.last) return;
    openModal('modal-qr');
    // Sans la lib, le canvas restait BLANC sans un mot : le joueur croyait
    // montrer son code alors que personne ne pouvait le capturer.
    const ok = QR.render($('qr-canvas'), state.last.you.qrToken);
    const err = $('qr-error');
    err.classList.toggle('hidden', ok);
    if (!ok) err.textContent = 'CODE INDISPONIBLE — recharge la page avant de continuer à jouer.';
  };
  $('btn-scan').onclick = () => {
    const s = state.last;
    if (s && s.dispersionEndsAt && Date.now() < s.dispersionEndsAt) {
      toast('Attends la fin de la dispersion pour éliminer.');
      return;
    }
    Sensors.vibrate(35); // l'action principale du chasseur ne donnait aucun retour tactile
    openScan();
  };
  $('btn-radar').onclick = () => {
    const btn = $('btn-radar');
    if (btn.disabled) return;
    btn.disabled = true; // désactivation optimiste
    socket.emit('useRadar', {}, (res) => {
      if (!res || !res.ok) { toast((res && res.error) || 'Radar indisponible.', 'danger'); updateRadarButton(); return; }
      // Applique tout de suite le décompte à l'état local : sinon le ticker (250 ms)
      // réactiverait le bouton depuis un état périmé jusqu'au prochain état serveur (1.5 s)
      if (state.last && state.last.you && res.usesLeft != null) state.last.you.radarUsesLeft = res.usesLeft;
      updateRadarButton();
    });
  };
  $('btn-chat').onclick = () => {
    unreadChat = 0; updateChatBadge();
    openModal('modal-chat');
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
  // Deux usages pour la même caméra : éliminer une cible, ou rejoindre une
  // partie. Chacun a son validateur, donc un QR de partie ne peut pas être pris
  // pour un QR d'identité et inversement.
  function openScan() {
    openModal('modal-scan');
    $('mt-scan').textContent = 'SCAN CIBLE';
    $('scan-status').textContent = 'Chargement du scanner…';
    QR.startScan($('scan-video'), onScanDetect, (err) => { $('scan-status').textContent = err; });
    setTimeout(() => {
      if (!$('modal-scan').classList.contains('hidden') && $('scan-status').textContent === 'Chargement du scanner…') {
        $('scan-status').textContent = 'Vise le QR code de la cible…';
      }
    }, 400);
  }

  // Accepte le lien de partage (…/?c=ABCDE) comme le code nu.
  function extractGameCode(data) {
    const s = String(data || '').trim();
    const m = s.match(/[?&]c=([A-Za-z0-9]{5})(?![A-Za-z0-9])/);
    if (m) return m[1].toUpperCase();
    if (/^[A-Za-z0-9]{5}$/.test(s)) return s.toUpperCase();
    return null;
  }
  function openJoinScan() {
    const name = ($('input-name').value || '').trim();
    if (!name) { homeError('ENTRE D’ABORD TON IDENTIFIANT'); $('input-name').focus(); return; }
    openModal('modal-scan');
    $('mt-scan').textContent = 'SCAN PARTIE';
    $('scan-status').textContent = 'Chargement du scanner…';
    QR.startScan($('scan-video'), onJoinScanDetect,
      (err) => { $('scan-status').textContent = err; },
      extractGameCode);
    setTimeout(() => {
      if (!$('modal-scan').classList.contains('hidden') && $('scan-status').textContent === 'Chargement du scanner…') {
        $('scan-status').textContent = 'Vise le QR affiché par l’hôte…';
      }
    }, 400);
  }
  function onJoinScanDetect(code) {
    $('scan-status').textContent = 'PARTIE ' + code + ' — connexion…';
    Sensors.sfx('tag'); Sensors.vibrate([140, 70, 140]);
    $('input-code').value = code;
    closeModal($('modal-scan'));
    doJoin();
  }
  $('btn-scan-join').onclick = openJoinScan;
  function onScanDetect(token) {
    $('scan-status').textContent = 'Vérification…';
    socket.emit('scanQR', { token }, (res) => {
      if (res && res.ok) {
        $('scan-status').textContent = 'CIBLE ÉLIMINÉE : ' + res.name;
        Sensors.sfx('tag'); Sensors.vibrate([180, 80, 180, 80, 340]);
        setTimeout(closeScan, 1200);
      } else {
        $('scan-status').textContent = voice(res && res.error, 'ÉCHEC — VISE UN AUTRE QR');
        Sensors.vibrate([90, 60, 90]);
        // resumeScan() ne no-ope plus : la boucle rAF redémarre réellement.
        setTimeout(() => QR.resumeScan(), 900);
      }
    });
  }
  function closeScan() { QR.stopScan(); closeModal($('modal-scan')); }

  // Fermeture des modales
  document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.onclick = () => closeModal(btn.closest('.modal'));
  });

  // ------------------------------------------------- Accessibilité des modales
  // Aucune des cinq modales n'avait de piège de focus ni de touche Échap : le
  // focus restait dans la page derrière l'overlay, et il n'existait aucune
  // sortie clavier de la modale de scan.
  let focusRoot = null, focusPrev = null;
  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

  function trapFocus(el) {
    focusPrev = document.activeElement;
    focusRoot = el;
    const first = el.querySelector(FOCUSABLE);
    if (first) setTimeout(() => first.focus(), 30);
  }
  function releaseFocus() {
    focusRoot = null;
    if (focusPrev && document.contains(focusPrev)) { try { focusPrev.focus(); } catch (_) {} }
    focusPrev = null;
  }
  function openModal(id) {
    const el = $(id);
    el.classList.remove('hidden');
    trapFocus(el);
  }
  function closeModal(modal) {
    if (!modal) return;
    modal.classList.add('hidden');
    if (modal.id === 'modal-scan') QR.stopScan();
    releaseFocus();
  }
  function topOverlay() {
    if (!$('capture-alert').classList.contains('hidden')) return $('capture-alert');
    const open = [...document.querySelectorAll('.modal:not(.hidden)')];
    return open.length ? open[open.length - 1] : null;
  }
  document.addEventListener('keydown', (e) => {
    const top = topOverlay();
    if (e.key === 'Escape') {
      // L'alerte hors-zone n'est PAS fermable : c'est un compte à rebours de
      // sécurité, pas une boîte de dialogue.
      if (!$('zone-alert').classList.contains('hidden')) return;
      if (top === $('capture-alert')) { hideCaptureTakeover(); return; }
      if (top) { e.preventDefault(); closeModal(top); }
      return;
    }
    if (e.key !== 'Tab' || !focusRoot || focusRoot.classList.contains('hidden')) return;
    const items = [...focusRoot.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // --- Fin ---
  $('btn-home').onclick = leaveToHome;
  $('btn-replay').onclick = () => {
    socket.emit('restartGame', {}, (res) => {
      if (!res || !res.ok) toast((res && res.error) || 'Impossible de relancer.', 'danger');
      else toast('Nouvelle partie : réattribue les rôles et relance.', '', 5000);
    });
  };

  // --- Liste des joueurs (noms et rôles uniquement, aucune position) ---
  $('btn-players').onclick = () => {
    const open = $('players-panel').classList.toggle('hidden') === false;
    $('btn-players').setAttribute('aria-pressed', String(open));
    renderPlayersPanel();
  };
  $('pp-close').onclick = () => $('players-panel').classList.add('hidden');
  function renderPlayersPanel() {
    const panel = $('players-panel');
    if (panel.classList.contains('hidden')) return;
    const s = state.last;
    if (!s || !s.roster) return;
    const list = $('pp-list');
    list.innerHTML = '';
    const sorted = [...s.roster].sort((a, b) => (a.role === b.role ? 0 : a.role === 'hider' ? -1 : 1));
    sorted.forEach((p) => {
      const li = document.createElement('li');
      if (!p.connected) li.classList.add('off');
      li.innerHTML =
        '<span class="pp-name">' + escapeHtml(p.name) + (p.isMe ? ' <span class="pp-me">(toi)</span>' : '') + '</span>' +
        (p.connected ? '' : '<span class="pp-me">hors ligne</span>') +
        '<span class="pp-role ' + p.role + '">' + (p.role === 'hunter' ? 'CHASSEUR' : 'CACHÉ') + '</span>';
      list.appendChild(li);
    });
  }

  function leaveToHome() {
    socket.emit('leave'); // départ volontaire : on libère vraiment la place
    clearSession();
    resetToHome();
    $('input-code').value = '';
  }

  // Retour à l'accueil SANS quitter la partie côté serveur : la place reste
  // réservée, le joueur peut la reprendre en rejoignant avec le même nom.
  function sessionLost(code, name, msg) {
    resetToHome();
    if (code) $('input-code').value = code;
    if (name) $('input-name').value = name;
    homeError(msg + ' Appuie sur REJOINDRE pour reprendre ta place.');
    toast('Reconnexion nécessaire', 'danger', 6000);
  }

  function resetSafety() {
    const chk = $('chk-safety');
    if (chk) chk.checked = false;
    lobbyError('');
    updateLaunchState();
  }

  // Une couche Leaflet qui refuse de disparaître ne doit JAMAIS pouvoir bloquer
  // un changement d'écran. C'est exactement ce qui est arrivé : reset() levait
  // une ReferenceError, et tout ce qui suivait dans resetToHome() — dont le
  // show('screen-home') — était sauté. Le joueur appuyait sur RETOUR et restait
  // sur une partie terminée, sa session déjà effacée.
  function safeMapReset() {
    try { GameMap.reset(); }
    catch (err) { console.error('GameMap.reset', err); }
  }

  function resetToHome() {
    teardownGame();
    Sensors.stopWatch();
    safeMapReset();
    state.joined = false; state.code = null; state.playerId = null; state.last = null; state.selfPos = null; state.sentPos = null;
    geoState.lastFixAt = 0; geoState.started = false;
    resetSafety();
    updateGpsBadge();
    show('screen-home');
  }

  // Recentrer la carte sur soi
  $('btn-recenter').onclick = () => { if (state.selfPos) GameMap.recenter(state.selfPos); };

  // iOS/Safari : l'audio ne peut démarrer qu'après un geste utilisateur.
  // On déverrouille le contexte au premier toucher, sinon les alertes seraient muettes.
  document.addEventListener('pointerdown', function unlock() {
    Sensors.ensureAudio();
    rapporterEtat({ audio: true });
    document.removeEventListener('pointerdown', unlock);
  }, { once: true });

  // --- Code de partie passé dans l'URL (lien de partage) ---
  try {
    const c = new URLSearchParams(location.search).get('c');
    if (c) {
      $('input-code').value = c.toUpperCase().slice(0, 5);
      history.replaceState(null, '', location.pathname); // URL propre ensuite
    }
  } catch (_) {}

  // --- Installation PWA : plein écran, sans barres de navigateur ---
  let deferredInstall = null;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (!isStandalone) $('btn-install').classList.remove('hidden');
  });
  if (isIOS && !isStandalone) $('btn-install').classList.remove('hidden');
  $('btn-install').onclick = () => {
    if (deferredInstall) {
      $('install-go').classList.remove('hidden');
      $('install-ios').classList.add('hidden');
    } else {
      // iOS n'expose aucune API d'installation : on explique la manipulation
      $('install-go').classList.add('hidden');
      $('install-ios').classList.remove('hidden');
    }
    openModal('modal-install');
  };
  $('install-go').onclick = async () => {
    if (!deferredInstall) return;
    closeModal($('modal-install'));
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (_) {}
    deferredInstall = null;
    $('btn-install').classList.add('hidden');
  };

  // Hauteur réelle de la zone visible. window.innerHeight est la seule mesure
  // fiable sur iOS : en paysage notamment, les unités CSS peuvent dépasser
  // l'écran et faire disparaître le HUD (haut) et la barre d'actions (bas).
  // Clavier ouvert : visualViewport tombe à ~55 % de la fenêtre. Si on répercute
  // ça sur --app-h, le <body> se rétracte en haut de l'écran et le fond du <html>
  // apparaît en dessous — c'est la « bande bleue » qu'on voyait, avec le
  // formulaire coupé au milieu. On fige donc la hauteur pendant la saisie : le
  // clavier recouvre simplement le bas de la page, et centerFocused() se charge
  // de ramener le champ dans la partie visible.
  function keyboardOpen() {
    const vv = window.visualViewport;
    if (!vv) return false;
    return vv.height < window.innerHeight * 0.78;
  }

  function setAppHeight() {
    if (keyboardOpen()) return;
    // visualViewport donne la hauteur RÉELLEMENT visible. C'est indispensable :
    // sur Samsung Internet et iOS, la barre d'URL recouvre le contenu sans que
    // innerHeight ne change, ce qui poussait le HUD (haut) et la barre d'actions
    // (bas) hors de l'écran — on ne voyait plus que la carte.
    const vv = window.visualViewport;
    const h = vv && vv.height ? vv.height : window.innerHeight;
    // Garde-fou : une mesure nulle ou absurde écraserait le fallback CSS et
    // ferait disparaître toute l'interface. On garde alors la précédente.
    if (!h || h < 200) return;
    document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
    GameMap.invalidate(); // la carte doit se remesurer après un changement de taille
  }
  setAppHeight();
  window.addEventListener('resize', setAppHeight);
  if (window.visualViewport) {
    // Ces deux événements couvrent l'apparition/disparition des barres du
    // navigateur, que 'resize' seul ne signale pas toujours sur Android.
    window.visualViewport.addEventListener('resize', setAppHeight);
    window.visualViewport.addEventListener('scroll', setAppHeight);
  }
  window.addEventListener('orientationchange', () => {
    // La hauteur n'est mise à jour qu'APRÈS la rotation : on remesure plus tard
    setTimeout(setAppHeight, 100);
    setTimeout(setAppHeight, 500);
  });
  // Filet de sécurité : si une barre apparaît sans déclencher aucun événement,
  // on rattrape l'écart en arrière-plan (comparaison, donc aucun coût visuel).
  setInterval(() => {
    const vv = window.visualViewport;
    const h = Math.round(vv && vv.height ? vv.height : window.innerHeight);
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--app-h'), 10);
    // --app-h non encore posée => cur vaut NaN, et `Math.abs(h - NaN) > 4` est
    // TOUJOURS faux : le filet écrit précisément pour rattraper une mesure
    // manquante ne pouvait pas se déclencher dans ce cas-là.
    if (h < 200) return;
    if (!Number.isFinite(cur) || Math.abs(h - cur) > 4) setAppHeight();
  }, 1000);

  // ---------------------------------------------------------- CLAVIER MOBILE
  // --app-h suit visualViewport : à l'ouverture du clavier la page rétrécit de
  // moitié, et le champ qu'on est en train de remplir se retrouve sous le
  // clavier — on tape en aveugle. Le navigateur essaie bien de le ramener, mais
  // il le fait AVANT que la hauteur ait fini de bouger, donc ça rate.
  // On le repositionne nous-mêmes, deux fois : le clavier s'anime et iOS
  // redimensionne en deux temps.
  let kbTimers = [];
  function centerFocused() {
    const el = document.activeElement;
    if (!el || !el.matches || !el.matches('input, textarea, select')) return;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    catch (_) { el.scrollIntoView(); }
  }
  function scheduleCenter() {
    kbTimers.forEach(clearTimeout);
    kbTimers = [setTimeout(centerFocused, 260), setTimeout(centerFocused, 620)];
  }
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el || !el.matches || !el.matches('input, textarea, select')) return;
    // La barre de lancement est collée en bas et fait ~190 px : avec le clavier
    // ouvert il ne reste qu'environ 400 px, elle mangerait la moitié de ce qui
    // reste. On la retire le temps de la saisie, elle revient au relâchement.
    document.body.classList.toggle('kb-typing', !!el.closest('#host-panel'));
    scheduleCenter();
  });
  document.addEventListener('focusout', () => {
    kbTimers.forEach(clearTimeout); kbTimers = [];
    document.body.classList.remove('kb-typing');
  });
  if (window.visualViewport) {
    // Le clavier qui s'ouvre OU se ferme redimensionne le viewport visuel :
    // dans les deux cas on remet le champ en vue.
    window.visualViewport.addEventListener('resize', () => {
      if (document.activeElement && document.activeElement.matches &&
          document.activeElement.matches('input, textarea, select')) scheduleCenter();
    });
  }

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
