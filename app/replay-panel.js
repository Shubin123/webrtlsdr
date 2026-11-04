import { duration, MAX_RECORD_SECONDS, parseRecording, recordingFileName } from "./iq-replay.js";

const mhz = (hz) => `${(hz / 1e6).toFixed(3)} MHz`;

export function installReplayPanel({ recorder, rxFrequency, onUse }) {
  const field = (name) => document.getElementById(`iq${name}`);
  let note = "";

  function describe(recording) {
    const size = recording.iq.length / 1e6;
    const source = recording.name ? `Loaded ${recording.name}: ` : "Recorded ";
    const guessed = recording.guessed ? " Frequency or sample rate was not in the file name; current RX settings assumed." : "";
    return `${source}${duration(recording).toFixed(2)} s at ${mhz(recording.frequency)}, ${(recording.sampleRate / 1e6).toFixed(3)} MS/s, ${size.toFixed(1)} MB.${guessed}`;
  }

  function refresh() {
    const capturing = Boolean(recorder.capture);
    field("Record").disabled = !capturing && !recorder.receiving();
    field("Record").textContent = capturing ? `■ Stop (${recorder.progress().toFixed(1)} s)` : "● Record IQ";
    field("Record").classList.toggle("active", capturing);
    field("Seconds").disabled = capturing;
    const recording = recorder.recording;
    field("Use").disabled = capturing || !recording;
    field("Save").disabled = capturing || !recording;
    field("Status").textContent = capturing
      ? `Recording IQ… ${recorder.progress().toFixed(1)} of ${Number(field("Seconds").value).toFixed(1)} s.`
      : recording ? describe(recording) : recorder.receiving() ? "No recording yet." : "No recording. Start RX to record.";
    field("Note").textContent = note;
  }

  recorder.addEventListener("change", (event) => {
    note = event.detail?.reason ? `Recording stopped early: ${event.detail.reason}.` : "";
    refresh();
  });
  // The recorder only sees sample blocks; poll to follow RX starting and stopping.
  setInterval(() => {
    if (recorder.capture && !recorder.receiving()) recorder.finish("RX stopped");
    refresh();
  }, 250);

  field("Record").addEventListener("click", () => {
    if (recorder.capture) { recorder.stop(); return; }
    try {
      recorder.start(Math.min(MAX_RECORD_SECONDS, Number(field("Seconds").value)));
      note = "";
    } catch (error) { note = error.message; }
    refresh();
  });

  field("Save").addEventListener("click", () => {
    const recording = recorder.recording;
    const url = URL.createObjectURL(new Blob([recording.iq], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = recording.name || recordingFileName(recording);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

  field("Load").addEventListener("change", async () => {
    const file = field("Load").files[0];
    field("Load").value = "";
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      recorder.load(parseRecording(file.name, bytes, { sampleRate: recorder.sampleRate || 1024000, frequency: rxFrequency() }));
      note = "";
    } catch (error) { note = error.message; }
    refresh();
  });

  field("Use").addEventListener("click", () => {
    note = onUse(recorder.recording) || "";
    refresh();
  });

  refresh();
}
