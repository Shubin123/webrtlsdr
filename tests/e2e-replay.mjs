// SPDX-License-Identifier: Apache-2.0
//
// End-to-end tests for IQ record & replay without hardware: the recorder as a
// Radio sample receiver, .cu8/.cs8 files, the replay renderer's spectrum, and
// replay through Fl2kDevice + the real Wasm driver into a mock FL2000.
// The physical loopback is in tests/hw-fl2k-loopback.mjs.
//
// Run: node tests/e2e-replay.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { mockFl2k, mockUsb, unpackRed } from "./lib/mock-fl2k.mjs";
import { allowProtectedUsb } from "./lib/node-webusb.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { IqRecorder, duration, parseRecording, recordingFileName, renderReplay, replayLength, replayProblem, MAX_REPLAY_SAMPLES } = await import(path.join(root, "app/iq-replay.js"));
const { Fl2kDevice, FL2K_SAMPLES } = await import(path.join(root, "app/fl2k-device.js"));

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

// What the Radio hands its receivers: floats from the RTL's u8 (converters.js).
function block(u8, frequency) {
  const n = u8.length / 2;
  const I = new Float32Array(n);
  const Q = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    I[i] = u8[2 * i] / 128 - 0.995;
    Q[i] = u8[2 * i + 1] / 128 - 0.995;
  }
  return { I, Q, frequency };
}
const randomU8 = (n) => Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256));
function receiving(rate = 1024000) {
  const recorder = new IqRecorder();
  recorder.setSampleRate(rate);
  recorder.receiveSamples(block(new Uint8Array(2), 100e6));
  return recorder;
}
// Complex tone at `offset` Hz in u8 IQ, as an RTL would deliver it.
function toneIq(offset, rate, count, amplitude = 100) {
  const iq = new Uint8Array(count * 2);
  for (let n = 0; n < count; n++) {
    iq[2 * n] = Math.round(127.5 + amplitude * Math.cos((2 * Math.PI * offset * n) / rate));
    iq[2 * n + 1] = Math.round(127.5 + amplitude * Math.sin((2 * Math.PI * offset * n) / rate));
  }
  return iq;
}
function goertzel(samples, frequency, rate) {
  let re = 0;
  let im = 0;
  for (let n = 0; n < samples.length; n++) {
    const phase = (2 * Math.PI * frequency * n) / rate;
    re += samples[n] * Math.cos(phase);
    im -= samples[n] * Math.sin(phase);
  }
  return Math.hypot(re, im) / samples.length;
}

console.log("Record & replay E2E tests\n");

// ==========================================================================
console.log("--- Recording ---\n");

await test("recording needs RX running", () => {
  const recorder = new IqRecorder();
  recorder.setSampleRate(1024000);
  assert.throws(() => recorder.start(1), /Start RX/);
});

await test("recording keeps the RTL's bytes exactly", () => {
  const recorder = receiving();
  recorder.start(0.01);
  const sent = randomU8(2 * 10240);
  for (let i = 0; i < sent.length; i += 4096) recorder.receiveSamples(block(sent.subarray(i, i + 4096), 433.92e6));
  assert.equal(recorder.capture, null, "stops by itself when full");
  assert.deepEqual(recorder.recording.iq, sent.subarray(0, 2 * 10240));
  assert.equal(recorder.recording.frequency, 433.92e6);
  assert.equal(recorder.recording.sampleRate, 1024000);
  assert.ok(Math.abs(duration(recorder.recording) - 0.01) < 1e-9);
});

await test("stopping early keeps what was captured", () => {
  const recorder = receiving();
  recorder.start(5);
  recorder.receiveSamples(block(randomU8(2000), 100e6));
  assert.ok(Math.abs(recorder.progress() - 1000 / 1024000) < 1e-9);
  recorder.stop();
  assert.equal(recorder.recording.iq.length, 2000);
});

await test("retuning RX ends the recording and says why", () => {
  const recorder = receiving();
  let reason;
  recorder.addEventListener("change", (event) => { reason = event.detail?.reason; });
  recorder.start(5);
  recorder.receiveSamples(block(randomU8(2000), 100e6));
  recorder.receiveSamples(block(randomU8(2000), 101e6));
  assert.equal(recorder.capture, null);
  assert.equal(recorder.recording.iq.length, 2000);
  assert.equal(reason, "RX frequency changed");
});

