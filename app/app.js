// SPDX-License-Identifier: Apache-2.0
//
// Web RTL-SDR receiver: a static, offline web application built on the
// webrtlsdr and signals libraries. It never makes network requests.

import { Demodulator } from "./lib/signals/demod/demodulator.js";
import {
  getMode,
  getSchemes,
  modeParameters,
} from "./lib/signals/demod/modes.js";
import { Spectrum } from "./lib/signals/demod/spectrum.js";
import { CompositeReceiver } from "./lib/signals/radio/sample_receiver.js";
import {
  modulateAM,
  modulateFM,
  noise,
  sum,
  tone,
  wbfmSignal,
} from "./lib/signals/sources/generators.js";
import { Radio, RtlProvider } from "./lib/webrtlsdr/radio.js";
import {
  RTL2832U_Provider,
  findKnownDevice,
  isRtlDevice,
} from "./lib/webrtlsdr/rtlsdr.js";
import { FakeRtlDeviceProvider } from "./lib/webrtlsdr/fakertl/fakertl.js";
import { RadioErrorType } from "./lib/webrtlsdr/errors.js";
import { RecordingPlayer } from "./player.js";
import { MODELS, Transcriber } from "./transcriber.js";

// ---------------------------------------------------------------------------
// Settings

const STORAGE_KEY = "webrtlsdr.settings.v1";

const DEFAULT_BOOKMARKS = [
  { name: "FM broadcast", frequency: 88500000, scheme: "WBFM" },
  { name: "Aviation emergency", frequency: 121500000, scheme: "AM" },
  { name: "Marine ch 16", frequency: 156800000, scheme: "NBFM" },
  { name: "NOAA weather", frequency: 162550000, scheme: "NBFM" },
  { name: "2 m calling", frequency: 146520000, scheme: "NBFM" },
  { name: "PMR446 ch 1", frequency: 446006250, scheme: "NBFM" },
];

const DEFAULTS = {
  frequency: 88500000,
  offset: 0,
  scheme: "WBFM",
  modes: {},
  volume: 0.5,
  gain: null,
  manualGain: 30,
  ppm: 0,
  sampleRate: 1024000,
  directSampling: 0,
  biasTee: false,
  buffersPerSecond: 20,
  fftSize: 2048,
  range: 60,
  step: 100000,
  autoStart: true,
  simulated: false,
  stt: false,
  sttModel: "moonshine-base",
  bookmarks: DEFAULT_BOOKMARKS,
};

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

let settings = loadSettings();
let saveTimer = undefined;

function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage may be unavailable (private mode); settings just won't persist.
    }
  }, 200);
}

// ---------------------------------------------------------------------------
// Radio pipeline

/** A device provider that switches between the real stick and a simulated one. */
class SwitchableProvider {
  constructor() {
    this.real = new RTL2832U_Provider();
    this.fake = new FakeRtlDeviceProvider(simulatedSignals());
  }

  async get() {
    if (!settings.simulated) return this.real.get();
    await loadSimulatedSpeech();
    return this.fake.get();
  }
}

/** A recording of speech (16 kHz mono) that the simulated stations broadcast. */
let simulatedSpeech = new Float32Array(0);

async function loadSimulatedSpeech() {
  if (simulatedSpeech.length > 0) return;
  try {
    const wav = new DataView(await (await fetch("sim/jfk.wav")).arrayBuffer());
    // Find the "data" chunk of the 16-bit PCM WAV file.
    let pos = 12;
    while (pos + 8 <= wav.byteLength) {
      const id = String.fromCharCode(
        wav.getUint8(pos), wav.getUint8(pos + 1), wav.getUint8(pos + 2), wav.getUint8(pos + 3),
      );
      const size = wav.getUint32(pos + 4, true);
      if (id === "data") {
        const samples = new Float32Array(size >> 1);
        for (let i = 0; i < samples.length; ++i) {
          samples[i] = wav.getInt16(pos + 8 + 2 * i, true) / 32768;
        }
        simulatedSpeech = samples;
        return;
      }
      pos += 8 + size + (size & 1);
    }
  } catch {
    // Without the recording, the speech stations are silent.
  }
}

/** A generator that repeats the speech recording, with a pause after each repetition. */
function speech(pauseSeconds) {
  return (sample, rate, _centerFreq, I, Q) => {
    const audio = simulatedSpeech;
    const period = audio.length + pauseSeconds * 16000;
    for (let i = 0; i < I.length; ++i) {
      const t = ((sample + i) / rate) * 16000;
      const k = Math.floor(t) % period;
      const f = t - Math.floor(t);
      I[i] = k + 1 < audio.length ? audio[k] * (1 - f) + audio[k + 1] * f : 0;
    }
    Q.fill(0);
  };
}

/** Signals heard by the simulated SDR. */
function simulatedSignals() {
  return sum(
    modulateFM(88.5e6, 75000, 0.1, wbfmSignal(tone(600, 0.5), tone(400, 0.5))),
    modulateFM(88.1e6, 75000, 0.05, wbfmSignal(tone(1000, 0.5))),
    modulateFM(88.9e6, 75000, 0.03, wbfmSignal(speech(2))),
    modulateAM(121.5e6, 0.1, speech(4)),
    modulateFM(162.55e6, 5000, 0.1, tone(1050, 0.5)),
    modulateFM(146.52e6, 5000, 0.05, speech(3)),
    modulateAM(810e3, 0.1, tone(900, 0.5)),
    tone(14225750, 0.01),
    noise(0.02),
  );
}

