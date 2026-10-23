// Network audit: which hosts does the page contact? Served over http, opened
// as file://, and in simulated TV-app mode. Also checks the font & hls.js load.
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { spawn } from "node:child_process";
const WEB = process.argv[2], OUT = process.argv[3] || process.env.TEMP;
let failed = false; fs.mkdirSync(OUT, { recursive: true });
const m3u = "#EXTM3U\n" + [0, 1, 2].map(i => `#EXTINF:-1 tvg-id="c${i}.us" group-title="News",Chan ${i} (720p)\nhttp://127.0.0.1:1/s${i}.m3u8`).join("\n");
const server = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/list.m3u" || u.pathname === "/proxy") { r.writeHead(200, { "access-control-allow-origin": "*" }); r.end(m3u); return; }
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".woff2") ? "font/woff2" : "text/html";
  r.writeHead(200, { "content-type": type }); r.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(8769, r));
const chrome = spawn(process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9337", "--user-data-dir=" + path.join(OUT, "profile"), "about:blank"]);
let ws; for (let i = 0; i < 50 && !ws; i++) { await new Promise(r => setTimeout(r, 200)); try { const u = (await (await fetch("http://127.0.0.1:9337/json")).json()).find(x => x.type === "page")?.webSocketDebuggerUrl; if (u) ws = new WebSocket(u); } catch {} }
await new Promise(r => ws.onopen = r);
let id = 0; const p = new Map(); let reqs = []; const errs = [];
ws.onmessage = m => { const d = JSON.parse(m.data);
  if (p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); }
  if (d.method === "Network.requestWillBeSent") reqs.push(d.params.request.url);
  if (d.method === "Runtime.exceptionThrown") errs.push(d.params.exceptionDetails.exception?.description);
  if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errs.push(d.params.entry.text); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await send("Network.enable"); await send("Runtime.enable"); await send("Page.enable"); await send("Log.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });

const hosts = () => [...new Set(reqs.map(u => { try { const x = new URL(u); return x.protocol === "file:" ? "file://" + x.pathname.split("/").slice(-2).join("/") : x.protocol === "data:" ? "data:" : x.host; } catch { return u.slice(0, 40); } }))];
async function scenario(name, url, native) {
  reqs = [];
  let sid;
  if (native) sid = (await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.MZNative={play(){},togglePause(){},setMuted(){},exit(){},isTv(){return true},setVideoRect(){},setLandscape(){}}` })).result.identifier;
  await send("Page.navigate", { url }); await sleep(500);
  await ev(`localStorage.setItem("tv.iptv.store.v1", JSON.stringify({ source:{type:"url",url:"http://127.0.0.1:8769/list.m3u"}, seenWelcome:true }))`);
  reqs = [];
  await send("Page.reload"); await sleep(1500);
  await ev(`playIndex(0)`); await sleep(1500);   // HLS channel → browser lazy-loads hls.js
  const r = JSON.parse(await ev(`(async () => { await document.fonts.ready; return JSON.stringify({
      interLoaded: document.fonts.check("16px 'Inter Variable'") && [...document.fonts].some(f => f.family.includes("Inter") && f.status === "loaded"),
      hlsLoaded: !!window.Hls, channels: channels.length }); })()`));
  console.log(name.padEnd(22), JSON.stringify({ ...r, hostsContacted: hosts() }));
  // Only the local test server / local files: nothing from a CDN or elsewhere.
  if (!r.interLoaded || !r.channels || hosts().some(h => !/^(127\.0\.0\.1|file:\/\/|data:)/.test(h))) failed = true;
  if (sid) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: sid });
}
await scenario("browser (http)", "http://127.0.0.1:8769/", false);
await scenario("browser (file://)", "file:///" + WEB.replace(/\\/g, "/") + "/index.html", false);
await scenario("TV app (simulated)", "http://127.0.0.1:8769/", true);
console.log("errors:", errs.filter(e => !/127\.0\.0\.1:1\//.test(e)).length ? errs : "(none besides the fake dead streams)");
const realErrs = errs.filter(e => !/127\.0\.0\.1:1\/|ERR_UNSAFE_PORT/.test(e));
if (realErrs.length) failed = true;
console.log(failed ? "FAIL" : "ok");
ws.close(); chrome.kill(); server.close(); process.exit(failed ? 1 : 0);
