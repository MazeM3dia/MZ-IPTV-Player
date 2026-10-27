// The browser page in Firefox and WebKit (Safari's engine), through Playwright:
// TV (960×540, keyboard), desktop (1440×900, mouse) and phone (390×844, touch).
// Layout, keyboard / touch, filter + search, menus, error and welcome cards;
// with --online also real HLS playback of a public test stream.
// Optional: needs `npm install` + `npx playwright install firefox webkit`,
// otherwise it exits with code 3 and run.mjs reports SKIP.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const WEB = process.argv[2], OUT = process.argv[3], ONLINE = process.argv.includes("--online");
fs.mkdirSync(OUT, { recursive: true });
let pw;
try { pw = await import("playwright"); }
catch { console.log("SKIP: Playwright isn't installed. Run: npm install && npx playwright install firefox webkit"); process.exit(3); }

const PLAY_URL = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";   // public H.264/AAC HLS test stream
const CC = ["de", "us", "gb", "jp", "br", "fr", "in", "my"], GR = ["News", "Kids;Animation", "Music", "Sports"];
let m3u = "#EXTM3U\n#EXTINF:-1 tvg-id=\"Mux.us\" group-title=\"Movies\",Test Stream (720p)\n" + (ONLINE ? PLAY_URL : "http://127.0.0.1:1/test.m3u8") + "\n";
for (let i = 1; i < 60; i++) m3u += `#EXTINF:-1 tvg-id="Ch${i}.${CC[i % CC.length]}" group-title="${GR[i % GR.length]}",Channel ${i + 1}${i % 3 ? " (1080p)" : ""}${i % 5 ? "" : " [Geo-blocked]"}\nhttp://127.0.0.1:1/s${i}.m3u8\n`;
const TYPES = { ".js": "text/javascript", ".woff2": "font/woff2", ".png": "image/png", ".html": "text/html" };
const server = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/list.m3u") { r.writeHead(200, { "content-type": "audio/x-mpegurl" }); r.end(m3u); return; }
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); r.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(8791, r));
const BASE = "http://127.0.0.1:8791/index.html";
const VIEWS = [
  { name: "tv",      viewport: { width: 960,  height: 540 } },
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone",   viewport: { width: 390,  height: 844 }, hasTouch: true },
];
let pass = 0, fail = 0;
const check = (name, ok, info) => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  -> " + JSON.stringify(info).slice(0, 400))); };

