// runner.js — единый процесс: HTTP API + статическая раздача + пул Puppeteer

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const puppeteer = require("puppeteer");

const def_save_dir = "./ipeye-shots"

const fetch = (...a) => import("node-fetch").then(({default: f}) => f(...a));

const OPT_PATH = process.env.OPT_PATH || "/data/options.json";

/* ====== util ====== */
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logFsError(err, p) {
    const hint =
        err?.code === 'ENOENT' ? 'Файл не найден. В аддоне HA опции лежат в /data/options.json.' :
            err?.code === 'EACCES' ? 'Недостаточно прав. В аддоне читайте/пишите в /data; проверьте монтирование и права.' :
                null;

    console.error(`[options] Не удалось прочитать ${p}: ${err?.code || 'ERR'} ${err?.message}${hint ? ` — ${hint}` : ''}`);
}

function logJsonError(err, raw, p) {
    const m = /position (\d+)/i.exec(err.message || '');
    if (m) {
        const pos = Number(m[1]);
        const { line, col, context } = locate(raw, pos);
        console.error(`[options] Неверный JSON в ${p}: строка ${line}, столбец ${col}. ${err.message}\n${context}`);
    } else {
        console.error(`[options] Неверный JSON в ${p}: ${err.message}`);
    }
}

function locate(text, pos, radius = 40) {
    let line = 1, col = 1;
    for (let i = 0; i < pos && i < text.length; i++) {
        if (text[i] === '\n') { line++; col = 1; } else { col++; }
    }
    const start = Math.max(0, pos - radius);
    const end = Math.min(text.length, pos + radius);
    const snippet = text.slice(start, end);
    const caret = ' '.repeat(Math.max(0, pos - start)) + '^';
    return { line, col, context: `…${snippet}…\n${caret}` };
}

async function loadOptions() {
    try {
        const raw = await fsp.readFile(OPT_PATH, 'utf8');
        try {
            return JSON.parse(raw);
        } catch (e) {
            logJsonError(e, raw, OPT_PATH);
            return {};
        }
    } catch (e) {
        logFsError(e, OPT_PATH);
        return {};
    }
}

function parseCameras(opt) {
    let cams = opt.cameras ?? [];
    // list(str) вариант
    if (Array.isArray(cams)) {
        cams = cams
            .map(line => {
                if (typeof line !== 'string') return null;
                const [name, url, selector] = line.split('|');
                return { name: (name||'').trim(), player_url: (url||'').trim(), iframe_selector: (selector||'').trim() };
            })
            .filter(c => c && c.name && c.player_url);
    }
    // JSON-строка вариант
    else if (typeof cams === 'string') {
        try { cams = JSON.parse(cams); }
        catch { console.warn('[opts] cameras is string but not JSON; ignoring'); cams = []; }
    }
    if (!Array.isArray(cams)) cams = [];
    const fallbackSel = opt.iframe_selector || 'iframe';
    return cams
        .map(c => ({ name: String(c.name), player_url: String(c.player_url||''), iframe_selector: c.iframe_selector || fallbackSel }))
        .filter(c => c.name && c.player_url);
}


/* ====== static server for SAVE_DIR ====== */
let httpServer = null;

