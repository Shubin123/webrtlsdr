// SPDX-License-Identifier: Apache-2.0
//
// End-to-end transmission tests without hardware: every modulation mode, the
// playbooks, and the real Emscripten FL2K driver (app/fl2k/runtime.js) driven
// through Fl2kDevice against a mock FL2000 that records the bytes it receives.
// For the physical FL2K + RTL-SDR loopback, see tests/hw-fl2k-loopback.mjs.
//
// Run: node tests/e2e-transmission.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { mockFl2k, mockUsb, unpackRed } from "./lib/mock-fl2k.mjs";
import { allowProtectedUsb } from "./lib/node-webusb.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { prepareTx, validateTx, txSample } = await import(path.join(root, "app/tx-signal.js"));
const { playbooks } = await import(path.join(root, "app/tx-playbooks.js"));
const { FL2K_SAMPLES, FL2K_BYTES, Fl2kDevice, inspectFl2k } = await import(path.join(root, "app/fl2k-device.js"));

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

const base = { mode: "CW", carrier: 1e6, rate: 20e6, tone: 1000, depth: 0.8, deviation: 5000, level: 0.5, duration: 0.1, bitrate: 1200, bits: "10101010" };
const config = (overrides) => prepareTx({ ...base, ...overrides });
const render = (settings, count) => Int8Array.from({ length: count }, (_, i) => txSample(settings, i));
const crossings = (settings, start, length) => {
  let count = 0;
  let previous = txSample(settings, start);
  for (let i = start + 1; i < start + length; i++) {
    const sample = txSample(settings, i);
    if ((previous >= 0) !== (sample >= 0)) count++;
    previous = sample;
  }
  return count;
};
// Smallest and largest half-cycle peak, to compare envelope flatness.
function envelope(settings, count) {
  const half = Math.round(settings.rate / settings.carrier / 2);
  let low = Infinity;
  let high = 0;
  for (let start = 0; start + half <= count; start += half) {
    let peak = 0;
    for (let i = start; i < start + half; i++) peak = Math.max(peak, Math.abs(txSample(settings, i)));
    low = Math.min(low, peak);
    high = Math.max(high, peak);
  }
  return { low, high };
}

console.log("Transmission E2E tests (mock FL2000, real Wasm driver)\n");

// ==========================================================================
console.log("--- Signal generation ---\n");

for (const mode of ["CW", "AM", "FM", "OOK", "2-FSK"]) {
  await test(`${mode}: valid at 1 MHz / 20 MS/s and within signed 8-bit range`, () => {
    const settings = config({ mode, level: 1 });
    validateTx(settings);
    for (const sample of render(settings, 40000)) assert.ok(sample >= -127 && sample <= 127, `sample ${sample}`);
  });
}

await test("CW: zero crossings match the carrier frequency", () => {
  const settings = config({ carrier: 1e6, rate: 40e6 });
  const ratio = crossings(settings, 0, 40000) / (2 * 1e6 * 0.001);
  assert.ok(ratio > 0.99 && ratio < 1.01, `ratio ${ratio}`);
});

await test("CW: level 0 is silent", () => {
  for (const sample of render(config({ level: 0 }), 2000)) assert.equal(Math.abs(sample), 0);
});

await test("CW: peak amplitude follows level", () => {
  const peak = (level) => Math.max(...render(config({ level }), 2000).map(Math.abs));
  assert.equal(peak(1), 127);
  assert.ok(Math.abs(peak(0.5) - 64) <= 1, `0.5 → ${peak(0.5)}`);
});

await test("AM: envelope swings with the tone, nulls at 100% depth", () => {
  const partial = envelope(config({ mode: "AM", depth: 0.5, level: 1 }), 40000);
  assert.ok(partial.low > 30 && partial.low < partial.high * 0.5, `${partial.low}/${partial.high}`);
  const full = envelope(config({ mode: "AM", depth: 1, level: 1 }), 40000);
  assert.ok(full.low <= 2, `100% depth minimum ${full.low}`);
});

await test("FM: constant envelope", () => {
  const { low, high } = envelope(config({ mode: "FM", carrier: 5e6, rate: 40e6, level: 0.7 }), 40000);
  assert.ok(low / high > 0.85, `${low}/${high}`);
});