const player = new RecordingPlayer();
const demodulator = new Demodulator({ player });
const spectrum = new Spectrum(settings.fftSize);
const radio = new Radio(
  new RtlProvider(new SwitchableProvider()),
  CompositeReceiver.of(demodulator, spectrum),
  { buffersPerSecond: settings.buffersPerSecond },
);

const transcriber = new Transcriber(new URL("./", location.href).href, () => ({
  time: new Date(),
  frequency: settings.frequency + settings.offset,
  scheme: settings.scheme,
}));
player.onAudio = (left, right) => transcriber.push(left, right);
const transcript = [];

const knownModes = {};
for (const scheme of getSchemes()) {
  knownModes[scheme] = { ...getMode(scheme), ...(settings.modes[scheme] || {}) };
  knownModes[scheme].scheme = scheme;
}

let devicePresent = false;
let directActive = false;
let stereoActive = false;

async function applySettingsToRadio() {
  await radio.setSampleRate(settings.sampleRate);
  await radio.setFrequency(settings.frequency);
  await radio.setFrequencyCorrection(settings.ppm);
  await radio.setGain(settings.gain);
  await radio.setDirectSamplingMethod(settings.directSampling);
  await radio.enableBiasTee(settings.biasTee);
  demodulator.setVolume(settings.volume);
  demodulator.setMode(knownModes[settings.scheme] || getMode("WBFM"));
  demodulator.setFrequencyOffset(settings.offset);
}

async function start() {
  if (radio.isPlaying()) return;
  hideOverlay();
  try {
    await player.resume();
  } catch {
    // Audio will start once the browser allows it.
  }
  await radio.start();
}

async function stop() {
  if (!radio.isPlaying()) return;
  if (player.isRecording()) await toggleRecording();
  await radio.stop();
}

/** Starts playing, waiting for a user gesture first if the browser requires it. */
function startWhenAllowed() {
  const activation = navigator.userActivation;
  if (activation && !activation.hasBeenActive) {
    showOverlay();
  } else {
    start();
  }
}

// ---------------------------------------------------------------------------
// Plug and play

async function initUsb() {
  if (!("usb" in navigator)) {
    showBanner(
      "This browser does not support WebUSB. Use Chrome, Edge or Opera on a computer or Android device — or enable the simulated SDR in Advanced.",
    );
    el.connectButton.disabled = true;
    updateStatus();
    return;
  }
  if (!window.isSecureContext) {
    showBanner("WebUSB requires HTTPS or localhost.");
  }
  navigator.usb.addEventListener("connect", (e) => {
    if (!isRtlDevice(e.device)) return;
    log("SDR plugged in");
    onDevicePresent();
  });
  navigator.usb.addEventListener("disconnect", async (e) => {
    if (!isRtlDevice(e.device)) return;
    log("SDR unplugged");
    devicePresent = (await findKnownDevice()) !== undefined;
    if (!settings.simulated && radio.isPlaying()) {
      try {
        await radio.stop();
      } catch {
        // The device is gone; nothing else to clean up.
      }
    }
    updateStatus();
  });
  if ((await findKnownDevice()) !== undefined) {
    log("Found a previously paired SDR");
    onDevicePresent();
  }
  updateStatus();
}

function onDevicePresent() {
  devicePresent = true;
  updateStatus();
  if (settings.autoStart && !settings.simulated && !radio.isPlaying()) {
    startWhenAllowed();
  }
}

async function connectDevice() {
  if (settings.simulated) {
    settings.simulated = false;
    el.simulatedBox.checked = false;
    saveSettings();
  }
  try {
    // Asking for the device from a click lets the browser show its chooser.
    const device = await navigator.usb.requestDevice({
      filters: [
        { vendorId: 0x0bda, productId: 0x2832 },
        { vendorId: 0x0bda, productId: 0x2838 },
      ],
    });
    if (device) {
      log(`Paired ${device.productName || "RTL-SDR"}`);
      devicePresent = true;
      updateStatus();
      await start();
    }
  } catch (e) {
    if (e?.name !== "NotFoundError") log(`Could not connect: ${e}`, true);
  }
}

// ---------------------------------------------------------------------------
// UI

const el = {};
for (const id of [
  "status",
  "statusText",
  "connectButton",
  "playButton",
  "recordButton",
  "banner",
  "bannerText",
  "bannerButton",
  "freqInput",
  "stepSelect",
  "modeBadge",
  "stereoBadge",
  "directBadge",
  "recBadge",
  "signalBar",
  "signalText",
  "audioBar",
  "audioText",
  "scope",
  "spectrumCanvas",
  "waterfallCanvas",
  "schemeSelect",
  "bandwidthInput",
  "squelchInput",
  "squelchOut",
  "stereoBox",
  "volumeInput",
  "volumeOut",
  "autoGainBox",
  "gainInput",
  "gainOut",
  "sampleRateSelect",
  "ppmInput",
  "directSelect",
  "biasTeeBox",
  "buffersInput",
  "fftSelect",
  "rangeInput",
  "rangeOut",
  "autoStartBox",
  "simulatedBox",
  "resetButton",
  "bookmarkName",
  "addBookmark",
  "bookmarkList",
  "exportBookmarks",
  "importBookmarks",
  "log",
  "startOverlay",
  "startOverlayButton",
  "sttBox",
  "sttModelSelect",
  "sttDeleteButton",
  "transcript",
  "sttStatus",
  "sttActivity",
  "transcriptLive",
  "transcriptLiveText",
  "sttProgress",
  "sttProgressBar",
  "transcriptList",
  "copyTranscript",
  "exportTranscript",
  "clearTranscript",
]) {
  el[id] = document.getElementById(id);
}

