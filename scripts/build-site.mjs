// SPDX-License-Identifier: Apache-2.0
//
// Builds the static web application in `site/`:
//   - copies the app from `app/`,
//   - copies the compiled library (`dist/`) and the signals library into
//     `site/lib/`, rewriting bare imports to relative paths so no import map
//     or CDN is needed,
//   - writes the service worker's list of files to cache,
//   - fails if any shipped code could contact another server.
//
// Run `npm run build` first. This script has no dependencies.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "site");
const signalsDist = path.join(root, "node_modules/@jtarrio/signals/dist");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function copyJs(fromDir, toDir) {
  for (const file of walk(fromDir)) {
    if (!file.endsWith(".js")) continue;
    const dest = path.join(toDir, path.relative(fromDir, file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let code = fs.readFileSync(file, "utf8");
    code = code.replace(/^\/\/# sourceMappingURL=.*$/m, "");
    code = code.replace(
      /(from\s*|import\s*)(["'])@jtarrio\/signals\/([^"']+)\2/g,
      (_, kw, q, sub) => {
        let rel = path.relative(
          path.dirname(dest),
          path.join(out, "lib/signals", sub),
        );
        if (!rel.startsWith(".")) rel = "./" + rel;
        return `${kw}${q}${rel.split(path.sep).join("/")}${q}`;
      },
    );
    fs.writeFileSync(dest, code);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, "app"), out, { recursive: true });
copyJs(path.join(root, "dist"), path.join(out, "lib/webrtlsdr"));
copyJs(signalsDist, path.join(out, "lib/signals"));
fs.mkdirSync(path.join(out, "licenses"), { recursive: true });
fs.copyFileSync(
  path.join(root, "LICENSE"),
  path.join(out, "licenses/webrtlsdr-LICENSE.txt"),
);
fs.copyFileSync(
  path.join(signalsDist, "../LICENSE"),
  path.join(out, "licenses/signals-LICENSE.txt"),
);
// Tell GitHub Pages to serve files as they are.
fs.writeFileSync(path.join(out, ".nojekyll"), "");

// Safety check: shipped code must not reach out to the network or load code
// from anywhere else. The service worker may fetch, but only same-origin
// (it refuses everything else).
const forbidden = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /WebSocket/,
  /EventSource/,
  /sendBeacon/,
  /RTCPeerConnection/,
  /importScripts/,
  /\bimport\s*\(/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /(src|href|from)\s*=?\s*["'](https?:)?\/\//,
];
const problems = [];
for (const file of walk(out)) {
  if (!/\.(js|html|css|webmanifest)$/.test(file)) continue;
  const rel = path.relative(out, file);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
    for (const re of forbidden) {
      if (!re.test(code)) continue;
      if (rel === "sw.js" && re.source.includes("fetch")) continue;
      problems.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
    // Absolute URLs are allowed only in comments and plain links.
    if (/https?:\/\//.test(code) && !/<a\s[^>]*href=/.test(code)) {
      problems.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
}
if (problems.length > 0) {
  console.error("Possible network access in shipped files:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

const files = walk(out)
  .map((f) => path.relative(out, f).split(path.sep).join("/"))
  .filter((f) => f !== "sw.js" && f !== ".nojekyll")
  .sort();
const hash = createHash("sha256");
for (const f of files) hash.update(f).update(fs.readFileSync(path.join(out, f)));
const buildId = hash.digest("hex").slice(0, 12);
const cached = ["./", ...files.map((f) => "./" + f)];
const swPath = path.join(out, "sw.js");
fs.writeFileSync(
  swPath,
  fs
    .readFileSync(swPath, "utf8")
    .replace("__BUILD_ID__", buildId)
    .replace("__FILES__", JSON.stringify(cached, null, 2)),
);

console.log(`Built site/ (${files.length} files, build ${buildId})`);
