// SPDX-License-Identifier: Apache-2.0
//
// A mock FL2000 USB device with the real adapter's descriptors (see
// docs/hardware-e2e.md), behaving like Chrome's USBDevice. It keeps a register
// file for vendor control transfers and records every bulk transfer, so tests
// can run the real Emscripten driver and check the exact bytes it sends.

const alternates = (count, bulkOn) => Array.from({ length: count }, (_, setting) => ({
  alternateSetting: setting,
  interfaceClass: 0x10,
  interfaceSubclass: 0,
  interfaceProtocol: 0,
  endpoints: bulkOn.includes(setting)
    ? [{ endpointNumber: 1, direction: "out", type: "bulk", packetSize: 1024 }, { endpointNumber: 1, direction: "in", type: "bulk", packetSize: 1024 }]
    : [],
}));

// deadStarts: how many sessions start with a silent DAC. Register 0x8000 then
// reads status 5 in bits 8–10 once streaming, instead of 6.
export function mockFl2k({ protectedRefused = false, interfaceClass = 0x10, deadStarts = 0 } = {}) {
  const layout = [
    { interfaceNumber: 0, alternates: alternates(2, [1]) },
    { interfaceNumber: 1, alternates: alternates(7, [1, 2, 3, 4, 5, 6]) },
    { interfaceNumber: 2, alternates: alternates(1, []) },
  ];
  for (const iface of layout) for (const alternate of iface.alternates) alternate.interfaceClass = interfaceClass;
  const claimed = new Set();
  const selected = new Map();
  const registers = new Map();
  let dead = false;
  let streaming = false;
  const device = {
    sessions: 0,
    deadSessions: 0,
    vendorId: 0x1d5c,
    productId: 0x2000,
    productName: "FL2000DX",
    serialNumber: "MOCK-FL2K",
    opened: false,
    registers,
    controlLog: [],
    bulk: [],
    // Replace to inject failures: (endpoint, data) => Promise<USBOutTransferResult>.
    onTransferOut: null,
    get configuration() {
      return {
        configurationValue: 1,
        interfaces: layout.map((iface) => ({
          interfaceNumber: iface.interfaceNumber,
          claimed: claimed.has(iface.interfaceNumber),
          alternates: iface.alternates,
          alternate: iface.alternates[selected.get(iface.interfaceNumber) ?? 0],
        })),
      };
    },
    async open() {
      device.opened = true;
      device.sessions++;
      dead = deadStarts > 0;
      if (dead) { deadStarts--; device.deadSessions++; }
    },
    async close() { device.opened = false; streaming = false; claimed.clear(); selected.clear(); },
    async selectConfiguration() {},
    async claimInterface(number) {
      if (!device.opened) throw new Error("Device not open.");
      if (protectedRefused) throw new Error("Failed to execute 'claimInterface' on 'USBDevice': The requested interface implements a protected class.");
      claimed.add(number);
    },
    async releaseInterface(number) { claimed.delete(number); selected.delete(number); },
    async selectAlternateInterface(number, alternate) {
      if (!claimed.has(number)) throw new Error("Interface not claimed.");
      selected.set(number, alternate);
    },
    async controlTransferIn(setup, length) {
      if (!device.opened) throw new Error("Device closed.");
      device.controlLog.push({ dir: "in", ...setup });
      const data = new DataView(new ArrayBuffer(length));
      const status = streaming ? (dead ? 0x300005c1 : 0x300006c1) : 0x300000c1;
      if (length === 4) data.setUint32(0, setup.index === 0x8000 ? status : registers.get(setup.index) ?? 0, true);
      return { status: "ok", data };
    },
    async controlTransferOut(setup, bytes) {
      if (!device.opened) throw new Error("Device closed.");
      device.controlLog.push({ dir: "out", ...setup });
      if (bytes.length === 4) registers.set(setup.index, new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true));
      return { status: "ok", bytesWritten: bytes.length };
    },
    async transferOut(endpoint, data) {
      if (!device.opened) throw new Error("Device closed.");
      const alternate = layout[0].alternates[selected.get(0) ?? 0];
      if (!claimed.has(0) || !alternate.endpoints.some((e) => e.direction === "out" && e.endpointNumber === endpoint)) throw new Error("Endpoint not available.");
      streaming = true;
      if (device.onTransferOut) return device.onTransferOut(endpoint, data);
      device.bulk.push(new Uint8Array(data));
      return { status: "ok", bytesWritten: data.byteLength };
    },
  };
  return device;
}

export function mockUsb(devices) {
  const listeners = new Map();
  return {
    devices,
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
    removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter((l) => l !== listener)); },
    async getDevices() { return devices; },
    async requestDevice() { return devices[0]; },
    unplug(device) {
      devices.splice(devices.indexOf(device), 1);
      for (const listener of listeners.get("disconnect") || []) listener({ device });
    },
  };
}

// Inverse of fl2k_convert_r in libosmo-fl2k.c: where each of 8 red samples
// lands within a 24-byte group.
const RED = [6, 1, 12, 15, 10, 21, 16, 19];

/** Red-channel bytes from a packed bulk transfer, offset back to signed samples. */
export function unpackRed(bytes) {
  const out = new Int8Array(bytes.length / 3);
  for (let group = 0, j = 0; group < bytes.length; group += 24) {
    for (const position of RED) out[j++] = bytes[group + position] - 128;
  }
  return out;
}
