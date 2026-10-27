// SPDX-License-Identifier: Apache-2.0
//
// Caches the whole application so it keeps working offline. It only ever
// requests files from the site's own origin; any other request is refused.
// The speech model and its runtime are large, so they are not downloaded
// up front: they are cached the first time they are used.

const BUILD_ID = "899bd13a91c3";
const MODELS_ID = "8cd30377d7a3";
const FILES = [
  "./",
  "./app.js",
  "./capabilities.html",
  "./fl2k-device.js",
  "./fl2k-panel.js",
  "./fl2k/COPYING.txt",
  "./fl2k/hardware-e2e.txt",
  "./fl2k/runtime.js",
  "./fl2k/source.tar.gz",
  "./icon.svg",
  "./index.html",
  "./lib/signals/demod/demod-am.js",
  "./lib/signals/demod/demod-cw.js",
  "./lib/signals/demod/demod-nbfm.js",
  "./lib/signals/demod/demod-ssb.js",
  "./lib/signals/demod/demod-wbfm.js",
  "./lib/signals/demod/demodulator.js",
  "./lib/signals/demod/empty-demodulator.js",
  "./lib/signals/demod/modes.js",
  "./lib/signals/demod/player.js",
  "./lib/signals/demod/sample-counter.js",
  "./lib/signals/demod/spectrum.js",
  "./lib/signals/dsp/buffers.js",
  "./lib/signals/dsp/coefficients.js",
  "./lib/signals/dsp/converters.js",
  "./lib/signals/dsp/demodulators.js",
  "./lib/signals/dsp/fft.js",
  "./lib/signals/dsp/filters.js",
  "./lib/signals/dsp/math.js",
  "./lib/signals/dsp/power.js",
  "./lib/signals/dsp/resamplers.js",
  "./lib/signals/errors.js",
  "./lib/signals/players/audioplayer.js",
  "./lib/signals/radio.js",
  "./lib/signals/radio/radio.js",
  "./lib/signals/radio/sample_block.js",
  "./lib/signals/radio/sample_receiver.js",
  "./lib/signals/radio/signal_source.js",
  "./lib/signals/radio/single_thread.js",
  "./lib/signals/sources/generated.js",
  "./lib/signals/sources/generators.js",
  "./lib/signals/sources/provider.js",
  "./lib/signals/sources/push.js",
  "./lib/signals/sources/read_ring.js",
  "./lib/signals/sources/realtime.js",
  "./lib/signals/wasm/convolver.js",
  "./lib/signals/wasm/fft.js",
  "./lib/signals/wasm/wasm-bytes.js",
  "./lib/webrtlsdr/errors.js",
  "./lib/webrtlsdr/fakertl/fakertl.js",
  "./lib/webrtlsdr/radio.js",
  "./lib/webrtlsdr/radio/radio.js",
  "./lib/webrtlsdr/radio/source.js",
  "./lib/webrtlsdr/rtlsdr.js",
  "./lib/webrtlsdr/rtlsdr/r820t.js",
  "./lib/webrtlsdr/rtlsdr/r828d.js",
  "./lib/webrtlsdr/rtlsdr/r8xx.js",
  "./lib/webrtlsdr/rtlsdr/rtl2832u.js",
  "./lib/webrtlsdr/rtlsdr/rtlcom.js",
  "./lib/webrtlsdr/rtlsdr/rtldevice.js",
  "./lib/webrtlsdr/rtlsdr/tuner.js",
  "./licenses/signals-LICENSE.txt",
  "./licenses/transformers-LICENSE.txt",
  "./licenses/webrtlsdr-LICENSE.txt",
  "./manifest.webmanifest",
  "./player.js",
  "./sim/README.md",
  "./sim/jfk.wav",
  "./stt/guard.js",
  "./stt/start.js",
  "./stt/worker.js",
  "./style.css",
  "./transcriber.js",
  "./tx-playbooks.js",
  "./tx-signal.js",
  "./tx.js"
];
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
