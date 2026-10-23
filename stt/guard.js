// SPDX-License-Identifier: Apache-2.0
//
// Loaded before the speech-to-text worker. Restricts the worker to its own
// origin: requests to any other server are refused, and the APIs that could
// open other kinds of connections are removed. This is in addition to the
// page's Content Security Policy, which the worker inherits.

const origin = new URL(self.location.href).origin;
const sameOriginFetch = self.fetch.bind(self);

self.fetch = (input, init) => {
  const href = input instanceof Request ? input.url : String(input);
  const url = new URL(href, origin + "/");
  if (url.origin !== origin) {
    return Promise.reject(new TypeError(`Blocked request to ${url.origin}`));
  }
  // Paths are resolved against this site: a blob worker can't resolve them.
  return sameOriginFetch(input instanceof Request ? input : url.href, init);
};

for (const name of [
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "WebTransport",
  "RTCPeerConnection",
]) {
  try {
    Object.defineProperty(self, name, { value: undefined });
  } catch {
    // Not present in this browser.
  }
}
