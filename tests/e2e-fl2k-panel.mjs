// SPDX-License-Identifier: Apache-2.0
//
// End-to-end test for the FL2K panel, IWA integration, and build artifacts.
// Verifies file structure, HTML elements, and the IWA detection logic.
//
// Run: node tests/e2e-fl2k-panel.mjs

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(import.meta.dirname, "..");
const site = path.join(root, "site");

if (!fs.existsSync(path.join(site, "index.html"))) {
  console.error("SKIP: site/ not built. Run `npm run build:site` first.");
  process.exit(0);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

console.log("FL2K panel E2E tests\n");

const html = fs.readFileSync(path.join(site, "index.html"), "utf8");

// --------------------------------------------------------------------------
// FL2K panel HTML structure
// --------------------------------------------------------------------------

test("index.html contains FL2K hardware panel", () => {
  assert.ok(html.includes('class="fl2k-hardware"'), "fl2k-hardware section missing");
});

test("FL2K device select exists", () => {
  assert.ok(html.includes('id="fl2kDevices"'), "fl2kDevices select missing");
});

test("FL2K request button exists", () => {
  assert.ok(html.includes('id="fl2kRequest"'), "fl2kRequest button missing");
});

test("FL2K transmit button exists", () => {
  assert.ok(html.includes('id="fl2kStart"'), "fl2kStart button missing");
});

test("FL2K header TX button exists in topbar", () => {
  assert.ok(html.includes('id="fl2kHeaderTx"'), "fl2kHeaderTx button missing");
});

// --------------------------------------------------------------------------
// IWA integration elements
// --------------------------------------------------------------------------

test("IWA status section exists", () => {
  assert.ok(html.includes('id="fl2kIwa"'), "fl2kIwa div missing");
  assert.ok(html.includes('id="fl2kIwaStatus"'), "fl2kIwaStatus paragraph missing");
});

test("IWA download link exists with correct URL", () => {
  assert.ok(html.includes('id="fl2kIwaLink"'), "fl2kIwaLink anchor missing");
  assert.ok(
    html.includes("webrtlsdr.swbn"),
    "IWA download link does not reference .swbn bundle",
  );
});

test("IWA install instructions exist", () => {
  assert.ok(html.includes('id="fl2kInstall"'), "fl2kInstall section missing");
  assert.ok(html.includes("chrome://flags"), "chrome://flags instructions missing");
  assert.ok(html.includes("chrome://iwa-dev"), "chrome://iwa-dev instructions missing");
});

// --------------------------------------------------------------------------
// FL2K device detection module
// --------------------------------------------------------------------------

const { inspectFl2k, isFl2k, installedApp, usbUnrestricted } = await import(
  path.join(root, "app/fl2k-device.js")
);

test("isFl2k identifies FL2000 USB vendor/product", () => {
  assert.ok(isFl2k({ vendorId: 0x1d5c, productId: 0x2000 }));
  assert.ok(!isFl2k({ vendorId: 0x0bda, productId: 0x2832 }));
  assert.ok(!isFl2k({ vendorId: 0x1d5c, productId: 0x1234 }));
});

test("installedApp returns false in Node.js", () => {
  assert.equal(installedApp(), false);
});

test("usbUnrestricted returns false in Node.js", () => {
  assert.equal(usbUnrestricted(), false);
});

test("inspectFl2k rejects device without bulk OUT endpoint", () => {
  const device = {
    vendorId: 0x1d5c,
    productId: 0x2000,
    configuration: {
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 0,
        alternates: [{ interfaceClass: 0xff, alternateSetting: 0, endpoints: [] }],
      }],
    },
  };
  const result = inspectFl2k(device);
  assert.equal(result.supported, false);
});

test("inspectFl2k accepts device with bulk OUT on endpoint 1", () => {
  const device = {
    vendorId: 0x1d5c,
    productId: 0x2000,
    configuration: {
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 0,
        alternates: [{
          interfaceClass: 0xff,
          alternateSetting: 1,
          endpoints: [{ direction: "out", type: "bulk", endpointNumber: 1 }],
        }],
      }],
    },
  };
  const result = inspectFl2k(device, true);
  assert.equal(result.supported, true);
  assert.equal(result.interface, 0);
  assert.equal(result.alternate, 1);
});

test("inspectFl2k rejects protected class without unrestricted", () => {
  const device = {
    vendorId: 0x1d5c,
    productId: 0x2000,
    configuration: {
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 0,
        alternates: [{
          interfaceClass: 0x10,
          alternateSetting: 1,
          endpoints: [{ direction: "out", type: "bulk", endpointNumber: 1 }],
        }],
      }],
    },
  };
  const result = inspectFl2k(device, false);
  assert.equal(result.supported, false);
  assert.ok(result.reason.includes("protected"), "reason should mention protected class");
});

// --------------------------------------------------------------------------
// FL2K build artifacts
// --------------------------------------------------------------------------

test("FL2K runtime.js exists in site", () => {
  assert.ok(fs.existsSync(path.join(site, "fl2k/runtime.js")));
});

test("FL2K COPYING.txt exists in site", () => {
  assert.ok(fs.existsSync(path.join(site, "fl2k/COPYING.txt")));
});

test("FL2K hardware-e2e.txt exists in site", () => {
  assert.ok(fs.existsSync(path.join(site, "fl2k/hardware-e2e.txt")));
});

test("FL2K source archive exists in site", () => {
  assert.ok(fs.existsSync(path.join(site, "fl2k/source.tar.gz")));
});

// --------------------------------------------------------------------------
// IWA build script
// --------------------------------------------------------------------------

test("IWA build script exists", () => {
  assert.ok(fs.existsSync(path.join(root, "scripts/build-iwa.mjs")));
});

test("IWA build script references usb-unrestricted permission", () => {
  const script = fs.readFileSync(path.join(root, "scripts/build-iwa.mjs"), "utf8");
  assert.ok(
    script.includes("usb-unrestricted"),
    "IWA manifest should request usb-unrestricted permission",
  );
});

// --------------------------------------------------------------------------
// TX signal validation
// --------------------------------------------------------------------------

const { validateTx, prepareTx } = await import(path.join(root, "app/tx-signal.js"));

test("prepareTx generates valid CW config", () => {
  const config = prepareTx({
    mode: "CW",
    carrier: 40.2e6,
    rate: 100e6,
    tone: 1000,
    depth: 0.8,
    deviation: 5000,
    level: 0.8,
    duration: 0.1,
  });
  assert.equal(config.mode, "CW");
  assert.equal(config.carrier, 40.2e6);
  validateTx(config);
});

test("prepareTx generates valid AM config", () => {
  const config = prepareTx({
    mode: "AM",
    carrier: 1e6,
    rate: 20e6,
    tone: 1000,
    depth: 0.8,
    deviation: 5000,
    level: 0.25,
    duration: 0.1,
  });
  assert.equal(config.mode, "AM");
  validateTx(config);
});

// --------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
