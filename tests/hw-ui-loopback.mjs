// SPDX-License-Identifier: Apache-2.0
//
// Physical hardware UI test of the installed app: installs the signed bundle
// (default dist-iwa/webrtlsdr.swbn; set BUNDLE to test a downloaded release)
// as an Isolated Web App in a throwaway Chrome profile, then clicks through it
// like a user: real RTL-SDR RX, Transmit on the real FL2K, and record & replay.
// Pass/fail is read from the app's own signal meter.
//
// THIS TRANSMITS. Cable the FL2K red output through an attenuator into the
// RTL-SDR (as in docs/hardware-e2e.md); do not connect an antenna.
//
// Chrome's USB chooser cannot be automated, so the devices are granted to the
// app by Chrome's WebUsbAllowDevicesForUrls policy. On macOS the test sets it
// for this app's origin only (in com.google.Chrome) and removes it afterwards.
// Elsewhere set the policy yourself; see
// https://chromeenterprise.google/policies/#WebUsbAllowDevicesForUrls
//
// Run: npm run build:site && npm run build:iwa && npm run test:hardware-ui

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchChrome } from "./lib/chrome.mjs";
import { nodeWebUsb } from "./lib/node-webusb.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bundle = path.resolve(process.env.BUNDLE || path.join(root, "dist-iwa/webrtlsdr.swbn"));
if (!fs.existsSync(bundle)) {
  console.error(`SKIP: ${path.relative(root, bundle)} not built. Run \`npm run build:site && npm run build:iwa\`.`);
  process.exit(0);
}
const usb = nodeWebUsb();
const attached = usb ? await usb.getDevices() : [];
if (!attached.some((d) => d.vendorId === 0x1d5c && d.productId === 0x2000) || !attached.some((d) => d.vendorId === 0x0bda && [0x2832, 0x2838].includes(d.productId))) {
  console.error("SKIP: needs an FL2000 (1d5c:2000) and an RTL-SDR (0bda:2832/2838) attached.");
  process.exit(0);
}

// The app ID is in the bundle's integrity block.
const header = fs.readFileSync(bundle).subarray(0, 512).toString("latin1");
const appId = header.match(/webBundleId.{1,3}?([a-z2-7]{56})/)?.[1];
assert.ok(appId, "no web bundle ID in the bundle's integrity block");
const appUrl = `isolated-app://${appId}/`;

const policy = { devices: [{ vendor_id: 0x1d5c, product_id: 0x2000 }, { vendor_id: 0x0bda, product_id: 0x2838 }, { vendor_id: 0x0bda, product_id: 0x2832 }], urls: [appUrl] };
let policySet = false;
if (process.platform === "darwin") {
  const plist = `<dict><key>devices</key><array>${policy.devices.map((d) => `<dict><key>vendor_id</key><integer>${d.vendor_id}</integer><key>product_id</key><integer>${d.product_id}</integer></dict>`).join("")}</array><key>urls</key><array><string>${appUrl}</string></array></dict>`;
  let existing = "";
  try { existing = execFileSync("defaults", ["read", "com.google.Chrome", "WebUsbAllowDevicesForUrls"], { stdio: ["ignore", "pipe", "ignore"] }).toString(); } catch {}
  if (!existing.includes(appUrl)) {
    if (existing) {
      console.error("SKIP: WebUsbAllowDevicesForUrls is already set for other origins; add this app to it by hand:", JSON.stringify(policy));
      process.exit(0);
    }
    execFileSync("defaults", ["write", "com.google.Chrome", "WebUsbAllowDevicesForUrls", "-array", plist]);
    policySet = true;
    console.log(`Granted the FL2K and RTL-SDR to ${appUrl} by Chrome policy for this run.`);
  }
}
const cleanup = () => { if (policySet) { execFileSync("defaults", ["delete", "com.google.Chrome", "WebUsbAllowDevicesForUrls"]); policySet = false; } };
process.on("exit", cleanup);

const chrome = await launchChrome({
  headless: false,
  flags: ["enable-isolated-web-apps@1", "enable-isolated-web-app-dev-mode@1", "enable-unrestricted-usb@1"],
  args: [`--install-isolated-web-app-from-file=${bundle}`],
});
if (!chrome) {
  console.error("SKIP: Chrome not found. Set CHROME to its executable.");
  process.exit(0);
}

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;
const MHZ = process.env.TX_MHZ ?? "30.2";
let page;
const ui = (fn, ...args) => page.run(fn, ...args);
const helpers = () => {
  window.$ = (id) => document.getElementById(id);
  window.setField = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new Event("input", { bubbles: true }));
    $(id).dispatchEvent(new Event("change", { bubbles: true }));
  };
  window.tick = (id, on = true) => { if ($(id).checked !== on) $(id).click(); };
  window.txState = () => $("txControlState").textContent;
  window.meter = () => Number.parseFloat($("signalText").textContent) || 0;
  // Signal meter readings every 100 ms for `ms`, and how long TX was on air meanwhile.
  window.watch = async (ms) => {
    const readings = [];
    let onAir = 0;
    for (const end = performance.now() + ms; performance.now() < end;) {
      readings.push(meter());
      if (txState().startsWith("TRANSMITTING")) onAir += 100;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { readings, onAir };
  };
  return true;
};
async function transmit() {
  await ui(() => tick("fl2kArmed"));
  await page.until(() => !$("fl2kStart").disabled).catch(async (error) => { throw new Error(`${error.message}: ${await ui(() => $("txBlocked").textContent)}`); });
  await ui(() => $("fl2kStart").click());
  await page.until(() => txState().startsWith("TRANSMITTING"), { timeout: 30000 });
}
async function stopTx() {
  await ui(() => $("fl2kStart").click());
  await page.until(() => txState() === "TX off", { timeout: 10000 });
}

