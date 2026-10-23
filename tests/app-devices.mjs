// The Android app on a phone / tablet (fake MZNative, isTv=false, touch) and
// on a TV (isTv=true): touch UI on/off, ExoPlayer video box, Back, landscape.
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { spawn } from "node:child_process";
const WEB = process.argv[2], OUT = process.argv[3]; fs.mkdirSync(OUT, { recursive: true });
let m3u = "#EXTM3U\n";
for (let i = 0; i < 40; i++) m3u += `#EXTINF:-1 tvg-id="ch${i}.us" group-title="News",Channel ${i + 1}\nhttp://127.0.0.1:1/s${i}.m3u8\n`;
const server = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/proxy") { r.writeHead(200); r.end(m3u); return; }
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".woff2") ? "font/woff2" : "text/html" }); r.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(8771, r));
const chrome = spawn(process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9340",
  "--user-data-dir=" + path.join(OUT, "profile"), "--no-first-run", "about:blank"]);
let wsUrl; for (let i = 0; i < 50 && !wsUrl; i++) { await new Promise(r => setTimeout(r, 200)); try { wsUrl = (await (await fetch("http://127.0.0.1:9340/json")).json()).find(x => x.type === "page")?.webSocketDebuggerUrl; } catch {} }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = m => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errs.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async n => fs.writeFileSync(path.join(OUT, n + ".png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
async function tap(x, y) { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }); await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(250); }
let pass = 0, fail = 0;
const check = (name, ok, info) => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  -> " + JSON.stringify(info))); };
await send("Page.enable"); await send("Runtime.enable");
const fake = tv => `window.__calls=[]; window.MZNative={ play:(u)=>{__calls.push(["play",u]); setTimeout(()=>mzOnNative({type:"state",state:"playing"}),80);},
  togglePause:()=>{__calls.push(["togglePause"]); mzOnNative({type:"state",state:"paused"});}, setMuted:m=>__calls.push(["mute",m]),
  exit:()=>__calls.push(["exit"]), isTv:()=>${tv}, setVideoRect:(...a)=>__calls.push(["rect",...a]), setLandscape:b=>__calls.push(["land",b]) };
  localStorage.setItem("tv.iptv.store.v1", JSON.stringify({ source:{type:"url",url:"http://127.0.0.1:1/list.m3u"}, seenWelcome:true }));`;
