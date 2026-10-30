// Builds both browsers from one source tree. No dependencies.
//
//   node build.mjs
//
// Writes dist/firefox and dist/chromium (load these unpacked) plus
// dist/unveil-firefox-<version>.xpi and dist/unveil-chromium-<version>.zip.
// Refuses to run when the two manifests disagree on version, or when the
// vendor host lists in the two backgrounds and the content script drift apart.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");

const TARGETS = {
  firefox: {
    files: ["manifest.json", "background.js"],
    icons: ["unveil.svg"],
    pkg: (v) => `unveil-firefox-${v}.xpi`
  },
  chromium: {
    files: ["manifest.json", "background.js", "rules.json"],
    icons: ["unveil.svg", "unveil-16.png", "unveil-32.png", "unveil-48.png", "unveil-128.png"],
    pkg: (v) => `unveil-chromium-${v}.zip`
  }
};

function fail(msg) {
  console.error("build stopped: " + msg);
  process.exit(1);
}

// ---------- drift checks ----------

const versions = Object.fromEntries(Object.keys(TARGETS).map((t) => [
  t, JSON.parse(readFileSync(join(ROOT, t, "manifest.json"), "utf8")).version
]));
if (new Set(Object.values(versions)).size !== 1) {
  fail("manifest versions differ: " + JSON.stringify(versions) + ". Bump both together.");
}
const version = versions.firefox;

const ffSource = readFileSync(join(ROOT, "firefox", "background.js"), "utf8");
const ffBlock = ffSource.match(/const BLOCKED_HOSTS = \[([\s\S]*?)\];/);
if (!ffBlock) fail("could not find BLOCKED_HOSTS in firefox/background.js");
const ffHosts = [...ffBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

const rules = JSON.parse(readFileSync(join(ROOT, "chromium", "rules.json"), "utf8"));
const crHosts = [...rules[0].condition.requestDomains].sort();
if (ffHosts.join() !== crHosts.join()) {
  fail("vendor hosts differ.\n  firefox/background.js: " + ffHosts.join(", ") + "\n  chromium/rules.json:   " + crHosts.join(", "));
}

const content = readFileSync(join(ROOT, "src", "content.js"), "utf8");
const frameLine = content.match(/const VENDOR_FRAME = (.*);/);
for (const h of ffHosts) {
  if (!frameLine || !frameLine[1].includes(h.replace(/\./g, "\\."))) {
    fail(`vendor host ${h} is missing from VENDOR_FRAME in src/content.js`);
  }
}

// ---------- Firefox self hosted updates ----------
// Firefox only auto updates a self distributed add-on if the signed copy the
// user installed already carried update_url, so it is set from the start and
// updates.json is regenerated from the manifest on every build. Commit it with
// each version bump; CI fails if it is stale.

const REPO = "Kelevrust/Unveil";
const gecko = JSON.parse(readFileSync(join(ROOT, "firefox", "manifest.json"), "utf8")).browser_specific_settings.gecko;
const expectedUpdateUrl = `https://raw.githubusercontent.com/${REPO}/main/updates.json`;
if (gecko.update_url !== expectedUpdateUrl) {
  fail(`firefox update_url should be ${expectedUpdateUrl}`);
}
const updates = {
  addons: {
    [gecko.id]: {
      updates: [{
        version,
        update_link: `https://github.com/${REPO}/releases/download/v${version}/${TARGETS.firefox.pkg(version)}`
      }]
    }
  }
};
writeFileSync(join(ROOT, "updates.json"), JSON.stringify(updates, null, 2) + "\n");

// ---------- zip (stored as deflate, fixed timestamps so builds are repeatable) ----------

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function zipDir(dir, outFile) {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of listFiles(dir)) {
    const name = Buffer.from(relative(dir, file).split(sep).join("/"), "utf8");
    const raw = readFileSync(file);
    const data = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(outFile, Buffer.concat([...locals, cd, end]));
}

// ---------- build ----------

rmSync(DIST, { recursive: true, force: true });

for (const [target, spec] of Object.entries(TARGETS)) {
  const out = join(DIST, target);
  mkdirSync(join(out, "icons"), { recursive: true });
  cpSync(join(ROOT, "src"), out, { recursive: true });
  for (const f of spec.files) cpSync(join(ROOT, target, f), join(out, f));
  for (const i of spec.icons) cpSync(join(ROOT, "icons", i), join(out, "icons", i));
  const pkg = join(DIST, spec.pkg(version));
  zipDir(out, pkg);
  console.log(`${target}: dist/${target}/  ->  dist/${spec.pkg(version)}`);
}
