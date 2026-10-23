// SPDX-License-Identifier: Apache-2.0
//
// Caches the whole application so it keeps working offline. It only ever
// requests files from the site's own origin; any other request is refused.
// The speech model and its runtime are large, so they are not downloaded
// up front: they are cached the first time they are used.

const BUILD_ID = "__BUILD_ID__";
const MODELS_ID = "__MODELS_ID__";
const FILES = __FILES__;
const CACHE = `webrtlsdr-${BUILD_ID}`;
const MODELS_CACHE = `webrtlsdr-models-${MODELS_ID}`;

function isOnDemand(url) {
  return /\/(models\/|stt\/ort-)/.test(url.pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Bypass the HTTP cache so files from different builds are never mixed.
      .then((cache) =>
        cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) =>
                k.startsWith("webrtlsdr-") && k !== CACHE && k !== MODELS_CACHE,
            )
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    event.respondWith(Response.error());
    return;
  }
  if (isOnDemand(url)) {
    event.respondWith(
      caches.open(MODELS_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request, { ignoreSearch: true });
        if (hit) return hit;
        const response = await fetch(event.request);
        if (response.ok && response.status === 200) {
          await cache.put(event.request, response.clone());
        }
        return response;
      }),
    );
    return;
  }
  event.respondWith(
    caches
      .match(event.request, { ignoreSearch: true })
      .then((hit) => hit || fetch(event.request)),
  );
});
