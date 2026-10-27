import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "app/fl2k");
fs.mkdirSync(output, { recursive: true });
execFileSync(process.env.EMCC || "emcc", [
  path.join(root, "drivers/fl2k-web/browser.c"),
  "-I" + path.join(root, "drivers/fl2k-web"),
  "-I" + path.join(root, "drivers/osmo-fl2k/include"),
  "-DFL2K_WEBUSB", "-O2", "--no-entry", "-sASYNCIFY=1",
  "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=web",
  "-sSINGLE_FILE=1", "-sWASM_ASYNC_COMPILATION=0", "-sFILESYSTEM=0",
  "-sDYNAMIC_EXECUTION=0", "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=33554432",
  '-sEXPORTED_FUNCTIONS=["_malloc","_free","_fl2k_get_device_count","_fl2k_get_device_name"]',
  '-sEXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
  "-o", path.join(output, "runtime.js"),
], { stdio: "inherit" });
fs.copyFileSync(path.join(root, "drivers/osmo-fl2k/COPYING"), path.join(output, "COPYING.txt"));
fs.copyFileSync(path.join(root, "docs/hardware-e2e.md"), path.join(output, "hardware-e2e.txt"));
execFileSync("tar", ["-czf", path.join(output, "source.tar.gz"), "-C", root,
  "drivers/osmo-fl2k", "drivers/fl2k-web", "scripts/build-fl2k.mjs",
  "app/fl2k-device.js", "app/fl2k-panel.js", "package.json", "README.md", "LICENSE", "docs/hardware-e2e.md",
]);
console.log("Built FL2K Emscripten runtime (embedded Wasm, no runtime fetch).");
