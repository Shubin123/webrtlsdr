// Records raw IQ from the receiver and renders it for replay through the FL2K
// red DAC: the recorded band is moved up to a chosen carrier as real samples.

export const MAX_RECORD_SECONDS = 10;
export const MAX_REPLAY_SAMPLES = 32000000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

// The inverse of the radio's u8 → float conversion (u8 / 128 − 0.995).
const toU8 = (value) => Math.max(0, Math.min(255, Math.round((value + 0.995) * 128)));

/** A SampleReceiver for the Radio that keeps up to MAX_RECORD_SECONDS of IQ as rtl_sdr-style unsigned 8-bit pairs. */
export class IqRecorder extends EventTarget {
  constructor() {
    super();
    this.sampleRate = 0;
    this.recording = null;
    this.capture = null;
    this.lastBlock = -Infinity;
  }

  setSampleRate(sampleRate) {
    if (this.capture && sampleRate !== this.sampleRate) this.finish("RX sample rate changed");
    this.sampleRate = sampleRate;
  }

  receiveSamples(block) {
    this.lastBlock = performance.now();
    const capture = this.capture;
    if (!capture) return;
    capture.frequency ??= block.frequency;
    if (block.frequency !== capture.frequency) {
      this.finish("RX frequency changed");
      return;
    }
    const count = Math.min(block.I.length, capture.iq.length / 2 - capture.length);
    for (let i = 0, j = capture.length * 2; i < count; i++, j += 2) {
      capture.iq[j] = toU8(block.I[i]);
      capture.iq[j + 1] = toU8(block.Q[i]);
    }
    capture.length += count;
    if (capture.length * 2 >= capture.iq.length) this.finish("");
  }

  /** Whether the receiver delivered samples in the last second. */
  receiving() {
    return performance.now() - this.lastBlock < 1000;
  }

  start(seconds) {
    if (!(seconds > 0 && seconds <= MAX_RECORD_SECONDS)) throw new Error(`Record 0.1–${MAX_RECORD_SECONDS} seconds.`);
    if (!this.sampleRate || !this.receiving()) throw new Error("Start RX (Play RX) before recording IQ.");
    this.capture = { iq: new Uint8Array(2 * Math.round(seconds * this.sampleRate)), length: 0, frequency: undefined, sampleRate: this.sampleRate, started: new Date() };
    this.dispatchEvent(new Event("change"));
  }

  stop() {
    if (this.capture) this.finish("");
  }

  finish(reason) {
    const capture = this.capture;
    this.capture = null;
    if (capture.length > 0) {
      this.recording = { iq: capture.iq.slice(0, capture.length * 2), sampleRate: capture.sampleRate, frequency: capture.frequency, recordedAt: capture.started, name: "" };
    }
    this.dispatchEvent(new CustomEvent("change", { detail: { reason } }));
  }

  /** Seconds captured so far, while recording. */
  progress() {
    return this.capture ? this.capture.length / this.capture.sampleRate : 0;
  }

  load(recording) {
    this.capture = null;
    this.recording = recording;
    this.dispatchEvent(new Event("change"));
  }
}

export const duration = (recording) => recording.iq.length / 2 / recording.sampleRate;

/** Why this recording cannot be replayed at `carrier` with `dacRate`, or "". */
export function replayProblem(recording, { carrier, dacRate, level }) {
  if (!recording) return "Record or load IQ first.";
  if (!(level >= 0 && level <= 1)) return "Output level must be 0–100%.";
  const half = recording.sampleRate / 2;
  if (!(carrier - half > 0)) return `The recording is ${(recording.sampleRate / 1e6).toFixed(3)} MHz wide: replay it at ${(half / 1e6).toFixed(3)} MHz or higher.`;
  if (!(carrier + half < dacRate / 2)) return `Replaying ${(recording.sampleRate / 1e6).toFixed(3)} MHz of bandwidth at ${(carrier / 1e6).toFixed(3)} MHz needs a DAC rate above ${(2 * (carrier + half) / 1e6).toFixed(1)} MS/s.`;
  return "";
}

/** How much of the recording fits in one FL2K buffer at `dacRate`. */
export function replayLength(recording, dacRate) {
  const total = Math.floor(duration(recording) * dacRate);
  const samples = Math.min(total, MAX_REPLAY_SAMPLES);
  return { samples, seconds: samples / dacRate, truncated: samples < total };
}

