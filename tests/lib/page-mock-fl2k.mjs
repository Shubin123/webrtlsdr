// SPDX-License-Identifier: Apache-2.0
//
// Loaded by tests/ui-app.mjs into the page before the app: replaces
// navigator.usb with one mock FL2000 whose interface is vendor-specific (so the
// website may claim it) and whose bulk transfers take real time. It keeps
// counters rather than the transferred bytes, so long transmissions stay small.

import { mockFl2k, mockUsb, unpackRed } from "./mock-fl2k.mjs";

const device = mockFl2k({ interfaceClass: 0xff });
const stats = { blocks: 0, active: 0, lastAt: 0 };
device.onTransferOut = async (endpoint, data) => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  const red = unpackRed(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength));
  stats.blocks++;
  stats.lastAt = performance.now();
  // A block counts as active when its red samples are not all at midpoint.
  if (red.some((sample) => Math.abs(sample) > 2)) stats.active++;
  return { status: "ok", bytesWritten: data.byteLength };
};
Object.defineProperty(navigator, "usb", { value: mockUsb([device]), configurable: true });
window.__fl2k = { device, stats };
