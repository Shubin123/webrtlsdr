// SPDX-License-Identifier: Apache-2.0
//
// Turns demodulated audio into text with a speech recognition model that runs
// entirely in the browser. Audio at 48 kHz is filtered and decimated to
// 16 kHz, split into utterances with an adaptive energy detector, and sent to
// a worker running Moonshine (see stt/worker.js).

export const MODELS = {
  "moonshine-base": { label: "Moonshine Base", size: "66 MB" },
  "moonshine-tiny": { label: "Moonshine Tiny", size: "32 MB" },
};

const IN_RATE = 48000;
const OUT_RATE = 16000;
const FRAME = 320; // 20 ms at 16 kHz.
const PREROLL_FRAMES = 15;
const HANGOVER_FRAMES = 40;
const MIN_SPEECH_FRAMES = 15;
const MAX_FRAMES = 1000; // 20 seconds.
const MAX_QUEUE = 4;
const FLOOR_FRAMES = 250; // The noise floor is the quietest frame in 5 seconds.

/** Low-pass filter (7 kHz) and decimation by 3, from 48 kHz to 16 kHz. */
class Decimator {
  constructor() {
    const taps = 63;
    const cutoff = 7000 / IN_RATE;
    this.coefs = new Float32Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; ++i) {
      const n = i - (taps - 1) / 2;
      const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
      const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
      this.coefs[i] = sinc * window;
      sum += this.coefs[i];
    }
    for (let i = 0; i < taps; ++i) this.coefs[i] /= sum;
    this.history = new Float32Array(taps);
    this.pos = 0;
    this.phase = 0;
  }

  /** Processes mono samples and returns the decimated output. */
  process(input) {
    const taps = this.coefs.length;
    const out = new Float32Array(Math.ceil(input.length / 3) + 1);
    let n = 0;
    for (let i = 0; i < input.length; ++i) {
      this.history[this.pos] = input[i];
      this.pos = (this.pos + 1) % taps;
      if (++this.phase < 3) continue;
      this.phase = 0;
      let acc = 0;
      for (let k = 0; k < taps; ++k) {
        acc += this.coefs[k] * this.history[(this.pos + k) % taps];
      }
      out[n++] = acc;
    }
    return out.subarray(0, n);
  }
}

/** Splits a 16 kHz audio stream into utterances. */
class Segmenter {
  constructor(onSegment) {
    this.onSegment = onSegment;
    this.frame = new Float32Array(FRAME);
    this.framePos = 0;
    this.levels = new Float32Array(FLOOR_FRAMES).fill(-120);
    this.levelPos = 0;
    this.preroll = [];
    this.active = false;
    this.frames = [];
    this.speechFrames = 0;
    this.silentFrames = 0;
  }

  reset() {
    this.framePos = 0;
    this.preroll = [];
    this.active = false;
    this.frames = [];
  }

  push(samples) {
    for (let i = 0; i < samples.length; ++i) {
      this.frame[this.framePos++] = samples[i];
      if (this.framePos === FRAME) {
        this.processFrame(this.frame.slice());
        this.framePos = 0;
      }
    }
  }

  processFrame(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; ++i) sum += frame[i] * frame[i];
    const db = 10 * Math.log10(sum / frame.length + 1e-12);
    this.levels[this.levelPos] = db;
    this.levelPos = (this.levelPos + 1) % FLOOR_FRAMES;
    let floor = Infinity;
    for (let i = 0; i < FLOOR_FRAMES; ++i) floor = Math.min(floor, this.levels[i]);
    const speech = db > -60 && db > Math.max(floor, -90) + 9;

    if (!this.active) {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      if (speech) {
        this.active = true;
        this.frames = [...this.preroll];
        this.preroll = [];
        this.speechFrames = 1;
        this.silentFrames = 0;
      }
      return;
    }

    this.frames.push(frame);
    if (speech) {
      this.speechFrames++;
      this.silentFrames = 0;
    } else {
      this.silentFrames++;
    }
    if (this.silentFrames >= HANGOVER_FRAMES || this.frames.length >= MAX_FRAMES) {
      this.finish();
    }
  }

  finish() {
    const keep = this.frames.length - Math.max(0, this.silentFrames - 10);
    const frames = this.frames.slice(0, keep);
    const enough = this.speechFrames >= MIN_SPEECH_FRAMES;
    this.active = false;
    this.frames = [];
    if (!enough) return;
    const audio = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => audio.set(f, i * FRAME));
    // Normalize the level; quiet audio transcribes poorly.
    let peak = 0;
    for (let i = 0; i < audio.length; ++i) peak = Math.max(peak, Math.abs(audio[i]));
    if (peak > 0) {
      const gain = Math.min(0.9 / peak, 30);
      for (let i = 0; i < audio.length; ++i) audio[i] *= gain;
    }
    this.onSegment(audio);
  }
}