async function startHttp(opts, cameraManager) {
    if (httpServer) return httpServer;
    const PORT = Number(opts.http_port || 8099);
    const BIND = String(opts.http_bind || "0.0.0.0");
    const SAVE_DIR = String(opts.save_dir || def_save_dir);
    const PUBLIC_PREFIX = String(opts.public_prefix || "/shots");
    const SERVE = Boolean(opts.serve_save_dir ?? true);

    await fsp.mkdir(SAVE_DIR, {recursive: true});

    httpServer = http.createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/health") {
                const state = cameraManager.state();
                res.writeHead(200, {"content-type": "application/json"});
                res.end(JSON.stringify({ok: true, ...state}));
                return;
            }

            if (SERVE && req.method === "GET" && req.url.startsWith(PUBLIC_PREFIX + "/")) {
                const start = Date.now();
                const { pathname } = new URL(req.url, `http://${req.headers.host}`);

                const finish = (status, extra = "") => {
                    const ms = Date.now() - start;
                    console.log(`[${new Date().toISOString()}] ${req.method} ${pathname} -> ${status}${extra ? " " + extra : ""} ${ms}ms`);
                };

                if (pathname.startsWith(PUBLIC_PREFIX + "/")) {
                    try {
                        const rel = decodeURIComponent(pathname.slice((PUBLIC_PREFIX + "/").length));
                        const abs = path.resolve(SAVE_DIR, rel);
                        const root = path.resolve(SAVE_DIR);

                        // простая защита от выхода из каталога
                        if (!abs.startsWith(root + path.sep)) {
                            res.writeHead(403);
                            res.end("Forbidden");
                            finish(403);
                            return;
                        }

                        let stat;
                        try {
                            stat = await fsp.stat(abs);
                        } catch (e) {
                            if (e.code === "ENOENT") {
                                res.writeHead(404);
                                res.end("Not found");
                                finish(404);
                            } else {
                                res.writeHead(500);
                                res.end("Server error");
                                finish(500, e.code || "");
                            }
                            return;
                        }

                        res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": stat.size });

                        const stream = fs.createReadStream(abs);
                        stream.on("error", (e) => {
                            if (!res.headersSent) res.writeHead(500);
                            res.end("Read error");
                            finish(500, e.code || "read-error");
                        });
                        res.on("finish", () => {
                            // компактный вывод размера в КБ
                            const kb = Math.round((stat.size / 1024) * 10) / 10;
                            finish(200, `${kb}KB`);
                        });

                        stream.pipe(res);
                        return;
                    } catch (e) {
                        res.writeHead(500);
                        res.end("Unhandled error");
                        finish(500);
                        return;
                    }
                }
            }

            if (req.method === "GET" && req.url === "/cameras") {
                res.writeHead(200, {"content-type": "application/json"});
                res.end(JSON.stringify({cameras: cameraManager.list()}));
                return;
            }

            // Trigger capture by camera name
            if (req.method === "GET" && (req.url.startsWith("/capture") || req.url.startsWith("/capture?"))) {
                const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
                const camera = (u.searchParams.get("camera") || "").trim();
                const playerUrl = u.searchParams.get("player_url") || null;   // опционально: разовый URL вместо преднастроенной камеры
                const cameraLabel = u.searchParams.get("camera_label") || camera || "manual";

                if (!camera && !playerUrl) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok:false, error:"camera or player_url required" }));
                    return;
                }

                try {
                    const result = await cameraManager.capture({
                        name: camera || `adhoc-${Date.now()}`,
                        player_url: playerUrl,
                        cameraLabel
                    });
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok:true, ...result }));
                } catch (e) {
                    res.writeHead(500, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok:false, error:String(e.message||e) }));
                }
                return;
            }

            res.writeHead(404);
            res.end();
        } catch (e) {
            res.writeHead(500);
            res.end(String(e.message || e));
        }
    });

    httpServer.on("error", (e) => {
        console.error("[ipeye-shot] HTTP error:", e);
    });

    httpServer.listen(PORT, BIND, () => {
        console.log(`[ipeye-shot] HTTP listening on ${BIND}:${PORT}; serving ${SERVE ? (SAVE_DIR + " at " + PUBLIC_PREFIX) : "no static"}`);
    });
    return httpServer;
}

/* ====== Camera Manager (one browser, many pages) ====== */
class CameraManager {
    constructor(opts) {
        this.opts = opts;
        this.browser = null;
        this.pages = new Map();   // name -> { page, url, iframe_selector, busy, lastOpen, lastUse }
        this.queue = new Map();   // serialize per camera
    }

    state() {
        const cams = [];
        for (const [name, st] of this.pages.entries()) {
            cams.push({name, url: st.url, busy: !!st.busy, lastOpen: st.lastOpen, lastUse: st.lastUse});
        }
        return {browser: !!this.browser, cameras: cams};
    }

    list() {
        return Array.from(this.pages.keys());
    }

    async ensureBrowser() {
        if (this.browser && this.browser.isConnected()) return this.browser;
        this.browser = await puppeteer.launch({
            headless: this.opts.headless ?? "new",
            args: [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--autoplay-policy=no-user-gesture-required",
                `--window-size=${this.opts.view_w || 1280},${this.opts.view_h || 720}`
            ]
        });
        this.browser.on("disconnected", () => {
            console.warn("[puppeteer] browser disconnected");
            this.browser = null;
        });
        return this.browser;
    }

    async ensurePage(cam) {
        const now = Date.now();
        let st = this.pages.get(cam.name);

        // lazy create
        if (!st || !st.page || st.page.isClosed()) {
            await this.ensureBrowser();
            const page = await this.browser.newPage();
            await page.setViewport({width: Number(this.opts.view_w || 1280), height: Number(this.opts.view_h || 720)});
            st = {
                page,
                url: cam.player_url,
                iframe_selector: cam.iframe_selector || this.opts.iframe_selector || "iframe",
                busy: false,
                lastOpen: now,
                lastUse: 0
            };
            this.pages.set(cam.name, st);
            await this.navigate(st);
            return st;
        }

        // maybe reload by TTL or url change
        const ttl = Number(this.opts.reload_minutes || 60) * 60_000;
        if ((ttl > 0 && (now - st.lastOpen) > ttl) || (cam.player_url && cam.player_url !== st.url)) {
            try {
                await st.page.close({runBeforeUnload: false});
            } catch {
            }
            this.pages.delete(cam.name);
            return this.ensurePage(cam);
        }

        return st;
    }

