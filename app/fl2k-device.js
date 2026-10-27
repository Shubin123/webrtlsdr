import createFl2k from "./fl2k/runtime.js";

export const FL2K_SAMPLES = 1280 * 1024;
export const FL2K_BYTES = FL2K_SAMPLES * 3;
export const isFl2k = (device) => device.vendorId === 0x1d5c && device.productId === 0x2000;

const protectedClasses = new Set([0x01, 0x03, 0x08, 0x0b, 0x0e, 0x10, 0xe0]);

export function inspectFl2k(device) {
  const configurations = device.configuration ? [device.configuration] : (device.configurations || []);
  const blocked = new Set();
  for (const configuration of configurations) {
    for (const iface of configuration.interfaces) {
      if (![0, 1].includes(iface.interfaceNumber)) continue;
      const alternates = iface.alternates || [iface.alternate];
      const protectedAlternates = alternates.filter((alternate) => protectedClasses.has(alternate.interfaceClass));
      if (protectedAlternates.length) {
        protectedAlternates.forEach((alternate) => blocked.add(alternate.interfaceClass));
        continue;
      }
      const alternate = alternates.find((setting) => setting.endpoints.some((endpoint) => endpoint.direction === "out" && endpoint.type === "bulk" && endpoint.endpointNumber === 1));
      if (alternate) return { supported: true, configuration: configuration.configurationValue, interface: iface.interfaceNumber, alternate: alternate.alternateSetting };
    }
  }
  const classes = [...blocked].map((value) => `0x${value.toString(16).padStart(2, "0")}`).join(", ");
  return {
    supported: false,
    reason: classes
      ? `FL2K detected, but its USB interfaces use browser-protected class ${classes}${blocked.has(0x10) ? " (Audio/Video)" : ""}. Normal WebUSB cannot access this adapter, and Emscripten, WinUSB or Chrome flags do not remove this restriction. Use Export FL2K TX samples (works offline) and play the file with native fl2k_file.`
      : "FL2K detected, but no accessible bulk OUT endpoint 1 exists on interface 0 or 1.",
  };
}

export class Fl2kDevice extends EventTarget {
  constructor(usb = globalThis.navigator?.usb, factory = createFl2k) {
    super();
    this.usb = usb;
    this.factory = factory;
    this.devices = [];
    this.module = null;
    this.connected = false;
    this.running = false;
    this.transmitting = false;
    this.stopping = false;
    this.actualRate = 0;
    this.queue = Promise.resolve();
    this.transport = { devices: [], device: null, error: "", call: (...args) => this.usbCall(...args) };
    this.disconnectListener = (event) => {
      if (event.device === this.transport.device) {
        this.stop().catch((error) => this.report(error.message));
        this.report("FL2K unplugged. TX stopped; reconnect explicitly to use it again.");
      }
      this.scan().catch((error) => this.report(error.message));
    };
    this.connectListener = () => this.scan().catch((error) => this.report(error.message));
    this.usb?.addEventListener("disconnect", this.disconnectListener);
    this.usb?.addEventListener("connect", this.connectListener);
  }

  report(message) {
    this.dispatchEvent(new CustomEvent("status", { detail: { message, connected: this.connected, running: this.running, rate: this.actualRate } }));
  }

  async scan() {
    if (!this.usb) throw new Error("WebUSB unavailable. Use Chromium over HTTPS or localhost.");
    this.devices = (await this.usb.getDevices()).filter(isFl2k);
    this.dispatchEvent(new CustomEvent("devices", { detail: this.devices }));
    return this.devices;
  }

  async request() {
    if (!this.usb) throw new Error("WebUSB unavailable. Use Chromium over HTTPS or localhost.");
    const device = await this.usb.requestDevice({ filters: [{ vendorId: 0x1d5c, productId: 0x2000 }] });
    await this.scan();
    return this.open(device);
  }

  async initialize() {
    if (!this.module) this.module = await this.factory({ usb: this.transport });
    return this.module;
  }

