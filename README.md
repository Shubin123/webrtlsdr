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
- **Speech to text, on device:** turn on *Transcribe audio to text* to get a live transcript of what you hear. It runs [Moonshine](https://github.com/moonshine-ai/moonshine) (MIT) with Transformers.js and ONNX Runtime Web on the CPU (WebAssembly), in a worker so the audio stays smooth. *Moonshine Base* (66 MB) is the default; *Moonshine Tiny* (32 MB) is faster. Both beat Whisper models of the same size in word error rate. The model is served by the site, downloaded only when you first turn the feature on, and cached for offline use. Audio is filtered and resampled to 16 kHz, then split into transmissions by an adaptive voice-activity detector.
- **No external connections:** every file is served from the same origin; nothing is loaded from a CDN, and there are no fonts, analytics or trackers. A Content-Security-Policy (`default-src 'none'`, `connect-src 'self'`) makes the browser block any request to another server; requests to the site itself are allowed only so the speech model can be loaded on demand. Settings stay in the browser's local storage. A service worker caches the app so it works fully offline after the first visit.
- **Speech model isolation:** the speech worker is started from a blob URL, so it inherits the page's Content-Security-Policy (`connect-src 'self'`, `script-src 'self'`). On top of that, `app/stt/guard.js` runs before the library and rejects any request to another origin and removes XHR/WebSocket/EventSource. Transformers.js is configured for local files only, and its default remote hosts are rewritten to `blocked.invalid` in the bundle. The model files are pinned to a Hugging Face revision and checked against SHA-256 hashes (`scripts/stt-models.json`) at build time.
- **Build-time check:** `scripts/build-site.mjs` fails the build if any shipped file contains code that could reach the network (`fetch`, XHR, WebSocket, beacons, dynamic imports, external URLs, …). The exceptions are the service worker, which serves the app's own files and refuses every cross-origin request, and the bundled speech library, which is checked for remote hosts instead (see below).

### FL2K TX / modulation panel

The left-hand TX panel generates AM, FM, CW, OOK and continuous-phase binary FSK,
with carrier, DAC sample rate, modulation depth/deviation, output level and
duration controls. It exports **signed 8-bit real samples**, not IQ, for the
FL2K red DAC channel. Preview/export alone never transmit. The hardware section
contains an experimental WebUSB TX path through an Emscripten-compiled driver,
but the physically tested FL2000 adapter is blocked by protected USB classes. RTL-SDR
hardware remains receive-only. Microphone/audio-file modulation is not implemented.

#### Browser FL2K hardware interface (experimental)

**Stock FL2000 adapters need the installed app.** A `1d5c:2000` adapter only
has Audio/Video-class (`0x10`) USB interfaces, which Chrome does not let
websites claim, so on the website Transmit stays disabled and says why. The
same app installed as an *Isolated Web App* may claim them: it asks for the
`usb-unrestricted` permission, which Chrome grants once its Isolated Web App
flags are on. It is the same static files in one signed bundle, so it works
offline from the first start and needs no server or bridge. Hardware testing
(October 26, 2026) connected the real adapter from the installed app, set the
DAC to 20 MS/s and read back its PLL register; RF output has not been measured.
See `docs/hardware-e2e.md`. Exporting samples for native `fl2k_file` still
works too.

#### Installing the app (for FL2K transmit)

1. In Chrome, open `chrome://flags`, enable **Enable Isolated Web Apps**,
   **Enable Isolated Web App Developer Mode** and **Enable Isolated Web Apps to
   bypass USB restrictions**, then relaunch Chrome. Developer mode lets Chrome
   install apps that are not from a store; only install bundles you trust.
2. Download [`webrtlsdr.swbn`](https://github.com/Shubin123/webrtlsdr/releases/download/installable-app/webrtlsdr.swbn)
   (115 MB: the whole app, including both speech models).
3. Open `chrome://iwa-dev`, click **Install**, choose **Signed Bundle**, pick
   the file and install. Open **Web RTL-SDR** from Chrome's apps.
4. To update, install a newer bundle the same way; it replaces the app because
   it is signed with the same key.

To build the bundle yourself: `npm run build:site && npm run build:iwa` writes
`dist-iwa/webrtlsdr.swbn`. The first run creates the signing key
`iwa-signing-key.pem` (ignored by git). Keep a copy: a bundle signed with a
different key installs as a different app.

Receiving (RX) and transmitting (TX) are separate. **Play RX** and the Space
key only ever control the receiver; nothing transmits except **Transmit**, in
the top bar next to Play RX and at the top of the TX panel. When Transmit is
not possible yet, the top-bar button shows what is missing instead. TX is off when the page loads and returns to
off after every transmission.

1. Expand **FL2K hardware · WebUSB + Wasm** in the modulation panel. Use a Chromium browser on HTTPS or localhost with an FL2000DX adapter
   (`1d5c:2000`). The panel scans previously authorized devices and watches USB
   connect/disconnect events; use **Connect / grant FL2K access** the first time.
   Detection never starts TX. **Apply DAC sample rate** shows the achievable
   rate in advance; Transmit applies it anyway, and generated modulation uses
   the actual rate rather than the requested value.
2. Select generated modulation on the red/green/blue DAC, or load equal-length
   raw 8-bit sample files for any combination of RGB channels. Raw files are
   real DAC streams, not IQ, WAV or audio files. Unused DACs remain at midpoint.
3. Tick the setup confirmation, optionally tick **Keep transmitting until I
   press Stop**, and press **Transmit**. It connects, applies the DAC rate and
   prepares the samples ("TX preparing", amber, not on air yet, **Cancel**
   aborts), then goes on air. Below the Transmit button the panel says why
   Transmit is disabled, if it is.
4. While on air the TX box turns red and reads **TRANSMITTING** with the
   elapsed time, the top bar shows a red **TX ON AIR** pill and a **Stop TX**
   button, the whole window gets a red frame, and the tab title starts with
   "● TX ON AIR". Red is not used for anything else; RX playing is green.
5. **Stop transmitting**, the top bar's **Stop TX**, or hiding the page stops TX
   and closes USB. A one-shot transmission stops by itself. Either way both
   ticks are cleared, so the next transmission needs a fresh confirmation.
   Browser shutdown cannot guarantee cleanup; unplug to guarantee RF output is
   removed. Queue depth (one to four USB transfers) and transfer statistics are
   under FL2K hardware; statistics show host throughput, not gap-free RF output.

The advanced panel exposes register read/write and the driver's four-byte I²C
read/write operations while TX is stopped. Raw register writes invalidate the
known rate, so reapply it before transmitting. I²C is not a CC1101 SPI bridge.
`app/fl2k-device.js` also exposes detection, open/close, rate, register, I²C,
signed/unsigned RGB streaming, repeat and cancellation to JavaScript callers.

The browser build reuses the driver's initialization, PLL, I²C and RGB byte
packing code. A small libusb shim uses WebUSB control transfers with Asyncify;
the native pthread/libusb transfer loop is replaced with bounded browser bulk
transfers. No local server, native helper, pthreads, SharedArrayBuffer or
cross-origin-isolation headers are required by the experimental code path. This
does not mean the connected FL2000 can be accessed by normal WebUSB. Native kernel-driver
detachment, zero-copy buffers and native callback timing are not available in
WebUSB. The tested stock FL2000 fails before initialization because all of its
interfaces are protected. Wasm/mock tests verify software paths, not physical TX.

An OS display/storage driver may prevent interface claims. Close competing
applications; Windows may need WinUSB and Linux may need USB permissions.
The browser cannot forcibly detach a kernel driver. Real-time operation at high
sample rates is not guaranteed; USB/browser stalls can cause output gaps.
Streaming uses the upstream 1,310,720-sample blocks, padding the final block
with midpoint samples. Finite playback sends a final midpoint block before
closing USB; stopping does not promise that the adapter's analog DAC powers off.

To rebuild the Wasm package, install Emscripten with `emcc` on `PATH` (or set
`EMCC` to its executable), then run `npm run build:fl2k`. `npm run build:site`
also rebuilds it and fails if compilation fails. The generated
`app/fl2k/runtime.js` embeds the Wasm bytes and performs no runtime fetch.
The source archive and GPL license are linked in the panel and shipped with the
site. The build was verified with Emscripten 6.0.13-git; there are no Emscripten
requirements for end users viewing the published site.

The playbook picker includes 1 MHz OOK/FSK lab waveforms, LF 60/125 kHz
experiments, HF AM/CW, and CC1101 reference profiles at 315, 433.92, 868.3 and
915 MHz. CC1101 references deliberately disable FL2K export: those carriers
exceed this direct-sampling path's Nyquist limit. There is no SPI CC1101 driver,
GFSK shaping, protocol decoder, or packet/CRC encoder. Digital modes repeat an
editable binary test pattern at the selected bit rate. Save/delete custom
setups as browser-local bookmarks (up to 100); no hardware starts automatically.

Reference facts: Texas Instruments' CC1101 datasheet lists 300–348, 387–464
and 779–928 MHz operating ranges (`https://www.ti.com/product/CC1101`).
NIST describes WWVB's 60 kHz time service
(`https://www.nist.gov/pml/time-and-frequency-division/time-distribution/radio-station-wwvb`).
These references describe hardware/services, not permission to transmit.

The native driver and command-line tools are included in `drivers/osmo-fl2k`
from Osmocom revision `3706aad7d56fbf8a153c4018585ebe0efe1785e4`, with browser
build guards, short-read handling and open-error resource cleanup patches.
This separate upstream component retains its GPL-2.0-or-later licensing;
see its `COPYING`. Build it with CMake, a C compiler, pkg-config and libusb-1.0
development headers installed:

```shell
cmake -S drivers/osmo-fl2k -B /tmp/webrtlsdr-fl2k-build
cmake --build /tmp/webrtlsdr-fl2k-build
# After exporting fl2k-tx.s8, run from the download directory:
/tmp/webrtlsdr-fl2k-build/src/fl2k_file -s 20000000 -r 0 fl2k-tx.s8
```

Use the sample rate shown in the panel's generated command if you change it.
`-r 0` plays once; Ctrl+C stops TX. The browser cannot stop a native process.
The adapter's achievable DAC rate can differ from the requested rate, changing
the actual carrier and tone frequencies. Verify using measurement equipment.
Use a dummy load, attenuation and suitable output filtering; transmit only
where authorized. Export is capped at 32 million samples to bound browser memory.

### Run the receiver locally

```shell
npm ci --ignore-scripts
emcc --version      # Emscripten is required to build the browser FL2K runtime
npm run build:site   # builds site/
npm run serve        # http://localhost:8080 (WebUSB works on localhost)
```

You can copy the `site/` folder to any static web server. WebUSB requires HTTPS or `localhost`.
After a new version is published, opening the site once switches to it (if
RX or TX is running, a Reload banner appears instead of interrupting it).
There is no backend: after one visit the service worker serves the whole app
(receiver, modulation panel, FL2K Wasm driver, sample export, docs) from the
browser's cache with no server at all, and it can be installed as an app. The
only part not cached on the first visit is the speech model, which downloads
when you first turn transcription on and then also works offline. Opening
`index.html` straight from disk (`file://`) is not supported: Chrome refuses to
load module scripts from `file://`, and the offline cache needs HTTPS or localhost.

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
