// SPDX-License-Identifier: Apache-2.0
//
// Physical hardware test: drives a real FL2000 through the app's own driver
// (fl2k-device.js + the Emscripten runtime) over node-usb, and, if an RTL-SDR
// is attached, receives the transmission to prove RF actually comes out.
//
// THIS TRANSMITS. Cable the FL2K red output through an attenuator into the
// RTL-SDR (as in docs/hardware-e2e.md); do not connect an antenna.
//
// Run: npm run test:hardware        (skips if no FL2K is attached)

import assert from "node:assert/strict";
import path from "node:path";
import { allowProtectedUsb, nodeWebUsb } from "./lib/node-webusb.mjs";

const root = path.resolve(import.meta.dirname, "..");
allowProtectedUsb();
const { Fl2kDevice, FL2K_SAMPLES } = await import(path.join(root, "app/fl2k-device.js"));
const { prepareTx, validateTx, txSample } = await import(path.join(root, "app/tx-signal.js"));

const usb = nodeWebUsb();
if (!usb) {
  console.error("SKIP: the `usb` package is not installed. Run `npm install`.");
  process.exit(0);
}
const attached = await usb.getDevices();
const fl2kUsb = attached.find((d) => d.vendorId === 0x1d5c && d.productId === 0x2000);
const rtlUsb = attached.find((d) => d.vendorId === 0x0bda && [0x2832, 0x2838].includes(d.productId));
if (!fl2kUsb) {
  console.error("SKIP: no FL2000 (1d5c:2000) attached.");
  process.exit(0);
}

let passed = 0;
let failed = 0;
let skipped = 0;

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

const driver = new Fl2kDevice(usb);
driver.addEventListener("status", (event) => { if (process.env.VERBOSE) console.log(`        fl2k: ${event.detail.message}`); });

async function connect(rate) {
  if (!driver.connected) await driver.open((await driver.scan())[0]);
  await driver.setSampleRate(rate);
}

// Samples for `count` DAC samples of a TX panel waveform at the actual rate.
function waveform(overrides, count) {
  const settings = prepareTx({ mode: "CW", carrier: 1e6, rate: driver.actualRate, tone: 1000, depth: 0.8, deviation: 5000, level: 0.8, duration: count / driver.actualRate, bitrate: 1200, bits: "1010101000110011", ...overrides });
  validateTx(settings);
  return Int8Array.from({ length: count }, (_, i) => txSample(settings, i));
}

console.log("FL2K hardware tests (real device, real driver)\n");
console.log("--- FL2K ---\n");

await test("open claims the real adapter's interface 0, alternate 1", async () => {
  await driver.open((await driver.scan())[0]);
  const iface = driver.transport.device.configuration.interfaces[0];
  assert.ok(iface.claimed);
  assert.equal(iface.alternate.alternateSetting, 1);
  assert.ok(driver.connected);
});

for (const rate of [20e6, 100e6]) {
  await test(`PLL locks to ${rate / 1e6} MS/s`, async () => {
    await connect(rate);
    assert.ok(Math.abs(driver.actualRate - rate) / rate < 0.005, `actual ${driver.actualRate}`);
  });
}

await test("register read over USB control transfers", async () => {
  await connect(20e6);
  assert.equal(typeof await driver.register(0x8004), "number");
});

await test("0.5 s at 20 MS/s streams in real time and closes USB", async () => {
  await connect(20e6);
  const samples = waveform({ mode: "CW" }, 10e6);
  let stats;
  driver.addEventListener("progress", (event) => { stats = event.detail; });
  await driver.startTx({ red: samples, signed: true, queueDepth: 2 });
  const throughput = stats.bytes / 3 / (stats.elapsed / 1000);
  console.log(`        ${stats.transfers} blocks, ${(throughput / 1e6).toFixed(2)} MS/s USB throughput`);
  assert.ok(throughput >= 19e6, `throughput ${(throughput / 1e6).toFixed(2)} MS/s`);
  assert.equal(driver.connected, false);
});

