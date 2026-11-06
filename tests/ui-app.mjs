// SPDX-License-Identifier: Apache-2.0
//
// UI test of the built site in a real (headless) Chrome: buttons are clicked
// and the page's own text is read, as a user would. The simulated SDR provides
// RX; a mock FL2000 (tests/lib/page-mock-fl2k.mjs) stands in for the adapter,
// so the real Emscripten driver streams to it. For the same flow on real
// hardware in the installed app, see tests/hw-ui-loopback.mjs.
//
// Run: npm run build:site && node tests/ui-app.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launchChrome } from "./lib/chrome.mjs";

const root = path.resolve(import.meta.dirname, "..");
const site = path.join(root, "site");
if (!fs.existsSync(path.join(site, "index.html"))) {
  console.error("SKIP: site/ not built. Run `npm run build:site` first.");
  process.exit(0);
}

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const testFile = url.pathname.match(/^\/__test\/([\w-]+\.mjs)$/)?.[1];
  const file = testFile ? path.join(root, "tests/lib", testFile) : path.join(site, url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  let body = fs.readFileSync(file);
  // The mock must replace navigator.usb before the app's modules run.
  if (file === path.join(site, "index.html")) body = String(body).replace('<script src="app.js"', '<script src="__test/page-mock-fl2k.mjs" type="module"></script>\n    <script src="app.js"');
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://localhost:${server.address().port}/`;

const chrome = await launchChrome();
if (!chrome) {
  console.error("SKIP: Chrome not found. Set CHROME to its executable.");
  server.close();
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
let page;
const ui = (fn, ...args) => page.run(fn, ...args);
// In-page helpers, defined once.
const helpers = () => {
  window.$ = (id) => document.getElementById(id);
  window.setField = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new Event("input", { bubbles: true }));
    $(id).dispatchEvent(new Event("change", { bubbles: true }));
  };
  window.tick = (id, on = true) => {
    if ($(id).checked !== on) $(id).click();
  };
  window.txState = () => $("txControlState").textContent;
  return true;
};
async function arm() {
  await ui(() => tick("fl2kArmed"));
  await page.until(() => !$("fl2kStart").disabled).catch(async (error) => { throw new Error(`${error.message}: ${await ui(() => $("txBlocked").textContent + " / " + $("fl2kStatus").textContent)}`); });
}
async function waitOnAir() {
  await page.until(() => txState().startsWith("TRANSMITTING"), { timeout: 30000 });
}
async function stopTx() {
  await ui(() => $("fl2kStart").click());
  await page.until(() => txState() === "TX off", { timeout: 10000 });
}

console.log("UI tests (headless Chrome, simulated SDR, mock FL2000)\n");

await test("the app loads without JavaScript errors and TX is off", async () => {
  page = await chrome.page(origin);
  await page.until(() => document.readyState === "complete" && window.__fl2k && document.getElementById("fl2kStatus").textContent.includes("detected"));
  await ui(helpers);
  assert.equal(await ui(() => txState()), "TX off");
  assert.equal(await ui(() => $("txIndicatorText").textContent), "Off");
  assert.deepEqual(page.errors, []);
});

await test("the mock adapter is listed and Transmit waits for the setup confirmation", async () => {
  assert.match(await ui(() => $("fl2kDevices").selectedOptions[0].textContent), /FL2000DX/);
  assert.equal(await ui(() => $("fl2kStart").disabled), true);
  assert.match(await ui(() => $("txBlocked").textContent), /Tick the setup confirmation/);
});

await test("transmitting continuously is the default; 'Send once' is opt-in", async () => {
  assert.equal(await ui(() => $("fl2kOnce").checked), false);
  assert.equal(await ui(() => $("fl2kRepeat")), null, "the old opt-in repeat checkbox is gone");
});

await test("simulated RX plays and the signal meter reads", async () => {
  await ui(() => { tick("simulatedBox"); if (!$("startOverlay").hidden) $("startOverlayButton").click(); });
  await ui(() => { setField("freqInput", "30.2"); if ($("playButton").textContent.includes("Play")) $("playButton").click(); });
  await page.until(() => $("playButton").textContent === "Stop RX");
  await page.until(() => /\d+ dB/.test($("signalText").textContent));
});

await test("the transmit frequency raises the DAC rate to carry it", async () => {
  await ui(() => { setField("txMode", "CW"); setField("txCarrier", "30.2"); });
  assert.ok(Number(await ui(() => $("txRate").value)) >= 76);
  assert.match(await ui(() => $("txFreqNote").textContent), /raised to \d+ MS\/s/);
});

