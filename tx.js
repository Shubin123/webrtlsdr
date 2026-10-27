import { prepareTx, validateTx, txSample } from "./tx-signal.js";
import { playbooks } from "./tx-playbooks.js";

const field = (name) => document.getElementById(`tx${name}`);
const numeric = (name) => Number(field(name).value);
function settings() {
  return prepareTx({ mode: field("Mode").value, rate: numeric("Rate") * 1e6, carrier: numeric("Carrier") * 1e6, tone: numeric("Tone"), depth: numeric("Depth") / 100, deviation: numeric("Deviation") * 1000, level: numeric("Level") / 100, duration: numeric("Duration"), bitrate: numeric("Bitrate"), bits: field("Bits").value.trim() });
}
function refresh() {
  const config = settings();
  field("ToneLabel").hidden = !["AM", "FM"].includes(config.mode);
  field("DepthLabel").hidden = config.mode !== "AM";
  field("DeviationLabel").hidden = !["FM", "2-FSK"].includes(config.mode);
  field("BitrateLabel").hidden = !["OOK", "2-FSK"].includes(config.mode);
  field("BitsLabel").hidden = !["OOK", "2-FSK"].includes(config.mode);
  const canvas = field("Preview");
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  try {
    validateTx(config);
    field("Command").textContent = `fl2k_file -s ${config.rate} -r 0 fl2k-tx.s8`;
    field("Export").disabled = false;
    field("Status").textContent = "Preview only — no RF output. Signed 8-bit real samples, red DAC channel.";
    context.strokeStyle = "#58a6ff";
    context.beginPath();
    for (let position = 0; position < canvas.width; position++) {
      const height = canvas.height / 2 - txSample(config, position) / 128 * canvas.height / 2;
      if (position === 0) context.moveTo(position, height);
      else context.lineTo(position, height);
    }
    context.stroke();
  } catch (error) {
    field("Status").textContent = error.message;
    field("Command").textContent = "";
    field("Export").disabled = true;
  }
}
document.querySelectorAll(".tx-panel input:not(#txBookmarkName), #txMode").forEach((input) => input.addEventListener("input", refresh));
field("Export").addEventListener("click", async () => {
  field("Export").disabled = true;
  const controls = [...document.querySelectorAll(".tx-panel input, .tx-panel select, #txSave, #txDelete")];
  controls.forEach((control) => { control.disabled = true; });
  try {
    const config = settings();
    validateTx(config);
    const samples = new Int8Array(Math.floor(config.rate * config.duration));
    for (let offset = 0; offset < samples.length; offset += 262144) {
      const end = Math.min(samples.length, offset + 262144);
      for (let index = offset; index < end; index++) samples[index] = txSample(config, index);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const url = URL.createObjectURL(new Blob([samples], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "fl2k-tx.s8";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    field("Status").textContent = `Exported ${samples.length.toLocaleString()} samples. Hardware TX has not started.`;
  } catch (error) {
    field("Status").textContent = error.message;
  } finally {
    controls.forEach((control) => { control.disabled = false; });
    field("Export").disabled = false;
  }
});
const storageKey = "webrtlsdr.tx-bookmarks.v1";
let saved = [];
try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (Array.isArray(stored)) saved = stored.filter((entry) => {
    try { validateTx(entry.settings); return typeof entry.name === "string"; } catch { return false; }
  }).slice(0, 100);
} catch {}
function renderPresets() {
  field("Preset").replaceChildren();
  for (const [index, preset] of [...playbooks, ...saved].entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${index >= playbooks.length ? "Saved · " : ""}${preset.name}`;
    field("Preset").append(option);
  }
}
function loadPreset() {
  const preset = [...playbooks, ...saved][Number(field("Preset").value)];
  if (!preset) return;
  const values = preset.settings;
  for (const [name, value] of Object.entries({ Mode: values.mode, Rate: values.rate / 1e6, Carrier: values.carrier / 1e6, Tone: values.tone, Depth: values.depth * 100, Deviation: values.deviation / 1000, Level: values.level * 100, Duration: values.duration, Bitrate: values.bitrate, Bits: values.bits })) field(name).value = value;
  field("Notes").textContent = preset.notes || "Custom saved lab setup. Verify hardware limits and authorization before use.";
  refresh();
}
function persist(next) {
  localStorage.setItem(storageKey, JSON.stringify(next));
  saved = next;
  renderPresets();
}
field("Preset").addEventListener("change", loadPreset);
field("Save").addEventListener("click", () => {
  try {
    const config = settings();
    validateTx(config);
    const name = field("BookmarkName").value.trim();
    if (!name) throw new Error("Enter a bookmark name first.");
    if (saved.length >= 100) throw new Error("Delete a bookmark before adding more (limit 100).");
    const { prefix, ...values } = config;
    persist([...saved, { name, settings: values }]);
    field("Preset").value = String(playbooks.length + saved.length - 1);
    loadPreset();
  } catch (error) { field("Status").textContent = error.message; }
});
field("Delete").addEventListener("click", () => {
  const index = Number(field("Preset").value) - playbooks.length;
  if (index < 0) { field("Status").textContent = "Built-in playbooks cannot be deleted."; return; }
  try { persist(saved.filter((entry, position) => position !== index)); loadPreset(); }
  catch (error) { field("Status").textContent = error.message; }
});
renderPresets();
loadPreset();
