// Renders web/index.html at several viewport sizes (with touch where it
// applies), screenshots key states and probes touch-only operability.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const WEB = process.argv[2], OUT = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
const groups = ["News", "Sports", "Movies", "Kids", "Music"], ccs = ["us", "gb", "my", "fr", "de", "jp"];
let m3u = "#EXTM3U\n";
for (let i = 0; i < 60; i++) m3u += `#EXTINF:-1 tvg-id="ch${i}.${ccs[i % 6]}" group-title="${groups[i % 5]}",${i === 2 ? "Al Jazeera English Documentary Channel HD" : "Channel " + (i + 1)}\nhttp://127.0.0.1:1/s${i}.ts\n`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/list.m3u") { res.writeHead(200); res.end(m3u); return; }
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : u.pathname);
  if (fs.existsSync(f)) { res.writeHead(200, { "content-type": "text/html" }); res.end(fs.readFileSync(f)); } else { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(8766, r));
const chrome = spawn(process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9334",
  "--user-data-dir=" + path.join(OUT, "profile"), "--no-first-run", "about:blank"]);
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) { await new Promise(r => setTimeout(r, 200)); try { wsUrl = (await (await fetch("http://127.0.0.1:9334/json")).json()).find(x => x.type === "page")?.webSocketDebuggerUrl; } catch {} }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
const shot = async (name) => fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
async function tap(x, y) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(250);
}
await send("Page.enable"); await send("Runtime.enable");

const sizes = [
  { name: "phone-portrait",  w: 390,  h: 844,  dpr: 3, mobile: true },
  { name: "phone-landscape", w: 844,  h: 390,  dpr: 3, mobile: true },
  { name: "tablet-portrait", w: 820,  h: 1180, dpr: 2, mobile: true },
  { name: "small-window",    w: 640,  h: 480,  dpr: 1, mobile: false },
  { name: "desktop-1080",    w: 1920, h: 1080, dpr: 1, mobile: false },
];
const report = [];
for (const s of sizes) {
  await send("Emulation.setDeviceMetricsOverride", { width: s.w, height: s.h, deviceScaleFactor: s.dpr, mobile: s.mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: s.mobile, maxTouchPoints: s.mobile ? 5 : 1 });
  await send("Page.navigate", { url: "http://127.0.0.1:8766/" }); await sleep(400);
  await ev(`localStorage.setItem("tv.iptv.store.v1", JSON.stringify({ source:{type:"url",url:"http://127.0.0.1:8766/list.m3u"}, favorites:[], filter:{search:"",favOnly:false,country:null,category:null}, seenWelcome:false, recentlyWatched:[] }))`);
  await send("Page.reload"); await sleep(1000);
  await shot(s.name + "-1-welcome");
  await ev(`closeWelcome()`); await sleep(200);
  const m = JSON.parse(await ev(`JSON.stringify({ rootPx: getComputedStyle(document.documentElement).fontSize, stripW: Math.round(els.strip.getBoundingClientRect().width), rowH: ROW_H, rowsVisible: Math.floor(els.list.clientHeight / ROW_H), nameW: Math.round((document.querySelector('.channel .nm')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width), hOverflow: document.documentElement.scrollWidth > innerWidth })`));
  await shot(s.name + "-2-list");
  // play a channel by tapping/clicking row 2
  const row = JSON.parse(await ev(`JSON.stringify(document.querySelectorAll('.channel')[1].getBoundingClientRect())`));
  if (s.mobile) await tap(row.x + row.width / 2, row.y + row.height / 2); else await ev(`document.querySelectorAll('.channel')[1].click()`);
  await sleep(500);
  await shot(s.name + "-3-error");
  // touch-only probes: with the strip hidden, can a tap bring it back?
  const probes = {};
  if (s.mobile) {
    const portrait = s.h > s.w;
    const vid = portrait ? { x: s.w * 0.15, y: s.w * 0.5625 * 0.25 } : { x: s.w * 0.75, y: s.h * 0.35 };
    await ev(`hideStrip()`); await sleep(300);
    // tap the video → controls bar
    await tap(vid.x, vid.y); await sleep(250);
    probes.tapShowsControls = await ev(`document.body.classList.contains("controls-on")`);
    await shot(s.name + "-4-controls");
    // tap ▶ next in the bar
    const nb = JSON.parse(await ev(`JSON.stringify(document.querySelector('#controls [data-act="next"]').getBoundingClientRect())`));
    const before = await ev(`playingCh && playingCh.name`);
    await tap(nb.x + nb.width / 2, nb.y + nb.height / 2); await sleep(300);
    probes.nextButtonFlips = before !== await ev(`playingCh && playingCh.name`);
    // swipe left on the video → next channel
    const b2 = await ev(`playingCh && playingCh.name`);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: vid.x + 80, y: vid.y }] });
    for (let k = 1; k <= 5; k++) await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: vid.x + 80 - k * 35, y: vid.y + 2 }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(300);
    probes.swipeFlips = b2 !== await ev(`playingCh && playingCh.name`);
    // long-press a channel row → options for that row
    await ev(`showStrip()`); await sleep(300);
    const r3 = JSON.parse(await ev(`(() => { const l = els.list.getBoundingClientRect(); return JSON.stringify({ x: l.x, y: l.y + ROW_H * 1.5, height: 0 }); })()`));
    probes.rowUnderFinger = await ev(`(document.elementFromPoint(${r3.x + 60}, ${r3.y}) || {}).closest?.('.channel')?.querySelector('.nm')?.textContent || null`);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r3.x + 60, y: r3.y + r3.height / 2 }] });
    await sleep(800);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(250);
    probes.longPressOpensMenu = await ev(`mode === "menu" && els.mtitle.textContent`);
    await shot(s.name + "-5-menu");
    await tap(4, s.h - 4);
    probes.tapOutsideClosesMenu = await ev(`mode !== "menu"`);
    await ev(`if (mode === "menu") closeMenu(); openRecent()`); await sleep(200);
    await tap(4, s.h - 4);
    probes.tapOutsideClosesRecent = await ev(`mode !== "recent"`);
    await ev(`if (mode === "recent") closeRecent(); openFilter()`); await sleep(200);
    await shot(s.name + "-6-filter");
    const xb = JSON.parse(await ev(`JSON.stringify(document.querySelector('#filter .mclose').getBoundingClientRect())`));
    await tap(xb.x + xb.width / 2, xb.y + xb.height / 2);
    probes.filterCloseButton = await ev(`mode === "list"`);
    probes.touchCopy = await ev(`els.foot.textContent`);
    // Touch: opening the list starts no auto-hide countdown (slow finger-scrolls used to get cut off)
    probes.listStaysOpenOnTouch = await ev(`showStrip(); els.list.scrollTop += 200; hideTimer === null`);
  }
  report.push({ size: `${s.name} ${s.w}x${s.h}`, ...m, ...probes });
}
console.log(JSON.stringify(report, null, 1));
// Fail on horizontal overflow or any touch probe that came back false.
const bad = report.filter(r => r.hOverflow || Object.entries(r).some(([k, v]) => k !== "hOverflow" && (v === false || v === null)));
if (bad.length) console.log("FAIL:", bad.map(r => r.size).join(", "));
ws.close(); chrome.kill(); server.close(); process.exit(bad.length ? 1 : 0);