/**
 * Signed 8-bit DAC samples: the recording's complex baseband, linearly
 * interpolated to `dacRate` and mixed up to `carrier`, peak scaled to `level`.
 */
export async function renderReplay(recording, { carrier, dacRate, level }, canceled = () => false) {
  const problem = replayProblem(recording, { carrier, dacRate, level });
  if (problem) throw new Error(problem);
  const { iq, sampleRate } = recording;
  const count = iq.length / 2;
  let peak = 0;
  for (let i = 0; i < iq.length; i += 2) peak = Math.max(peak, Math.hypot(iq[i] - 127.5, iq[i + 1] - 127.5));
  const scale = peak > 0 ? (127 * level) / peak : 0;
  const out = new Int8Array(replayLength(recording, dacRate).samples);
  const step = sampleRate / dacRate;
  const rotateCos = Math.cos((2 * Math.PI * carrier) / dacRate);
  const rotateSin = Math.sin((2 * Math.PI * carrier) / dacRate);
  let c = 1;
  let s = 0;
  for (let offset = 0; offset < out.length; offset += 262144) {
    if (canceled()) throw new Error("Replay preparation canceled.");
    const end = Math.min(out.length, offset + 262144);
    for (let n = offset; n < end; n++) {
      const position = n * step;
      const index = Math.min(count - 1, Math.floor(position));
      const next = Math.min(count - 1, index + 1);
      const fraction = position - index;
      const i = iq[2 * index] - 127.5 + fraction * (iq[2 * next] - iq[2 * index]);
      const q = iq[2 * index + 1] - 127.5 + fraction * (iq[2 * next + 1] - iq[2 * index + 1]);
      out[n] = Math.max(-127, Math.min(127, Math.round(scale * (i * c - q * s))));
      const rotated = c * rotateCos - s * rotateSin;
      s = c * rotateSin + s * rotateCos;
      c = rotated;
    }
    // Keep the phasor on the unit circle; the recurrence drifts slowly.
    const norm = Math.hypot(c, s);
    c /= norm;
    s /= norm;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

/** File name carrying frequency and sample rate, e.g. iq_433920000Hz_1024000sps_20261103-101500.cu8. */
export function recordingFileName(recording) {
  const time = recording.recordedAt.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `iq_${Math.round(recording.frequency)}Hz_${Math.round(recording.sampleRate)}sps_${time}.cu8`;
}

const units = { "": 1, k: 1e3, K: 1e3, M: 1e6 };
function fromName(name) {
  const rate = name.match(/(\d+(?:\.\d+)?)([kM]?)sps/i) || name.match(/_(\d+(?:\.\d+)?)(k)(?=[_.])/);
  const frequency = name.match(/(\d+(?:\.\d+)?)([kM]?)Hz/i) || name.match(/_(\d+(?:\.\d+)?)(M)(?=[_.])/);
  return {
    sampleRate: rate ? Number(rate[1]) * units[rate[2]] : undefined,
    frequency: frequency ? Number(frequency[1]) * units[frequency[2]] : undefined,
  };
}

/**
 * Reads a .cu8 (rtl_sdr) or .cs8 (HackRF) IQ file. Frequency and sample rate
 * come from the name (this app's names, or rtl_433's _433.92M_250k), else from `fallback`.
 */
export function parseRecording(name, bytes, fallback) {
  const signed = /\.cs8$/i.test(name);
  if (!signed && !/\.(cu8|bin|raw)$/i.test(name)) throw new Error("Load an 8-bit IQ file: .cu8 (rtl_sdr) or .cs8 (HackRF).");
  if (bytes.length < 2 || bytes.length > MAX_FILE_BYTES) throw new Error("IQ files must be 2 bytes to 64 MB.");
  const parsed = fromName(name);
  const sampleRate = parsed.sampleRate ?? fallback.sampleRate;
  const frequency = parsed.frequency ?? fallback.frequency;
  if (!(sampleRate >= 1000 && sampleRate <= 20e6)) throw new Error("Could not tell the file's sample rate; put it in the name, e.g. _1024000sps.");
  const iq = new Uint8Array(bytes.length & ~1);
  for (let i = 0; i < iq.length; i++) iq[i] = signed ? (bytes[i] + 128) & 255 : bytes[i];
  return { iq, sampleRate, frequency, recordedAt: new Date(), name, guessed: parsed.sampleRate === undefined || parsed.frequency === undefined };
}

export const iqRecorder = new IqRecorder();
