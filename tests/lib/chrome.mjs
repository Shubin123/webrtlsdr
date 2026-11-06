// SPDX-License-Identifier: Apache-2.0
//
// Launches a throwaway Chrome profile and drives pages over the DevTools
// protocol, without extra dependencies (Node's built-in WebSocket).
// Set CHROME to the browser executable if it is not found automatically.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const candidates = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/homebrew/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

export const chromePath = () => candidates.find((file) => fs.existsSync(file));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts Chrome with a fresh profile.
 * @param {{args?: string[], flags?: string[], headless?: boolean}} options
 *   `flags` are chrome://flags entries ("name@1") written into the profile.
 */
export async function launchChrome({ args = [], flags = [], headless = true } = {}) {
  const executable = chromePath();
  if (!executable) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "webrtlsdr-chrome-"));
  if (flags.length) fs.writeFileSync(path.join(profile, "Local State"), JSON.stringify({ browser: { enabled_labs_experiments: flags } }));
  const port = 9400 + Math.floor(Math.random() * 500);
  const child = spawn(executable, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    ...(headless ? ["--headless=new"] : []),
    ...args,
    "about:blank",
  ], { stdio: process.env.VERBOSE ? "inherit" : "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/json/version`); break; } catch { await sleep(100); }
  }
  return {
    async targets() { return (await fetch(`${base}/json`)).json(); },
    /** Opens `url` in a new tab, or attaches to an existing page/app window whose URL contains it. */
    // Opening is retried: an app being installed cannot be opened yet.
    async page(url, { open = true, timeout = 20000 } = {}) {
      const end = Date.now() + timeout;
      let target;
      for (let attempt = 0; !(target = (await this.targets()).find((t) => ["page", "app"].includes(t.type) && t.url.startsWith(url))) && Date.now() < end; attempt++) {
        if (open && attempt % 15 === 0) await fetch(`${base}/json/new?${url}`, { method: "PUT" }).catch(() => {});
        await sleep(200);
      }
      if (!target) throw new Error(`no page at ${url}`);
      return connect(target.webSocketDebuggerUrl);
    },
    async close() {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const my = ++id;
    pending.set(my, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  await send("Runtime.enable");
  return {
    send,
    /** JavaScript errors the page has thrown since attaching. */
    errors,
    /** Evaluates `fn(...args)` in the page (as a user gesture) and returns its value. */
    async run(fn, ...args) {
      const result = await send("Runtime.evaluate", {
        expression: `(${fn})(...${JSON.stringify(args)})`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    /** Waits until `fn(...args)` returns something truthy in the page. */
    async until(fn, { timeout = 15000, args = [] } = {}) {
      const end = Date.now() + timeout;
      let value;
      while (!(value = await this.run(fn, ...args).catch(() => undefined)) && Date.now() < end) await sleep(100);
      if (!value) throw new Error(`timed out waiting for ${String(fn).slice(0, 120)}`);
      return value;
    },
    close() { ws.close(); },
  };
}