    async navigate(st) {
        try {
            await st.page.goto(st.url, {waitUntil: "domcontentloaded", timeout: 60_000});
            await sleep(800);
        } catch (e) {
            console.warn("[nav] failed:", e.message || e);
        }
    }

    async capture({name, player_url, cameraLabel}) {
        // resolve camera config or ad-hoc
        const known = parseCameras(this.opts).find(c => c.name === name);
        const cam = known || {name, player_url, iframe_selector: this.opts.iframe_selector || "iframe"};
        if (!cam.player_url) throw new Error("player_url not set for camera");

        // serialize requests per camera
        let q = this.queue.get(name);
        if (!q) {
            q = Promise.resolve();
            this.queue.set(name, q);
        }
        let resolveRes, rejectRes;
        const job = new Promise((res, rej) => {
            resolveRes = res;
            rejectRes = rej;
        });
        this.queue.set(name, q.then(() => job).catch(() => job)); // keep chain

        await (async () => {
            let st;
            try {
                st = await this.ensurePage(cam);
                st.busy = true;
                st.lastUse = Date.now();

                const buf = await this._captureFromAny(st);
                if (!buf) throw new Error("capture failed (no frame)");

                const baseName = `${name}-${ts()}`;
                await fsp.mkdir(this.opts.save_dir || def_save_dir, {recursive: true});
                const jpg = path.join(this.opts.save_dir || def_save_dir, `${baseName}.jpg`);
                await fsp.writeFile(jpg, buf);
                console.log("[save]", jpg);

                const pub = String(this.opts.public_base_url || `http://127.0.0.1:${this.opts.http_port || 8099}`).replace(/\/$/, "");
                const pref = String(this.opts.public_prefix || "/shots").replace(/\/$/, "");
                const imageUrl = `${pub}${pref}/${encodeURIComponent(path.basename(jpg))}`;

                const qs = new URLSearchParams({url: imageUrl, camera: cameraLabel || name, save: "true"});
                const url = `${String(this.opts.dt_url).replace(/\/$/, "")}?${qs.toString()}`;
                console.log("[dt] GET", url);

                const res = await fetch(url);
                const text = await res.text().catch(() => "");
                await fsp.writeFile(path.join(this.opts.save_dir || def_save_dir, `${baseName}.json`), text || "{}");
                if (!res.ok) throw new Error(`DT error ${res.status} ${res.statusText}`);

                resolveRes({file: path.basename(jpg), camera: cameraLabel || name, ok: true});
            } catch (e) {
                rejectRes(e);
            } finally {
                if (st) st.busy = false;
            }
        })();

        return job;
    }

    async _captureFromAny(st) {
        const {page, iframe_selector} = st;
        const PLAY_WAIT_MS = Number(this.opts.play_wait_ms || 1200);

        // try video/canvas in any frame
        const videoOrCanvas = async () => {
            let handle = null, fr = null;
            for (const f of page.frames()) {
                try {
                    handle = await f.$("video") || await f.$("canvas");
                    if (handle) {
                        fr = f;
                        break;
                    }
                } catch {
                }
            }
            if (!handle) return null;
            try {
                await fr?.evaluate((node) => {
                    if (node?.tagName?.toLowerCase() === "video") {
                        node.muted = true;
                        node.play?.().catch(() => {
                        });
                    }
                }, handle);
            } catch {
            }
            await sleep(PLAY_WAIT_MS);
            return handle.screenshot({type: "jpeg", quality: 85});
        };

        const iframeShot = async () => {
            try {
                const el = await page.$(iframe_selector);
                if (!el) return null;
                await sleep(PLAY_WAIT_MS);
                return el.screenshot({type: "jpeg", quality: 85});
            } catch {
                return null;
            }
        };

        const pageShot = async () => page.screenshot({type: "jpeg", quality: 85, fullPage: false});

        // pipeline
        return (await videoOrCanvas()) || (await iframeShot()) || (await pageShot());
    }
}

/* ====== bootstrap ====== */
(async () => {
    const opts = await loadOptions();

    const manager = new CameraManager(opts);
    await startHttp(opts, manager);

    // прогрев
    if (opts.prewarm) {
        const cams = parseCameras(opts);
        for (const c of cams) {
            manager.ensurePage(c).then(() => console.log("[warmup] ready:", c.name))
                .catch(e => console.warn("[warmup] fail:", c.name, e.message || e));
        }
    }

    // аккуратное завершение
    const shutdown = async () => {
        try {
            if (manager.browser) await manager.browser.close();
        } catch {
        }
        try {
            if (httpServer) await new Promise(r => httpServer.close(() => r()));
        } catch {
        }
        process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    console.log("[ipeye-shot] ready: POST /capture | GET /cameras | GET /health");
})();
