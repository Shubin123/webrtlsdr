// SPDX-License-Identifier: Apache-2.0
//
// End-to-end test for the site build: verifies all expected files exist,
// the service worker is configured, and no network access leaks through.
//
// Run: node tests/e2e-build.mjs

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(import.meta.dirname, "..");
const site = path.join(root, "site");

if (!fs.existsSync(path.join(site, "index.html"))) {
  console.error("SKIP: site/ not built. Run `npm run build:site` first.");
  process.exit(0);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

console.log("Build E2E tests\n");

// --------------------------------------------------------------------------
// Core files
// --------------------------------------------------------------------------

const required = [
  "index.html",
  "app.js",
  "style.css",
  "icon.svg",
  "manifest.webmanifest",
  "sw.js",
  "transcriber.js",
  "fl2k-panel.js",
  "fl2k-device.js",
  "tx.js",
  "tx-signal.js",
  "tx-playbooks.js",
  "player.js",
  "capabilities.html",
  "stt/start.js",
  "stt/guard.js",
  "stt/worker.js",
  "fl2k/runtime.js",
  "fl2k/COPYING.txt",
  "fl2k/hardware-e2e.txt",
  "fl2k/source.tar.gz",
  "sim/jfk.wav",
];

for (const file of required) {
  test(`site/${file} exists`, () => {
    assert.ok(fs.existsSync(path.join(site, file)), `${file} missing`);
  });
}

// --------------------------------------------------------------------------
// ORT WASM files (on-demand, cached by service worker)
// --------------------------------------------------------------------------

test("ORT asyncify WASM binary exists", () => {
  const p = path.join(site, "stt/ort-wasm-simd-threaded.asyncify.wasm");
  assert.ok(fs.existsSync(p));
  assert.ok(fs.statSync(p).size > 1_000_000, "WASM binary too small");
});

test("ORT asyncify MJS factory exists", () => {
  const p = path.join(site, "stt/ort-wasm-simd-threaded.asyncify.mjs");
  assert.ok(fs.existsSync(p));
  assert.ok(fs.statSync(p).size > 10_000, "MJS factory too small");
});

// --------------------------------------------------------------------------
// Model files (on-demand)
// --------------------------------------------------------------------------

for (const model of ["moonshine-tiny", "moonshine-base"]) {
  const modelDir = path.join(site, "models", model);
  for (const file of [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
  ]) {
    test(`models/${model}/${file} exists`, () => {
      assert.ok(fs.existsSync(path.join(modelDir, file)));
    });
  }
}

// --------------------------------------------------------------------------
// Service worker
// --------------------------------------------------------------------------

test("service worker has build ID substituted", () => {
  const sw = fs.readFileSync(path.join(site, "sw.js"), "utf8");
  assert.ok(!sw.includes("__BUILD_ID__"), "BUILD_ID placeholder not replaced");
  assert.ok(!sw.includes("__MODELS_ID__"), "MODELS_ID placeholder not replaced");
  assert.ok(!sw.includes("__FILES__"), "FILES placeholder not replaced");
});

test("service worker caches core files", () => {
  const sw = fs.readFileSync(path.join(site, "sw.js"), "utf8");
  assert.ok(sw.includes("./index.html"), "index.html not in cache list");
  assert.ok(sw.includes("./app.js"), "app.js not in cache list");
  assert.ok(sw.includes("./style.css"), "style.css not in cache list");
});

test("service worker does not pre-cache model files", () => {
  const sw = fs.readFileSync(path.join(site, "sw.js"), "utf8");
  assert.ok(!sw.includes("models/moonshine"), "model files should be on-demand");
  assert.ok(!sw.includes("ort-wasm-simd"), "ORT files should be on-demand");
});

// --------------------------------------------------------------------------
// Content Security Policy
// --------------------------------------------------------------------------

test("index.html has a Content-Security-Policy", () => {
  const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(html.includes("default-src 'none'"));
});

// --------------------------------------------------------------------------
// No remote host references in app JS
// --------------------------------------------------------------------------

test("app JS files do not reference remote hosts", () => {
  const appFiles = ["app.js", "fl2k-panel.js", "fl2k-device.js", "transcriber.js", "tx.js", "tx-signal.js", "player.js"];
  const hosts = ["huggingface.co", "jsdelivr", "unpkg.com", "cdnjs.cloudflare.com"];
  for (const file of appFiles) {
    const code = fs.readFileSync(path.join(site, file), "utf8");
    for (const host of hosts) {
      assert.ok(!code.includes(host), `${file} references ${host}`);
    }
  }
});

test("bundled STT worker does not reference remote hosts", () => {
  const code = fs.readFileSync(path.join(site, "stt/worker.js"), "utf8");
  for (const host of ["huggingface.co", "jsdelivr", "unpkg.com", "cdnjs"]) {
    assert.ok(!code.includes(host), `stt/worker.js references ${host}`);
  }
});

// --------------------------------------------------------------------------
// Worker WASM path configuration
// --------------------------------------------------------------------------

test("bundled worker references asyncify WASM files", () => {
  const code = fs.readFileSync(path.join(site, "stt/worker.js"), "utf8");
  assert.ok(
    code.includes("ort-wasm-simd-threaded.asyncify.wasm"),
    "worker should reference asyncify .wasm",
  );
  assert.ok(
    code.includes("ort-wasm-simd-threaded.asyncify.mjs"),
    "worker should reference asyncify .mjs",
  );
});

// --------------------------------------------------------------------------
// Library files
// --------------------------------------------------------------------------

test("webrtlsdr library files present", () => {
  assert.ok(fs.existsSync(path.join(site, "lib/webrtlsdr/radio.js")));
  assert.ok(fs.existsSync(path.join(site, "lib/webrtlsdr/rtlsdr.js")));
});

test("signals library files present", () => {
  assert.ok(fs.existsSync(path.join(site, "lib/signals/demod/demodulator.js")));
  assert.ok(fs.existsSync(path.join(site, "lib/signals/demod/modes.js")));
});

// --------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
