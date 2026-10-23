// Keyboard + TV-remote behaviour (browser and simulated TV app): serves the
// page + a test playlist, drives it with key events over CDP, checks state.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const WEB = process.argv[2];
const OUT = process.argv[3];
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
fs.mkdirSync(OUT, { recursive: true });

// ---- test playlist ----
const groups = ["News", "Sports", "Movies", "Kids", "Music"];
const ccs = ["us", "gb", "my", "fr", "de", "jp"];
let m3u = "#EXTM3U\n";
for (let i = 0; i < 60; i++) {
  const name = i === 3 ? 'Evil <img src=x onerror="window.__xss=1">' : "Channel " + (i + 1);
  m3u += `#EXTINF:-1 tvg-id="ch${i}.${ccs[i % 6]}" tvg-logo="" group-title="${groups[i % 5]}",${name}\n`;
  m3u += `http://127.0.0.1:1/stream${i}${i % 2 ? ".m3u8" : ".ts"}\n`;
}

// v2 of the playlist: one extra channel, and channel 2 (tvg-id ch1.gb) got a new stream URL
const m3u2 = m3u.replace("http://127.0.0.1:1/stream1.m3u8", "http://127.0.0.1:1/stream1-moved.m3u8") +
  '#EXTINF:-1 tvg-id="new.us" group-title="News",Brand New\nhttp://127.0.0.1:1/new.m3u8\n';
const defaultM3u = Array.from({ length: 5 }, (_, i) => `#EXTINF:-1 tvg-id="d${i}.us",Default ${i + 1}\nhttp://127.0.0.1:1/d${i}.ts`).join("\n");
let serveV2 = false;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const target = u.searchParams.get("url") || "";
  if (u.pathname === "/proxy" && target.includes("missing")) { res.writeHead(502, { "content-type": "text/plain" }); res.end("The playlist server answered HTTP 404."); return; }
  if (u.pathname === "/proxy" && target.includes("iptv-org")) { res.writeHead(200, { "content-type": "text/plain" }); res.end(defaultM3u); return; }
  if (u.pathname === "/proxy" || u.pathname === "/list.m3u") { res.writeHead(200, { "content-type": "text/plain" }); res.end(serveV2 ? m3u2 : m3u); return; }
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : u.pathname);
  if (fs.existsSync(f)) { res.writeHead(200, { "content-type": "text/html" }); res.end(fs.readFileSync(f)); }
  else { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(8765, r));

const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", "--window-size=960,540",
  "--user-data-dir=" + path.join(OUT, "profile"), "--no-first-run", "--autoplay-policy=no-user-gesture-required", "about:blank"]);
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await new Promise(r => setTimeout(r, 200));
  try { const t = await (await fetch("http://127.0.0.1:9333/json")).json(); wsUrl = t.find(x => x.type === "page")?.webSocketDebuggerUrl; } catch {}
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") logs.push("EXCEPTION: " + JSON.stringify(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") logs.push("console.error: " + d.params.args.map(a => a.value ?? a.description).join(" "));
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); return r.result?.result?.value; };
const KEYS = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27, Backspace: 8, PageDown: 34, "/": 191 };
async function key(k, holdMs = 0) {
  const base = { key: k, code: k, windowsVirtualKeyCode: KEYS[k] || k.toUpperCase().charCodeAt(0) };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (k.length === 1) await send("Input.dispatchKeyEvent", { type: "char", text: k, ...base });
  if (holdMs) await sleep(holdMs);
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(120);
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64"));
}
const state = () => ev(`JSON.stringify({mode, zone, focusIndex, playState, playing: playingCh && playingCh.name, open: isOpen(), view: view.length, status: els.status.className, picker: picker && picker.key, headFocus, xss: window.__xss || 0, calls: window.__calls || null})`).then(JSON.parse);