  serial(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async invoke(name, args = []) {
    this.transport.error = "";
    const result = await this.module.ccall(name, "number", args.map(() => "number"), args, { async: true });
    if (result < 0) {
      const message = this.transport.error || `FL2K ${name} failed (${result}).`;
      if (!this.transport.device?.opened && name !== "fl2k_web_close") {
        try { await this.module.ccall("fl2k_web_close", "number", [], [], { async: true }); } catch {}
        this.connected = false;
        this.actualRate = 0;
      }
      throw new Error(message);
    }
    return result;
  }

  async usbCall(operation, index, argument, extra) {
    if (operation === 0) {
      this.transport.device = this.transport.devices[index];
      if (!this.transport.device) throw new Error("FL2K device is no longer available.");
      await this.transport.device.open();
      if (this.transport.device.configuration?.configurationValue !== this.usbInterface.configuration) await this.transport.device.selectConfiguration(this.usbInterface.configuration);
      return;
    }
    const device = this.transport.device;
    if (!device?.opened) {
      if (operation === 1 || operation === 3) return;
      throw new Error("FL2K USB connection is closed.");
    }
    if (operation === 1) {
      for (const iface of device.configuration.interfaces) {
        if (iface.claimed) await device.releaseInterface(iface.interfaceNumber);
      }
      await device.close();
    } else if (operation === 2) await device.claimInterface(this.usbInterface.interface);
    else if (operation === 3) {
      if (device.configuration.interfaces.some((iface) => iface.interfaceNumber === this.usbInterface.interface && iface.claimed)) await device.releaseInterface(this.usbInterface.interface);
    } else if (operation === 4) await device.selectAlternateInterface(this.usbInterface.interface, this.usbInterface.alternate);
  }

  async open(device) {
    return this.serial(async () => {
      if (this.connected || this.transmitting) throw new Error("Disconnect the current FL2K first.");
      if (!device || !isFl2k(device)) throw new Error("Select an authorized FL2000DX adapter.");
      this.usbInterface = inspectFl2k(device);
      if (!this.usbInterface.supported) throw new Error(this.usbInterface.reason);
      await this.initialize();
      this.transport.devices = [device];
      try {
        await this.invoke("fl2k_web_open", [0]);
        const bulk = device.configuration.interfaces.some((iface) => iface.claimed && iface.alternate.endpoints.some((endpoint) => endpoint.direction === "out" && endpoint.type === "bulk" && endpoint.endpointNumber === 1));
        if (!bulk) throw new Error("FL2K bulk OUT endpoint 1 is unavailable in the claimed interface.");
        this.connected = true;
        this.report(`Connected: ${device.productName || "FL2000DX"}. TX is off.`);
      } catch (error) {
        await this.invoke("fl2k_web_close").catch(() => {});
        if (device.opened) await device.close().catch(() => {});
        throw new Error(`${error.message} Close other FL2K/display applications; WebUSB cannot detach an OS display/storage driver. Windows may require WinUSB and Linux USB permissions.`);
      }
    });
  }

  assertIdle() {
    if (!this.connected) throw new Error("Connect an FL2K first.");
    if (this.transmitting) throw new Error("Stop TX before changing device configuration.");
  }

  async setSampleRate(rate) {
    return this.serial(async () => {
      this.assertIdle();
      if (!Number.isInteger(rate) || rate < 8e6 || rate > 160e6) throw new Error("DAC rate must be 8–160 MS/s.");
      await this.invoke("fl2k_web_set_rate", [rate]);
      this.actualRate = this.module._fl2k_web_get_rate();
      this.report(`Actual DAC rate: ${this.actualRate.toLocaleString()} samples/s. TX is off.`);
      return this.actualRate;
    });
  }

  async register(reg, value) {
    return this.serial(async () => {
      this.assertIdle();
      if (!Number.isInteger(reg) || reg < 0 || reg > 0xffff || (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))) throw new Error("Use a 16-bit register address and 32-bit unsigned value.");
      if (value !== undefined) {
        const result = await this.invoke("fl2k_web_write_reg", [reg, value]);
        this.actualRate = 0;
        return result;
      }
      const pointer = this.module._malloc(4);
      if (!pointer) throw new Error("FL2K Wasm allocation failed.");
      try {
        await this.invoke("fl2k_web_read_reg", [reg, pointer]);
        return new DataView(this.module.HEAPU8.buffer).getUint32(pointer, true);
      } finally { this.module._free(pointer); }
    });
  }

  async i2c(address, reg, bytes) {
    return this.serial(async () => {
      this.assertIdle();
      if (!Number.isInteger(address) || address < 0 || address > 127 || !Number.isInteger(reg) || reg < 0 || reg > 255) throw new Error("Use a 7-bit I²C address and an 8-bit register.");
      if (bytes !== undefined && (!(bytes instanceof Uint8Array) || bytes.length !== 4)) throw new Error("I²C writes require exactly four bytes.");
      const pointer = this.module._malloc(4);
      if (!pointer) throw new Error("FL2K Wasm allocation failed.");
      try {
        if (bytes) this.module.HEAPU8.set(bytes, pointer);
        await this.invoke(bytes ? "fl2k_web_i2c_write" : "fl2k_web_i2c_read", [address, reg, pointer]);
        return this.module.HEAPU8.slice(pointer, pointer + 4);
      } finally { this.module._free(pointer); }
    });
  }

