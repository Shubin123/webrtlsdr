import { Fl2kDevice, inspectFl2k, installedApp, unrestrictedHint, usbUnrestricted } from "./fl2k-device.js";
import { prepareTx, validateTx } from "./tx-signal.js";

export function installFl2kPanel({ getSettings, generate }) {
  const field = (name) => document.getElementById(`fl2k${name}`);
  const driver = new Fl2kDevice();
  let busy = false;
  // Transmitting is off unless the user has just pressed Transmit.
  let starting = false;
  let stopping = false;
  let onAirSince = 0;
  let onAirConfig = "";
  let onAirTimer;
  let lastError = "";
  const title = document.title;
  const idleButtons = ["Rate", "ReadRegister", "WriteRegister", "ReadI2c", "WriteI2c"];
  const status = (message) => { field("Status").textContent = message; };
  const selectedDevice = () => driver.devices[Number(field("Devices").value)];
  function txState() {
    if (stopping) return "stopping";
    if (driver.running) return "on";
    if (starting) return "starting";
    return "off";
  }
  function blockedReason(valid) {
    if (!driver.usb) return "Transmit needs WebUSB, which this browser does not have.";
    if (busy) return "Busy with another FL2K action…";
    if (!driver.connected) {
      const device = selectedDevice();
      if (!device) return "Connect an FL2K adapter under FL2K hardware below to enable Transmit.";
      if (!inspectFl2k(device).supported) {
        return installedApp()
          ? "This FL2K needs one more Chrome flag: in chrome://flags enable \u201cEnable Isolated Web Apps to bypass USB restrictions\u201d, then relaunch Chrome."
          : "Chrome only lets the installed app use this FL2K (protected USB class). See \u201cInstall the app\u201d under FL2K hardware below.";
      }
    }
    if (field("Source").value === "files" && !["Red", "Green", "Blue"].some((name) => field(name).files.length)) return "Choose at least one raw sample file below.";
    if (!valid) return "Fix the waveform settings below before transmitting.";
    if (!field("Armed").checked) return "Tick the setup confirmation above to enable Transmit.";
    return "";
  }
  function refreshTx(valid) {
    const state = txState();
    const blocked = state === "off" ? blockedReason(valid) : "";
    field("Start").disabled = state === "stopping" || Boolean(blocked);
    field("Start").textContent = { off: "Transmit", starting: "Cancel", on: "■ Stop transmitting", stopping: "Stopping…" }[state];
    document.getElementById("txBlocked").textContent = blocked;
    document.getElementById("txControl").dataset.state = state;
    document.getElementById("txControlState").textContent = { off: "TX off", starting: "TX preparing…", on: "TRANSMITTING", stopping: "TX stopping…" }[state];
    document.getElementById("txControlDetail").textContent = {
      off: lastError ? `Not transmitting. Last attempt: ${lastError}` : "Not transmitting.",
      starting: "Connecting and preparing samples. Not on air yet.",
      on: `On air for ${((performance.now() - onAirSince) / 1000).toFixed(1)} s · ${onAirConfig}`,
      stopping: "Stopping and closing USB…",
    }[state];
    document.getElementById("txIndicator").dataset.state = state;
    document.getElementById("txIndicatorText").textContent = { off: "Off", starting: "Preparing", on: "ON AIR", stopping: "Stopping" }[state];
    document.body.dataset.tx = state;
    document.title = state === "on" ? `● TX ON AIR · ${title}` : title;
    const header = field("HeaderTx");
    header.dataset.state = state;
    header.textContent = { off: "Transmit", starting: "■ Cancel TX", on: "■ Stop TX", stopping: "Stopping…" }[state];
    header.disabled = state === "stopping";
    header.setAttribute("aria-disabled", String(Boolean(blocked)));
    header.title = blocked || (state === "off" ? "Transmit with the settings in the TX panel" : "");
    if (state === "on" && !onAirTimer) onAirTimer = setInterval(refresh, 500);
    if (state !== "on" && onAirTimer) { clearInterval(onAirTimer); onAirTimer = undefined; }
  }
  function refresh() {
    const locked = busy || driver.running;
    document.querySelector(".fl2k-hardware").dataset.running = String(driver.running);
    field("Request").disabled = locked || driver.connected || !driver.usb;
    const selected = driver.devices[Number(field("Devices").value)];
    const compatibility = selected && inspectFl2k(selected);
    field("Open").disabled = locked || driver.connected || !compatibility?.supported;
    field("Compatibility").textContent = compatibility
      ? (compatibility.supported
        ? `${usbUnrestricted() ? "Installed app: Chrome allows protected USB interfaces. " : ""}Using USB interface ${compatibility.interface}, alternate ${compatibility.alternate}.`
        : compatibility.reason)
      : usbUnrestricted()
        ? "Installed app: Chrome allows the FL2000's protected USB interface. Connect the adapter to transmit."
        : `Standard FL2000 adapters only have Audio/Video-class (0x10) USB interfaces, which Chrome does not let websites use. ${unrestrictedHint()}`;
    field("Install").hidden = installedApp();
    field("Scan").disabled = locked || !driver.usb;
    field("Stop").disabled = !busy && !driver.connected && !driver.running;
    idleButtons.forEach((name) => { field(name).disabled = locked || !driver.connected; });
    let valid = true;
    try { if (field("Source").value === "generated") validateTx(prepareTx({ ...getSettings(), rate: driver.actualRate || getSettings().rate })); }
    catch { valid = false; }
    let exportValid = true;
    try { validateTx(getSettings()); } catch { exportValid = false; }
    document.getElementById("txExport").disabled = locked || !exportValid;
    refreshTx(valid);
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
    catch (error) {
      if (error.name === "NotFoundError") status("No FL2K selected. Choose the adapter in Chrome's USB prompt.");
      else if (/protected class/.test(error.message)) status(`FL2K detected, but ${installedApp() ? "Chrome has not given this app USB access to it" : "this website cannot open it"} (see below).`);
      else status(error.message);
    }
    finally { lock(false); }
  }
  driver.addEventListener("status", (event) => {
    if (driver.running && !onAirSince) { starting = false; onAirSince = performance.now(); }
    if (!driver.running) onAirSince = 0;
    status(event.detail.message);
    refresh();
  });
  driver.addEventListener("devices", (event) => {
    const previous = field("Devices").value;
    field("Devices").replaceChildren();
    event.detail.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${device.productName || "FL2000DX"}${device.serialNumber ? ` · ${device.serialNumber}` : ` · adapter ${index + 1}`}${inspectFl2k(device).supported ? "" : " · WebUSB blocked"}`;
      field("Devices").append(option);
    });
    if (!event.detail.length) {
      const option = document.createElement("option");
      option.textContent = "No authorized FL2K detected";
      field("Devices").append(option);
    } else if (previous && Number(previous) < event.detail.length) field("Devices").value = previous;
    refresh();
  });
  field("Devices").addEventListener("change", refresh);
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
  ["Armed", "Source", "Red", "Green", "Blue"].forEach((name) => field(name).addEventListener("change", refresh));
  async function stopTx() {
    field("Armed").checked = false;
    field("Repeat").checked = false;
    stopping = true;
    refresh();
    status("Stopping TX and closing USB…");
    try { await driver.stop(); }
    catch (error) { status(error.message); }
    finally { stopping = false; refresh(); }
  }
  field("Start").addEventListener("click", () => {
    const state = txState();
    if (state === "on" || state === "starting") { stopTx(); return; }
    if (state !== "off") return;
    action(async () => {
      starting = true;
      lastError = "";
      refresh();
      try { await transmit(); }
      catch (error) { lastError = error.message; throw error; }
      finally { starting = false; field("Armed").checked = false; field("Repeat").checked = false; }
    });
  });
  async function transmit() {
    if (!field("Armed").checked) throw new Error("Confirm your setup before transmitting.");
    if (!driver.connected) await driver.open(selectedDevice());
    await driver.setSampleRate(getSettings().rate);
    const rate = `${(driver.actualRate / 1e6).toFixed(3)} MS/s`;
    const options = { signed: true, repeat: field("Repeat").checked, queueDepth: Number(field("Queue").value) };
    if (field("Source").value === "generated") {
      const config = prepareTx({ ...getSettings(), rate: driver.actualRate });
      validateTx(config);
      status("Generating samples using the actual DAC rate… not on air yet.");
      options[field("Channel").value] = await generate(config, () => !field("Armed").checked || !driver.connected || document.hidden);
      onAirConfig = `${config.mode} at ${(config.carrier / 1e6).toFixed(3)} MHz · ${rate} · ${field("Channel").value} DAC`;
    } else {
      options.signed = field("Encoding").value === "signed";
      for (const name of ["Red", "Green", "Blue"]) {
        const file = field(name).files[0];
        if (!file) continue;
        if (!file.size || file.size > 32000000) throw new Error("Each raw channel file must be 1–32 MB.");
        options[name.toLowerCase()] = new Uint8Array(await file.arrayBuffer());
      }
    }
    if (field("Source").value === "files") onAirConfig = `raw RGB files · ${rate}`;
    if (!field("Armed").checked) throw new Error("TX canceled before going on air.");
    await driver.startTx(options);
  }
  field("Stop").addEventListener("click", stopTx);
  // The top-bar button mirrors Transmit. When transmitting is not possible yet
  // it shows what is missing instead of doing anything.
  field("HeaderTx").addEventListener("click", () => {
    if (txState() !== "off" || !field("Start").disabled) {
      field("Start").click();
      return;
    }
    const box = document.getElementById("txControl");
    box.scrollIntoView({ block: "nearest" });
    box.classList.remove("attention");
    void box.offsetWidth;
    box.classList.add("attention");
    if (!driver.connected && !selectedDevice()) {
      document.querySelector(".fl2k-hardware").open = true;
      field("Request").focus();
    } else if (!driver.connected && !inspectFl2k(selectedDevice()).supported) {
      document.querySelector(".fl2k-hardware").open = true;
      field("Install").scrollIntoView({ block: "nearest" });
    } else if (!field("Armed").checked && !field("Armed").disabled) {
      field("Armed").focus();
    }
  });
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
    if (txState() === "on" || txState() === "starting") stopTx();
  };
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopOnHide(); });
  window.addEventListener("pagehide", stopOnHide);
  driver.scan().then((devices) => status(`${devices.length} authorized FL2K adapter(s) detected. Connect explicitly; TX never starts automatically.`)).catch((error) => status(error.message));
  refresh();
  return { refresh, driver, setBusy: lock };
}
