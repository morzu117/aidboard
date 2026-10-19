// Coquille hors-ligne : quand le daemon est injoignable, c'est le seul moyen de rendre quoi que
// ce soit (c'est lui qui sert le HTML/JS — sans lui, le navigateur affiche sa propre page
// d'erreur avant que React n'ait la moindre chance de charger).
//
// Réseau toujours préféré, cache en secours seulement sur échec : pas de manifest de précache, pas
// de nom de cache versionné à invalider — dès que le réseau répond, le cache se met à jour avec la
// réponse fraîche tout seul.
const CACHE = 'aid-shell';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return;
  const path = new URL(request.url).pathname;
  // L'état vivant, jamais mis en cache — son échec est déjà géré côté app (AidClient.failed()).
  if (path.startsWith('/api/') || path.startsWith('/ws/') || path === '/auth') return;

  const cacheKey = request.mode === 'navigate' ? '/' : request;
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(CACHE).then((c) => c.put(cacheKey, copy));
        return response;
      })
      .catch(() => caches.match(cacheKey)),
  );
});