console.log(`Installed-app hardware UI tests (${path.basename(bundle)}, real FL2K + RTL-SDR)\n`);

await test("the bundle installs and opens as the installed app", async () => {
  page = await chrome.page(appUrl, { timeout: 60000 });
  await page.until(() => document.readyState === "complete" && /authorized FL2K/.test(document.getElementById("fl2kStatus")?.textContent ?? ""), { timeout: 30000 });
  await ui(helpers);
  assert.match(await ui(() => $("fl2kIwaStatus").textContent), /Running as installed app/);
});
if (!page) {
  await chrome.close();
  cleanup();
  process.exit(1);
}

await test("both real devices are available to the app", async () => {
  const devices = await ui(async () => (await navigator.usb.getDevices()).map((d) => d.vendorId));
  assert.ok(devices.includes(0x1d5c) && devices.includes(0x0bda), JSON.stringify(devices));
  assert.match(await ui(() => $("fl2kDevices").selectedOptions[0].textContent), /FL2000|adapter/);
  assert.doesNotMatch(await ui(() => $("fl2kDevices").selectedOptions[0].textContent), /blocked/);
});

let idle = 0;
await test(`real RTL-SDR RX plays at ${MHZ} MHz`, async () => {
  await ui(() => { tick("simulatedBox", false); if (!$("startOverlay").hidden) $("startOverlayButton").click(); });
  await ui((mhz) => { setField("schemeSelect", "AM"); setField("freqInput", mhz); if ($("playButton").textContent.includes("Play")) $("playButton").click(); }, MHZ);
  await page.until(() => $("playButton").textContent === "Stop RX", { timeout: 20000 });
  await page.until(() => /\d+ dB/.test($("signalText").textContent), { timeout: 20000 });
  await sleep(2000);
  idle = median((await ui(() => watch(2000))).readings);
  console.log(`        idle signal meter ${idle} dB`);
});

async function carrierTest(label) {
  await ui((mhz) => { setField("fl2kSource", "generated"); setField("txMode", "CW"); setField("txCarrier", mhz); }, MHZ);
  await transmit();
  const { readings, onAir } = await ui(() => watch(5000));
  const status = await ui(() => $("txControlState").textContent);
  await stopTx();
  const after = median((await ui(() => watch(2000))).readings);
  const during = median(readings);
  console.log(`        ${label}: on air ${(onAir / 1000).toFixed(1)} s of 5, meter median ${during} dB (idle ${idle}, after Stop ${after})`);
  assert.equal(status, `TRANSMITTING ${Number(MHZ).toFixed(3)} MHz`, "still on air after 5 s");
  assert.ok(onAir >= 4800, `only on air for ${onAir} ms`);
  assert.ok(during - idle >= 20, `carrier only ${during - idle} dB over idle`);
  assert.ok(during - after >= 15, `meter fell only ${during - after} dB after Stop`);
}

await test("pressing Transmit with the default settings is received for as long as it is on", () => carrierTest("first"));
await test("a second Transmit is received as well", () => carrierTest("second"));

await test("record IQ of an OOK transmission, then replay it and receive it", async () => {
  await ui(() => { setField("txMode", "OOK"); setField("iqSeconds", "1"); });
  await transmit();
  await sleep(500);
  await ui(() => $("iqRecord").click());
  await page.until((mhz) => $("iqStatus").textContent.startsWith(`Recorded 1.00 s at ${Number(mhz).toFixed(3)} MHz`), { timeout: 10000, args: [MHZ] });
  await stopTx();
  await sleep(1000);
  const quiet = median((await ui(() => watch(1500))).readings);
  await ui(() => $("iqUse").click());
  assert.equal(await ui(() => $("fl2kSource").value), "replay");
  await transmit();
  const { readings, onAir } = await ui(() => watch(4000));
  const detail = await ui(() => $("txControlDetail").textContent);
  await stopTx();
  const during = median(readings);
  console.log(`        replay: on air ${(onAir / 1000).toFixed(1)} s of 4, meter median ${during} dB (before ${quiet})`);
  assert.match(detail, /IQ replay/);
  assert.ok(onAir >= 3800, `replay only on air for ${onAir} ms`);
  assert.ok(during - quiet >= 15, `replay only ${during - quiet} dB over idle`);
  await ui(() => setField("fl2kSource", "generated"));
});

await test("no JavaScript errors during the run", async () => {
  assert.deepEqual(page.errors, []);
});

await ui(() => { if ($("playButton").textContent === "Stop RX") $("playButton").click(); }).catch(() => {});
page.close();
await chrome.close();
cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
