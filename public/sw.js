'use strict';
/*
 * sw.js — service worker minimal (installabilité PWA + repli hors-ligne).
 * Le jeu a besoin du réseau en permanence (Socket.io) : on adopte une stratégie
 * "network-first" pour la coquille statique. Le cache ne sert QUE de repli quand
 * le réseau est indisponible — jamais pour figer une version périmée.
 */
const CACHE = 'traque-shell-v6';
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
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