const calls = async () => JSON.parse(await ev("JSON.stringify(__calls)"));
const lastRect = async () => (await calls()).filter(c => c[0] === "rect").pop();
const lastLand = async () => JSON.stringify((await calls()).filter(c => c[0] === "land").pop());
const vis = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== "none"; })()`);
async function boot(tv, w, h, touch) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: touch });
  await send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  const s = await send("Page.addScriptToEvaluateOnNewDocument", { source: fake(tv) });
  await send("Page.navigate", { url: "http://127.0.0.1:8771/index.html" });
  for (let i = 0; i < 40 && !(await ev("typeof channels!=='undefined' && channels.length")); i++) await sleep(150);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: s.result.identifier });
  await sleep(400);
}

// ---------- App on a phone, portrait ----------
await boot(false, 390, 844, true);
check("phone: is-native + touch classes", await ev(`document.documentElement.className`) === "is-native touch", await ev(`document.documentElement.className`));
check("phone: control bar + tap layer present", (await vis("#controls")) && (await vis("#tap")));
check("phone: close (x) buttons shown", await vis("#menu .mclose"));
let r = await lastRect();
check("phone portrait: ExoPlayer box = 16:9 on top", r && r[1] === 0 && r[2] === 0 && r[3] === 390 && Math.abs(r[4] - 390 * 9 / 16) < 1, r);
await ev(`playIndex(0)`); await sleep(300);
await tap(195, 100);
check("phone: tap video shows control bar", await ev(`document.body.classList.contains("controls-on")`));
await tap(195, 100);
await ev(`mzOnNative({type:"error",reason:"Access denied — the stream is probably geo-restricted."})`); await sleep(100);
check("phone: error card has Retry / Next buttons", await ev(`!!els.status.querySelector('[data-act=retry]') && !!els.status.querySelector('[data-act=next]')`), await ev("els.status.innerHTML"));
await shot("app-phone-portrait-error");
await ev(`playIndex(1)`); await sleep(300);
await ev(`mzOnNative({type:"state",state:"paused"})`); await sleep(50);
check("phone: paused card has Resume button", await ev(`!!els.status.querySelector('[data-act=pause]')`));
await ev(`mzOnNative({type:"state",state:"playing"})`);
// Back in portrait: first arms exit, second exits (used to be swallowed forever)
const b1 = await ev(`mzOnRemote("Back")`);
check("phone portrait: 1st Back -> 'press again' banner", b1 === true && /again to exit/.test(await ev("els.banner.textContent")), await ev("els.banner.textContent"));
await ev(`mzOnRemote("Back")`);
check("phone portrait: 2nd Back -> MZNative.exit()", (await calls()).some(c => c[0] === "exit"));
// Fullscreen button = hold sideways; Back leaves it first
await ev(`exitArmed=false; showControls()`); await sleep(50);
await ev(`document.querySelector('#controls [data-act=fullscreen]').click()`);
check("phone: fullscreen button -> setLandscape(true)", (await lastLand()) === '["land",true]');
check("phone: button becomes 'Exit fullscreen'", await ev(`document.querySelector('#controls [data-act=fullscreen]').getAttribute("aria-label")`) === "Exit fullscreen");
await send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 2, mobile: true }); await sleep(400);
r = await lastRect();
check("phone landscape: ExoPlayer box = whole screen", JSON.stringify(r) === '["rect",0,0,-1,-1]', r);
await shot("app-phone-landscape");
const n0 = (await calls()).filter(c => c[0] === "exit").length;
await ev(`showStrip()`); await ev(`mzOnRemote("Back")`);
check("phone landscape: Back closes the open list first", !(await ev(`els.strip.classList.contains("open")`)) && (await lastLand()) === '["land",true]');
await ev(`mzOnRemote("Back")`);
check("phone landscape: Back leaves forced landscape (no exit)", (await lastLand()) === '["land",false]' && (await calls()).filter(c => c[0] === "exit").length === n0);
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(400);
r = await lastRect();
check("phone back to portrait: box on top again", r && r[3] === 390 && Math.abs(r[4] - 219.375) < 1, r);
await shot("app-phone-portrait");
// Portrait filter: sits under the video (same place as the list), video stays visible
await ev(`openFilter()`); await sleep(300);
const fr = JSON.parse(await ev(`JSON.stringify({ f: els.filter.getBoundingClientRect(), v: els.video.getBoundingClientRect() })`));
check("phone portrait: filter opens below the video, not over it", Math.abs(fr.f.top - fr.v.bottom) <= 2 && fr.f.bottom >= 843, fr);
await shot("app-phone-portrait-filter");
await ev(`closeFilter()`);

// ---------- App on a tablet, landscape ----------
await boot(false, 1280, 800, true);
check("tablet: touch UI on", (await ev(`document.documentElement.classList.contains("touch")`)) && (await vis("#controls")));
check("tablet landscape: whole-screen video", JSON.stringify(await lastRect()) === '["rect",0,0,-1,-1]', await lastRect());

// ---------- App on a TV ----------
await boot(true, 960, 540, false);
check("tv: no touch class", await ev(`document.documentElement.className`) === "is-native", await ev(`document.documentElement.className`));
check("tv: control bar / tap layer / close buttons hidden", !(await vis("#controls")) && !(await vis("#tap")) && !(await vis("#menu .mclose")));
await ev(`playIndex(0)`); await sleep(300);
await ev(`mzOnNative({type:"error",reason:"x"})`); await sleep(50);
check("tv: error card shows remote keys, no buttons", !(await ev(`!!els.status.querySelector('button')`)) && /<kbd>/.test(await ev("els.status.innerHTML")));
await ev(`showStrip()`); const tb = await ev(`mzOnRemote("Back")`);
check("tv: Back closes the list first", tb === true && !(await ev(`els.strip.classList.contains("open")`)));
check("tv: never asks for landscape", !(await calls()).some(c => c[0] === "land"));

console.log(`\n${pass} passed, ${fail} failed`); console.log("JS errors:", errs.length ? errs : "(none)");
ws.close(); chrome.kill(); server.close(); process.exit(fail ? 1 : 0);
