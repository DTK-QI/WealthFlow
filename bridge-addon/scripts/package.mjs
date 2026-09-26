import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const addonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(addonRoot, "..");
const originFlag = process.argv.indexOf("--origin");
const originValue = originFlag >= 0 ? process.argv[originFlag + 1] : process.env.WEALTHFLOW_ADDON_ORIGIN;

if (!originValue) throw new Error("需要 --origin https://你的-WealthFlow-host");
const origin = new URL(originValue);
if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
  throw new Error("origin 必須是乾淨的 HTTPS origin，例如 https://flow.example.com");
}

execFileSync(process.execPath, [path.join(projectRoot, "node_modules/typescript/bin/tsc"), "-p", path.join(addonRoot, "tsconfig.json")], {
  cwd: projectRoot,
  stdio: "inherit",
});
execFileSync(process.execPath, [path.join(projectRoot, "node_modules/vite/bin/vite.js"), "build", "--config", path.join(addonRoot, "vite.config.ts")], {
  cwd: projectRoot,
  env: { ...process.env, WEALTHFLOW_ADDON_ORIGIN: origin.origin },
  stdio: "inherit",
});

const manifest = JSON.parse(fs.readFileSync(path.join(addonRoot, "manifest.json"), "utf8"));
manifest.network = { allowedHosts: [origin.hostname] };
const releaseRoot = path.join(addonRoot, "releases");
const artifact = path.join(releaseRoot, `wealthflow-addon-${manifest.version}.zip`);

const crcTable = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { day, time };
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosTimestamp(new Date());
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body);
    const compressed = deflateRawSync(body, { level: 9 });
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const entries = [
  { name: "manifest.json", body: `${JSON.stringify(manifest, null, 2)}\n` },
  { name: "dist/addon.js", body: fs.readFileSync(path.join(addonRoot, "dist/addon.js")) },
  { name: "dist/wealthflow.css", body: fs.readFileSync(path.join(addonRoot, "dist/wealthflow.css")) },
  { name: "README.md", body: fs.readFileSync(path.join(addonRoot, "README.md")) },
];
fs.mkdirSync(releaseRoot, { recursive: true });
fs.writeFileSync(artifact, zip(entries));
process.stdout.write(`${artifact}\n`);
