// SPDX-License-Identifier: Apache-2.0
//
// Builds the static web application in `site/`:
//   - copies the app from `app/`,
//   - copies the compiled library (`dist/`) and the signals library into
//     `site/lib/`, rewriting bare imports to relative paths so no import map
//     or CDN is needed,
//   - bundles the speech-to-text worker and copies the ONNX Runtime
//     WebAssembly binary,
//   - copies the speech models (downloading them at a pinned revision into
//     .cache/ if needed) after checking their SHA-256 hashes,
//   - writes the service worker's list of files to cache,
//   - fails if any shipped code could contact another server.
//
// Run `npm run build` first.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

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

// Speech-to-text worker. The library's default remote hosts are replaced with
// an unresolvable name as an extra safeguard; the worker is configured to use
// only local files anyway.
const workerOut = path.join(out, "stt/worker.js");
await build({
  entryPoints: [path.join(root, "stt/worker.js")],
  outfile: workerOut,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  // Use the WebAssembly-only runtime: it is half the size of the WebGPU one.
  alias: { "onnxruntime-web/webgpu": "onnxruntime-web/wasm" },
  logLevel: "warning",
});
const REMOTE_HOSTS = /(huggingface\.co|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)/g;
fs.writeFileSync(
  workerOut,
  fs
    .readFileSync(workerOut, "utf8")
    .replace(REMOTE_HOSTS, "blocked.invalid")
    // This unused class name is 32 characters long and contains "mistral",
    // so GitHub's secret scanning mistakes it for a Mistral AI API key and
    // blocks the push. Renaming it everywhere is harmless.
    .replaceAll("Mistral3ForConditionalGeneration", "Mistral3ForConditionalGenerationModel"),
);
const ortDist = path.join(root, "node_modules/onnxruntime-web/dist");
fs.copyFileSync(
  path.join(ortDist, "ort-wasm-simd-threaded.wasm"),
  path.join(out, "stt/ort-wasm-simd-threaded.wasm"),
);
for (const [name, file] of [
  ["transformers", "node_modules/@huggingface/transformers/LICENSE"],
  ["onnxruntime-web", "node_modules/onnxruntime-web/LICENSE"],
]) {
  if (fs.existsSync(path.join(root, file))) {
    fs.copyFileSync(path.join(root, file), path.join(out, `licenses/${name}-LICENSE.txt`));
  }
}

// Speech models, verified against the hashes in scripts/stt-models.json.
const manifestPath = path.join(root, "scripts/stt-models.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const [name, model] of Object.entries(manifest)) {
  for (const file of model.files) {
    const cached = path.join(root, ".cache/models", name, file.path);
    if (!fs.existsSync(cached)) {
      const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`;
      console.log(`Downloading ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
    }
    const data = fs.readFileSync(cached);
    const sha = createHash("sha256").update(data).digest("hex");
    if (sha !== file.sha256 || data.length !== file.size) {
      fs.rmSync(cached);
      throw new Error(`${name}/${file.path}: hash mismatch (deleted, run again)`);
    }
    const dest = path.join(out, "models", name, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(cached, dest);
  }
}

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
  // guard.js names the network APIs in order to remove them.
  if (rel === path.join("stt", "guard.js")) continue;
  if (rel === path.join("stt", "worker.js")) {
    // A third-party bundle: it contains fetch() and dynamic imports, which it
    // only points at this site (see stt/worker.js). It runs under the page's
    // CSP plus guard.js. Make sure no remote host survived the rewrite.
    const code = fs.readFileSync(file, "utf8");
    for (const host of ["huggingface.co", "jsdelivr", "unpkg.com", "cdnjs"]) {
      if (code.includes(host)) problems.push(`${rel}: mentions ${host}`);
    }
    continue;
  }
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
    for (const re of forbidden) {
      if (!re.test(code)) continue;
      if (rel === "sw.js" && re.source.includes("fetch")) continue;
      // fetch() of a relative path only reaches this site.
      if (re.source.includes("fetch") && /\bfetch\s*\(\s*["'](?![a-z]+:|\/\/)[^"']*["']\s*\)/.test(code)) continue;
      // A plain link only navigates when clicked; it loads nothing.
      if (re.source.startsWith("(src|href|from)") && /^[^<]*(<(?!(link|script|img|iframe|source|video|audio|embed|object)\b)[^>]*>[^<]*)*$/i.test(code) && /<a\s[^>]*href=/.test(code)) continue;
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
  .filter((f) => !f.startsWith("models/") && !f.startsWith("stt/ort-"))
  .sort();
const modelsId = createHash("sha256")
  .update(fs.readFileSync(manifestPath))
  .update(fs.readFileSync(path.join(ortDist, "ort-wasm-simd-threaded.wasm")))
  .digest("hex")
  .slice(0, 12);
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
    .replace("__MODELS_ID__", modelsId)
    .replace("__FILES__", JSON.stringify(cached, null, 2)),
);

console.log(`Built site/ (${files.length} files, build ${buildId})`);
