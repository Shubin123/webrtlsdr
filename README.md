# Web RTL-SDR

Access RTL-SDR devices and receive and demodulate radio signals from your web application.

## What is this

This is a library that provides functions to access and operate an RTL-SDR device from a web application, receive radio signals, demodulate them, and play it through the computer's speakers or headphones.

It provides low-level access to the RTL-SDR stick, and also uses the [Signals library](https://github.com/jtarrio/signals) to provide a full reception/demodulation pipeline.

This library powers Radio Receiver, my browser-based SDR application, which you can try at [radio.ea1iti.es](https://radio.ea1iti.es).

## Web app (offline, plug and play)

This fork includes a complete receiver app in [`app/`](app/) that is published as a static site on GitHub Pages: **https://shubin123.github.io/webrtlsdr/** (see the [capabilities page](https://shubin123.github.io/webrtlsdr/capabilities.html) for everything it can do).

- **Plug and play:** press *Connect SDR* once to grant the page access to your stick (browsers require this the first time). After that the stick is picked up automatically whenever it is plugged in, and playback starts on its own (can be turned off under *Advanced*). Unplugging stops cleanly.
- **Features:** WBFM (stereo), NBFM, AM, USB, LSB and CW; live spectrum and waterfall with click/drag/scroll tuning; bandwidth, squelch, volume, RF gain/AGC, sample rate, PPM correction, direct sampling (HF), bias tee, FFT size; bookmarks with JSON import/export; recording audio to a local file; signal and audio meters; keyboard shortcuts; a simulated SDR to try it without hardware.
- **No external connections:** every file is served from the same origin; nothing is loaded from a CDN, and there are no fonts, analytics or trackers. A Content-Security-Policy with `connect-src 'none'` makes the browser block any network request the page might try to make. Settings stay in the browser's local storage. A service worker caches the app so it works fully offline after the first visit.
- **Build-time check:** `scripts/build-site.mjs` fails the build if any shipped file contains code that could reach the network (`fetch`, XHR, WebSocket, beacons, dynamic imports, external URLs, …). The only exception is the service worker, which serves the app's own files and refuses every cross-origin request.

### Run it locally

```shell
npm ci --ignore-scripts
npm run build:site   # builds site/
npm run serve        # http://localhost:8080 (WebUSB works on localhost)
```

You can copy the `site/` folder to any static web server. WebUSB requires HTTPS or `localhost`.

### Publishing to GitHub Pages

No GitHub Actions are used. Pages serves the prebuilt files committed to the `gh-pages` branch. To publish an update:

```shell
npm run build:site
git -C site init -q && git -C site add -A && git -C site commit -qm "Publish site"
git -C site push -f "$(git remote get-url origin)" HEAD:gh-pages
rm -rf site/.git
```

### Troubleshooting

- **Linux:** unload the DVB-T driver (`sudo rmmod dvb_usb_rtl28xxu`, or blacklist it) and add a udev rule so your user can access the stick.
- **Windows:** install the WinUSB driver for the stick using [Zadig](https://zadig.akeo.ie/).
- **macOS / Android:** works out of the box with a Chromium-based browser (Android needs a USB OTG adapter).

## Compatible hardware and software

Web RTL-SDR was written to work with an RTL-2832U-based DVB-T (European digital TV) USB receiver with a R820/828/860 tuner chip. Support for other chips may be added as required.

Web RTL-SDR uses the WebUSB API, which is only available in Chromium-based browsers (Chrome, Edge, Opera) on computers and Android devices.

## How to install

```shell
npm install @jtarrio/webrtlsdr
```

## How to use

See [the `docs` directory](docs/README.md) for the documentation, or check out the following examples.

### High-level access to RTL-SDR (demodulate and play through the computer's speakers)

This program is a complete stereo FM radio receiver tuned for 88.5 MHz.

```typescript
import { Demodulator } from "@jtarrio/signals/demod/demodulator.js";
import { getMode } from "@jtarrio/signals/demod/modes.js";
import { Radio, RtlProvider } from "@jtarrio/webrtlsdr/radio.js";

let demodulator = new Demodulator();
let radio = new Radio(new RtlProvider(), demodulator);

radio.setFrequency(88500000);
demodulator.setVolume(1);
demodulator.setMode(getMode("WBFM"));

document
  .getElementById("playButton")
  .addEventListener("click", () => radio.start());
document
  .getElementById("stopButton")
  .addEventListener("click", () => radio.stop());
```

You can also see a full example at [`examples/highlevel`](examples/highlevel/script.js).

### Low-level access (read samples straight from the stick)

This program connects to the RTL-SDR stick, tunes to 88.5 MHz, reads 65536 samples, and closes the connection.

```typescript
import { RTL2832U_Provider } from "@jtarrio/webrtlsdr/rtlsdr.js";

let provider = new RTL2832U_Provider();
let device = await provider.get();
await device.setSampleRate(1024000);
await device.setCenterFrequency(88500000);
await device.setGain(null);
await device.resetBuffer();
let samples = await device.readSamples(65536);
await device.close();
```

You can also see a full example at [`examples/lowlevel`](examples/lowlevel/script.js).

## Acknowledgements

This is a spinoff of https://github.com/jtarrio/radioreceiver, which is, in turn, a fork of https://github.com/google/radioreceiver. (I am the original author, but I was employed by Google at the time.)

Kudos and thanks to the [RTL-SDR project](http://sdr.osmocom.org/trac/wiki/rtl-sdr) for figuring out the magic numbers needed to drive the USB tuner.