await test("changing the RX sample rate ends the recording", () => {
  const recorder = receiving();
  recorder.start(5);
  recorder.receiveSamples(block(randomU8(2000), 100e6));
  recorder.setSampleRate(2048000);
  assert.equal(recorder.capture, null);
  assert.equal(recorder.recording.sampleRate, 1024000);
});

await test("a new recording replaces the previous one only once it has samples", () => {
  const recorder = receiving();
  recorder.start(5);
  recorder.receiveSamples(block(randomU8(2000), 100e6));
  recorder.stop();
  const first = recorder.recording;
  recorder.start(5);
  recorder.stop();
  assert.equal(recorder.recording, first);
});

await test("recording length is limited to 10 s", () => {
  assert.throws(() => receiving().start(11), /0\.1–10 seconds/);
});

// ==========================================================================
console.log("\n--- Files ---\n");

await test("saved file name round-trips frequency and sample rate", () => {
  const recording = { iq: randomU8(100), sampleRate: 2048000, frequency: 433920000, recordedAt: new Date("2026-11-03T10:15:00Z") };
  const name = recordingFileName(recording);
  assert.equal(name, "iq_433920000Hz_2048000sps_20261103-101500.cu8");
  const loaded = parseRecording(name, recording.iq, { sampleRate: 1, frequency: 1 });
  assert.equal(loaded.frequency, 433920000);
  assert.equal(loaded.sampleRate, 2048000);
  assert.equal(loaded.guessed, false);
  assert.deepEqual(loaded.iq, recording.iq);
});

await test("rtl_433 file names are understood", () => {
  const loaded = parseRecording("g001_433.92M_250k.cu8", randomU8(10), { sampleRate: 1, frequency: 1 });
  assert.equal(loaded.frequency, 433.92e6);
  assert.equal(loaded.sampleRate, 250e3);
});

await test("HackRF .cs8 files are converted to unsigned", () => {
  const loaded = parseRecording("capture_40MHz_2Msps.cs8", Uint8Array.from([0, 127, 128, 255]), { sampleRate: 1, frequency: 1 });
  assert.deepEqual([...loaded.iq], [128, 255, 0, 127]);
  assert.equal(loaded.frequency, 40e6);
  assert.equal(loaded.sampleRate, 2e6);
});

await test("unknown names fall back to RX settings and say so", () => {
  const loaded = parseRecording("capture.cu8", randomU8(10), { sampleRate: 1024000, frequency: 97.7e6 });
  assert.equal(loaded.sampleRate, 1024000);
  assert.equal(loaded.frequency, 97.7e6);
  assert.equal(loaded.guessed, true);
});

await test("other formats are refused", () => {
  assert.throws(() => parseRecording("audio.wav", randomU8(10), { sampleRate: 1024000, frequency: 1e6 }), /\.cu8/);
  assert.throws(() => parseRecording("x.cu8", new Uint8Array(1), { sampleRate: 1024000, frequency: 1e6 }), /2 bytes/);
});

// ==========================================================================
console.log("\n--- Replay rendering ---\n");

const rate = 1024000;
const recording = { iq: toneIq(100e3, rate, 10240), sampleRate: rate, frequency: 433.92e6, recordedAt: new Date() };

await test("replay must fit between 0 Hz and the DAC's Nyquist limit", () => {
  assert.match(replayProblem(recording, { carrier: 0.4e6, dacRate: 20e6, level: 0.5 }), /0\.512 MHz or higher/);
  assert.match(replayProblem(recording, { carrier: 9.8e6, dacRate: 20e6, level: 0.5 }), /DAC rate above 20\.6 MS\/s/);
  assert.equal(replayProblem(recording, { carrier: 5e6, dacRate: 20e6, level: 0.5 }), "");
  assert.match(replayProblem(null, { carrier: 5e6, dacRate: 20e6, level: 0.5 }), /Record or load/);
});