await test("FM: frequency is carrier+deviation at tone peak, carrier−deviation at trough", () => {
  const settings = config({ mode: "FM", carrier: 5e6, rate: 80e6, deviation: 50000, level: 0.8 });
  const window = 4000;
  const high = crossings(settings, 0, window);
  const low = crossings(settings, settings.rate / settings.tone / 2 - window / 2, window);
  assert.ok(high - low >= 6, `crossings ${high} vs ${low}`);
});

await test("OOK: '1' bits carry the carrier, '0' bits are silent", () => {
  const settings = config({ mode: "OOK", bits: "10" });
  const perBit = settings.rate / settings.bitrate;
  const peakIn = (bit) => {
    let peak = 0;
    for (let i = Math.ceil(bit * perBit) + 10; i < (bit + 1) * perBit - 10; i++) peak = Math.max(peak, Math.abs(txSample(settings, i)));
    return peak;
  };
  assert.ok(peakIn(0) > 50, `bit 0 ('1') peak ${peakIn(0)}`);
  assert.equal(peakIn(1), 0);
  assert.ok(peakIn(2) > 50);
});

await test("2-FSK: constant envelope and continuous phase across bits", () => {
  const settings = config({ mode: "2-FSK", bitrate: 4800, bits: "11001100", level: 0.6 });
  const { low, high } = envelope(settings, 20000);
  assert.ok(low / high > 0.85, `${low}/${high}`);
  // At 20 samples per carrier cycle a sine moves at most ~0.32 of full scale per sample.
  const samples = render(settings, 50000);
  for (let i = 1; i < samples.length; i++) assert.ok(Math.abs(samples[i] - samples[i - 1]) <= 26, `jump at ${i}`);
});

await test("prepareTx builds the 2-FSK phase accumulator", () => {
  assert.deepEqual(prepareTx({ ...base, bits: "1100" }).prefix, [0, 1, 2, 1, 0]);
});

// ==========================================================================
console.log("\n--- Validation ---\n");

for (const [label, overrides, pattern] of [
  ["rate below 8 MS/s", { rate: 1e6 }, /rate/],
  ["rate above 160 MS/s", { rate: 200e6 }, /rate/],
  ["carrier below 1 kHz", { carrier: 500 }, /carrier/],
  ["carrier above Nyquist", { carrier: 25e6, rate: 40e6 }, /Nyquist/],
  ["more than 32 M samples", { rate: 160e6, duration: 1 }, /32 million/],
  ["unknown modulation", { mode: "PSK" }, /modulation/],
  ["OOK without bits", { mode: "OOK", bits: "" }, /binary pattern/],
  ["OOK non-binary bits", { mode: "OOK", bits: "1021" }, /binary pattern/],
  ["2-FSK with bitrate 0", { mode: "2-FSK", bitrate: 0 }, /binary pattern/],
]) {
  await test(`validateTx rejects ${label}`, () => assert.throws(() => validateTx(config(overrides)), pattern));
}

await test("validateTx accepts the lower limits", () => {
  validateTx(config({ carrier: 1000, rate: 8e6, tone: 20, depth: 0, deviation: 100, level: 0, duration: 0.01 }));
});

// ==========================================================================
console.log("\n--- Playbooks ---\n");

for (const playbook of playbooks) {
  const reference = playbook.notes.startsWith("REFERENCE ONLY");
  await test(`${playbook.name}: ${reference ? "stays out of FL2K range" : "validates"}`, () => {
    if (reference) assert.throws(() => validateTx(prepareTx(playbook.settings)), /Nyquist/);
    else validateTx(prepareTx(playbook.settings));
  });
}

await test("playbook names are unique", () => {
  assert.equal(new Set(playbooks.map((p) => p.name)).size, playbooks.length);
});

// ==========================================================================
console.log("\n--- Device access ---\n");

allowProtectedUsb();

async function connected(device = mockFl2k(), rate = 20e6) {
  const usb = mockUsb([device]);
  const driver = new Fl2kDevice(usb);
  const statuses = [];
  driver.addEventListener("status", (event) => statuses.push(event.detail.message));
  await driver.scan();
  await driver.open(device);
  if (rate) await driver.setSampleRate(rate);
  return { driver, device, usb, statuses };
}

await test("scan lists only FL2000 adapters", async () => {
  const other = { ...mockFl2k(), vendorId: 0x0bda, productId: 0x2838 };
  const driver = new Fl2kDevice(mockUsb([other, mockFl2k()]));
  assert.equal((await driver.scan()).length, 1);
  await driver.dispose();
});

