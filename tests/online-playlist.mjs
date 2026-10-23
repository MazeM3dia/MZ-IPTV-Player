// Real iptv-org playlist (downloaded by run.mjs) in simulated TV mode:
// parse stats, search, row/banner/error screenshots.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const [WEB, OUT, M3U] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const m3u = fs.readFileSync(M3U);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/proxy") { res.writeHead(200, { "content-type": "text/plain" }); res.end(m3u); return; }
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : u.pathname);
  if (fs.existsSync(f)) { res.writeHead(200, { "content-type": "text/html" }); res.end(fs.readFileSync(f)); } else { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(8767, r));
const chrome = spawn(process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9335",
  "--user-data-dir=" + path.join(OUT, "profile"), "--no-first-run", "about:blank"]);
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) { await new Promise(r => setTimeout(r, 200)); try { wsUrl = (await (await fetch("http://127.0.0.1:9335/json")).json()).find(x => x.type === "page")?.webSocketDebuggerUrl; } catch {} }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errs.push(d.params.exceptionDetails.exception?.description); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
const shot = async (name) => fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 960, height: 540, deviceScaleFactor: 2, mobile: false });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__calls=[]; window.MZNative={ play:(...a)=>{__calls.push(a); setTimeout(()=>mzOnNative({type:"error",reason:"Access denied — the stream is probably geo-restricted."}),100);}, togglePause(){}, setMuted(){}, exit(){}, isTv(){ return true; }, setVideoRect(){}, setLandscape(){} }; document.addEventListener("DOMContentLoaded",()=>{document.body.style.background="#1d3557"});` });
await send("Page.navigate", { url: "http://127.0.0.1:8767/" }); await sleep(400);
await ev(`localStorage.setItem("tv.iptv.store.v1", JSON.stringify({ seenWelcome:true, favorites:[], recentlyWatched:[] }))`);
await send("Page.reload"); await sleep(2500);
const stats = await ev(`JSON.stringify({
  n: channels.length,
  withRes: channels.filter(c => c.res).length, geo: channels.filter(c => c.geo).length, part: channels.filter(c => c.part).length,
  ua: channels.filter(c => c.ua).length, ref: channels.filter(c => c.ref).length,
  dirtyNames: channels.filter(c => /\\(\\d{3,4}[pi]\\)|\\[(Geo-blocked|Not 24\\/7)\\]/.test(c.name)).length,
  sample: channels.slice(1, 4).map(c => ({ name: c.name, res: c.res, ua: !!c.ua }))
})`);
console.log(stats);
// search by country / genre
await ev(`filter.search = "malaysia"; applyFilters()`); const my = await ev(`view.length`);
await ev(`filter.search = "news"; applyFilters()`); const news = await ev(`view.length`);
await ev(`filter.search = ""; applyFilters()`);
console.log(JSON.stringify({ searchMalaysia: my, searchNews: news }));
// pick a geo-blocked channel that needs a user-agent if one exists, else any geo-blocked
const idx = await ev(`(() => { let i = view.findIndex(c => c.geo && c.res && c.ua); if (i < 0) i = view.findIndex(c => c.geo && c.res); return i; })()`);
await ev(`setFocus(${idx}); showStrip()`); await sleep(300);
await shot("real-1-list");
await ev(`playIndex(${idx}); hideStrip()`); await sleep(400);
await shot("real-2-banner-error");
console.log(JSON.stringify({ lastCall: await ev(`__calls[__calls.length-1].map(x => typeof x === "string" && x.length > 50 ? x.slice(0, 50) + "…" : x)`) }));
console.log("JS errors:", errs.length ? errs : "(none)");
ws.close(); chrome.kill(); server.close(); process.exit(errs.length ? 1 : 0);
