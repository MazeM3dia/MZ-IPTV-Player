// Runs the test suites against web/index.html in headless Chrome.
//
//   node tests/run.mjs            offline suites (no internet needed)
//   node tests/run.mjs --online   + real iptv-org playlist and real playback
//   node tests/run.mjs contrast   only suites whose name contains "contrast"
//
// Needs Node 22+ and Chrome. Set CHROME=<path to chrome.exe> if it isn't in
// the default place. Screenshots and logs go to tests/out/<suite>/.
// cross-browser (Firefox + WebKit) is optional: it needs Playwright
// (npm install, then npx playwright install firefox webkit) and is skipped
// without it.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "web");
const OUT = path.join(HERE, "out");
const DEFAULT_URL = "https://iptv-org.github.io/iptv/index.m3u";

const SUITES = [
  { name: "keys-remote",     what: "keyboard + TV remote, refresh, favourites, default playlist" },
  { name: "app-devices",     what: "app on phone / tablet / TV: touch UI, video box, Back, rotation" },
  { name: "screens",         what: "5 screen sizes + touch probes, no horizontal overflow" },
  { name: "network",         what: "nothing loads from a CDN; font + icons are local" },
  { name: "contrast",        what: "WCAG text contrast + focus outlines in every main state" },
  { name: "cross-browser",   what: "Firefox + WebKit (Safari engine): layout, input, menus (+ playback online)" },
  { name: "online-playlist", what: "real iptv-org playlist: parsing, search", online: true },
  { name: "online-playback", what: "real playlist downloads and a real channel plays", online: true },
];

const args = process.argv.slice(2);
const online = args.includes("--online");
const only = args.filter(a => !a.startsWith("--"));
const picked = SUITES.filter(s => (online || !s.online) && (!only.length || only.some(o => s.name.includes(o))));

function run(suite, extra = []) {
  const out = path.join(OUT, suite.name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(HERE, suite.name + ".mjs"), WEB, out, ...extra]);
    let log = "";
    p.stdout.on("data", d => log += d); p.stderr.on("data", d => log += d);
    p.on("close", code => {
      fs.writeFileSync(path.join(out, "log.txt"), log);
      resolve({ ok: code === 0, skip: code === 3, secs: ((Date.now() - t0) / 1000).toFixed(0), log });
    });
  });
}

let failed = 0, skipped = 0;
for (const s of picked) {
  const extra = s.name === "cross-browser" && online ? ["--online"] : [];
  if (s.name === "online-playlist") {
    const file = path.join(OUT, "iptv.m3u");
    fs.mkdirSync(OUT, { recursive: true });
    try { fs.writeFileSync(file, await (await fetch(DEFAULT_URL)).text()); }
    catch (e) { console.log(`FAIL  ${s.name.padEnd(16)} couldn't download the playlist: ${e.message}`); failed++; continue; }
    extra.push(file);
  }
  process.stdout.write(`  ..  ${s.name.padEnd(16)} ${s.what}\r`);
  const r = await run(s, extra);
  if (r.skip) { skipped++; console.log(`SKIP  ${s.name.padEnd(16)} ${r.log.trim().replace(/^SKIP:\s*/, "")}`); continue; }
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${s.name.padEnd(16)} ${s.what}  (${r.secs}s)`);
  if (!r.ok) {
    failed++;
    const lines = r.log.trim().split("\n");
    const interesting = lines.filter(l => /FAIL|Error|error|below/.test(l));
    console.log((interesting.length ? interesting : lines.slice(-15)).map(l => "      " + l).join("\n"));
  }
}
console.log(`\n${picked.length - failed - skipped}/${picked.length - skipped} suites passed${skipped ? `, ${skipped} skipped` : ""}. Logs + screenshots: ${path.relative(process.cwd(), OUT) || OUT}`);
process.exit(failed ? 1 : 0);