await test("open claims interface 0, alternate 1 (bulk OUT endpoint 1)", async () => {
  const { driver, device, statuses } = await connected(undefined, 0);
  const iface = device.configuration.interfaces[0];
  assert.ok(iface.claimed);
  assert.equal(iface.alternate.alternateSetting, 1);
  assert.ok(driver.connected);
  assert.ok(statuses.some((s) => s.startsWith("Connected: FL2000DX")));
  assert.ok(device.controlLog.length > 0, "driver initialized device registers");
  await driver.dispose();
});

await test("open rejects a non-FL2K device", async () => {
  const driver = new Fl2kDevice(mockUsb([]));
  await assert.rejects(driver.open({ ...mockFl2k(), vendorId: 0x1234 }), /FL2000DX/);
  await driver.dispose();
});

await test("open rejects a second connection", async () => {
  const { driver, device } = await connected(undefined, 0);
  await assert.rejects(driver.open(device), /Disconnect the current FL2K/);
  await driver.dispose();
});

await test("website: protected Audio/Video class is refused before touching USB", async () => {
  const saved = globalThis.document;
  globalThis.document = undefined;
  try {
    const device = mockFl2k();
    assert.match(inspectFl2k(device).reason, /protected class 0x10 \(Audio\/Video\)/);
    const driver = new Fl2kDevice(mockUsb([device]));
    await assert.rejects(driver.open(device), /protected class/);
    assert.equal(device.opened, false);
    await driver.dispose();
  } finally { globalThis.document = saved; }
});

await test("vendor-specific interface works without usb-unrestricted", async () => {
  const saved = globalThis.document;
  globalThis.document = undefined;
  try {
    const { driver } = await connected(mockFl2k({ interfaceClass: 0xff }));
    assert.equal(driver.actualRate, 20e6);
    await driver.dispose();
  } finally { globalThis.document = saved; }
});

// ==========================================================================
console.log("\n--- Rate, registers, I²C ---\n");

await test("setSampleRate needs a connection", async () => {
  const driver = new Fl2kDevice(mockUsb([]));
  await assert.rejects(driver.setSampleRate(20e6), /Connect an FL2K first/);
  await driver.dispose();
});

await test("setSampleRate rejects 1 MS/s and 200 MS/s", async () => {
  const { driver } = await connected(undefined, 0);
  await assert.rejects(driver.setSampleRate(1e6), /8–160/);
  await assert.rejects(driver.setSampleRate(200e6), /8–160/);
  await driver.dispose();
});

for (const rate of [8e6, 20e6, 100e6, 150e6]) {
  // The PLL cannot hit every rate: 8 MS/s comes out as 8.032786 MS/s.
  await test(`setSampleRate ${rate / 1e6} MS/s programs the PLL within 0.5%`, async () => {
    const { driver } = await connected(undefined, rate);
    assert.ok(Math.abs(driver.actualRate - rate) / rate < 0.005, `actual ${driver.actualRate}`);
    await driver.dispose();
  });
}

await test("register write then read round-trips through the device", async () => {
  const { driver, device } = await connected();
  await driver.register(0x8020, 0x12345678);
  assert.equal(device.registers.get(0x8020), 0x12345678);
  assert.equal(await driver.register(0x8020), 0x12345678);
  assert.equal(driver.actualRate, 0, "a raw register write invalidates the DAC rate");
  await assert.rejects(driver.register(0x10000), /16-bit/);
  await driver.dispose();
});

await test("I²C write needs exactly four bytes", async () => {
  const { driver } = await connected();
  await assert.rejects(driver.i2c(0x50, 0, new Uint8Array(2)), /four bytes/);
  await assert.rejects(driver.i2c(0x80, 0), /7-bit/);
  await driver.dispose();
});

// ==========================================================================
console.log("\n--- Transmit ---\n");

for (const [label, options, pattern] of [
  ["no channel", {}, /at least one DAC channel/],
  ["unequal channels", { red: new Int8Array(10), green: new Int8Array(20) }, /equal sample counts/],
  ["empty channel", { red: new Int8Array(0) }, /1–32 million/],
  ["queue depth 0", { red: new Int8Array(10), queueDepth: 0 }, /queue depth/],
  ["Float32 samples", { red: new Float32Array(10) }, /8-bit/],
]) {
  await test(`startTx rejects ${label}`, async () => {
    const { driver } = await connected();
    await assert.rejects(driver.startTx(options), pattern);
    assert.equal(driver.transmitting, false);
    await driver.dispose();
  });
}

