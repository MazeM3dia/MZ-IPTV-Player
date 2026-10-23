// End-to-end over the real internet: first run (no saved data) → default
// iptv-org playlist downloads → try real channels until one actually plays.
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { spawn } from "node:child_process";
const WEB = process.argv[2], OUT = process.argv[3]; fs.mkdirSync(OUT, { recursive: true });
const server = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x"); const f = path.join(WEB, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".woff2") ? "font/woff2" : "text/html" }); r.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(8770, r));
const chrome = spawn(process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9339",
  "--user-data-dir=" + path.join(OUT, "profile"), "--autoplay-policy=no-user-gesture-required", "about:blank"]);
let ws; for (let i = 0; i < 50 && !ws; i++) { await new Promise(r => setTimeout(r, 200)); try { const u = (await (await fetch("http://127.0.0.1:9339/json")).json()).find(x => x.type === "page")?.webSocketDebuggerUrl; if (u) ws = new WebSocket(u); } catch {} }
await new Promise(r => ws.onopen = r);
let id = 0; const p = new Map(); const errs = []; const reqHosts = new Set();
ws.onmessage = m => { const d = JSON.parse(m.data); if (p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errs.push(d.params.exceptionDetails.exception?.description);
  if (d.method === "Network.requestWillBeSent") { try { reqHosts.add(new URL(d.params.request.url).host); } catch {} } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 960, height: 540, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:8770/" });
const t0 = Date.now(); let n = 0;
while (Date.now() - t0 < 30000 && !(n = await ev(`typeof channels !== "undefined" ? channels.length : 0`))) await sleep(250);
console.log(`default playlist: ${n} channels in ${((Date.now() - t0) / 1000).toFixed(1)}s, URL field = ${await ev("els.url.value")}`);
await ev(`closeWelcome(); muted = true; player.setMuted(true)`);
// Try channels (HLS, no special headers, not geo-blocked, 24/7) until one plays.
const candidates = JSON.parse(await ev(`JSON.stringify(view.map((c, i) => ({ i, c })).filter(({ c }) => c.isHls && !c.ua && !c.ref && !c.geo && !c.part && /^https:/.test(c.url)).slice(0, 12).map(x => x.i))`));
let played = null;
for (const i of candidates) {
  await ev(`playIndex(${i}); hideStrip()`);
  const t = Date.now();
  while (Date.now() - t < 9000 && !["playing", "error"].includes(await ev("playState"))) await sleep(300);
  const st = await ev(`JSON.stringify({ name: playingCh.name, state: playState, t: els.video.currentTime, w: els.video.videoWidth, h: els.video.videoHeight, status: els.status.textContent.slice(0, 90) })`);
  console.log("  try", st);
  if (JSON.parse(st).state === "playing") { const a = await ev("els.video.currentTime"); await sleep(4000); console.log("  clock", a.toFixed(1), "->", (await ev("els.video.currentTime")).toFixed(1)); played = JSON.parse(await ev(`JSON.stringify({ name: playingCh.name, advancing: els.video.currentTime, size: els.video.videoWidth + "x" + els.video.videoHeight })`)); break; }
}
await sleep(300);
await fs.promises.writeFile(path.join(OUT, "e2e.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
console.log("result:", played ? `PLAYING "${played.name}" — ${played.size}, ${played.advancing.toFixed(1)}s in` : "no candidate played (network/geo?)");
console.log("hosts contacted:", [...reqHosts].filter(h => !h.startsWith("127.0.0.1")).slice(0, 12).join(", "));
console.log("JS errors:", errs.length ? errs : "(none)");
ws.close(); chrome.kill(); server.close(); process.exit(played && !errs.length ? 0 : 1);
