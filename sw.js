/* ============================================================================
   Check-List CD — Service Worker
   Guarda a "casca" do app para que ele abra dentro da câmara fria, sem sinal.
   Ao subir uma versão nova, altere CACHE_VERSAO para invalidar o cache antigo.
   ========================================================================== */

const CACHE_VERSAO = 'checklist-cd-vs.2026.08.21.0012';

const ARQUIVOS_BASE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', evento => {
  evento.waitUntil(
    caches.open(CACHE_VERSAO)
      .then(cache => cache.addAll(ARQUIVOS_BASE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', evento => {
  evento.waitUntil(
    caches.keys()
      .then(chaves => Promise.all(
        chaves.filter(chave => chave !== CACHE_VERSAO).map(chave => caches.delete(chave))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', evento => {
  const requisicao = evento.request;

  // Só a casca do app é cacheada. Chamadas ao Apps Script e ao Google
  // Identity sempre vão para a rede — dados nunca podem vir de cache velho.
  if (requisicao.method !== 'GET') return;
  if (new URL(requisicao.url).origin !== self.location.origin) return;

  // Stale-while-revalidate: responde na hora com o cache e atualiza em segundo plano.
  evento.respondWith(
    caches.open(CACHE_VERSAO).then(async cache => {
      const emCache = await cache.match(requisicao);
      const daRede = fetch(requisicao)
        .then(resposta => {
          if (resposta && resposta.status === 200) cache.put(requisicao, resposta.clone());
          return resposta;
        })
        .catch(() => emCache);
      return emCache || daRede;
    })
  );
});