await test("startTx needs a sample rate first", async () => {
  const { driver } = await connected(undefined, 0);
  await assert.rejects(driver.startTx({ red: new Int8Array(10) }), /Apply a sample rate/);
  await driver.dispose();
});

await test("CW stream: the device receives exactly the generated samples, then silence", async () => {
  const { driver, device, statuses } = await connected();
  const samples = render(config({ level: 0.8 }), Math.floor(FL2K_SAMPLES * 2.5));
  let progress = 0;
  driver.addEventListener("progress", () => progress++);
  await driver.startTx({ red: samples, signed: true, queueDepth: 2 });
  assert.equal(device.bulk.length, 4, "3 data blocks + 1 silent flush block");
  for (const block of device.bulk) assert.equal(block.length, FL2K_BYTES);
  const red = new Int8Array(device.bulk.length * FL2K_SAMPLES);
  device.bulk.forEach((block, index) => red.set(unpackRed(block), index * FL2K_SAMPLES));
  assert.deepEqual(red.subarray(0, samples.length), samples);
  assert.ok(red.subarray(samples.length).every((sample) => sample === 0), "padding is silent");
  assert.ok(device.bulk.at(-1).every((byte) => byte === 128), "flush block is mid-scale on all channels");
  assert.equal(progress, 4);
  assert.equal(driver.connected, false, "USB is closed after TX");
  assert.ok(statuses.includes("TX ACTIVE — streaming DAC samples over WebUSB."));
  await driver.dispose();
});

await test("unsigned samples pass through unchanged", async () => {
  const { driver, device } = await connected();
  const samples = Uint8Array.from({ length: 4096 }, (_, i) => i & 255);
  await driver.startTx({ red: samples, signed: false });
  const red = unpackRed(device.bulk[0]);
  for (let i = 0; i < samples.length; i++) assert.equal((red[i] + 128) & 255, samples[i]);
  await driver.dispose();
});

await test("repeat wraps the buffer seamlessly and stops on request", async () => {
  const { driver, device } = await connected();
  const length = 1000003;
  const samples = Int8Array.from({ length }, (_, i) => (i % 251) - 125);
  device.onTransferOut = async (endpoint, data) => {
    device.bulk.push(new Uint8Array(data));
    if (device.bulk.length === 3) driver.stop();
    return { status: "ok", bytesWritten: data.byteLength };
  };
  const stream = driver.startTx({ red: samples, signed: true, repeat: true, queueDepth: 1 });
  await stream.catch(() => {});
  assert.ok(device.bulk.length >= 3);
  const red = unpackRed(device.bulk[1]);
  for (let i = 0; i < 2000; i++) assert.equal(red[i], samples[(FL2K_SAMPLES + i) % length], `sample ${i}`);
  assert.equal(driver.running, false);
  assert.equal(driver.connected, false);
  await driver.dispose();
});

// Real-time-ish bulk transfers, so a repeating stream is still running when the driver checks the DAC.
function paced(device, onBlock = () => {}) {
  device.onTransferOut = async (endpoint, data) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    device.bulk.push(new Uint8Array(data));
    onBlock(device.bulk.length);
    return { status: "ok", bytesWritten: data.byteLength };
  };
}

