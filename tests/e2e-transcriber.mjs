// SPDX-License-Identifier: Apache-2.0
//
// End-to-end test for the Moonshine speech-to-text pipeline.
// Verifies the model files load, inference runs, and the text cleaner works.
// Uses the CPU backend (WASM is browser-only); the model files are the same.
//
// Run: node tests/e2e-transcriber.mjs

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(import.meta.dirname, "..");
const siteModels = path.join(root, "site/models");

if (!fs.existsSync(path.join(siteModels, "moonshine-tiny/config.json"))) {
  console.error("SKIP: site/models not built. Run `npm run build:site` first.");
  process.exit(0);
}

const { env, pipeline } = await import(
  path.join(root, "node_modules/@huggingface/transformers/src/transformers.js")
);

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = siteModels + "/";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

console.log("Moonshine E2E tests\n");

// --------------------------------------------------------------------------
// Model loading
// --------------------------------------------------------------------------

let transcriber;

await test("moonshine-tiny loads from local files", async () => {
  transcriber = await pipeline("automatic-speech-recognition", "moonshine-tiny", {
    dtype: "q8",
    device: "cpu",
  });
  assert.ok(transcriber, "pipeline returned a transcriber");
});

// --------------------------------------------------------------------------
// Inference
// --------------------------------------------------------------------------

await test("silence produces empty or minimal text", async () => {
  const audio = new Float32Array(16000);
  const result = await transcriber(audio, { max_new_tokens: 10 });
  assert.equal(typeof result.text, "string");
});

await test("1-second tone produces a result without crashing", async () => {
  const audio = new Float32Array(16000);
  for (let i = 0; i < audio.length; i++) {
    audio[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / 16000);
  }
  const result = await transcriber(audio, { max_new_tokens: 20 });
  assert.equal(typeof result.text, "string");
});

await test("very short audio (0.25s) does not throw", async () => {
  const audio = new Float32Array(4000);
  const result = await transcriber(audio, { max_new_tokens: 5 });
  assert.equal(typeof result.text, "string");
});

// --------------------------------------------------------------------------
// Text cleaner (imported from the app module)
// --------------------------------------------------------------------------

const { cleanText } = await import(path.join(root, "app/transcriber.js"));

await test("cleanText removes long repetitions", () => {
  const input = "the quick brown fox the quick brown fox the quick brown fox the quick brown fox";
  const cleaned = cleanText(input);
  assert.equal(cleaned, "the quick brown fox");
});

await test("cleanText keeps short natural repeats", () => {
  const input = "no no that is wrong";
  const cleaned = cleanText(input);
  assert.equal(cleaned, "no no that is wrong");
});

await test("cleanText handles empty/whitespace input", () => {
  assert.equal(cleanText(""), "");
  assert.equal(cleanText("   "), "");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
});

await test("cleanText trims and normalizes whitespace", () => {
  assert.equal(cleanText("  hello   world  "), "hello world");
});

// --------------------------------------------------------------------------
// Model config checks
// --------------------------------------------------------------------------

await test("moonshine-tiny config has correct model_type", async () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(siteModels, "moonshine-tiny/config.json"), "utf8"),
  );
  assert.equal(config.model_type, "moonshine");
});

await test("moonshine-base config has correct model_type", async () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(siteModels, "moonshine-base/config.json"), "utf8"),
  );
  assert.equal(config.model_type, "moonshine");
});

await test("both models have required ONNX files", () => {
  for (const model of ["moonshine-tiny", "moonshine-base"]) {
    const onnxDir = path.join(siteModels, model, "onnx");
    assert.ok(
      fs.existsSync(path.join(onnxDir, "encoder_model_quantized.onnx")),
      `${model}/onnx/encoder_model_quantized.onnx missing`,
    );
    assert.ok(
      fs.existsSync(path.join(onnxDir, "decoder_model_merged_quantized.onnx")),
      `${model}/onnx/decoder_model_merged_quantized.onnx missing`,
    );
  }
});

// --------------------------------------------------------------------------
// WASM runtime files
// --------------------------------------------------------------------------

await test("ORT asyncify WASM files exist in site/stt/", () => {
  assert.ok(
    fs.existsSync(path.join(root, "site/stt/ort-wasm-simd-threaded.asyncify.wasm")),
    "asyncify .wasm missing",
  );
  assert.ok(
    fs.existsSync(path.join(root, "site/stt/ort-wasm-simd-threaded.asyncify.mjs")),
    "asyncify .mjs missing",
  );
});

// --------------------------------------------------------------------------
// Cleanup
// --------------------------------------------------------------------------

if (transcriber) await transcriber.dispose();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
