import { Fl2kDevice } from "./fl2k-device.js";
import { prepareTx, validateTx } from "./tx-signal.js";

export function installFl2kPanel({ getSettings, generate }) {
  const field = (name) => document.getElementById(`fl2k${name}`);
  const driver = new Fl2kDevice();
  let busy = false;
  const idleButtons = ["Rate", "ReadRegister", "WriteRegister", "ReadI2c", "WriteI2c"];
  const status = (message) => { field("Status").textContent = message; };
  function refresh() {
    const locked = busy || driver.running;
    document.querySelector(".fl2k-hardware").dataset.running = String(driver.running);
    field("Request").disabled = locked || driver.connected || !driver.usb;
    field("Open").disabled = locked || driver.connected || !driver.devices.length;
    field("Scan").disabled = locked || !driver.usb;
    field("Stop").disabled = !busy && !driver.connected && !driver.running;
    field("EmergencyStop").hidden = field("Stop").disabled;
    field("EmergencyStop").disabled = field("Stop").disabled;
    idleButtons.forEach((name) => { field(name).disabled = locked || !driver.connected; });
    let valid = true;
    try { if (field("Source").value === "generated") validateTx(prepareTx({ ...getSettings(), rate: driver.actualRate || getSettings().rate })); }
    catch { valid = false; }
    let exportValid = true;
    try { validateTx(getSettings()); } catch { exportValid = false; }
    document.getElementById("txExport").disabled = locked || !exportValid;
    field("Start").disabled = locked || !driver.connected || !driver.actualRate || !field("Armed").checked || !valid;
    field("Files").hidden = field("Source").value !== "files";
    field("ChannelLabel").hidden = field("Source").value === "files";
    field("ActualRate").textContent = driver.actualRate ? `Actual DAC rate: ${(driver.actualRate / 1e6).toFixed(6)} MS/s` : "Actual DAC rate: not configured";
  }
  function lock(value) {
    busy = value;
    document.querySelectorAll(".tx-panel input, .tx-panel select, #txExport, #txSave, #txDelete").forEach((control) => { control.disabled = value; });
    refresh();
  }
  async function action(callback) {
    if (busy) return;
    lock(true);
    try { await callback(); }
    catch (error) { status(error.message); }
    finally { lock(false); }
  }
  driver.addEventListener("status", (event) => { status(event.detail.message); refresh(); });
  driver.addEventListener("devices", (event) => {
    const previous = field("Devices").value;
    field("Devices").replaceChildren();
    event.detail.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${device.productName || "FL2000DX"}${device.serialNumber ? ` · ${device.serialNumber}` : ` · adapter ${index + 1}`}`;
      field("Devices").append(option);
    });
    if (!event.detail.length) {
      const option = document.createElement("option");
      option.textContent = "No authorized FL2K detected";
      field("Devices").append(option);
    } else if (previous && Number(previous) < event.detail.length) field("Devices").value = previous;
    refresh();
  });
  driver.addEventListener("progress", (event) => {
    const stats = event.detail;
    const rate = stats.elapsed > 0 ? stats.bytes / 3 / (stats.elapsed / 1000) : 0;
    field("Throughput").textContent = `${stats.transfers} USB blocks · ${(stats.bytes / 1e6).toFixed(1)} MB · ${(rate / 1e6).toFixed(2)} MS/s average USB completion throughput (not an RF continuity measurement)`;
  });
  field("Request").addEventListener("click", () => action(() => driver.request()));
  field("Open").addEventListener("click", () => action(() => driver.open(driver.devices[Number(field("Devices").value)])));
  field("Scan").addEventListener("click", () => action(async () => {
    const devices = await driver.scan();
    status(`${devices.length} authorized FL2K adapter(s). Grant access to discover a new adapter. TX remains off.`);
  }));
  field("Rate").addEventListener("click", () => action(() => driver.setSampleRate(getSettings().rate)));
  ["Armed", "Source"].forEach((name) => field(name).addEventListener("change", refresh));
  field("Start").addEventListener("click", () => action(async () => {
    if (!field("Armed").checked) throw new Error("Confirm your bench setup before transmitting.");
    const options = { signed: true, repeat: field("Repeat").checked, queueDepth: Number(field("Queue").value) };
    if (field("Source").value === "generated") {
      const config = prepareTx({ ...getSettings(), rate: driver.actualRate });
      validateTx(config);
      status("Generating samples using the actual DAC rate… TX is still off.");
      options[field("Channel").value] = await generate(config, () => !field("Armed").checked || !driver.connected || document.hidden);
    } else {
      options.signed = field("Encoding").value === "signed";
      for (const name of ["Red", "Green", "Blue"]) {
        const file = field(name).files[0];
        if (!file) continue;
        if (!file.size || file.size > 32000000) throw new Error("Each raw channel file must be 1–32 MB.");
        options[name.toLowerCase()] = new Uint8Array(await file.arrayBuffer());
      }
    }
    if (!field("Armed").checked) throw new Error("TX canceled.");
    await driver.startTx(options);
    field("Armed").checked = false;
  }));
  field("Stop").addEventListener("click", async () => {
    field("Armed").checked = false;
    field("Stop").disabled = true;
    status("Stopping TX and closing USB…");
    try { await driver.stop(); }
    catch (error) { status(error.message); }
    refresh();
  });
  field("EmergencyStop").addEventListener("click", () => field("Stop").click());
  const hex = (name, maxDigits) => {
    const value = field(name).value.trim().replace(/^0x/i, "");
    if (!new RegExp(`^[0-9a-fA-F]{1,${maxDigits}}$`).test(value)) throw new Error(`Invalid hexadecimal ${name}.`);
    return Number.parseInt(value, 16);
  };
  field("ReadRegister").addEventListener("click", () => action(async () => {
    const value = await driver.register(hex("Register", 4));
    field("Value").value = value.toString(16).padStart(8, "0");
    field("Result").textContent = `Register: 0x${field("Value").value}`;
  }));
  field("WriteRegister").addEventListener("click", () => action(async () => {
    if (!confirm("Write a raw FL2K register? This can change device operation.")) return;
    await driver.register(hex("Register", 4), hex("Value", 8));
    driver.actualRate = 0;
    field("Result").textContent = "Register written. Reapply the DAC rate before TX.";
  }));
  for (const write of [false, true]) field(write ? "WriteI2c" : "ReadI2c").addEventListener("click", () => action(async () => {
    let bytes;
    if (write) {
      if (!/^[0-9a-fA-F]{2}(\s+[0-9a-fA-F]{2}){3}$/.test(field("I2cBytes").value.trim())) throw new Error("Enter exactly four hex bytes separated by spaces.");
      if (!confirm("Write four bytes on the FL2K I²C bus?")) return;
      bytes = Uint8Array.from(field("I2cBytes").value.trim().split(/\s+/), (value) => Number.parseInt(value, 16));
    }
    const result = await driver.i2c(hex("I2cAddress", 2), hex("I2cRegister", 2), bytes);
    field("I2cBytes").value = [...result].map((value) => value.toString(16).padStart(2, "0")).join(" ");
    field("Result").textContent = `I²C ${write ? "written" : "read"}: ${field("I2cBytes").value}`;
  }));
  const stopOnHide = () => {
    if (!driver.running && !busy) return;
    field("Armed").checked = false;
    driver.stop().catch(() => {});
  };
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopOnHide(); });
  window.addEventListener("pagehide", stopOnHide);
  driver.scan().then((devices) => status(`${devices.length} authorized FL2K adapter(s) detected. Connect explicitly; TX never starts automatically.`)).catch((error) => status(error.message));
  refresh();
  return { refresh, driver, setBusy: lock };
}