await test("a tone recorded at +100 kHz replays at carrier +100 kHz, not its mirror", async () => {
  const dacRate = 20e6;
  const samples = await renderReplay(recording, { carrier: 5e6, dacRate, level: 1 });
  const window = samples.subarray(0, 200000);
  const upper = goertzel(window, 5.1e6, dacRate);
  const lower = goertzel(window, 4.9e6, dacRate);
  const carrier = goertzel(window, 5e6, dacRate);
  assert.ok(upper > 40, `upper ${upper}`);
  assert.ok(upper / lower > 30, `image only ${(20 * Math.log10(upper / lower)).toFixed(1)} dB down`);
  assert.ok(upper / carrier > 30, `carrier leak ${(20 * Math.log10(upper / carrier)).toFixed(1)} dB down`);
});

await test("replay scales the recording's peak to the output level", async () => {
  const full = await renderReplay(recording, { carrier: 5e6, dacRate: 20e6, level: 1 });
  const half = await renderReplay(recording, { carrier: 5e6, dacRate: 20e6, level: 0.5 });
  const peak = (s) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak(full) >= 125 && peak(full) <= 127, `full ${peak(full)}`);
  assert.ok(Math.abs(peak(half) - 63) <= 2, `half ${peak(half)}`);
});

await test("replay keeps the recording's timing", async () => {
  // 2 ms of carrier, 2 ms of silence, repeated: OOK as an RTL would record it.
  const count = 20480;
  const iq = new Uint8Array(count * 2).fill(128);
  for (let n = 0; n < count; n++) if (Math.floor(n / 2048) % 2 === 0) iq[2 * n] = 228;
  const samples = await renderReplay({ iq, sampleRate: rate, frequency: 1e6, recordedAt: new Date() }, { carrier: 2e6, dacRate: 20e6, level: 1 });
  assert.equal(samples.length, 400000);
  const on = (ms) => samples.subarray(ms * 20000, ms * 20000 + 1000).some((v) => Math.abs(v) > 60);
  assert.deepEqual([0.5, 1.5, 2.5, 3.5, 4.5, 6.5, 8.5].map(on), [true, true, false, false, true, false, true]);
});

await test("long recordings are cut to what one FL2K buffer holds", () => {
  const long = { iq: new Uint8Array(2 * rate * 2), sampleRate: rate, frequency: 1e6 };
  const length = replayLength(long, 100e6);
  assert.equal(length.samples, MAX_REPLAY_SAMPLES);
  assert.ok(length.truncated);
  assert.ok(Math.abs(length.seconds - 0.32) < 1e-9);
  assert.equal(replayLength(long, 8e6).truncated, false);
});

await test("replay preparation can be canceled", async () => {
  await assert.rejects(renderReplay(recording, { carrier: 5e6, dacRate: 20e6, level: 1 }, () => true), /canceled/);
});

// ==========================================================================
console.log("\n--- Replay through the FL2K driver (mock FL2000, red DAC) ---\n");

allowProtectedUsb();

await test("record → replay → the FL2K's red DAC receives the replayed samples", async () => {
  const recorder = receiving();
  recorder.start(0.05);
  const iq = toneIq(-50e3, rate, 51200);
  for (let i = 0; i < iq.length; i += 8192) recorder.receiveSamples(block(iq.subarray(i, i + 8192), 7.1e6));
  const device = mockFl2k();
  const driver = new Fl2kDevice(mockUsb([device]));
  await driver.scan();
  await driver.open(device);
  await driver.setSampleRate(40e6);
  const samples = await renderReplay(recorder.recording, { carrier: recorder.recording.frequency, dacRate: driver.actualRate, level: 0.8 });
  assert.equal(samples.length, 2000000);
  await driver.startTx({ red: samples, signed: true });
  const red = new Int8Array(device.bulk.length * FL2K_SAMPLES);
  device.bulk.forEach((bytes, index) => red.set(unpackRed(bytes), index * FL2K_SAMPLES));
  assert.deepEqual(red.subarray(0, samples.length), samples);
  const tone = goertzel(red.subarray(0, 400000), 7.05e6, 40e6);
  const image = goertzel(red.subarray(0, 400000), 7.15e6, 40e6);
  assert.ok(tone / image > 30, "recorded −50 kHz tone replays at 7.05 MHz");
  await driver.dispose();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
