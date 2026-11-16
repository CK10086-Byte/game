'use strict';

// Cache only the offline notice and app artwork, never a room or a game session.
const CACHE_PREFIX = 'pixel-tank-mobile-';
const CACHE_NAME = CACHE_PREFIX + 'v1';
const OFFLINE_PAGE = '/tank-offline.html';
const ASSETS = new Set([
  OFFLINE_PAGE, '/tank-offline.css',
  '/tank-icon-192.png', '/tank-icon-512.png', '/tank-icon-180.png',
]);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...ASSETS]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function offlineNavigation(request) {
  try {
    return await fetch(request);
  } catch (_) {
    const cached = await caches.open(CACHE_NAME)
      .then(cache => cache.match(OFFLINE_PAGE)).catch(() => null);
    return cached || new Response(
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>坦克对战需要联网</title><h1>连接暂时中断</h1><p>坦克对战需要网络，包括单人训练。请恢复网络后重新打开游戏。</p><a href="/games/tanks/play">重新连接游戏</a></html>',
      {status: 503, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}},
    );
  }
}

async function staticAsset(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      // A full storage quota must not turn a successful request into an error.
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      } catch (_) { /* optional cache */ }
    }
    return response;
  } catch (error) {
    const cached = await caches.open(CACHE_NAME)
      .then(cache => cache.match(request)).catch(() => null);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations are never stored, including invitation URLs with a room code.
  if (request.mode === 'navigate' && url.pathname.startsWith('/games/tanks/')) {
    event.respondWith(offlineNavigation(request));
    return;
  }
  // API, gameplay JS/maps, URLs with parameters and other games bypass the cache.
  if (url.search || !ASSETS.has(url.pathname)) return;
  event.respondWith(staticAsset(request));
});