const results = [];
const check = (name, cond, info) => { results.push((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  → " + JSON.stringify(info))); };

await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 960, height: 540, deviceScaleFactor: 2, mobile: false });

// Seed store so the page loads our test playlist instead of iptv-org.
async function boot(native, store) {
  await send("Page.navigate", { url: "http://127.0.0.1:8765/" }); await sleep(500);
  store = store || { source:{type:"url", url:"http://127.0.0.1:8765/list.m3u"}, favorites:[], filter:{search:"",favOnly:false,country:null,category:null}, seenWelcome:false, recentlyWatched:[] };
  await ev(`localStorage.setItem("tv.iptv.store.v1", ${JSON.stringify(JSON.stringify(store))})`);
  if (native) {
    const r = await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__calls=[]; window.MZNative={ play:(u,h)=>{__calls.push(["play",u,h]); setTimeout(()=>mzOnNative({type:"state",state:"buffering"}),50); setTimeout(()=>{ if (/stream5\\./.test(u)) mzOnNative({type:"error",reason:"Access denied — the stream is probably geo-restricted."}); else mzOnNative({type:"state",state:"playing"}); },150); }, togglePause:()=>{__calls.push(["togglePause"]); mzOnNative({type:"state",state:"paused"});}, setMuted:(m)=>__calls.push(["setMuted",m]), exit:()=>__calls.push(["exit"]), isTv:()=>true, setVideoRect:(...a)=>__calls.push(["rect",...a]), setLandscape:(b)=>__calls.push(["land",b]) };` });
    boot.scriptId = r.result.identifier;
  } else if (boot.scriptId) { await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: boot.scriptId }); boot.scriptId = null; }
  await send("Page.reload"); await sleep(1200);
}

// ================= BROWSER MODE =================
await boot(false);
let s = await state();
await shot("web-01-welcome");
check("web: welcome open on first run", s.mode === "welcome", s);
check("web: playlist loaded (60)", s.view === 60, s);
check("web: XSS name escaped", s.xss === 0, s);
await key("Enter"); s = await state();
check("web: OK closes welcome", s.mode === "list", s);
await key("ArrowDown"); await key("ArrowDown"); s = await state();
check("web: down moves focus", s.focusIndex === 2, s);
await shot("web-02-list");
await key("ArrowUp"); await key("ArrowUp"); await key("ArrowUp"); s = await state();
check("web: up from row 0 enters head bar", s.zone === "head", s);
await key("ArrowRight"); s = await state();
check("web: right moves in head", s.headFocus === 1, s);
await shot("web-03-head");
await key("ArrowDown"); s = await state();
check("web: down returns to list", s.zone === "list", s);
await key("PageDown"); s = await state();
check("web: PgDn pages list", s.focusIndex > 3, s);
await key("Enter"); await sleep(400); s = await state();
check("web: OK plays focused & hides strip", !!s.playing && !s.open, s);
check("web: unreachable stream shows persistent error", s.status === "error", s);
await shot("web-04-error");
await key("ArrowRight"); await sleep(300); s = await state();
check("web: right flips channel", s.playing && s.playing !== "Channel 1", s);
await key("ArrowDown"); await key("Enter", 800); s = await state();
check("web: hold Enter opens options menu", s.mode === "menu", s);
await shot("web-05-menu");
await key("Escape"); s = await state();
check("web: Esc closes menu", s.mode === "list", s);
// Android WebView: holding OK repeats keydown WITHOUT e.repeat; the first repeat
// (Android's long-press moment, ~400 ms) must open options — before the 550 ms fallback.
{ const ok = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...ok }); await sleep(380);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...ok }); await sleep(60);
  s = await state();
  check("tv: held OK (repeat without flag) opens options at Android's long-press", s.mode === "menu", s);
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...ok }); await sleep(150);
  check("tv: releasing a held OK doesn't also play", (await state()).mode === "menu", null);
  await key("Escape"); }
// Ctrl/Alt/Cmd + letter belongs to the browser / system (Ctrl+M must not mute, Ctrl+R not open Recent)
{ const before = await ev("muted + '|' + mode");
  for (const k of ["m", "r", "f"]) {
    const b = { key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers: 2 };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...b }); await send("Input.dispatchKeyEvent", { type: "keyUp", ...b }); }
  await sleep(150);
  check("web: Ctrl+M / Ctrl+R / Ctrl+F are ignored", (await ev("muted + '|' + mode")) === before, before); }
await key("/"); s = await state();
check("web: / opens filter", s.mode === "filter", s);
await key("ArrowDown"); await key("ArrowDown"); await key("Enter"); s = await state();
check("web: OK on Country opens picker", s.picker === "country", s);
await shot("web-06-picker");
await key("ArrowDown"); await key("Enter"); s = await state();
check("web: picking a country filters", !s.picker && s.view === 10, s);
await key("Escape"); s = await state();
check("web: Esc closes filter", s.mode === "list", s);
await shot("web-07-filtered");
await key("r"); s = await state();
check("web: R opens recent", s.mode === "recent", s);
await shot("web-08-recent");
await key("Escape");

// ================= NATIVE (TV app) MODE =================
await boot(true);
s = await state();
check("tv: welcome open", s.mode === "welcome", s);
await shot("tv-01-welcome");
await key("Enter");
check("tv: playlist via /proxy", s.view === 60, s);
const fileHidden = await ev(`els.fileBtn.offsetParent === null && getComputedStyle(document.body).backgroundColor`);
check("tv: File hidden + transparent body", fileHidden === "rgba(0, 0, 0, 0)", fileHidden);
await key("ArrowDown"); await key("ArrowDown"); await key("ArrowDown"); await key("ArrowDown"); await key("ArrowDown");
await key("Enter"); await sleep(400); s = await state();
check("tv: OK calls MZNative.play with hls hint", JSON.stringify(s.calls).includes('"play","http://127.0.0.1:1/stream5.m3u8",true'), s.calls);
check("tv: native error shows card", s.status === "error", s);
await shot("tv-02-error");
await key("ArrowRight"); await sleep(400); s = await state();
check("tv: flip → native playing clears status", s.playState === "playing" && s.status === "", s);
let r = await ev(`mzOnRemote("PlayPause")`); s = await state();
check("tv: PlayPause → togglePause + paused card", r === true && s.status === "paused", s);
await shot("tv-03-paused");
await ev(`mzOnRemote("PlayPause")`);
r = await ev(`mzOnRemote("Menu")`); s = await state();
check("tv: MENU opens the options menu (as on Fire TV / Shield)", r === true && s.mode === "menu", s);
await ev(`mzOnRemote("Menu")`); s = await state();
check("tv: MENU again closes it", s.mode === "list", s);
{ const before = await ev("favorites.has(playingCh.key)");
  await ev(`mzOnRemote("Bookmark")`);
  check("tv: Bookmark button toggles favourite", (await ev("favorites.has(playingCh.key)")) === !before, before);
  await ev(`mzOnRemote("Bookmark")`); }
r = await ev(`mzOnRemote("Yellow")`); s = await state();
check("tv: Yellow opens filter", s.mode === "filter", s);
r = await ev(`mzOnRemote("Back")`); s = await state();
check("tv: Back closes filter", r === true && s.mode === "list", s);
await ev(`mzOnRemote("Back")`); s = await state();
check("tv: Back hides strip", !s.open, s);
r = await ev(`mzOnRemote("Back")`); s = await state();
check("tv: Back at root arms exit (no exit yet)", r === true && !JSON.stringify(s.calls).includes("exit"), s.calls);
await shot("tv-04-exit-confirm");
await ev(`mzOnRemote("Back")`); s = await state();
check("tv: second Back exits", JSON.stringify(s.calls).includes('["exit"]'), s.calls);
r = await ev(`mzOnRemote("ChannelUp")`); await sleep(300); s = await state();
check("tv: CH+ with strip hidden flips", r === true && s.playing === "Channel 8", s);
await ev(`mzOnRemote("Red")`);
s = await state();
const fav = await ev(`favorites.has(playingCh.key)`);
check("tv: Red key favourites playing channel", fav === true, fav);
await key("ArrowDown"); await sleep(200);
await shot("tv-05-list-fav");
r = await ev(`mzOnRemote("Green")`); s = await state();
check("tv: Green opens recent", s.mode === "recent", s);
await ev(`mzOnRemote("Back")`);
r = await ev(`mzOnRemote("Unknown")`);
check("tv: unknown remote key not consumed", r === false, r);

// ================= PLAYLIST REFRESH / KEYS / DEFAULT =================
// Old-format store (URL-keyed) from the previous build.
await boot(true, { source:{type:"url", url:"http://127.0.0.1:8765/list.m3u"},
  favorites:["http://127.0.0.1:1/stream1.m3u8"], lastChannelUrl:"http://127.0.0.1:1/stream2.ts",
  recentlyWatched:[{ url:"http://127.0.0.1:1/stream2.ts", name:"Channel 3", logo:"", watchedAt:Date.now() }],
  filter:{search:"",favOnly:false,country:null,category:null}, seenWelcome:true });
await sleep(400);
s = await state();
let k = JSON.parse(await ev(`JSON.stringify({ favs:[...favorites], last:lastChannelKey, recentKey:recentlyWatched[0].key })`));
check("keys: old URL favourite migrated to tvg-id key", k.favs.includes("id:ch1.gb") && k.favs.length === 1, k);
check("keys: old last-channel URL migrated & resumed", k.last === "id:ch2.my" && s.playing === "Channel 3", { k, s });
check("keys: history entry gained key", k.recentKey === "id:ch2.my", k);
const playsBefore = s.calls.filter(c => c[0] === "play").length;
serveV2 = true;
await ev(`hideStrip(); playlistLoadedAt = 0; maybeRefresh()`); await sleep(600);
s = await state();
k = JSON.parse(await ev(`JSON.stringify({ n:channels.length, ch2url:channels[1].url, ch2fav:favorites.has(channels[1].key), banner:els.banner.textContent, open:isOpen() })`));
check("refresh: new list swapped in (61)", k.n === 61, k);
check("refresh: playback NOT interrupted", s.calls.filter(c => c[0] === "play").length === playsBefore && s.playing === "Channel 3" && s.playState === "playing", s);
check("refresh: favourite survives stream-URL change", k.ch2url.includes("moved") && k.ch2fav === true, k);
check("refresh: banner reports change, strip stays hidden", k.banner.includes("Playlist updated") && k.banner.includes("+1") && !k.open, k);
await shot("tv-07-refreshed");
await ev(`showStrip(); lastInputAt = Date.now(); playlistLoadedAt = 0; maybeRefresh()`); await sleep(400);
check("refresh: skipped while strip open", (await ev(`playlistLoadedAt`)) === 0, null);

// Mouse wheel / scrollbar: scrolling the list restarts the auto-hide countdown
{ const before = await ev(`showStrip(); hideTimer`); await ev(`els.list.scrollTop += 300`); await sleep(100);
  check("list: scrolling restarts the auto-hide timer", (await ev(`hideTimer`)) !== before && (await ev(`hideTimer !== null`)), before); await ev(`hideStrip()`); }

// Saved playlist is dead → default playlist loads, saved URL kept
await boot(true, { source:{type:"url", url:"http://127.0.0.1:8765/missing.m3u"}, favorites:[], filter:{search:"",favOnly:false,country:null,category:null}, seenWelcome:true, recentlyWatched:[] });
await sleep(400);
k = JSON.parse(await ev(`JSON.stringify({ n:channels.length, first:channels[0].name, saved:savedSource.url, banner:els.banner.textContent })`));
check("default: falls back to default playlist", k.n === 5 && k.first === "Default 1", k);
check("default: user's saved URL kept for next start", k.saved.endsWith("missing.m3u"), k);
check("default: banner explains the fallback", k.banner.includes("Couldn't load your playlist") && k.banner.includes("HTTP 404"), k);
await shot("tv-08-fallback");
// Blank URL field + Load → default
await ev(`els.url.value = ""; els.load.click()`); await sleep(400);
k = JSON.parse(await ev(`JSON.stringify({ saved:savedSource.url, field:els.url.value })`));
check("default: blank URL + Load loads the default", k.saved === "https://iptv-org.github.io/iptv/index.m3u" && k.field === k.saved, k);
// Fresh install → default, no typing
await boot(true, {});
await sleep(400);
k = JSON.parse(await ev(`JSON.stringify({ n:channels.length, field:els.url.value })`));
check("default: first run loads default with URL pre-filled", k.n === 5 && k.field.includes("iptv-org"), k);

// 1280x720 layout check
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1.5, mobile: false });
await sleep(400); await key("ArrowDown"); await sleep(200);
await shot("tv-06-720p");

console.log(results.join("\n"));
console.log("\nJS errors:\n" + (logs.length ? logs.join("\n") : "(none)"));
ws.close(); chrome.kill(); server.close();
process.exit(results.some(r => r.startsWith("FAIL")) || logs.length ? 1 : 0);