function log(message, isError = false) {
  const li = document.createElement("li");
  if (isError) li.className = "error";
  li.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  el.log.prepend(li);
  while (el.log.children.length > 200) el.log.lastChild.remove();
  if (isError) showBanner(message);
}

function showBanner(text, buttonText, onClick) {
  el.bannerText.textContent = text;
  el.banner.hidden = false;
  el.bannerButton.hidden = !buttonText;
  if (buttonText) {
    el.bannerButton.textContent = buttonText;
    el.bannerButton.onclick = onClick;
  }
}

function hideBanner() {
  el.banner.hidden = true;
}

function showOverlay() {
  el.startOverlay.hidden = false;
}

function hideOverlay() {
  el.startOverlay.hidden = true;
}

function updateStatus() {
  const playing = radio.isPlaying();
  let state, text;
  if (playing) {
    state = "playing";
    text = settings.simulated ? "Playing (simulated)" : "Playing";
  } else if (settings.simulated) {
    state = "ready";
    text = "Simulated SDR ready";
  } else if (!("usb" in navigator)) {
    state = "error";
    text = "WebUSB unavailable";
  } else if (devicePresent) {
    state = "ready";
    text = "SDR connected";
  } else {
    state = "idle";
    text = "No SDR — plug one in";
  }
  el.status.dataset.state = state;
  el.statusText.textContent = text;
  el.playButton.textContent = playing ? "Stop RX" : "Play RX";
  el.playButton.classList.toggle("active", playing);
  el.recordButton.disabled = !playing;
  el.connectButton.hidden = settings.simulated || (devicePresent && playing);
  el.connectButton.textContent = devicePresent ? "Switch SDR" : "Connect SDR";
}

function tunedFrequency() {
  return settings.frequency + settings.offset;
}

function formatMHz(hz) {
  return (hz / 1e6).toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
}

