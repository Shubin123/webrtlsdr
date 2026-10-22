// SPDX-License-Identifier: Apache-2.0
//
// Caches the whole application so it keeps working offline. It only ever
// requests files from the site's own origin; any other request is refused.

const BUILD_ID = "__BUILD_ID__";
const FILES = __FILES__;
const CACHE = `webrtlsdr-${BUILD_ID}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
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
            .filter((k) => k.startsWith("webrtlsdr-") && k !== CACHE)
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
  event.respondWith(
    caches
      .match(event.request, { ignoreSearch: true })
      .then((hit) => hit || fetch(event.request)),
  );
});
