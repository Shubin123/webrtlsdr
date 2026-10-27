export function validateTx(settings) {
  const limits = { rate: [8e6, 160e6], carrier: [1000, 928e6], tone: [20, 20000], depth: [0, 1], deviation: [100, 200000], level: [0, 1], duration: [0.01, 2] };
  for (const [name, [minimum, maximum]] of Object.entries(limits)) {
    if (!Number.isFinite(settings[name]) || settings[name] < minimum || settings[name] > maximum) {
      throw new Error(`Invalid ${name}: expected ${minimum}–${maximum}.`);
    }
  }
  if (!["AM", "FM", "CW", "OOK", "2-FSK"].includes(settings.mode)) throw new Error("Unsupported modulation.");
  if (["OOK", "2-FSK"].includes(settings.mode) && (!Number.isFinite(settings.bitrate) || settings.bitrate < 1 || settings.bitrate > 100000 || !/^[01]{1,256}$/.test(settings.bits))) throw new Error("Use 1–100000 bit/s and a binary pattern of 1–256 bits.");
  const bandwidth = settings.mode === "2-FSK" ? settings.deviation + settings.bitrate : settings.mode === "OOK" ? settings.bitrate : settings.mode === "FM" ? settings.deviation + settings.tone : settings.mode === "AM" ? settings.tone : 0;
  if (settings.carrier <= bandwidth || settings.carrier + bandwidth >= settings.rate / 2) {
    throw new Error("Carrier and modulation bandwidth must fit between DC and the Nyquist limit.");
  }
  if (settings.rate * settings.duration > 32000000) throw new Error("Export limited to 32 million samples; reduce duration or rate.");
}

export function prepareTx(settings) {
  const prefix = [0];
  for (const bit of settings.bits || "") prefix.push(prefix[prefix.length - 1] + (bit === "1" ? 1 : -1));
  return { ...settings, prefix };
}

export function txSample(settings, sampleIndex) {
  const time = sampleIndex / settings.rate;
  const audioPhase = 2 * Math.PI * settings.tone * time;
  let envelope = settings.mode === "AM" ? (1 + settings.depth * Math.sin(audioPhase)) / (1 + settings.depth) : 1;
  let shift = settings.mode === "FM" ? settings.deviation / settings.tone * Math.sin(audioPhase) : 0;
  if (settings.mode === "OOK" || settings.mode === "2-FSK") {
    const bitTime = time * settings.bitrate;
    const bitIndex = Math.floor(bitTime);
    const bit = Number(settings.bits[bitIndex % settings.bits.length]);
    if (settings.mode === "OOK") envelope = bit;
    else {
      const prefix = settings.prefix || prepareTx(settings).prefix;
      let accumulated = Math.floor(bitIndex / settings.bits.length) * prefix[settings.bits.length] + prefix[bitIndex % settings.bits.length];
      accumulated += (bitTime - bitIndex) * (bit ? 1 : -1);
      shift = 2 * Math.PI * settings.deviation * accumulated / settings.bitrate;
    }
  }
  const phase = 2 * Math.PI * settings.carrier * time + shift;
  return Math.round(127 * settings.level * envelope * Math.sin(phase));
}