await test("repeat TX stops on request within 1 s", async () => {
  await connect(20e6);
  const stream = driver.startTx({ red: waveform({}, FL2K_SAMPLES), signed: true, repeat: true, queueDepth: 2 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const started = performance.now();
  await driver.stop();
  await stream.catch(() => {});
  assert.ok(performance.now() - started < 1000);
  assert.equal(driver.running, false);
});

// ==========================================================================
console.log("\n--- RF loopback into the RTL-SDR ---\n");

if (!rtlUsb) {
  console.log("  SKIP  no RTL-SDR attached");
  skipped++;
} else {
  const { RTL2832U } = await import(path.join(root, "dist/rtlsdr/rtl2832u.js"));
  const RX_RATE = 1024000;
  // At most 80 MS/s: above that the test adapter intermittently starts with a
  // silent DAC (see the high-rate check at the end).
  let TX_RATE = 80e6;
  let CENTER = 30e6;
  let CARRIER = 30.2e6;
  const N = 4096;
  await rtlUsb.open();
  const rtl = await RTL2832U.open(rtlUsb);
  await rtl.setSampleRate(RX_RATE);
  await rtl.setCenterFrequency(CENTER);
  await rtl.setGain(Number(process.env.RTL_GAIN ?? 20));

  function spectrum(iq) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      re[i] = (iq[2 * i] - 127.5) * w;
      im[i] = (iq[2 * i + 1] - 127.5) * w;
    }
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const angle = (-2 * Math.PI) / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const c = Math.cos(angle * k);
          const s = Math.sin(angle * k);
          const a = i + k;
          const b = a + len / 2;
          const xr = re[b] * c - im[b] * s;
          const xi = re[b] * s + im[b] * c;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
    const power = new Float64Array(N);
    for (let i = 0; i < N; i++) power[(i + N / 2) % N] = re[i] ** 2 + im[i] ** 2;
    return power;
  }

  const BIN = RX_RATE / N;
  // Where the carrier actually lands: FL2K and RTL-SDR clock errors add up.
  let ppm = 0;
  const offset = () => (CARRIER * ppm) / 1e6;

  // Strongest bin within ±halfWidth Hz of the carrier, in dB over the median bin.
  async function measure(halfWidth) {
    await rtl.resetBuffer();
    await rtl.readSamples(N * 4);
    const sum = new Float64Array(N);
    for (let block = 0; block < 16; block++) {
      const power = spectrum(new Uint8Array((await rtl.readSamples(N)).data));
      for (let i = 0; i < N; i++) sum[i] += power[i];
    }
    const center = Math.round(N / 2 + (CARRIER + offset() - CENTER) / BIN);
    const half = Math.max(2, Math.round(halfWidth / BIN));
    let peak = center;
    for (let i = center - half; i <= center + half; i++) if (sum[i] > sum[peak]) peak = i;
    const floor = [...sum].sort((a, b) => a - b)[N >> 1];
    return { db: 10 * Math.log10(sum[peak] / floor), hz: CENTER + (peak - N / 2) * BIN };
  }

  async function onAir(overrides, halfWidth) {
    await connect(TX_RATE);
    // 1.28 M samples: whole carrier and 1 kHz tone cycles at 80 MS/s, whole carrier cycles at 100 MS/s.
    let error;
    let transfers = 0;
    const count = () => transfers++;
    driver.addEventListener("progress", count);
    const stream = driver.startTx({ red: waveform({ carrier: CARRIER, ...overrides }, 1280000), signed: true, repeat: true, queueDepth: 4 }).catch((e) => { error = e; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      if (error || !driver.running) throw new Error(`FL2K stream not running after 300 ms: ${error?.message ?? "stopped"}`);
      const before = transfers;
      const result = await measure(halfWidth);
      if (error || transfers - before < 3) throw new Error(`FL2K stream stalled during measurement (${transfers - before} blocks): ${error?.message ?? "no error"}`);
      return result;
    } finally {
      driver.removeEventListener("progress", count);
      await driver.stop();
      await stream;
    }
  }

  const MAX_PPM = Number(process.env.MAX_PPM ?? 300);
  const mhz = () => (CARRIER / 1e6).toFixed(1);
  await test(`CW ${mhz()} MHz at ${TX_RATE / 1e6} MS/s is found within ${MAX_PPM} ppm`, async () => {
    const found = await onAir({ mode: "CW" }, (CARRIER * MAX_PPM) / 1e6);
    ppm = ((found.hz - CARRIER) / CARRIER) * 1e6;
    console.log(`        carrier at ${(found.hz / 1e6).toFixed(4)} MHz: ${offset() >= 0 ? "+" : ""}${offset().toFixed(0)} Hz (${ppm.toFixed(0)} ppm, FL2K + RTL-SDR clocks), ${found.db.toFixed(1)} dB`);
    assert.ok(found.db >= 20, `strongest bin only ${found.db.toFixed(1)} dB over the floor`);
  });

  await test("CW: rises ≥12 dB on air and falls ≥8 dB after stop", async () => {
    const before = (await measure(500)).db;
    const during = (await onAir({ mode: "CW" }, 500)).db;
    const after = (await measure(500)).db;
    console.log(`        before ${before.toFixed(1)} dB, on air ${during.toFixed(1)} dB, after ${after.toFixed(1)} dB`);
    assert.ok(during - before >= 12, `rise ${(during - before).toFixed(1)} dB`);
    assert.ok(during - after >= 8, `fall ${(during - after).toFixed(1)} dB`);
  });

  const STARTS = Number(process.env.STARTS ?? 20);
  await test(`${STARTS} consecutive starts all put out RF (dead DAC starts are restarted)`, async () => {
    let restarts = 0;
    const count = (event) => { if (event.detail.message.startsWith("FL2K DAC output did not start")) restarts++; };
    driver.addEventListener("status", count);
    const levels = [];
    try {
      for (let i = 0; i < STARTS; i++) levels.push((await onAir({ mode: "CW" }, 500)).db);
    } finally { driver.removeEventListener("status", count); }
    console.log(`        ${levels.map((db) => db.toFixed(0)).join(" ")} dB; ${restarts} automatic restart(s)`);
    const silent = levels.filter((db) => db < 20).length;
    assert.equal(silent, 0, `${silent} of ${STARTS} starts put out no carrier`);
  });

  for (const [mode, halfWidth] of [["AM", 2000], ["FM", 8000], ["OOK", 2000], ["2-FSK", 8000]]) {
    await test(`${mode} ${mhz()} MHz is received ≥10 dB over the idle band`, async () => {
      const idle = (await measure(halfWidth)).db;
      const during = (await onAir({ mode }, halfWidth)).db;
      console.log(`        idle ${idle.toFixed(1)} dB, on air ${during.toFixed(1)} dB`);
      assert.ok(during - idle >= 10, `rise ${(during - idle).toFixed(1)} dB`);
    });
  }

  // ------------------------------------------------------------------------
  console.log("\n--- Record & replay loopback ---\n");

  const { IqRecorder, renderReplay } = await import(path.join(root, "app/iq-replay.js"));
  const BITS = "1010101000110011";
  const BITRATE = 1200;

  async function captureIq(seconds) {
    await rtl.resetBuffer();
    await rtl.readSamples(N * 4);
    const out = new Uint8Array(2 * Math.round(seconds * RX_RATE));
    for (let at = 0; at < out.length;) {
      const bytes = new Uint8Array((await rtl.readSamples(16384)).data);
      out.set(bytes.subarray(0, out.length - at), at);
      at += bytes.length;
    }
    return out;
  }
  // On/off pattern of the signal at `offset` Hz: magnitude averaged per 1/16 bit, thresholded.
  function keying(iq, offset) {
    const per = Math.round(RX_RATE / BITRATE / 16);
    const levels = [];
    for (let start = 0; start + per <= iq.length / 2; start += per) {
      let re = 0;
      let im = 0;
      for (let n = start; n < start + per; n++) {
        const phase = (-2 * Math.PI * offset * n) / RX_RATE;
        const i = iq[2 * n] - 127.5;
        const q = iq[2 * n + 1] - 127.5;
        re += i * Math.cos(phase) - q * Math.sin(phase);
        im += i * Math.sin(phase) + q * Math.cos(phase);
      }
      levels.push(Math.hypot(re, im));
    }
    const threshold = (Math.max(...levels) + Math.min(...levels)) / 2;
    return levels.map((level) => (level > threshold ? 1 : -1));
  }
  // Normalized correlation of the keying with itself `bits` bits later.
  function correlation(keyed, bits) {
    const lag = Math.round(bits * 16);
    let sum = 0;
    for (let i = 0; i + lag < keyed.length; i++) sum += keyed[i] * keyed[i + lag];
    return sum / (keyed.length - lag);
  }
  // Strongest bin within ±20 kHz of `near` (Hz from the RX center).
  function peakOffset(iq, near) {
    const sum = new Float64Array(N);
    for (let start = 0; start + N <= iq.length / 2; start += N) {
      const power = spectrum(iq.subarray(2 * start, 2 * (start + N)));
      for (let i = 0; i < N; i++) sum[i] += power[i];
    }
    const center = Math.round(N / 2 + near / BIN);
    let peak = center;
    for (let i = center - Math.round(20000 / BIN); i <= center + Math.round(20000 / BIN); i++) if (sum[i] > sum[peak]) peak = i;
    return (peak - N / 2) * BIN;
  }
  function describeKeying(label, keyed) {
    const on = keyed.filter((v) => v > 0).length / keyed.length;
    const repeat = correlation(keyed, BITS.length);
    const shifted = correlation(keyed, 1);
    console.log(`        ${label}: on ${(on * 100).toFixed(0)}% of the time, pattern repeats every ${BITS.length} bits with r=${repeat.toFixed(2)} (1 bit later r=${shifted.toFixed(2)})`);
    return { on, repeat, shifted };
  }

  let recording;
  await test("RTL-SDR records the FL2K's OOK transmission as IQ", async () => {
    await connect(TX_RATE);
    // 9.6 M samples at 80 MS/s are exactly 9 repetitions of the 16-bit pattern, so the loop is seamless.
    const stream = driver.startTx({ red: waveform({ mode: "OOK", carrier: CARRIER, bits: BITS, bitrate: BITRATE }, 9600000), signed: true, repeat: true, queueDepth: 4 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(driver.running, "FL2K is transmitting");
      const recorder = new IqRecorder();
      recorder.setSampleRate(RX_RATE);
      recorder.receiveSamples({ I: new Float32Array(0), Q: new Float32Array(0), frequency: CENTER });
      recorder.start(0.25);
      const iq = await captureIq(0.25);
      for (let at = 0; at < iq.length; at += 16384) {
        const chunk = iq.subarray(at, at + 16384);
        const I = new Float32Array(chunk.length / 2);
        const Q = new Float32Array(chunk.length / 2);
        for (let i = 0; i < I.length; i++) { I[i] = chunk[2 * i] / 128 - 0.995; Q[i] = chunk[2 * i + 1] / 128 - 0.995; }
        recorder.receiveSamples({ I, Q, frequency: CENTER });
      }
      recording = recorder.recording;
    } finally {
      await driver.stop();
      await stream.catch(() => {});
    }
    assert.ok(recording && Math.abs(recording.iq.length / 2 / RX_RATE - 0.25) < 1e-3, "0.25 s recorded");
    const keyed = describeKeying("recorded", keying(recording.iq, peakOffset(recording.iq, CARRIER - CENTER + offset())));
    assert.ok(keyed.repeat > 0.6 && keyed.repeat - keyed.shifted > 0.5, "the recording holds the bit pattern");
  });

  await test("replaying the recording on the red DAC reproduces the bit pattern on air", async () => {
    assert.ok(recording, "needs the previous recording");
    const idle = await captureIq(0.2);
    await connect(TX_RATE);
    const samples = await renderReplay(recording, { carrier: recording.frequency, dacRate: driver.actualRate, level: 0.8 });
    const stream = driver.startTx({ red: samples, signed: true, repeat: true, queueDepth: 4 });
    let replayed;
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(driver.running, "FL2K is transmitting the replay");
      replayed = await captureIq(0.2);
    } finally {
      await driver.stop();
      await stream.catch(() => {});
    }
    const where = peakOffset(replayed, CARRIER - CENTER + offset());
    const power = (iq) => {
      const sum = new Float64Array(N);
      for (let s = 0; s + N <= iq.length / 2; s += N) { const p = spectrum(iq.subarray(2 * s, 2 * (s + N))); for (let i = 0; i < N; i++) sum[i] += p[i]; }
      return sum[Math.round(N / 2 + where / BIN)] / [...sum].sort((a, b) => a - b)[N >> 1];
    };
    const rise = 10 * Math.log10(power(replayed) / power(idle));
    console.log(`        replay received at ${((CENTER + where) / 1e6).toFixed(4)} MHz, ${rise.toFixed(1)} dB over idle`);
    assert.ok(rise >= 20, `replay only ${rise.toFixed(1)} dB over idle`);
    const keyed = describeKeying("replayed", keying(replayed, where));
    assert.ok(keyed.repeat > 0.6 && keyed.repeat - keyed.shifted > 0.5, "the replay holds the bit pattern");
    assert.ok(Math.abs(keyed.on - 0.5) < 0.15, `OOK duty ${(keyed.on * 100).toFixed(0)}%, expected ~50%`);
  });

  // ------------------------------------------------------------------------
  console.log("\n--- High DAC rate (informational) ---\n");

  // Above ~80 MS/s the test adapter sometimes streams with a silent DAC, and
  // the rate rises the longer it has been transmitting. Report it, don't fail.
  TX_RATE = 100e6;
  CENTER = 40e6;
  CARRIER = 40.2e6;
  await rtl.setCenterFrequency(CENTER);
  const HIGH_STARTS = Number(process.env.HIGH_STARTS ?? 10);
  let restarts = 0;
  const countRestarts = (event) => { if (event.detail.message.startsWith("FL2K DAC output did not start")) restarts++; };
  driver.addEventListener("status", countRestarts);
  const levels = [];
  for (let i = 0; i < HIGH_STARTS; i++) levels.push((await onAir({ mode: "CW" }, 500)).db);
  driver.removeEventListener("status", countRestarts);
  const silent = levels.filter((db) => db < 20).length;
  console.log(`        ${levels.map((db) => db.toFixed(0)).join(" ")} dB; ${restarts} automatic restart(s)`);
  console.log(`  ${silent ? "WARN" : "INFO"}  CW ${mhz()} MHz at ${TX_RATE / 1e6} MS/s: ${silent} of ${HIGH_STARTS} starts put out no carrier${silent ? " (adapter limit; keep the DAC at or below 80 MS/s)" : ""}`);

  await rtl.close();
}

await driver.dispose();
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed > 0 ? 1 : 0);