function formatHz(hz) {
  const a = Math.abs(hz);
  if (a >= 1e9) return `${(hz / 1e9).toFixed(3)} GHz`;
  if (a >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (a >= 1e3) return `${(hz / 1e3).toFixed(1)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function updateReadout() {
  if (document.activeElement !== el.freqInput) {
    el.freqInput.value = formatMHz(tunedFrequency());
  }
  el.modeBadge.textContent = settings.scheme;
  el.stereoBadge.hidden = !stereoActive;
  el.directBadge.hidden = !directActive;
}

/** Tunes to an absolute frequency, retuning the stick only if it falls outside the current band. */
async function tuneTo(freq, recenter = false) {
  freq = Math.max(0, Math.round(freq));
  const margin = settings.sampleRate * 0.4;
  if (recenter || Math.abs(freq - settings.frequency) > margin) {
    settings.frequency = freq;
    settings.offset = 0;
    await radio.setFrequency(freq);
  } else {
    settings.offset = freq - settings.frequency;
  }
  demodulator.setFrequencyOffset(settings.offset);
  saveSettings();
  updateReadout();
}

function tuneBy(steps) {
  const step = settings.step;
  const target = Math.round(tunedFrequency() / step + steps) * step;
  tuneTo(target);
}

function parseFrequency(text) {
  const m = String(text)
    .trim()
    .toLowerCase()
    .replace(/,/g, ".")
    .match(/^([\d.]+)\s*(g|m|k)?(hz)?$/);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (isNaN(v)) return undefined;
  const unit = m[2];
  if (unit === "g") return v * 1e9;
  if (unit === "k") return v * 1e3;
  if (unit === "m") return v * 1e6;
  // Without a unit: small numbers are MHz, large ones are Hz.
  return v < 10000 ? v * 1e6 : v;
}

function setMode(scheme) {
  const current = demodulator.getMode();
  knownModes[current.scheme] = current;
  const mode = knownModes[scheme] || getMode(scheme);
  demodulator.setMode(mode);
  settings.scheme = scheme;
  rememberMode();
  updateModeControls();
  updateReadout();
}

function rememberMode() {
  const mode = demodulator.getMode();
  knownModes[mode.scheme] = mode;
  settings.modes[mode.scheme] = mode;
  saveSettings();
}

function updateModeControls() {
  const mode = demodulator.getMode();
  const params = modeParameters(mode);
  el.schemeSelect.value = mode.scheme;
  el.bandwidthInput.disabled = !params.hasBandwidth();
  el.bandwidthInput.value = String(params.getBandwidth());
  el.squelchInput.disabled = !params.hasSquelch();
  el.squelchInput.value = String(params.getSquelch());
  el.squelchOut.textContent = params.hasSquelch()
    ? params.getSquelch().toFixed(1)
    : "—";
  el.stereoBox.disabled = !params.hasStereo();
  el.stereoBox.checked = params.hasStereo() && params.getStereo();
}

function updateGainControls() {
  const auto = settings.gain === null;
  el.autoGainBox.checked = auto;
  el.gainInput.disabled = auto;
  el.gainInput.value = String(settings.manualGain);
  el.gainOut.textContent = auto ? "auto" : `${settings.manualGain}`;
}

function initControls() {
  for (const scheme of getSchemes()) {
    const option = document.createElement("option");
    option.value = scheme;
    option.textContent = scheme;
    el.schemeSelect.appendChild(option);
  }

  el.stepSelect.value = String(settings.step);
  el.volumeInput.value = String(Math.round(settings.volume * 100));
  el.volumeOut.textContent = el.volumeInput.value;
  el.sampleRateSelect.value = String(settings.sampleRate);
  el.ppmInput.value = String(settings.ppm);
  el.directSelect.value = String(settings.directSampling);
  el.biasTeeBox.checked = settings.biasTee;
  el.buffersInput.value = String(settings.buffersPerSecond);
  el.fftSelect.value = String(settings.fftSize);
  el.rangeInput.value = String(settings.range);
  el.rangeOut.textContent = String(settings.range);
  el.autoStartBox.checked = settings.autoStart;
  el.simulatedBox.checked = settings.simulated;
  updateGainControls();
  updateModeControls();
  updateReadout();

  el.playButton.addEventListener("click", () =>
    radio.isPlaying() ? stop() : start(),
  );
  el.connectButton.addEventListener("click", connectDevice);
  el.recordButton.addEventListener("click", toggleRecording);
  el.startOverlayButton.addEventListener("click", start);
  el.startOverlay.addEventListener("click", (e) => {
    if (e.target === el.startOverlay) start();
  });

  el.freqInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.freqInput.blur();
    if (e.key === "Escape") {
      el.freqInput.value = formatMHz(tunedFrequency());
      el.freqInput.blur();
    }
  });
  el.freqInput.addEventListener("change", () => {
    const f = parseFrequency(el.freqInput.value);
    if (f === undefined) {
      el.freqInput.value = formatMHz(tunedFrequency());
      return;
    }
    tuneTo(f, true);
  });
  el.freqInput.addEventListener("blur", updateReadout);
  el.freqInput.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      tuneBy(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  for (const button of document.querySelectorAll("[data-step]")) {
    button.addEventListener("click", () => tuneBy(Number(button.dataset.step)));
  }
  el.stepSelect.addEventListener("change", () => {
    settings.step = Number(el.stepSelect.value);
    saveSettings();
  });

  el.schemeSelect.addEventListener("change", () =>
    setMode(el.schemeSelect.value),
  );
  el.bandwidthInput.addEventListener("change", () => {
    const v = Number(el.bandwidthInput.value);
    const params = modeParameters(demodulator.getMode());
    if (v > 0) demodulator.setMode(params.setBandwidth(v).mode);
    rememberMode();
    updateModeControls();
  });
  el.squelchInput.addEventListener("input", () => {
    const params = modeParameters(demodulator.getMode());
    demodulator.setMode(
      params.setSquelch(Number(el.squelchInput.value)).mode,
    );
    rememberMode();
    updateModeControls();
  });
  el.stereoBox.addEventListener("change", () => {
    const params = modeParameters(demodulator.getMode());
    demodulator.setMode(params.setStereo(el.stereoBox.checked).mode);
    rememberMode();
  });
  el.volumeInput.addEventListener("input", () => {
    settings.volume = Number(el.volumeInput.value) / 100;
    demodulator.setVolume(settings.volume);
    el.volumeOut.textContent = el.volumeInput.value;
    saveSettings();
  });

  el.autoGainBox.addEventListener("change", () => {
    settings.gain = el.autoGainBox.checked ? null : settings.manualGain;
    radio.setGain(settings.gain);
    updateGainControls();
    saveSettings();
  });
  el.gainInput.addEventListener("input", () => {
    settings.manualGain = Number(el.gainInput.value);
    settings.gain = settings.manualGain;
    radio.setGain(settings.gain);
    updateGainControls();
    saveSettings();
  });
  el.sampleRateSelect.addEventListener("change", async () => {
    settings.sampleRate = Number(el.sampleRateSelect.value);
    await radio.setSampleRate(settings.sampleRate);
    if (Math.abs(settings.offset) > settings.sampleRate * 0.4) {
      await tuneTo(tunedFrequency(), true);
    }
    saveSettings();
  });
  el.ppmInput.addEventListener("change", () => {
    const v = Math.round(Number(el.ppmInput.value));
    if (!isNaN(v)) settings.ppm = v;
    el.ppmInput.value = String(settings.ppm);
    radio.setFrequencyCorrection(settings.ppm);
    saveSettings();
  });
  el.directSelect.addEventListener("change", () => {
    settings.directSampling = Number(el.directSelect.value);
    radio.setDirectSamplingMethod(settings.directSampling);
    saveSettings();
  });
  el.biasTeeBox.addEventListener("change", () => {
    settings.biasTee = el.biasTeeBox.checked;
    radio.enableBiasTee(settings.biasTee);
    saveSettings();
  });
  el.buffersInput.addEventListener("change", () => {
    const v = Math.round(Number(el.buffersInput.value));
    if (v >= 1 && v <= 100) settings.buffersPerSecond = v;
    el.buffersInput.value = String(settings.buffersPerSecond);
    radio.setOptions({
      ...radio.getOptions(),
      buffersPerSecond: settings.buffersPerSecond,
    });
    saveSettings();
  });
  el.fftSelect.addEventListener("change", () => {
    settings.fftSize = Number(el.fftSelect.value);
    spectrum.size = settings.fftSize;
    saveSettings();
  });
  el.rangeInput.addEventListener("input", () => {
    settings.range = Number(el.rangeInput.value);
    el.rangeOut.textContent = String(settings.range);
    saveSettings();
  });
  el.autoStartBox.addEventListener("change", () => {
    settings.autoStart = el.autoStartBox.checked;
    saveSettings();
  });
  el.simulatedBox.addEventListener("change", async () => {
    const wasPlaying = radio.isPlaying();
    if (wasPlaying) await stop();
    settings.simulated = el.simulatedBox.checked;
    saveSettings();
    updateStatus();
    if (wasPlaying || settings.simulated) await start();
  });
  el.resetButton.addEventListener("click", async () => {
    if (!confirm("Reset all settings and bookmarks to their defaults?")) return;
    await stop();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    location.reload();
  });

  el.addBookmark.addEventListener("click", addBookmark);
  el.bookmarkName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBookmark();
  });
  el.exportBookmarks.addEventListener("click", exportBookmarks);
  el.importBookmarks.addEventListener("change", importBookmarks);
  renderBookmarks();

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement ||
      // Shortcuts only control the receiver; leave TX controls alone.
      t.closest?.(".tx-panel, #fl2kHeaderTx")
    ) {
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      radio.isPlaying() ? stop() : start();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      tuneBy(e.shiftKey ? 10 : 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      tuneBy(e.shiftKey ? -10 : -1);
    }
  });
}

// ---------------------------------------------------------------------------
// Bookmarks

function addBookmark() {
  const name =
    el.bookmarkName.value.trim() ||
    `${formatMHz(tunedFrequency())} ${settings.scheme}`;
  settings.bookmarks = [
    ...settings.bookmarks,
    { name, frequency: tunedFrequency(), scheme: settings.scheme },
  ].sort((a, b) => a.frequency - b.frequency);
  el.bookmarkName.value = "";
  saveSettings();
  renderBookmarks();
}

function renderBookmarks() {
  el.bookmarkList.replaceChildren();
  settings.bookmarks.forEach((b, index) => {
    const li = document.createElement("li");
    const go = document.createElement("button");
    go.type = "button";
    go.className = "bookmark";
    const name = document.createElement("span");
    name.textContent = b.name;
    const detail = document.createElement("small");
    detail.textContent = `${formatMHz(b.frequency)} MHz · ${b.scheme}`;
    go.append(name, detail);
    go.addEventListener("click", async () => {
      if (getSchemes().includes(b.scheme)) setMode(b.scheme);
      await tuneTo(b.frequency, true);
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "delete";
    del.title = "Delete bookmark";
    del.textContent = "×";
    del.addEventListener("click", () => {
      settings.bookmarks = settings.bookmarks.filter((_, i) => i !== index);
      saveSettings();
      renderBookmarks();
    });
    li.append(go, del);
    el.bookmarkList.append(li);
  });
}

function exportBookmarks() {
  const blob = new Blob([JSON.stringify(settings.bookmarks, null, 2)], {
    type: "application/json",
  });
  downloadBlob(blob, "webrtlsdr-bookmarks.json");
}

async function importBookmarks() {
  const file = el.importBookmarks.files?.[0];
  el.importBookmarks.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error("expected a list");
    const imported = data
      .filter(
        (b) =>
          b &&
          typeof b.name === "string" &&
          Number.isFinite(b.frequency) &&
          typeof b.scheme === "string",
      )
      .map((b) => ({
        name: b.name.slice(0, 40),
        frequency: b.frequency,
        scheme: b.scheme,
      }));
    settings.bookmarks = [...settings.bookmarks, ...imported].sort(
      (a, b) => a.frequency - b.frequency,
    );
    saveSettings();
    renderBookmarks();
    log(`Imported ${imported.length} bookmarks`);
  } catch (e) {
    log(`Could not import bookmarks: ${e.message}`, true);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Recording

async function toggleRecording() {
  if (player.isRecording()) {
    const result = await player.stopRecording();
    el.recBadge.hidden = true;
    el.recordButton.textContent = "Record";
    el.recordButton.classList.remove("active");
    if (!result) return;
    const ext = result.mimeType.includes("ogg") ? "ogg" : "webm";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob(
      result.blob,
      `${formatMHz(tunedFrequency())}MHz-${settings.scheme}-${stamp}.${ext}`,
    );
    log("Recording saved");
  } else {
    player.startRecording();
    el.recBadge.hidden = false;
    el.recordButton.textContent = "Stop rec";
    el.recordButton.classList.add("active");
    log("Recording started");
  }
}

// ---------------------------------------------------------------------------
// Speech to text

function initSpeechToText() {
  if (!(settings.sttModel in MODELS)) settings.sttModel = "moonshine-base";
  el.sttBox.checked = settings.stt;
  el.sttModelSelect.value = settings.sttModel;
  transcriber.setModel(settings.sttModel);

  transcriber.addEventListener("status", (e) => {
    const { state, message, progress } = e.detail;
    el.sttStatus.dataset.state = state;
    el.sttStatus.textContent = message;
    el.sttProgress.hidden = state !== "loading";
    if (progress !== undefined) {
      el.sttProgressBar.style.width = `${Math.round(progress * 100)}%`;
    }
    if (state === "error") log(message, true);
  });
  transcriber.addEventListener("transcript", (e) => addTranscript(e.detail));
  transcriber.addEventListener("partial", (e) => {
    el.transcriptLiveText.textContent = e.detail.text;
    el.transcriptLive.hidden = !e.detail.text;
    if (e.detail.text) el.transcriptList.scrollTop = el.transcriptList.scrollHeight;
  });
  transcriber.addEventListener("activity", (e) => {
    el.sttActivity.classList.toggle("on", e.detail.speech);
  });

  el.sttBox.addEventListener("change", () => {
    settings.stt = el.sttBox.checked;
    saveSettings();
    applySpeechToText();
  });
  el.sttModelSelect.addEventListener("change", () => {
    settings.sttModel = el.sttModelSelect.value;
    saveSettings();
    transcriber.setModel(settings.sttModel);
  });
  el.sttDeleteButton.addEventListener("click", async () => {
    if (!confirm("Delete the downloaded speech models from this device?")) return;
    if (settings.stt) {
      settings.stt = false;
      el.sttBox.checked = false;
      saveSettings();
      applySpeechToText();
    }
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("webrtlsdr-models")).map((k) => caches.delete(k)),
    );
    log("Deleted downloaded speech models");
  });
  el.copyTranscript.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(transcriptText());
      log("Transcript copied");
    } catch {
      log("Could not copy the transcript", true);
    }
  });
  el.exportTranscript.addEventListener("click", () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob(
      new Blob([transcriptText()], { type: "text/plain" }),
      `transcript-${stamp}.txt`,
    );
  });
  el.clearTranscript.addEventListener("click", () => {
    transcript.length = 0;
    el.transcriptList.replaceChildren(el.transcriptLive);
  });
  applySpeechToText();
}

function applySpeechToText() {
  el.transcript.hidden = !settings.stt;
  transcriber.setEnabled(settings.stt);
}

function addTranscript({ text, seconds, context }) {
  const entry = { ...context, text, seconds };
  transcript.push(entry);
  const li = document.createElement("li");
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${entry.time.toLocaleTimeString()} · ${formatMHz(entry.frequency)} MHz ${entry.scheme}`;
  const body = document.createElement("span");
  body.className = "text";
  body.textContent = text;
  li.append(meta, body);
  const atBottom =
    el.transcriptList.scrollTop + el.transcriptList.clientHeight >=
    el.transcriptList.scrollHeight - 8;
  el.transcriptList.insertBefore(li, el.transcriptLive);
  while (transcript.length > 500) {
    el.transcriptList.firstChild.remove();
    transcript.shift();
  }
  if (atBottom) el.transcriptList.scrollTop = el.transcriptList.scrollHeight;
}

function transcriptText() {
  return transcript
    .map(
      (t) =>
        `[${t.time.toISOString()}] ${formatMHz(t.frequency)} MHz ${t.scheme}: ${t.text}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Spectrum and waterfall

const COLORMAP = (() => {
  const stops = [
    [0, [0, 0, 16]],
    [0.25, [0, 32, 128]],
    [0.5, [0, 160, 192]],
    [0.7, [240, 220, 0]],
    [0.85, [255, 96, 0]],
    [1, [255, 255, 255]],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; ++i) {
    const x = i / 255;
    let j = 0;
    while (j < stops.length - 2 && x > stops[j + 1][0]) ++j;
    const [x0, c0] = stops[j];
    const [x1, c1] = stops[j + 1];
    const t = (x - x0) / (x1 - x0);
    for (let k = 0; k < 3; ++k) lut[i * 3 + k] = c0[k] + (c1[k] - c0[k]) * t;
  }
  return lut;
})();

const scope = {
  bins: new Float32Array(131072),
  columns: new Float32Array(0),
  smooth: new Float32Array(0),
  floor: -60,
  dragging: false,
  dpr: 1,
  lastSignalAt: 0,
};

function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  scope.dpr = dpr;
  for (const canvas of [el.spectrumCanvas, el.waterfallCanvas]) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      // Keep the waterfall history when resizing.
      let saved;
      if (canvas === el.waterfallCanvas && canvas.width > 1) {
        saved = document.createElement("canvas");
        saved.width = canvas.width;
        saved.height = canvas.height;
        saved.getContext("2d").drawImage(canvas, 0, 0);
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (canvas === el.waterfallCanvas) {
        ctx.fillStyle = "#000010";
        ctx.fillRect(0, 0, w, h);
        if (saved) ctx.drawImage(saved, 0, 0, w, saved.height);
      }
    }
  }
}

/** Returns the passband [low, high] in Hz relative to the tuned frequency. */
function passband() {
  const mode = demodulator.getMode();
  const bw = modeParameters(mode).getBandwidth();
  if (mode.scheme === "USB") return [0, bw];
  if (mode.scheme === "LSB") return [-bw, 0];
  return [-bw / 2, bw / 2];
}

function drawScope() {
  const sw = el.spectrumCanvas.width;
  const sh = el.spectrumCanvas.height;
  const ww = el.waterfallCanvas.width;
  const wh = el.waterfallCanvas.height;
  const sctx = el.spectrumCanvas.getContext("2d");
  const wctx = el.waterfallCanvas.getContext("2d");
  const dpr = scope.dpr;
  const rate = settings.sampleRate;
  const center = spectrum.frequency() ?? settings.frequency;
  const playing = radio.isPlaying();

  if (scope.columns.length !== sw) {
    scope.columns = new Float32Array(sw);
    scope.smooth = new Float32Array(sw).fill(-200);
  }

  // Compute one value per pixel column, with the FFT shifted so that the
  // center frequency is in the middle.
  if (playing) {
    const n = spectrum.size;
    const bins = scope.bins.subarray(0, n);
    spectrum.getSpectrum(bins);
    const half = n >> 1;
    for (let x = 0; x < sw; ++x) {
      const a = Math.floor((x * n) / sw);
      const b = Math.max(a + 1, Math.floor(((x + 1) * n) / sw));
      let max = -Infinity;
      for (let i = a; i < b; ++i) {
        const v = bins[(i + half) % n];
        if (v > max) max = v;
      }
      if (!Number.isFinite(max)) max = -200;
      scope.columns[x] = max;
      scope.smooth[x] =
        scope.smooth[x] < -150 ? max : scope.smooth[x] * 0.6 + max * 0.4;
    }
    // Track the noise floor (a low percentile) so the display auto-levels.
    const sorted = Float32Array.from(scope.columns).sort();
    const floor = sorted[Math.floor(sorted.length * 0.2)];
    if (Number.isFinite(floor)) scope.floor = scope.floor * 0.95 + floor * 0.05;
  }

  const minDb = scope.floor - 10;
  const maxDb = minDb + settings.range;
  const toY = (db) => sh - ((db - minDb) / (maxDb - minDb)) * sh;
  const freqToX = (f) => ((f - center) / rate + 0.5) * sw;

  // Spectrum background and grid.
  const css = getComputedStyle(document.documentElement);
  sctx.fillStyle = css.getPropertyValue("--scope-bg") || "#05070c";
  sctx.fillRect(0, 0, sw, sh);
  sctx.strokeStyle = css.getPropertyValue("--grid") || "#1e2633";
  sctx.fillStyle = css.getPropertyValue("--muted") || "#8b949e";
  sctx.lineWidth = 1;
  sctx.font = `${11 * dpr}px system-ui, sans-serif`;
  sctx.textBaseline = "top";
  for (let db = Math.ceil(minDb / 10) * 10; db < maxDb; db += 10) {
    const y = Math.round(toY(db)) + 0.5;
    sctx.beginPath();
    sctx.moveTo(0, y);
    sctx.lineTo(sw, y);
    sctx.stroke();
  }
  const gridStep = niceStep(rate / 8);
  const first = Math.ceil((center - rate / 2) / gridStep) * gridStep;
  sctx.textAlign = "center";
  for (let f = first; f < center + rate / 2; f += gridStep) {
    const x = Math.round(freqToX(f)) + 0.5;
    sctx.beginPath();
    sctx.moveTo(x, 0);
    sctx.lineTo(x, sh);
    sctx.stroke();
    sctx.fillText(formatMHz(f), x, 4 * dpr);
  }

  // Passband.
  const tuned = settings.frequency + settings.offset;
  const [lo, hi] = passband();
  const x0 = freqToX(tuned + lo);
  const x1 = freqToX(tuned + hi);
  sctx.fillStyle = css.getPropertyValue("--passband") || "rgba(88,166,255,0.18)";
  sctx.fillRect(x0, 0, Math.max(1, x1 - x0), sh);
  sctx.strokeStyle = css.getPropertyValue("--accent") || "#58a6ff";
  sctx.beginPath();
  const xt = Math.round(freqToX(tuned)) + 0.5;
  sctx.moveTo(xt, 0);
  sctx.lineTo(xt, sh);
  sctx.stroke();

  if (playing) {
    // Spectrum trace.
    sctx.beginPath();
    for (let x = 0; x < sw; ++x) {
      const y = toY(scope.smooth[x]);
      if (x === 0) sctx.moveTo(x, y);
      else sctx.lineTo(x, y);
    }
    sctx.lineTo(sw, sh);
    sctx.lineTo(0, sh);
    sctx.closePath();
    sctx.fillStyle = css.getPropertyValue("--trace-fill") || "rgba(63,185,80,0.25)";
    sctx.fill();
    sctx.strokeStyle = css.getPropertyValue("--trace") || "#3fb950";
    sctx.stroke();

    // Waterfall: scroll down one row and draw the newest line on top.
    wctx.drawImage(el.waterfallCanvas, 0, 0, ww, wh - 1, 0, 1, ww, wh - 1);
    const row = wctx.createImageData(ww, 1);
    for (let x = 0; x < ww; ++x) {
      const v = scope.columns[Math.floor((x * sw) / ww)];
      const t = Math.max(0, Math.min(1, (v - minDb) / (maxDb - minDb)));
      const c = Math.round(t * 255) * 3;
      row.data[x * 4] = COLORMAP[c];
      row.data[x * 4 + 1] = COLORMAP[c + 1];
      row.data[x * 4 + 2] = COLORMAP[c + 2];
      row.data[x * 4 + 3] = 255;
    }
    wctx.putImageData(row, 0, 0);

    // Signal meter: strongest bin in the passband over the noise floor.
    let peak = -Infinity;
    const a = Math.max(0, Math.floor(Math.min(x0, x1)));
    const b = Math.min(sw - 1, Math.ceil(Math.max(x0, x1)));
    for (let x = a; x <= b; ++x) peak = Math.max(peak, scope.columns[x]);
    const snr = Number.isFinite(peak) ? Math.max(0, peak - scope.floor) : 0;
    setMeter(el.signalBar, el.signalText, snr / 60, `${snr.toFixed(0)} dB`);
    const level = player.level;
    const dbfs = level > 0 ? 20 * Math.log10(level) : -Infinity;
    setMeter(
      el.audioBar,
      el.audioText,
      Number.isFinite(dbfs) ? (dbfs + 60) / 60 : 0,
      Number.isFinite(dbfs) ? `${dbfs.toFixed(0)} dB` : "—",
    );
  } else {
    setMeter(el.signalBar, el.signalText, 0, "—");
    setMeter(el.audioBar, el.audioText, 0, "—");
  }
}

function setMeter(bar, text, fraction, label) {
  bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  text.textContent = label;
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function scopeFrequencyAt(clientX) {
  const rect = el.spectrumCanvas.getBoundingClientRect();
  const center = spectrum.frequency() ?? settings.frequency;
  const fraction = (clientX - rect.left) / rect.width;
  return center + (fraction - 0.5) * settings.sampleRate;
}

function tuneToScope(clientX) {
  const step = Math.min(settings.step, 1000);
  const f = Math.round(scopeFrequencyAt(clientX) / step) * step;
  tuneTo(f);
}

function initScope() {
  const onDown = (e) => {
    scope.dragging = true;
    el.scope.setPointerCapture(e.pointerId);
    tuneToScope(e.clientX);
  };
  el.scope.addEventListener("pointerdown", onDown);
  el.scope.addEventListener("pointermove", (e) => {
    if (scope.dragging) tuneToScope(e.clientX);
  });
  el.scope.addEventListener("pointerup", () => (scope.dragging = false));
  el.scope.addEventListener("pointercancel", () => (scope.dragging = false));
  el.scope.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      tuneBy(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  new ResizeObserver(resizeCanvases).observe(el.scope);
  resizeCanvases();

  let last = 0;
  const frame = (t) => {
    if (t - last >= 33) {
      last = t;
      drawScope();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Radio events

radio.addEventListener("radio", (e) => {
  const d = e.detail;
  switch (d.type) {
    case "started":
      log(settings.simulated ? "Started (simulated SDR)" : "Started");
      hideBanner();
      break;
    case "stopped":
      log("Stopped");
      directActive = false;
      stereoActive = false;
      break;
    case "directSampling":
      directActive = d.active;
      log(`Direct sampling ${d.active ? "on" : "off"}`);
      break;
    case "error": {
      const ex = d.exception;
      if (ex?.type === RadioErrorType.NoDeviceSelected) {
        log("No SDR selected");
        break;
      }
      let msg = `${ex?.message || ex}`;
      if (ex?.cause) msg += ` (${ex.cause.message || ex.cause})`;
      if (ex?.type === RadioErrorType.UsbTransferError || /claim|open|access/i.test(msg)) {
        msg +=
          " — the stick may be in use by another program, or (on Linux) the DVB-T driver may need to be unloaded.";
      }
      log(msg, true);
      break;
    }
  }
  updateStatus();
  updateReadout();
});

demodulator.addEventListener("stereo-status", (e) => {
  stereoActive = e.detail;
  updateReadout();
});

// ---------------------------------------------------------------------------
// Offline support

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost") return;
  // The page is served from the cache, so after an update it first shows the
  // previous version. Switch to the new one as soon as it takes over: right
  // away if nothing is running, otherwise when the user is ready.
  const updating = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!updating) return;
    const transmitting = (document.body.dataset.tx || "off") !== "off";
    if (!radio.isPlaying() && !transmitting) {
      location.reload();
    } else {
      showBanner("A new version of this app is ready.", "Reload", () => location.reload());
    }
  });
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---------------------------------------------------------------------------

async function main() {
  if (location.hash === "#simulated") {
    settings.simulated = true;
    history.replaceState(null, "", location.pathname);
  }
  initControls();
  initScope();
  initSpeechToText();
  await applySettingsToRadio();
  updateModeControls();
  updateStatus();
  registerServiceWorker();
  await initUsb();
  if (settings.simulated && settings.autoStart) startWhenAllowed();
}

main();
