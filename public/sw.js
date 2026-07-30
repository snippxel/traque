'use strict';
/*
 * sw.js — service worker minimal (installabilité PWA + repli hors-ligne).
 * Le jeu a besoin du réseau en permanence (Socket.io) : on adopte une stratégie
 * "network-first" pour la coquille statique. Le cache ne sert QUE de repli quand
 * le réseau est indisponible — jamais pour figer une version périmée.
 */
const CACHE = 'traque-shell-v19';
const SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/map.js',
  '/js/qr.js',
  '/js/sensors.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Libs et polices auto-hébergées. Elles venaient de unpkg / jsDelivr /
  // fonts.gstatic.com, qu'on ne pouvait PAS mettre en cache (cross-origin).
  // Conséquences vécues sur un réseau qui saute : sans Leaflet l'écran de jeu
  // ne s'affichait pas du tout, sans qrcode le QR d'identité restait blanc
  // (donc le joueur ne pouvait jamais être capturé), sans jsQR le scan tournait
  // dans le vide. Tout est local maintenant, donc tout est mis en cache.
  '/vendor/leaflet.css',
  '/vendor/leaflet.js',
  '/vendor/qrcode.js',
  '/vendor/jsQR.js',
];

self.addEventListener('install', (e) => {
  // addAll() est atomique : une seule ressource en échec annule TOUT le cache et
  // laisse le joueur sans repli hors-ligne. On met donc en cache fichier par
  // fichier, pour qu'un échec isolé n'emporte pas les autres.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((url) => c.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Ne jamais intercepter Socket.io ni les ressources externes (tuiles, CDN)
  if (url.pathname.startsWith('/socket.io') || url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  // Network-first : on tente le réseau, on met à jour le cache, repli si hors-ligne
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});
