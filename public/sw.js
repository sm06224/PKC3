/*
 * PKC3 service worker — P1 skeleton。
 * PWA インストール可能性のための最小実装のみ。offline cache 戦略は P7 で確定する
 * (設計 doc §8)。fetch は respondWith を呼ばない = 既定のネットワーク動作。
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  /* pass-through — cache 戦略は P7 */
});