await test("a dead DAC start is detected and the adapter restarted until output runs", async () => {
  const { driver, device, statuses } = await connected(mockFl2k({ deadStarts: 2 }), 100e6);
  paced(device);
  const stream = driver.startTx({ red: new Int8Array(1000).fill(50), signed: true, repeat: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(device.sessions, 3);
  assert.equal(statuses.filter((s) => s.startsWith("FL2K DAC output did not start")).length, 2);
  assert.ok(driver.running && driver.connected);
  assert.equal(driver.actualRate, 100e6, "the restart keeps the DAC rate");
  await driver.stop();
  await stream.catch(() => {});
  await driver.dispose();
});

await test("gives up after 5 dead starts and says to replug", async () => {
  const { driver, device } = await connected(mockFl2k({ deadStarts: 99 }));
  paced(device);
  await assert.rejects(driver.startTx({ red: new Int8Array(1000), signed: true, repeat: true }), /did not start in 5 attempts\. Unplug and replug/);
  assert.equal(device.sessions, 5);
  assert.equal(driver.running, false);
  assert.equal(device.opened, false);
  await driver.dispose();
});

await test("Stop during a restart does not go back on air", async () => {
  const { driver, device } = await connected(mockFl2k({ deadStarts: 1 }));
  paced(device);
  driver.addEventListener("status", (event) => { if (event.detail.message.startsWith("FL2K DAC output did not start")) driver.stop(); });
  await assert.rejects(driver.startTx({ red: new Int8Array(1000), signed: true, repeat: true }), /stopped while restarting/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(driver.running, false);
  assert.equal(driver.connected, false);
  assert.equal(device.opened, false);
  await driver.dispose();
});

await test("a working start is not restarted", async () => {
  const { driver, device } = await connected();
  paced(device, (count) => { if (count === 10) driver.stop(); });
  await driver.startTx({ red: new Int8Array(1000), signed: true, repeat: true }).catch(() => {});
  assert.equal(device.sessions, 1);
  await driver.dispose();
});

await test("a second startTx while on air is refused", async () => {
  const { driver, device } = await connected();
  let release;
  device.onTransferOut = (endpoint, data) => new Promise((resolve) => { release = () => resolve({ status: "ok", bytesWritten: data.byteLength }); });
  const stream = driver.startTx({ red: new Int8Array(100), signed: true });
  await assert.rejects(driver.startTx({ red: new Int8Array(100) }), /Stop TX/);
  driver.stop();
  release();
  await stream.catch(() => {});
  await driver.dispose();
});

await test("a short bulk write stops TX with an error and closes USB", async () => {
  const { driver, device } = await connected();
  device.onTransferOut = async () => ({ status: "ok", bytesWritten: 7 });
  await assert.rejects(driver.startTx({ red: new Int8Array(FL2K_SAMPLES * 2), signed: true }), /short or stalled/);
  assert.equal(driver.running, false);
  assert.equal(driver.connected, false);
  assert.equal(device.opened, false);
  await driver.dispose();
});

await test("a stalled bulk write times out after 5 s and closes USB", async () => {
  const { driver, device } = await connected();
  device.onTransferOut = () => new Promise(() => {});
  const started = performance.now();
  await assert.rejects(driver.startTx({ red: new Int8Array(100), signed: true }), /timed out/);
  assert.ok(performance.now() - started >= 4900);
  assert.equal(device.opened, false);
  await driver.dispose();
});

await test("unplugging mid-TX stops the stream and says so", async () => {
  const { driver, device, usb, statuses } = await connected();
  device.onTransferOut = async (endpoint, data) => {
    if (device.bulk.push(new Uint8Array(data)) === 2) usb.unplug(device);
    return { status: "ok", bytesWritten: data.byteLength };
  };
  await driver.startTx({ red: new Int8Array(100), signed: true, repeat: true, queueDepth: 1 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(driver.running, false);
  assert.ok(statuses.some((s) => s.includes("FL2K unplugged")));
  await driver.dispose();
});

await test("the adapter can be reconnected for another transmission", async () => {
  const { driver, device } = await connected();
  await driver.startTx({ red: new Int8Array(100), signed: true });
  await driver.open(device);
  await driver.setSampleRate(40e6);
  await driver.startTx({ red: new Int8Array(100), signed: true });
  assert.equal(device.bulk.length, 4);
  await driver.dispose();
});

for (const playbook of playbooks.filter((p) => !p.notes.startsWith("REFERENCE ONLY"))) {
  await test(`playbook on air: ${playbook.name}`, async () => {
    const { driver, device } = await connected(undefined, playbook.settings.rate);
    const settings = prepareTx({ ...playbook.settings, rate: driver.actualRate, duration: 0.02 });
    validateTx(settings);
    const samples = render(settings, Math.floor(settings.rate * settings.duration));
    await driver.startTx({ red: samples, signed: true });
    assert.deepEqual(unpackRed(device.bulk[0]).subarray(0, Math.min(samples.length, FL2K_SAMPLES)), samples.subarray(0, FL2K_SAMPLES));
    await driver.dispose();
  });
}

// Must run last: after one refusal, usbUnrestricted() stays false for the page (here, the process).
await test("Chrome refusing the claim reports it, leaves the device closed, and blocks retries", async () => {
  const device = mockFl2k({ protectedRefused: true });
  const driver = new Fl2kDevice(mockUsb([device]));
  await driver.scan();
  await assert.rejects(driver.open(device), /Chrome refused the FL2K's protected USB interface/);
  assert.equal(device.opened, false);
  assert.equal(driver.connected, false);
  assert.equal(inspectFl2k(mockFl2k()).supported, false);
  await driver.dispose();
});

// ==========================================================================

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