for (const bname of ["firefox", "webkit"]) {
  let browser;
  try { browser = await pw[bname].launch(); }
  catch (e) { check(`${bname}: browser starts (npx playwright install ${bname})`, false, String(e.message).split("\n")[0]); continue; }
  console.log(`\n== ${bname} ${browser.version()}`);
  for (const v of VIEWS) {
    const tag = `${bname}-${v.name}`, errs = [];
    const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: 1, hasTouch: !!v.hasTouch });
    await ctx.addInitScript(() => localStorage.setItem("tv.iptv.store.v1",
      JSON.stringify({ source: { type: "url", url: "http://127.0.0.1:8791/list.m3u" }, seenWelcome: true })));
    const page = await ctx.newPage();
    page.on("pageerror", e => errs.push("pageerror: " + e.message));
    page.on("console", m => { if (m.type() === "error" && !/127\.0\.0\.1:1\/|ERR_CONNECTION|NS_ERROR|Failed to load resource/.test(m.text())) errs.push("console: " + m.text()); });
    const ev = (fn) => page.evaluate(fn);
    const shot = n => page.screenshot({ path: path.join(OUT, `${tag}-${n}.png`) });
    try {
      await page.goto(BASE);
      await page.waitForFunction(() => typeof channels !== "undefined" && channels.length > 0, null, { timeout: 15000 });
      await page.waitForTimeout(600);
      const info = await ev(() => {
        const fs = parseFloat(getComputedStyle(document.documentElement).fontSize), w = innerWidth;
        const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, w: b.width }; };
        return { cls: document.documentElement.className, n: channels.length, fs, w, sw: document.documentElement.scrollWidth,
          strip: r("#strip"), load: r("#load"), file: r("#fileBtn"), num: r(".channel .num"), txt: r(".channel .txt"),
          rows: document.querySelectorAll(".channel").length, de: countryName("DE"),
          cssMath: CSS.supports("width", "min(1px, 2px)"), portrait: PORTRAIT.matches };
      });
      check(`${tag}: loads the playlist`, info.n === 60, info.n);
      check(`${tag}: is-web` + (v.hasTouch ? " + touch" : ""), info.cls.includes("is-web") && (!v.hasTouch || info.cls.includes("touch")), info.cls);
      check(`${tag}: flex gap + min() supported natively`, !info.cls.includes("no-gap") && info.cssMath, info.cls);
      check(`${tag}: no horizontal overflow`, info.sw <= info.w, { sw: info.sw, w: info.w });
      const expStrip = info.portrait ? info.w : info.w * 0.05 + Math.min(24 * info.fs, 0.46 * info.w);
      check(`${tag}: channel list width`, Math.abs(info.strip.w - expStrip) < 1.5, { got: info.strip.w, exp: expStrip });
      check(`${tag}: top bar spacing`, Math.abs(info.file.l - info.load.r - 0.4 * info.fs) < 1, { got: info.file.l - info.load.r, exp: 0.4 * info.fs });
      check(`${tag}: row spacing`, Math.abs(info.txt.l - info.num.r - 3.4 * info.fs) < 1.5, { got: info.txt.l - info.num.r, exp: 3.4 * info.fs });
      check(`${tag}: list virtualized`, info.rows > 3 && info.rows < 40, info.rows);
      check(`${tag}: country names`, info.de === "Germany", info.de);
      if (info.portrait) check(`${tag}: portrait list under the 16:9 video`, Math.abs(info.strip.t - info.w * 9 / 16) < 1.5, info.strip);
      await shot("1-list");

      // Input: keyboard on TV / desktop, tap on the phone (plays channel 1)
      if (!v.hasTouch) {
        await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.waitForTimeout(150);
        check(`${tag}: ArrowDown moves the focus`, await ev(() => focusIndex) === 2, await ev(() => focusIndex));
        await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Enter");
      } else {
        const b = await page.locator(".channel").first().boundingBox();
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      }
      await page.waitForTimeout(300);
      check(`${tag}: ${v.hasTouch ? "tap" : "Enter"} starts channel 1`, await ev(() => playingCh && playingCh.name) === "Test Stream", await ev(() => playingCh && playingCh.name));
      if (ONLINE) {
        const media = await ev(() => ({ mse: !!(window.MediaSource || window.ManagedMediaSource), native: !!els.video.canPlayType("application/vnd.apple.mpegurl") }));
        if (!media.mse && !media.native) console.log(`SKIP ${tag}: playback — this ${bname} build has no Media Source and no native HLS (real Safari has native HLS)`);
        else {
          let p = null;
          for (let i = 0; i < 60; i++) {
            await page.waitForTimeout(500);
            p = await ev(() => ({ state: playState, t: els.video.currentTime, vw: els.video.videoWidth, status: els.status.textContent.replace(/\s+/g, " ").trim() }));
            if ((p.state === "playing" && p.t > 1.5 && p.vw > 0) || p.state === "error") break;
          }
          check(`${tag}: plays a real HLS stream`, p.state === "playing" && p.t > 1.5 && p.vw > 0, p);
          await shot("2-playing");
        }
      }
      if (v.hasTouch) {
        await page.touchscreen.tap(v.viewport.width / 2, 100); await page.waitForTimeout(300);
        check(`${tag}: tap on the video shows the control bar`, await ev(() => document.body.classList.contains("controls-on")));
        await shot("3-controls");
        await page.touchscreen.tap(v.viewport.width / 2, 100); await page.waitForTimeout(300);
      }

      // Filter + search by country name
      await ev(() => openFilter(true)); await page.waitForTimeout(300);
      await page.locator("#fsearch").fill("germany"); await page.waitForTimeout(400);
      check(`${tag}: search by country name`, await ev(() => view.length) === 7, await ev(() => view.length));
      await shot("4-filter");
      await page.locator("#fsearch").fill(""); await page.waitForTimeout(300);
      await ev(() => closeFilter()); await page.waitForTimeout(200);

      // Options menu, error card, welcome card
      await ev(() => openMenu(view[1])); await page.waitForTimeout(300);
      const menu = await ev(() => ({ w: document.querySelector("#menu .card").getBoundingClientRect().width, items: document.querySelectorAll("#mlist .mitem").length }));
      check(`${tag}: options menu`, menu.items >= 5 && menu.w > 200, menu);
      await shot("5-menu");
      await ev(() => closeMenu()); await page.waitForTimeout(200);
      const inside = (sel) => ev(new Function(`const c = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
        return c.left >= 0 && c.right <= innerWidth && c.top >= 0 && c.bottom <= innerHeight;`));
      await ev(() => onPlayerError("Access denied — the stream is probably geo-restricted.")); await page.waitForTimeout(300);
      check(`${tag}: error card fits the screen`, await inside("#status"));
      await shot("6-error");
      await ev(() => openWelcome()); await page.waitForTimeout(300);
      check(`${tag}: welcome card fits the screen`, await inside("#welcome .card"));
      await shot("7-welcome");
      check(`${tag}: no JS errors`, !errs.length, errs);
    } catch (e) { check(`${tag}: run`, false, String(e.message || e).slice(0, 300)); }
    await ctx.close();
  }
  await browser.close();
}
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
