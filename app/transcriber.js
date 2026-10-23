// SPDX-License-Identifier: Apache-2.0
//
// Turns demodulated audio into text with a speech recognition model that runs
// entirely in the browser. Audio at 48 kHz is filtered and decimated to
// 16 kHz, split into utterances with an adaptive energy detector, and sent to
// a worker running Moonshine (see stt/worker.js). While someone is talking,
// the utterance so far is transcribed whenever the worker is idle, so text
// appears live; the final text replaces it when the utterance ends.

export const MODELS = {
  "moonshine-base": { label: "Moonshine Base", size: "66 MB" },
  "moonshine-tiny": { label: "Moonshine Tiny", size: "32 MB" },
};

const IN_RATE = 48000;
const OUT_RATE = 16000;
const FRAME = 320; // 20 ms at 16 kHz.
const FRAMES_PER_SECOND = OUT_RATE / FRAME;
const PREROLL_FRAMES = 15;
const HANGOVER_FRAMES = 60; // 1.2 s of quiet ends an utterance; live text covers the wait.
const MIN_SPEECH_FRAMES = 15;
const MAX_FRAMES = 12 * FRAMES_PER_SECOND;
const CUT_SEARCH_FRAMES = 3 * FRAMES_PER_SECOND;
const FLOOR_FRAMES = 5 * FRAMES_PER_SECOND;
const PARTIAL_INTERVAL_FRAMES = FRAMES_PER_SECOND;
const MAX_QUEUE = 4;
const TARGET_RMS = 0.1;

/** Low-pass filter (7 kHz) and decimation by 3, from 48 kHz to 16 kHz. */
class Decimator {
  constructor() {
    const taps = 48;
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
    // The history is stored twice so the filter can read it without wrapping.
    this.history = new Float32Array(taps * 2);
    this.pos = 0;
    this.phase = 0;
    this.out = new Float32Array(0);
  }

  /** Processes left and right channels and returns mono output at 16 kHz. */
  process(left, right) {
    const taps = this.coefs.length;
    const coefs = this.coefs;
    const history = this.history;
    const size = Math.ceil(left.length / 3) + 1;
    if (this.out.length < size) this.out = new Float32Array(size);
    let n = 0;
    for (let i = 0; i < left.length; ++i) {
      const v = (left[i] + right[i]) * 0.5;
      history[this.pos] = v;
      history[this.pos + taps] = v;
      if (++this.pos === taps) this.pos = 0;
      if (++this.phase < 3) continue;
      this.phase = 0;
      let acc = 0;
      for (let k = 0, j = this.pos; k < taps; ++k, ++j) acc += coefs[k] * history[j];
      this.out[n++] = acc;
    }
    return this.out.subarray(0, n);
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
    this.segId = 0;
    this.reset();
  }

  reset() {
    this.framePos = 0;
    this.preroll = [];
    this.active = false;
    this.frames = [];
    this.frameDb = [];
    this.speechFrames = 0;
    this.silentFrames = 0;
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
    if (++this.levelPos === FLOOR_FRAMES) this.levelPos = 0;
    let floor = Infinity;
    for (let i = 0; i < FLOOR_FRAMES; ++i) if (this.levels[i] < floor) floor = this.levels[i];
    const speech = db > -60 && db > Math.max(floor, -90) + 9;

    if (!this.active) {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      if (speech) {
        this.active = true;
        this.segId++;
        this.frames = [...this.preroll];
        this.frameDb = this.frames.map(() => -120);
        this.preroll = [];
        this.speechFrames = 1;
        this.silentFrames = 0;
      }
      return;
    }

    this.frames.push(frame);
    this.frameDb.push(db);
    if (speech) {
      this.speechFrames++;
      this.silentFrames = 0;
    } else {
      this.silentFrames++;
    }
    if (this.silentFrames >= HANGOVER_FRAMES) {
      this.finish();
    } else if (this.frames.length >= MAX_FRAMES) {
      this.split();
    }
  }