/** Removes the repetition small models sometimes produce on noisy audio. */
function cleanText(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/\b(\w+(?:\s+\w+){0,3})(?:[\s,.]+\1\b){2,}/gi, "$1");
  if (!/[a-z0-9]/i.test(t)) return "";
  return t;
}

/**
 * Manages the speech-to-text worker and the audio segmentation.
 *
 * Events:
 * - "status": detail is { state, message, progress? }
 * - "transcript": detail is { text, seconds, elapsed, context }
 */
export class Transcriber extends EventTarget {
  constructor(baseUrl, getContext) {
    super();
    this.baseUrl = baseUrl;
    this.getContext = getContext;
    this.worker = undefined;
    this.enabled = false;
    this.model = "moonshine-base";
    this.ready = false;
    this.busy = false;
    this.queue = [];
    this.nextId = 1;
    this.pending = new Map();
    this.progress = new Map();
    this.loadFraction = 0;
    this.decimator = new Decimator();
    this.segmenter = new Segmenter((audio) => this.enqueue(audio));
  }

  /** Feeds demodulated 48 kHz stereo audio. */
  push(left, right) {
    if (!this.enabled) return;
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; ++i) mono[i] = (left[i] + right[i]) / 2;
    this.segmenter.push(this.decimator.process(mono));
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) {
      this.load();
    } else {
      this.segmenter.reset();
      this.queue = [];
      this.status("off", "Off");
    }
  }

  setModel(model) {
    if (!(model in MODELS) || model === this.model) return;
    this.model = model;
    this.ready = false;
    if (this.enabled) this.load();
  }

  load() {
    if (!this.worker) this.worker = this.createWorker();
    this.ready = false;
    this.progress.clear();
    this.loadFraction = 0;
    const info = MODELS[this.model];
    this.status("loading", `Loading ${info.label} (${info.size})…`, 0);
    this.worker.postMessage({ type: "load", base: this.baseUrl, model: this.model });
  }

  createWorker() {
    // The worker is started from a blob so that it inherits this page's
    // Content Security Policy; guard.js then locks it to this origin.
    const guard = new URL("stt/guard.js", this.baseUrl).href;
    const main = new URL("stt/worker.js", this.baseUrl).href;
    const source = `import ${JSON.stringify(guard)};\nimport ${JSON.stringify(main)};\n`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    worker.addEventListener("message", (e) => this.onMessage(e.data));
    worker.addEventListener("error", (e) => {
      this.status("error", `Speech model failed to start: ${e.message || "unknown error"}`);
    });
    return worker;
  }

  onMessage(msg) {
    switch (msg.type) {
      case "progress": {
        this.progress.set(msg.file, msg);
        let loaded = 0;
        let total = 0;
        for (const p of this.progress.values()) {
          loaded += p.loaded || 0;
          total += p.total || 0;
        }
        // Files report their sizes as they start, so only move forward.
        this.loadFraction = Math.max(this.loadFraction, total > 0 ? loaded / total : 0);
        const fraction = this.loadFraction;
        const info = MODELS[this.model];
        this.status("loading", `Loading ${info.label} (${info.size})… ${Math.round(fraction * 100)}%`, fraction);
        break;
      }
      case "ready":
        if (msg.model !== this.model) return;
        this.ready = true;
        this.status("listening", `${MODELS[this.model].label} ready — listening`);
        this.drain();
        break;
      case "result": {
        const context = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        this.busy = false;
        const text = cleanText(msg.text);
        if (text) {
          this.dispatchEvent(
            new CustomEvent("transcript", {
              detail: { text, seconds: msg.seconds, elapsed: msg.elapsed, context },
            }),
          );
        }
        if (this.enabled) this.status("listening", `${MODELS[this.model].label} ready — listening`);
        this.drain();
        break;
      }
      case "error":
        if (msg.id !== undefined) {
          this.pending.delete(msg.id);
          this.busy = false;
          this.drain();
        } else {
          this.ready = false;
        }
        this.status("error", `Speech recognition error: ${msg.message}`);
        break;
    }
  }

  enqueue(audio) {
    this.queue.push({ audio, context: this.getContext() });
    // If the computer cannot keep up, skip the oldest utterances.
    while (this.queue.length > MAX_QUEUE) this.queue.shift();
    this.drain();
  }

  drain() {
    if (!this.ready || this.busy || this.queue.length === 0 || !this.enabled) return;
    const { audio, context } = this.queue.shift();
    const id = this.nextId++;
    this.pending.set(id, context);
    this.busy = true;
    this.status("working", "Transcribing…");
    this.worker.postMessage({ type: "transcribe", id, audio }, [audio.buffer]);
  }

  status(state, message, progress) {
    this.dispatchEvent(new CustomEvent("status", { detail: { state, message, progress } }));
  }
}
