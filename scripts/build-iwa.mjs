// SPDX-License-Identifier: Apache-2.0
//
// Packs the built site (`site/`) into a Signed Web Bundle that Chrome installs
// as an Isolated Web App: dist-iwa/webrtlsdr.swbn.
//
// Websites cannot claim USB interfaces of "protected" classes, and the stock
// FL2000 adapter only has Audio/Video-class (0x10) interfaces. An Isolated Web
// App may, if it asks for the "usb-unrestricted" permission and the user has
// enabled Chrome's Isolated Web App flags. The bundle holds every file, so
// the installed app needs no server and works offline from the start.
//
// The bundle is signed with an Ed25519 key, which also fixes the app's ID.
// The key is created on first use in iwa-signing-key.pem (not committed):
// keep a copy, or later bundles will install as a different app.
//
// Run `npm run build:site` first.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as wbn from "wbn";
import * as wbnSign from "wbn-sign";

const root = path.resolve(import.meta.dirname, "..");
const site = path.join(root, "site");
const out = path.join(root, "dist-iwa");
const keyFile = process.env.IWA_SIGNING_KEY || path.join(root, "iwa-signing-key.pem");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".wav": "audio/wav",
  ".gz": "application/gzip",
};

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

if (!fs.existsSync(path.join(site, "index.html"))) {
  throw new Error("site/ is missing; run `npm run build:site` first");
}
if (!fs.existsSync(keyFile)) {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(`Created signing key ${path.relative(root, keyFile)}. Back it up: updates must be signed with it.`);
}
const key = wbnSign.parsePemKey(fs.readFileSync(keyFile, "utf8"));

// Chrome only accepts increasing versions when updating an installed app.
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const version = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}${pad(now.getUTCDate())}.${now.getUTCHours()}${pad(now.getUTCMinutes())}`;
const siteManifest = JSON.parse(fs.readFileSync(path.join(site, "manifest.webmanifest"), "utf8"));
const manifest = {
  ...siteManifest,
  name: "Web RTL-SDR",
  id: "/",
  start_url: "/",
  scope: "/",
  version,
  // This manifest lives in /.well-known/, so paths must start at the root.
  icons: siteManifest.icons.map((icon) => ({ ...icon, src: new URL(icon.src, "https://app/").pathname })),
  permissions_policy: {
    "cross-origin-isolated": ["self"],
    usb: ["self"],
    "usb-unrestricted": ["self"],
  },
};

const builder = new wbn.BundleBuilder();
const add = (url, body, type) => builder.addExchange(url, 200, { "Content-Type": type }, body);
add("/.well-known/manifest.webmanifest", JSON.stringify(manifest, null, 2), types[".webmanifest"]);
let count = 0;
for (const file of walk(site).sort()) {
  const rel = path.relative(site, file).split(path.sep).join("/");
  // The installed app is the offline copy; it does not use the service worker.
  if (rel === "sw.js" || rel === ".nojekyll") continue;
  const type = types[path.extname(rel)] || "application/octet-stream";
  const body = fs.readFileSync(file);
  add("/" + rel, body, type);
  if (rel === "index.html") add("/", body, type);
  count++;
}

const signed = await wbnSign.SignedWebBundle.fromWebBundle(builder.createBundle(), [
  new wbnSign.NodeCryptoSigningStrategy(key),
]);
fs.mkdirSync(out, { recursive: true });
const bundle = path.join(out, "webrtlsdr.swbn");
fs.writeFileSync(bundle, signed.getSignedWebBundleBytes());
const id = new wbnSign.WebBundleId(key).serializeWithIsolatedWebAppOrigin();
console.log(`Built ${path.relative(root, bundle)} (${count} files, ${(fs.statSync(bundle).size / 1e6).toFixed(1)} MB, version ${version})`);
console.log(`App origin: ${id}`);
