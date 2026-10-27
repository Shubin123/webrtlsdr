# Physical hardware E2E results

Test date: October 26, 2026. Host: macOS on Apple Silicon, Google Chrome
155.0.8059.85. The web app was served on localhost with its real WebUSB API;
neither USB device nor the received samples were mocked. Browser automation
instrumented the existing USB reads and audio scheduling without replacing
their results. The simulated SDR was explicitly disabled.

## Summary

| Device / path | Result |
| --- | --- |
| RTL2838UHIDIR, `0bda:2838`, browser RX | Pass |
| FL2000, `1d5c:2000`, native enumeration / open / PLL / close | Pass |
| FL2000, normal Chrome WebUSB interface claim | Blocked: protected Audio/Video class `0x10` |
| FL2000 browser TX / RF loopback | Not passed; blocked before streaming |

These results do **not** establish that everything works. In particular, the
connected stock FL2000 cannot be used for TX by this normal static web app.

## RTL-SDR: 17 passing checks

- Live waterfall pixels changed while real USB reads continued.
- AM, NBFM, USB, LSB, CW and WBFM could be selected without interrupting RX
  or triggering browser JavaScript errors (six checks).
- Changing sample rate to 2.048, 2.4 and 1.024 MS/s kept hardware reads
  running (three checks).
- Tuning to 97.7 and 88.5 MHz updated the readout and kept RX running
  (two checks).
- Recording/export produced a 758-byte WebM file with playback muted.
  This checks the recording workflow, not audible reception quality.
- Stopping RX ended further USB reads.
- Restarting RX reopened the real hardware and resumed reads.
- Modulation bookmarks could be saved and deleted.
- The 433.92 MHz CC1101 reference profile correctly disabled out-of-range
  FL2K sample export.

The final run transferred **18,135,040 bytes in 163 USB sample blocks**,
observed input values spanning 0–255, and scheduled 163 audio buffers. There
were no uncaught browser JavaScript errors. The recording and screenshots
remain local test artifacts, not files published with the site. No audio
was uploaded to an external service.

## FL2K: physical compatibility blocker

The actual SuperSpeed USB descriptor configuration contains:

- Interface 0, alternates 0–1: class `0x10`.
- Interface 1, alternates 0–6: class `0x10`.
- Interface 2, alternate 0: class `0x10`.
- Bulk OUT endpoint 1 exists on interface 0 alternate 1 and on interface 1,
  but the surrounding interfaces are protected Audio/Video class.

Chrome returned:

```text
Failed to execute 'claimInterface' on 'USBDevice':
The requested interface implements a protected class.
```

This is a browser interface-class restriction, not an Emscripten compilation
problem. Trying another alternate setting, closing a competing application,
or installing WinUSB does not change the descriptor class. There is no
unprotected fallback interface on this particular adapter.

The native osmo-fl2k library independently reported one adapter and
successfully opened it, selected an actual sample rate of 20,000,000 samples/s,
and closed it. No TX sample stream was started in that native control test.
The hardware is present and accessible to native software; that does not
make it accessible to normal WebUSB.

The web app now inspects interface descriptors before initializing Wasm or
writing USB registers, reports protected classes explicitly, and disables
opening a known-incompatible device. A vendor-specific interface, if a
different adapter legitimately provides one, can be selected without trying
to claim a protected interface first. Regression checks exercised both the
protected-device rejection and permitted interface-1 selection using the
compiled Wasm runtime; those regression checks are software tests, not a
claim of physical FL2K streaming.

For this adapter, use exported sample files with native `fl2k_file`. Controlling
native FL2K from a browser would require an additional local bridge or another
appropriately packaged application. No such bridge is implemented here, and
the site does not try to disable browser protections.

## Not verified

- Physical FL2K transmission, RGB DAC outputs, RF timing or TX/RX loopback.
- RF filtering, output power, attenuation or antenna/load safety.
- Physical unplug/replug behavior.
- Speech transcription and speech-model accuracy.
- Audible station reception quality; the RX run was muted.

## Repeating the browser checks

Build with `npm run build:site` and serve with `npm run serve`. Use a separate
Chrome test profile, grant access to the actual RTL-SDR, disable simulated
mode, and exercise the receive controls listed above. Clear the test profile's
service-worker/cache storage, or wait for its update and reload, to ensure a
previous offline build is not under test. Do not clear the user's normal
browser profile. Verify that sample transfers stop when RX stops.

For FL2K, inspect the actual descriptors and the panel's compatibility result
before attempting TX. Detection alone is not proof of a usable interface.
Do not substitute a mock-device test for a physical-device result.
