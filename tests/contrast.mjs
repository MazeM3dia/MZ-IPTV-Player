// WCAG contrast audit of the live page: every visible text element, against the
// background really behind it (translucent layers composited over BOTH a black
// and a white video frame — the worse result counts).
// Also checks the focus indicator (non-text, 3:1) on focused rows.
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { spawn } from "node:child_process";
const WEB = process.argv[2], OUT = process.argv[3]; fs.mkdirSync(OUT, { recursive: true });
let m3u = "#EXTM3U\n";
for (let i = 0; i < 30; i++) m3u += `#EXTINF:-1 tvg-id="ch${i}.us" group-title="News;Sports",Channel ${i + 1} ${i % 3 ? "(1080p)" : "[Geo-blocked]"}\nhttp://127.0.0.1:1/s${i}.m3u8\n`;
const server = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/list.m3u" || u.pathname === "/proxy") { r.writeHead(200); r.end(m3u); return; }
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".woff2") ? "font/woff2" : f.endsWith(".png") ? "image/png" : "text/html" }); r.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(8773, r));
const chrome = spawn(process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9343", "--user-data-dir=" + path.join(OUT, "cprof"), "about:blank"]);
let u; for (let i = 0; i < 50 && !u; i++) { await new Promise(r => setTimeout(r, 200)); try { u = (await (await fetch("http://127.0.0.1:9343/json")).json()).find(x => x.type === "page")?.webSocketDebuggerUrl; } catch {} }
const ws = new WebSocket(u); await new Promise(r => ws.onopen = r);
let id = 0; const p = new Map(); ws.onmessage = m => { const d = JSON.parse(m.data); if (p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs in the page. Colours are resolved by the browser to rgb()/color(srgb ...)
const AUDIT = `(() => {
  const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgba = (c) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = "#000"; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data;
    const m = /\\/\\s*([\\d.]+)\\)|rgba\\([^)]*,\\s*([\\d.]+)\\)/.exec(c); const a = m ? parseFloat(m[1] ?? m[2]) : (c === "transparent" ? 0 : 1);
    return [d[0], d[1], d[2], a]; };
  const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  function bgOf(el, base) {     // composite backgrounds from the root down to el
    const chain = []; for (let e = el; e; e = e.parentElement) chain.unshift(e);
    let col = base;             // under everything: the video frame
    for (const e of chain) { const s = getComputedStyle(e); const c = rgba(s.backgroundColor); const o = parseFloat(s.opacity);
      if (c[3] > 0) col = over([c[0], c[1], c[2], c[3] * o], col); }
    return col;
  }
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n; (n = walker.nextNode());) {
    const el = n.parentElement; if (!el || seen.has(el) || !n.textContent.trim()) continue; seen.add(el);
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    let vis = true, op = 1; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.visibility === "hidden" || s.display === "none") vis = false; op *= parseFloat(s.opacity); }
    if (!vis || op < 0.5) continue;               // fading/hidden layers aren't read
    const s = getComputedStyle(el); const fg = rgba(s.color);
    const cr = Math.min(...[[0, 0, 0, 1], [255, 255, 255, 1]].map(b => { const bg = bgOf(el, b); return ratio(over(fg, bg), bg); }));
    const px = parseFloat(s.fontSize), bold = parseInt(s.fontWeight) >= 700;
    const large = px >= 24 || (bold && px >= 18.66);
    out.push({ text: n.textContent.trim().slice(0, 40), sel: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : ""),
      cr: +cr.toFixed(2), need: large ? 3 : 4.5, fg: s.color });
  }
  // focus indicator: focused row / item border vs the surface around it (non-text 3:1)
  const foc = [];
  for (const el of document.querySelectorAll(".channel.focused, .fitem.focused, .mitem.focused, .ritem.focused, .hf")) {
    const r = el.getBoundingClientRect(); if (!r.width) continue;
    const s = getComputedStyle(el); const bc = rgba(s.borderTopColor);
    const cr = Math.min(...[[0, 0, 0, 1], [255, 255, 255, 1]].map(b => { const around = bgOf(el.parentElement, b); return ratio(over(bc, around), around); }));
    foc.push({ sel: el.className, cr: +cr.toFixed(2) });
  }
  return JSON.stringify({ text: out, focus: foc });
})()`;

const results = [];
async function audit(label) {
  const r = JSON.parse(await ev(AUDIT));
  const bad = r.text.filter(t => t.cr < t.need), focBad = r.focus.filter(f => f.cr < 3);
  const min = r.text.reduce((m, t) => Math.min(m, t.cr), 99);
  const primary = r.text.filter(t => /10[67], 165, 251|0\.72 0\.14 258|oklch\(0\.72/.test(t.fg));
  results.push({ label, n: r.text.length, min, bad, focBad, focus: r.focus, primaryMin: primary.reduce((m, t) => Math.min(m, t.cr), 99), primaryN: primary.length });
  fs.writeFileSync(path.join(OUT, `contrast-${label}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
}
await send("Page.enable"); await send("Runtime.enable");
for (const [mode, native] of [["browser", false], ["tv-app", true]]) {
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  const sid = (await send("Page.addScriptToEvaluateOnNewDocument", { source: (native
      ? `window.MZNative={play(){setTimeout(()=>mzOnNative({type:"error",reason:"Access denied — the stream is probably geo-restricted."}),100)},togglePause(){},setMuted(){},exit(){},isTv(){return true},setVideoRect(){},setLandscape(){}};` : "") +
      `localStorage.setItem("tv.iptv.store.v1", JSON.stringify({ source:{type:"url",url:"http://127.0.0.1:8773/list.m3u"}, seenWelcome:false }));` })).result.identifier;
  await send("Page.navigate", { url: "http://127.0.0.1:8773/" });
  for (let i = 0; i < 40 && !(await ev("typeof channels!=='undefined' && channels.length")); i++) await sleep(150);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: sid });
  await sleep(500);
  await audit(mode + "-welcome");
  await ev("closeWelcome(); showStrip(); setFocus(1)"); await sleep(400); await audit(mode + "-list");
  await ev("hideStrip(); playIndex(2)"); await sleep(2500); await audit(mode + "-error");
  await ev("showStrip(); openFilter()"); await sleep(400); await audit(mode + "-filter");
  await ev("closeFilter(); openMenu(view[3])"); await sleep(400); await audit(mode + "-menu");
  await ev("closeMenu(); hideStrip(); pushDigit('1'); pushDigit('2')"); await sleep(200); await audit(mode + "-numpad");
}
for (const r of results) {
  console.log(`${r.label.padEnd(18)} ${String(r.n).padStart(3)} texts  min ${r.min.toFixed(2)}:1  blue-text min ${r.primaryN ? r.primaryMin.toFixed(2) + ":1 (" + r.primaryN + ")" : "-"}  focus ${r.focus.map(f => f.cr).join(",") || "-"}  ${r.bad.length || r.focBad.length ? "FAIL" : "ok"}`);
  for (const b of r.bad) console.log("     text below", b.need, ":", b.cr, b.sel, JSON.stringify(b.text), b.fg);
  for (const b of r.focBad) console.log("     focus below 3:", b.cr, b.sel);
}
const failed = results.some(r => r.bad.length || r.focBad.length);
ws.close(); chrome.kill(); server.close(); process.exit(failed ? 1 : 0);
