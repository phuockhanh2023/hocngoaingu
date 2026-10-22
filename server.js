// Chạy: node server.js  (cần Node 18+). Không cần cài thêm thư viện.
// Nếu có file yt-dlp.exe (Windows) hoặc yt-dlp cạnh file này, server sẽ dùng làm phương án dự phòng.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const PORT = process.env.PORT || 3000;
const TR = new Map();
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png" };

const CLIENTS = [
  { ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
    ctx: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, osName: "Android", osVersion: "14", hl: "en" } },
  { ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    ctx: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82", hl: "en" } },
  { ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
    ctx: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", hl: "en" }, embed: true },
];

async function getTracks(id, c) {
  const body = { context: { client: c.ctx }, videoId: id };
  if (c.embed) body.context.thirdParty = { embedUrl: "https://www.google.com" };
  const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST", headers: { "content-type": "application/json", "user-agent": c.ua }, body: JSON.stringify(body),
  });
  const j = await r.json();
  return (j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
}

function pick(tracks, lang) {
  const re = new RegExp("^" + lang, "i");
  const c = tracks.filter((t) => re.test(t.languageCode || ""));
  const trad = (t) => lang === "zh" && /hant|tw|hk/i.test(t.languageCode || "");
  c.sort((a, b) => (a.kind === "asr") - (b.kind === "asr") || trad(a) - trad(b));
  return c[0];
}

function parseJson3(txt) {
  const j = JSON.parse(txt);
  const cues = [];
  for (const e of j.events || []) {
    if (!e.segs) continue;
    const text = e.segs.map((s) => s.utf8).join("").replace(/\s*\n\s*/g, " ").trim();
    if (!text) continue;
    cues.push({ s: e.tStartMs / 1000, e: (e.tStartMs + (e.dDurationMs || 2000)) / 1000, t: text });
  }
  for (let i = 0; i < cues.length - 1; i++) if (cues[i].e > cues[i + 1].s) cues[i].e = cues[i + 1].s;
  return cues;
}

async function viaInnertube(id, lang, log, avail) {
  for (const c of CLIENTS) {
    try {
      const tracks = await getTracks(id, c);
      tracks.forEach((x) => { const n = x.languageCode + (x.kind === "asr" ? " (auto)" : ""); if (!avail.includes(n)) avail.push(n); });
      const t = pick(tracks, lang);
      if (!t) { log.push(c.ctx.clientName + ": không có track"); continue; }
      const txt = await (await fetch(t.baseUrl + "&fmt=json3", { headers: { "user-agent": c.ua } })).text();
      if (!txt) { log.push(c.ctx.clientName + ": phụ đề rỗng"); continue; }
      const cues = parseJson3(txt);
      if (cues.length) return { track: t.languageCode, auto: t.kind === "asr", cues };
      log.push(c.ctx.clientName + ": 0 câu");
    } catch (e) { log.push(c.ctx.clientName + ": " + e.message); }
  }
  return null;
}

function viaYtdlp(id, lang, log) {
  const exe = ["yt-dlp.exe", "yt-dlp"].map((n) => path.join(__dirname, n)).find((p) => fs.existsSync(p));
  if (!exe) { log.push("yt-dlp: chưa có file yt-dlp.exe"); return Promise.resolve(null); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cnc-"));
  const args = ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", lang + ".*", "--sub-format", "json3",
    "--no-warnings", "-o", path.join(dir, "%(id)s"), "https://www.youtube.com/watch?v=" + id];
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: 90000 }, (err, _o, stderr) => {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json3"));
        // ưu tiên phụ đề thủ công (không có -orig), tiếng Trung ưu tiên giản thể
        files.sort((a, b) => /orig/.test(a) - /orig/.test(b) || /Hant|TW|HK/i.test(a) - /Hant|TW|HK/i.test(b));
        if (!files.length) { log.push("yt-dlp: không tải được" + (stderr ? " — " + String(stderr).split("\n")[0] : "")); return resolve(null); }
        const cues = parseJson3(fs.readFileSync(path.join(dir, files[0]), "utf8"));
        resolve(cues.length ? { track: files[0], auto: /orig/.test(files[0]), cues } : null);
      } catch (e) { log.push("yt-dlp: " + e.message); resolve(null); }
      finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
    });
  });
}

async function captions(id, lang) {
  const log = [], avail = [];
  const r = (await viaInnertube(id, lang, log, avail)) || (await viaYtdlp(id, lang, log));
  if (r) return Object.assign({ available: avail }, r);
  return { error: "Không lấy được phụ đề " + lang + " (" + log.join("; ") + ")", available: avail };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/captions") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    try {
      const v = u.searchParams.get("v") || "";
      if (!/^[\w-]{11}$/.test(v)) throw new Error("ID video không hợp lệ");
      res.end(JSON.stringify(await captions(v, u.searchParams.get("lang") || "zh")));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  if (u.pathname === "/api/tr") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    try {
      const sl = u.searchParams.get("sl") || "auto", q = u.searchParams.get("q") || "";
      if (q.length > 4000) throw new Error("Văn bản quá dài");
      const key = sl + "|" + q;
      let body = TR.get(key);
      if (!body) {
        const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&tl=vi&dt=t&dt=rm&dt=bd&sl=" + encodeURIComponent(sl) + "&q=" + encodeURIComponent(q));
        if (!r.ok) throw new Error("Google trả về HTTP " + r.status);
        body = await r.text();
        if (TR.size > 1500) TR.delete(TR.keys().next().value);
        TR.set(key, body);
      }
      res.end(body);
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message || e) })); }
    return;
  }
  let f = u.pathname === "/" ? "/index.html" : u.pathname;
  f = path.join(__dirname, path.normalize(f).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(f, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end("Not found"); }
    res.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream");
    res.end(buf);
  });
}).listen(PORT, "0.0.0.0", () => console.log("Mở http://localhost:" + PORT));
