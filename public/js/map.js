'use strict';
/*
 * map.js — rendu cartographique via Leaflet + tuiles CartoDB Dark (sans clé API).
 * Gère : marqueur du joueur, coéquipiers, signaux gris (dernières positions
 * révélées), révélations exactes temporaires, cercles de zone (actuelle + suivante).
 * Expose window.GameMap.
 */
window.GameMap = (function () {
  let map = null;
  let selfMarker = null, accuracyCircle = null;
  let zoneCircle = null, nextZoneCircle = null;
  const markers = new Map(); // id -> Leaflet marker (coéquipiers + signaux)
  let revealMarkers = []; // marqueurs temporaires (radar / flash)
  let hasCentered = false;

  function divIcon(cls, label) {
    return L.divIcon({
      className: 'mk ' + cls,
      html: '<div class="mk-dot"></div>' + (label ? '<div class="mk-label">' + esc(label) + '</div>' : ''),
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }
  function esc(s) { return (s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  function init() {
    if (map) return map;
    map = L.map('map', { zoomControl: false, attributionControl: true, tap: true });
    map.setView([48.8566, 2.3522], 16);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(map);
    return map;
  }

  function setSelf(pos, role) {
    if (!map || !pos) return;
    const cls = 'mk-self ' + role;
    if (!selfMarker) {
      selfMarker = L.marker([pos.lat, pos.lng], { icon: divIcon(cls, 'MOI'), zIndexOffset: 1000 }).addTo(map);
      accuracyCircle = L.circle([pos.lat, pos.lng], { radius: pos.accuracy || 15, color: '#C6FF00', weight: 1, opacity: 0.3, fillColor: '#C6FF00', fillOpacity: 0.06 }).addTo(map);
    } else {
      selfMarker.setLatLng([pos.lat, pos.lng]);
      selfMarker.setIcon(divIcon(cls, 'MOI'));
      accuracyCircle.setLatLng([pos.lat, pos.lng]);
      accuracyCircle.setRadius(pos.accuracy || 15);
    }
    if (!hasCentered) { map.setView([pos.lat, pos.lng], 17); hasCentered = true; }
  }

  function recenter(pos) { if (map && pos) map.setView([pos.lat, pos.lng], map.getZoom()); }

  // Cadre la carte pour que TOUS les points donnés soient visibles à l'écran.
  // Sans ça, un marqueur créé loin de la vue actuelle (radar, flash de sortie de
  // zone) existe bien sur la carte mais reste invisible tant qu'on ne scrolle
  // pas manuellement dessus — ce que le joueur perçoit comme "rien ne s'affiche".
  function focus(points) {
    if (!map) return;
    const pts = (points || []).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!pts.length) return;
    if (pts.length === 1) { map.setView(pts[0], Math.max(map.getZoom(), 16), { animate: true }); return; }
    map.fitBounds(L.latLngBounds(pts).pad(0.3), { animate: true, maxZoom: 17 });
  }

  // Met à jour un ensemble de marqueurs (coéquipiers OU signaux)
  function syncMarkers(list, kindClass, keyPrefix) {
    const seen = new Set();
    for (const item of list) {
      const key = keyPrefix + item.id;
      seen.add(key);
      const cls = kindClass + (item.role ? ' ' + item.role : '');
      if (markers.has(key)) {
        const m = markers.get(key);
        m.setLatLng([item.lat, item.lng]);
        m.setIcon(divIcon(cls, item.name));
      } else {
        markers.set(key, L.marker([item.lat, item.lng], { icon: divIcon(cls, item.name) }).addTo(map));
      }
    }
    // Retire les marqueurs disparus pour ce préfixe
    for (const [key, m] of markers) {
      if (key.startsWith(keyPrefix) && !seen.has(key)) { map.removeLayer(m); markers.delete(key); }
    }
  }

  function setTeammates(list, myRole) {
    syncMarkers(list.map((t) => ({ ...t, role: myRole })), 'mk-team', 'team:');
  }
  function setSignals(list) {
    syncMarkers(list, 'mk-signal', 'sig:');
  }
  function clearSignals() { syncMarkers([], 'mk-signal', 'sig:'); }

  // Révélations exactes temporaires (radar + sorties de zone) reçues dans l'état
  function setReveals(list) {
    revealMarkers.forEach((m) => map.removeLayer(m));
    revealMarkers = [];
    for (const r of list) {
      const m = L.marker([r.lat, r.lng], { icon: divIcon('mk-reveal', r.name), zIndexOffset: 900 }).addTo(map);
      revealMarkers.push(m);
    }
  }

  // Chasseur(s) visibles par un caché repéré au radar (contre-révélation 30 s)
  let spottedMarkers = [];
  function setSpotted(list) {
    spottedMarkers.forEach((m) => map.removeLayer(m));
    spottedMarkers = [];
    for (const h of list || []) {
      const m = L.marker([h.lat, h.lng], { icon: divIcon('mk-hunter', 'CHASSEUR ' + (h.name || '')), zIndexOffset: 950 }).addTo(map);
      spottedMarkers.push(m);
    }
  }

  // Lieu où un coéquipier caché s'est fait prendre. Reste plus longtemps que les
  // autres marqueurs : c'est une information tactique (secteur dangereux).
  let downMarkers = [];
  function addDown(lat, lng, name, ms) {
    if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const m = L.marker([lat, lng], { icon: divIcon('mk-down', '✖ ' + (name || '')), zIndexOffset: 800 }).addTo(map);
    downMarkers.push(m);
    setTimeout(() => { map.removeLayer(m); downMarkers = downMarkers.filter((x) => x !== m); }, ms || 120000);
  }
  function clearDowns() { downMarkers.forEach((m) => map.removeLayer(m)); downMarkers = []; }

  // Ajoute un marqueur pulsant ponctuel (utilisé pour le flash instantané)
  function pulse(lat, lng, name, ms) {
    const m = L.marker([lat, lng], { icon: divIcon('mk-reveal', name), zIndexOffset: 950 }).addTo(map);
    setTimeout(() => map.removeLayer(m), ms || 6000);
  }

  // Points d'un cercle géodésique approximé, pour construire un anneau troué.
  function ringPoints(center, radiusM, n, reverse) {
    const latR = radiusM / 111320;
    const lngR = radiusM / (111320 * Math.cos(center.lat * Math.PI / 180) || 1);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      pts.push([center.lat + latR * Math.sin(a), center.lng + lngR * Math.cos(a)]);
    }
    return reverse ? pts.reverse() : pts;
  }

  // Rectangle très large, servant de contour extérieur au voile.
  const WORLD = [[-89, -179], [-89, 179], [89, 179], [89, -179]];

  // Trois états, trois traitements — et un seul principe : la couleur dit ce qui
  // est vrai MAINTENANT, jamais ce qui le sera plus tard.
  //
  //   dehors        = déjà hors-jeu       -> voilé, la carte s'efface
  //   dans la zone  = terrain de jeu      -> carte nette, rien par-dessus
  //   zone suivante = là où il faut aller -> tireté BLEU, aucun remplissage
  //
  // Le tireté était magenta, c'est-à-dire la couleur du chasseur, sur l'élément
  // le plus permanent du terrain : la carte disait « danger » là où la règle dit
  // « va là ». Le bleu est la couleur de la structure et de la zone dans la loi
  // de couleur ; c'est celle qui appartient à ce cercle.
  //
  // EXCEPTION ASSUMÉE : le cercle jouable reste lime alors que la loi écrite dit
  // « bleu = zone ». Ici le lime ne désigne pas la zone en tant que structure,
  // il désigne « sûr » — le même sens que partout ailleurs pour le caché — et le
  // briefing du salon l'enseigne déjà en toutes lettres (« reste dans le cercle
  // vert »). C'est la seule divergence avec PRODUCT.md ; elle est délibérée.
  // À trancher un jour dans un sens ou dans l'autre, pas à laisser dériver.
  //
  // La version précédente peignait en rouge la bande entre les deux cercles.
  // C'était faux : cette bande est parfaitement jouable sur le moment, le rouge
  // la faisait passer pour interdite. Le décompte du bandeau dit déjà quand
  // elle tombera.
  let outsideVeil = null;
  function setZone(zone) {
    if (!map || !zone || !zone.center) return;
    const c = [zone.center.lat, zone.center.lng];

    // Voile sur tout ce qui est hors de la zone actuelle : un polygone monde
    // troué du disque jouable. C'est le seul endroit vraiment interdit.
    const hole = ringPoints(zone.center, zone.radius, 96, true);
    if (!outsideVeil) {
      outsideVeil = L.polygon([WORLD, hole], {
        stroke: false, fillColor: '#050A1C', fillOpacity: 0.62, interactive: false,
      }).addTo(map);
    } else {
      outsideVeil.setLatLngs([WORLD, hole]);
    }
    outsideVeil.bringToBack();

    if (!zoneCircle) {
      zoneCircle = L.circle(c, { radius: zone.radius, color: '#C6FF00', weight: 4, fill: false, interactive: false }).addTo(map);
      // Première zone reçue : on cadre la carte dessus pour voir tout le terrain de jeu
      try { map.fitBounds(zoneCircle.getBounds().pad(0.08)); hasCentered = true; } catch (_) {}
    } else {
      zoneCircle.setLatLng(c); zoneCircle.setRadius(zone.radius);
    }

    // Zone suivante : une cible à rejoindre, pas une menace. Tireté, sans fond,
    // pour qu'on lise « va là » et pas « n'entre pas ».
    if (zone.nextShrinkAt && zone.nextRadius < zone.radius) {
      if (!nextZoneCircle) {
        nextZoneCircle = L.circle(c, { radius: zone.nextRadius, color: '#1F6BFF', weight: 3, dashArray: '10 12', fill: false, interactive: false }).addTo(map);
      } else {
        nextZoneCircle.setLatLng(c); nextZoneCircle.setRadius(zone.nextRadius);
      }
    } else if (nextZoneCircle) {
      map.removeLayer(nextZoneCircle); nextZoneCircle = null;
    }
  }

  // Cap (bearing) de A vers B, en degrés depuis le nord
  function bearing(from, to) {
    const φ1 = from.lat * Math.PI / 180, φ2 = to.lat * Math.PI / 180;
    const Δλ = (to.lng - from.lng) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function reset() {
    if (!map) return;
    if (selfMarker) { map.removeLayer(selfMarker); selfMarker = null; }
    if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }
    if (zoneCircle) { map.removeLayer(zoneCircle); zoneCircle = null; }
    if (nextZoneCircle) { map.removeLayer(nextZoneCircle); nextZoneCircle = null; }
    if (outsideVeil) { map.removeLayer(outsideVeil); outsideVeil = null; }
    for (const m of markers.values()) map.removeLayer(m);
    markers.clear();
    revealMarkers.forEach((m) => map.removeLayer(m)); revealMarkers = [];
    spottedMarkers.forEach((m) => map.removeLayer(m)); spottedMarkers = [];
    clearDowns();
    hasCentered = false;
  }

  function invalidate() { if (map) setTimeout(() => map.invalidateSize(), 60); }

  // --- Aperçu de la zone dans le lobby (carte indépendante de celle du jeu) ---
  // Permet à l'hôte de VOIR le terrain avant de lancer : routes passantes, plans
  // d'eau... c'est ce que la case de sécurité lui demande de vérifier.
  let pMap = null, pCircle = null, pMarker = null;
  function previewInit() {
    if (pMap) return pMap;
    pMap = L.map('lobby-map', { zoomControl: false, attributionControl: false, dragging: true, tap: true });
    pMap.setView([48.8566, 2.3522], 15);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 20 }).addTo(pMap);
    return pMap;
  }
  function previewUpdate(pos, radius) {
    if (!pos) return;
    previewInit();
    const c = [pos.lat, pos.lng];
    if (!pCircle) {
      pCircle = L.circle(c, { radius, color: '#C6FF00', weight: 4, fillColor: '#C6FF00', fillOpacity: 0.07 }).addTo(pMap);
      pMarker = L.marker(c, { icon: divIcon('mk-self hider', 'DÉPART') }).addTo(pMap);
    } else {
      pCircle.setLatLng(c); pCircle.setRadius(radius);
      pMarker.setLatLng(c);
    }
    try { pMap.fitBounds(pCircle.getBounds().pad(0.15)); } catch (_) {}
    setTimeout(() => pMap.invalidateSize(), 60);
  }
  function previewInvalidate() { if (pMap) setTimeout(() => pMap.invalidateSize(), 60); }

  return {
    init, setSelf, recenter, focus, setTeammates, setSignals, clearSignals,
    setReveals, setSpotted, addDown, clearDowns, pulse, setZone, bearing, reset, invalidate,
    previewUpdate, previewInvalidate,
  };
})();