  async startTx({ red, green, blue, signed = true, repeat = false, queueDepth = 2 }) {
    await this.serial(async () => {
      this.assertIdle();
      if (!this.actualRate) throw new Error("Apply a sample rate before TX.");
      if (!Number.isInteger(queueDepth) || queueDepth < 1 || queueDepth > 4) throw new Error("USB queue depth must be 1–4.");
      const channels = [red, green, blue];
      if (!channels.some(Boolean)) throw new Error("Provide at least one DAC channel.");
      for (const channel of channels.filter(Boolean)) {
        if (!(channel instanceof Int8Array || channel instanceof Uint8Array) || !channel.length || channel.length > 32000000) throw new Error("Each DAC channel must contain 1–32 million 8-bit samples.");
      }
      const lengths = channels.filter(Boolean).map((channel) => channel.length);
      if (!lengths.every((length) => length === lengths[0])) throw new Error("RGB channels must have equal sample counts.");
      this.running = true;
      this.transmitting = true;
      this.stopping = false;
      this.stats = { bytes: 0, transfers: 0, started: performance.now() };
      this.report("TX ACTIVE — streaming DAC samples over WebUSB.");
      this.stream = this.pump(channels, lengths[0], signed, repeat, queueDepth);
    });
    return this.stream;
  }

  async bulk(bytes) {
    const device = this.transport.device;
    let timer;
    try {
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          device.close().catch(() => {});
          reject(new Error("FL2K bulk transfer timed out; connection closed."));
        }, 5000);
      });
      const result = await Promise.race([device.transferOut(1, bytes), timeout]);
      if (result.status !== "ok" || result.bytesWritten !== bytes.length) throw new Error("FL2K short or stalled bulk transfer. TX stopped.");
      this.stats.bytes += bytes.length;
      this.stats.transfers++;
      this.dispatchEvent(new CustomEvent("progress", { detail: { ...this.stats, elapsed: performance.now() - this.stats.started } }));
    } finally { clearTimeout(timer); }
  }

  async pump(channels, length, signed, repeat, queueDepth) {
    const module = this.module;
    const pointers = [];
    const pending = new Set();
    let failure;
    let offset = 0;
    let sent = 0;
    try {
      for (let index = 0; index < 4; index++) {
        const pointer = module._malloc(index === 0 ? FL2K_BYTES : FL2K_SAMPLES);
        if (!pointer) throw new Error("FL2K Wasm buffer allocation failed.");
        pointers.push(pointer);
      }
      const fill = (channel, pointer) => {
        module.HEAPU8.fill(signed ? 0 : 128, pointer, pointer + FL2K_SAMPLES);
        if (!channel) return 0;
        for (let written = 0; written < FL2K_SAMPLES;) {
          const position = (offset + written) % length;
          const count = Math.min(FL2K_SAMPLES - written, length - position, repeat ? FL2K_SAMPLES : Math.max(0, length - offset - written));
          if (!count) break;
          module.HEAPU8.set(channel.subarray(position, position + count), pointer + written);
          written += count;
        }
        return pointer;
      };
      while (this.running && (repeat || offset < length)) {
        const channelPointers = channels.map((channel, index) => fill(channel, pointers[index + 1]));
        module._fl2k_web_pack(pointers[0], ...channelPointers, signed ? 1 : 0);
        const bytes = module.HEAPU8.slice(pointers[0], pointers[0] + FL2K_BYTES);
        const transfer = this.bulk(bytes).catch((error) => {
          if (!this.stopping) failure ||= error;
          this.running = false;
          this.transport.device?.close().catch(() => {});
        }).finally(() => pending.delete(transfer));
        pending.add(transfer);
        offset += FL2K_SAMPLES;
        sent += FL2K_SAMPLES;
        if (repeat) offset %= length;
        if (pending.size >= queueDepth) await Promise.race(pending);
      }
      await Promise.all(pending);
      if (failure) throw failure;
      if (this.running && this.transport.device?.opened) {
        module._fl2k_web_pack(pointers[0], 0, 0, 0, 1);
        await this.bulk(module.HEAPU8.slice(pointers[0], pointers[0] + FL2K_BYTES));
      }
      this.report(`TX sample stream finished (${sent.toLocaleString()} samples/channel including padded blocks).`);
    } catch (error) {
      if (!this.stopping) failure = error;
      this.running = false;
      if (this.transport.device?.opened) await this.transport.device.close().catch(() => {});
      await Promise.all(pending);
    } finally {
      pointers.forEach((pointer) => module._free(pointer));
      this.running = false;
      await this.serial(async () => {
        await this.invoke("fl2k_web_close").catch(() => {});
        this.connected = false;
        this.transmitting = false;
        this.actualRate = 0;
      });
      this.report(failure ? failure.message : "TX stopped and USB closed. Reconnect for another transmission. Unplug to guarantee RF output is removed.");
    }
    if (failure) throw failure;
  }

  async stop() {
    this.stopping = true;
    this.running = false;
    if (this.transport.device?.opened) await this.transport.device.close().catch(() => {});
    if (this.stream) {
      await this.stream.catch(() => {});
      this.stream = null;
    }
    await this.serial(async () => {
      if (this.module) await this.invoke("fl2k_web_close").catch(() => {});
      this.connected = false;
      this.actualRate = 0;
      this.report("FL2K USB closed. Unplug to guarantee RF output is removed.");
    });
  }

  async dispose() {
    this.usb?.removeEventListener("connect", this.connectListener);
    this.usb?.removeEventListener("disconnect", this.disconnectListener);
    await this.stop();
  }
}
