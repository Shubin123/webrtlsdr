// SPDX-License-Identifier: Apache-2.0
//
// WebUSB for Node, backed by the `usb` package, so the app's own drivers can
// talk to real hardware outside a browser.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// node-usb leaves `interface.alternate` at the old setting after
// selectAlternateInterface(); Chrome updates it, and fl2k-device.js relies on that.
function trackAlternates(device) {
  const selected = new Map();
  const wrapped = Object.create(device);
  for (const name of ["open", "reset", "selectConfiguration", "claimInterface", "controlTransferIn", "controlTransferOut", "transferOut", "transferIn"]) {
    wrapped[name] = (...args) => device[name](...args);
  }
  wrapped.selectAlternateInterface = async (number, alternate) => {
    await device.selectAlternateInterface(number, alternate);
    selected.set(number, alternate);
  };
  wrapped.releaseInterface = async (number) => {
    await device.releaseInterface(number);
    selected.delete(number);
  };
  wrapped.close = async () => {
    await device.close();
    selected.clear();
  };
  for (const name of ["opened", "vendorId", "productId", "productName", "serialNumber", "configurations"]) {
    Object.defineProperty(wrapped, name, { get: () => { try { return device[name]; } catch { return undefined; } } });
  }
  Object.defineProperty(wrapped, "configuration", {
    get() {
      const configuration = device.configuration;
      if (!configuration) return configuration;
      return {
        ...configuration,
        interfaces: configuration.interfaces.map((iface) => ({
          interfaceNumber: iface.interfaceNumber,
          claimed: iface.claimed,
          alternates: iface.alternates,
          alternate: selected.has(iface.interfaceNumber)
            ? iface.alternates.find((alternate) => alternate.alternateSetting === selected.get(iface.interfaceNumber))
            : iface.alternate,
        })),
      };
    },
  });
  return wrapped;
}

/** A navigator.usb stand-in with access to every attached device, or null if `usb` cannot load. */
export function nodeWebUsb() {
  let WebUSB;
  try { ({ WebUSB } = require("usb")); } catch { return null; }
  const usb = new WebUSB({ allowAllDevices: true });
  const wrapped = new Map();
  return {
    addEventListener: (...args) => usb.addEventListener?.(...args),
    removeEventListener: (...args) => usb.removeEventListener?.(...args),
    async getDevices() {
      return (await usb.getDevices()).map((device) => {
        if (!wrapped.has(device)) wrapped.set(device, trackAlternates(device));
        return wrapped.get(device);
      });
    },
  };
}

/** Lets fl2k-device.js claim the FL2000's Audio/Video-class interface, as the installed app can. */
export function allowProtectedUsb() {
  globalThis.document = { featurePolicy: { allowsFeature: (feature) => feature === "usb-unrestricted" } };
}