  /** Ends the utterance after a pause. */
  finish() {
    const keep = this.frames.length - Math.max(0, this.silentFrames - 10);
    const enough = this.speechFrames >= MIN_SPEECH_FRAMES;
    const frames = this.frames.slice(0, keep);
    const segId = this.segId;
    this.active = false;
    this.frames = [];
    this.frameDb = [];
    if (enough) this.onSegment(toAudio(frames), segId, true);
  }

  /** Cuts continuous speech at the quietest moment of the last few seconds. */
  split() {
    let cut = this.frames.length - 1;
    for (let i = this.frames.length - CUT_SEARCH_FRAMES; i < this.frames.length; ++i) {
      if (this.frameDb[i] < this.frameDb[cut]) cut = i;
    }
    const head = this.frames.slice(0, cut + 1);
    const segId = this.segId;
    this.frames = this.frames.slice(cut + 1);
    this.frameDb = this.frameDb.slice(cut + 1);
    this.speechFrames = this.frames.length;
    this.segId++;
    this.onSegment(toAudio(head), segId, false);
  }

  /** The current utterance so far, for live results. */
  current() {
    return this.active ? toAudio(this.frames) : undefined;
  }
}

/** Joins frames and normalizes the level, which helps recognition. */
function toAudio(frames) {
  const audio = new Float32Array(frames.length * FRAME);
  frames.forEach((f, i) => audio.set(f, i * FRAME));
  // Normalize by the loudness of the louder half of the audio rather than
  // the peak, so a single click doesn't make the speech too quiet.
  const energies = frames.map((f) => {
    let s = 0;
    for (let i = 0; i < f.length; ++i) s += f[i] * f[i];
    return s / f.length;
  });
  energies.sort((a, b) => b - a);
  const loud = energies.slice(0, Math.max(1, energies.length >> 1));
  const rms = Math.sqrt(loud.reduce((a, b) => a + b, 0) / loud.length);
  if (rms > 0) {
    const gain = Math.max(0.1, Math.min(TARGET_RMS / rms, 50));
    for (let i = 0; i < audio.length; ++i) {
      audio[i] = Math.max(-1, Math.min(1, audio[i] * gain));
    }
  }
  return audio;
}

/** Removes the repetition small models sometimes produce on difficult audio. */
export function cleanText(text) {
  let words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  for (let n = Math.min(12, words.length >> 1); n >= 1; --n) {
    for (let i = 0; i + 2 * n <= words.length; ++i) {
      let same = true;
      for (let k = 0; k < n && same; ++k) same = norm(words[i + k]) === norm(words[i + n + k]);
      if (!same) continue;
      // Drop every following copy, and a trailing partial copy.
      let j = i + n;
      while (j + n <= words.length) {
        let again = true;
        for (let k = 0; k < n && again; ++k) again = norm(words[i + k]) === norm(words[j + k]);
        if (!again) break;
        j += n;
      }
      // Short repeats ("no, no") are often real speech.
      if (n < 3 && j - i < 3 * n) continue;
      let tail = words.length - j;
      if (tail < n) {
        let prefix = true;
        for (let k = 0; k < tail && prefix; ++k) {
          const a = norm(words[i + k]);
          const b = norm(words[j + k]);
          prefix = k === tail - 1 ? a.startsWith(b) : a === b;
        }
        if (prefix) j = words.length;
      }
      words.splice(i + n, j - (i + n));
    }
  }
  const t = words.join(" ");
  return /[a-z0-9]/i.test(t) ? t : "";
}

