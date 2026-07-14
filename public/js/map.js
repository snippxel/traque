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
      accuracyCircle = L.circle([pos.lat, pos.lng], { radius: pos.accuracy || 15, className: 'mk-accuracy', stroke: false }).addTo(map);
    } else {
      selfMarker.setLatLng([pos.lat, pos.lng]);
      selfMarker.setIcon(divIcon(cls, 'MOI'));
      accuracyCircle.setLatLng([pos.lat, pos.lng]);
      accuracyCircle.setRadius(pos.accuracy || 15);
    }
    if (!hasCentered) { map.setView([pos.lat, pos.lng], 17); hasCentered = true; }
  }

  function recenter(pos) { if (map && pos) map.setView([pos.lat, pos.lng], map.getZoom()); }

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

  // Ajoute un marqueur pulsant ponctuel (utilisé pour le flash instantané)
  function pulse(lat, lng, name, ms) {
    const m = L.marker([lat, lng], { icon: divIcon('mk-reveal', name), zIndexOffset: 950 }).addTo(map);
    setTimeout(() => map.removeLayer(m), ms || 6000);
  }

  function setZone(zone) {
    if (!map || !zone || !zone.center) return;
    const c = [zone.center.lat, zone.center.lng];
    if (!zoneCircle) {
      zoneCircle = L.circle(c, { radius: zone.radius, color: '#4dffa1', weight: 2, fill: true, fillColor: '#4dffa1', fillOpacity: 0.04 }).addTo(map);
    } else {
      zoneCircle.setLatLng(c); zoneCircle.setRadius(zone.radius);
    }
    if (zone.nextShrinkAt && zone.nextRadius < zone.radius) {
      if (!nextZoneCircle) {
        nextZoneCircle = L.circle(c, { radius: zone.nextRadius, color: '#ff2f45', weight: 1.5, dashArray: '6 6', fill: false }).addTo(map);
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
    for (const m of markers.values()) map.removeLayer(m);
    markers.clear();
    revealMarkers.forEach((m) => map.removeLayer(m)); revealMarkers = [];
    hasCentered = false;
  }

  function invalidate() { if (map) setTimeout(() => map.invalidateSize(), 60); }

  return {
    init, setSelf, recenter, setTeammates, setSignals, clearSignals,
    setReveals, pulse, setZone, bearing, reset, invalidate,
  };
})();
