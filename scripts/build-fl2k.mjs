import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
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
fs.writeFileSync(path.join(output, "source.tar.gz"), sourceArchive([
  "drivers/osmo-fl2k", "drivers/fl2k-web", "scripts/build-fl2k.mjs",
  "app/fl2k-device.js", "app/fl2k-panel.js", "package.json", "README.md", "LICENSE", "docs/hardware-e2e.md",
]));
console.log("Built FL2K Emscripten runtime (embedded Wasm, no runtime fetch).");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// A ustar archive with fixed timestamps and owners, so the same sources always
// give the same bytes. Otherwise every build would change the service worker's
// build ID and make every visitor download the whole offline cache again.
function sourceArchive(entries) {
  const files = entries
    .flatMap((entry) => {
      const p = path.join(root, entry);
      return fs.statSync(p).isDirectory() ? walk(p) : [p];
    })
    .filter((file) => path.basename(file) !== ".DS_Store")
    .sort();
  const blocks = [];
  for (const file of files) {
    const name = path.relative(root, file).split(path.sep).join("/");
    if (Buffer.byteLength(name) > 100) throw new Error(`${name}: path too long for the archive`);
    const data = fs.readFileSync(file);
    const mode = fs.statSync(file).mode & 0o111 ? 0o755 : 0o644;
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(mode.toString(8).padStart(7, "0"), 100);
    header.write("0000000", 108); // uid
    header.write("0000000", 116); // gid
    header.write(data.length.toString(8).padStart(11, "0"), 124);
    header.write("00000000000", 136); // mtime
    header.write("        ", 148); // checksum, computed below
    header.write("0", 156); // regular file
    header.write("ustar", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}