/**
 * Manages the speech-to-text worker and the audio segmentation.
 *
 * Events:
 * - "status": detail is { state, message, progress? }
 * - "activity": detail is { speech } when speech starts or stops
 * - "partial": detail is { text } with live text for the current utterance
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
    this.speed = undefined;
    this.dropped = 0;
    this.lastPartialFrames = 0;
    this.partialSeg = 0;
    this.wasActive = false;
    this.decimator = new Decimator();
    this.segmenter = new Segmenter((audio, segId, ended) =>
      this.enqueue(audio, segId, ended),
    );
  }

  /** Feeds demodulated 48 kHz stereo audio. */
  push(left, right) {
    if (!this.enabled) return;
    this.segmenter.push(this.decimator.process(left, right));
    const active = this.segmenter.active;
    if (active !== this.wasActive) {
      this.wasActive = active;
      this.dispatchEvent(new CustomEvent("activity", { detail: { speech: active } }));
    }
    this.maybePartial();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) {
      this.load();
    } else {
      this.segmenter.reset();
      this.queue = [];
      this.wasActive = false;
      this.status("off", "Off");
    }
  }

  setModel(model) {
    if (!(model in MODELS) || model === this.model) return;
    this.model = model;
    this.ready = false;
    this.speed = undefined;
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
      this.busy = false;
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
        const info = MODELS[this.model];
        this.status(
          "loading",
          `Loading ${info.label} (${info.size})… ${Math.round(this.loadFraction * 100)}%`,
          this.loadFraction,
        );
        break;
      }
      case "ready":
        if (msg.model !== this.model) return;
        this.ready = true;
        this.listening();
        this.drain();
        break;
      case "result": {
        const job = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        this.busy = false;
        if (job && !job.partial) {
          const speed = msg.seconds / Math.max(msg.elapsed, 1e-3);
          this.speed = this.speed === undefined ? speed : 0.7 * this.speed + 0.3 * speed;
          const text = cleanText(msg.text);
          if (text) {
            this.dispatchEvent(
              new CustomEvent("transcript", {
                detail: { text, seconds: msg.seconds, elapsed: msg.elapsed, context: job.context },
              }),
            );
          }
          this.partial("");
        } else if (job && job.segId === this.segmenter.segId && this.segmenter.active) {
          this.partial(cleanText(msg.text));
        }
        if (this.enabled && this.ready) this.listening();
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

  enqueue(audio, segId, ended) {
    this.queue.push({ audio, segId, ended, context: this.getContext() });
    // If the computer cannot keep up, skip the oldest utterances.
    while (this.queue.length > MAX_QUEUE) {
      this.queue.shift();
      this.dropped++;
    }
    this.lastPartialFrames = 0;
    this.drain();
  }

  /** Transcribes the utterance in progress if the worker has nothing else to do. */
  maybePartial() {
    if (!this.ready || this.busy || this.queue.length > 0) return;
    const seg = this.segmenter;
    if (!seg.active || seg.frames.length < FRAMES_PER_SECOND) return;
    if (this.partialSeg === seg.segId && seg.frames.length - this.lastPartialFrames < PARTIAL_INTERVAL_FRAMES) {
      return;
    }
    this.partialSeg = seg.segId;
    this.lastPartialFrames = seg.frames.length;
    this.send({ audio: seg.current(), segId: seg.segId, partial: true });
  }

  drain() {
    if (!this.ready || this.busy || this.queue.length === 0 || !this.enabled) return;
    this.send(this.queue.shift());
  }

  send(job) {
    const id = this.nextId++;
    this.pending.set(id, job);
    this.busy = true;
    const { audio } = job;
    this.worker.postMessage(
      { type: "transcribe", id, audio, partial: !!job.partial },
      [audio.buffer],
    );
  }

  partial(text) {
    this.dispatchEvent(new CustomEvent("partial", { detail: { text } }));
  }

  listening() {
    let message = `${MODELS[this.model].label} ready — listening`;
    if (this.speed !== undefined) message += ` · ${this.speed.toFixed(this.speed < 10 ? 1 : 0)}× real time`;
    if (this.dropped > 0) message += ` · skipped ${this.dropped} (computer too slow, try Tiny)`;
    this.status("listening", message);
  }

  status(state, message, progress) {
    this.dispatchEvent(new CustomEvent("status", { detail: { state, message, progress } }));
  }
}
