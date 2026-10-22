// SPDX-License-Identifier: Apache-2.0
//
// Speech-to-text worker. Bundled by scripts/build-site.mjs into
// site/stt/worker.js. It runs the Moonshine model with Transformers.js on the
// ONNX Runtime WebAssembly backend, loading the model and runtime only from
// this site (see app/stt/guard.js, which is loaded before this module).

import { env, pipeline } from "@huggingface/transformers";

let transcriber = undefined;
let loadedModel = undefined;

self.addEventListener("message", async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      await load(msg.base, msg.model);
    } else if (msg.type === "transcribe") {
      await transcribe(msg);
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      message: String(err?.message || err),
    });
  }
});

function configure(base) {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  // A path rather than a full URL, so that Transformers.js treats the
  // models as local files (guard.js resolves it against this site).
  env.localModelPath = new URL("models/", base).pathname;
  // The service worker caches the model files for offline use.
  env.useBrowserCache = false;
  env.useWasmCache = false;
  const onnx = env.backends.onnx;
  onnx.wasm.wasmPaths = {
    wasm: new URL("stt/ort-wasm-simd-threaded.wasm", base).href,
  };
  // Multiple threads need cross-origin isolation, which GitHub Pages lacks.
  onnx.wasm.numThreads = 1;
  onnx.wasm.proxy = false;
}

async function load(base, model) {
  if (loadedModel === model && transcriber) {
    self.postMessage({ type: "ready", model });
    return;
  }
  configure(base);
  if (transcriber) {
    await transcriber.dispose();
    transcriber = undefined;
    loadedModel = undefined;
  }
  transcriber = await pipeline("automatic-speech-recognition", model, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p) => {
      if (p.status === "progress") {
        self.postMessage({
          type: "progress",
          file: p.file,
          loaded: p.loaded,
          total: p.total,
        });
      }
    },
  });
  loadedModel = model;
  // Warm up so the first real transcription is fast.
  await transcriber(new Float32Array(16000), { max_new_tokens: 4 });
  self.postMessage({ type: "ready", model });
}

async function transcribe({ id, audio }) {
  if (!transcriber) throw new Error("Model not loaded");
  const seconds = audio.length / 16000;
  const started = performance.now();
  // Moonshine needs about 6.5 tokens per second of speech at most; capping the
  // output this way prevents runaway repetition on noise.
  const out = await transcriber(audio, {
    max_new_tokens: Math.ceil(seconds * 6.5) + 4,
  });
  self.postMessage({
    type: "result",
    id,
    text: out.text,
    seconds,
    elapsed: (performance.now() - started) / 1000,
  });
}