await test("Transmit stays on air until Stop, with every on-air indicator", async () => {
  await arm();
  const before = await ui(() => __fl2k.stats.blocks);
  await ui(() => $("fl2kStart").click());
  await waitOnAir();
  await sleep(3000);
  const on = await ui(() => ({
    state: txState(),
    detail: $("txControlDetail").textContent,
    pill: $("txIndicatorText").textContent,
    header: $("fl2kHeaderTx").textContent,
    body: document.body.dataset.tx,
    title: document.title,
    stats: { ...__fl2k.stats },
    since: performance.now() - __fl2k.stats.lastAt,
  }));
  assert.equal(on.state, "TRANSMITTING 30.200 MHz", "still on air after 3 s");
  assert.match(on.detail, /until you press Stop/);
  assert.equal(on.pill, "ON AIR 30.200 MHz");
  assert.equal(on.header, "■ Stop TX");
  assert.equal(on.body, "on");
  assert.match(on.title, /^● TX ON AIR/);
  assert.ok(on.stats.blocks - before >= 20, `only ${on.stats.blocks - before} USB blocks in 3 s`);
  assert.ok(on.stats.active >= 20, "blocks carry the waveform, not silence");
  assert.ok(on.since < 500, "USB blocks are still flowing");
  await stopTx();
  const off = await ui(() => ({ armed: $("fl2kArmed").checked, pill: $("txIndicatorText").textContent, title: document.title, open: __fl2k.device.opened, blocks: __fl2k.stats.blocks }));
  assert.equal(off.armed, false, "the confirmation is cleared");
  assert.equal(off.pill, "Off");
  assert.doesNotMatch(off.title, /ON AIR/);
  assert.equal(off.open, false, "USB is closed");
  await sleep(500);
  assert.equal(await ui(() => __fl2k.stats.blocks), off.blocks, "no USB blocks after Stop");
});

await test("a second transmission works without reconnecting by hand", async () => {
  await arm();
  await ui(() => $("fl2kStart").click());
  await waitOnAir();
  await sleep(1000);
  assert.ok((await ui(() => txState())).startsWith("TRANSMITTING"));
  await stopTx();
});

await test("the top-bar Transmit button starts and stops TX", async () => {
  await arm();
  await ui(() => $("fl2kHeaderTx").click());
  await waitOnAir();
  await ui(() => $("fl2kHeaderTx").click());
  await page.until(() => txState() === "TX off", { timeout: 10000 });
});

await test("'Send once' sends the set duration, then stops by itself", async () => {
  await ui(() => { tick("fl2kOnce"); setField("txDuration", "0.3"); });
  await arm();
  const before = await ui(() => __fl2k.stats.active);
  await ui(() => $("fl2kStart").click());
  await waitOnAir();
  assert.match(await ui(() => $("txControlDetail").textContent), /sending once/);
  await page.until(() => txState() === "TX off", { timeout: 10000 });
  const rate = Number(await ui(() => $("txRate").value)) * 1e6;
  const blocks = (await ui(() => __fl2k.stats.active)) - before;
  // 0.3 s of samples in 1,310,720-sample blocks.
  assert.ok(Math.abs(blocks - Math.ceil((0.3 * rate) / 1310720)) <= 1, `${blocks} blocks with signal`);
  assert.equal(await ui(() => $("fl2kOnce").checked), true, "the preference is kept");
  await ui(() => { tick("fl2kOnce", false); setField("txDuration", "0.1"); });
});

await test("record IQ from RX, then replay it with Transmit", async () => {
  await ui(() => { setField("iqSeconds", "0.5"); $("iqRecord").click(); });
  await page.until(() => /^Recorded 0\.50 s at 30\.200 MHz/.test($("iqStatus").textContent), { timeout: 10000 });
  await ui(() => $("iqUse").click());
  assert.equal(await ui(() => $("fl2kSource").value), "replay");
  await arm();
  const before = await ui(() => __fl2k.stats.active);
  await ui(() => $("fl2kStart").click());
  await waitOnAir();
  await sleep(1500);
  assert.match(await ui(() => $("txControlDetail").textContent), /IQ replay .* recorded at 30\.200 MHz/);
  assert.ok((await ui(() => __fl2k.stats.active)) - before >= 10, "the replay is streamed");
  await stopTx();
});

await test("hiding the page stops TX", async () => {
  await ui(() => setField("fl2kSource", "generated"));
  await arm();
  await ui(() => $("fl2kStart").click());
  await waitOnAir();
  await ui(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.until(() => txState() === "TX off", { timeout: 10000 });
  await ui(() => { delete document.hidden; });
});

await test("no JavaScript errors during the run", async () => {
  assert.deepEqual(page.errors, []);
});

page?.close();
await chrome.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
