// runner.js — оптимизированный HTTP API + Puppeteer pool

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const puppeteer = require("puppeteer");

const def_save_dir = "./ipeye-shots";
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

/* ===== util ===== */
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (lvl, msg, ...args) =>
    console.log(`[${new Date().toISOString()}] [${lvl}]`, msg, ...args);

/* ===== options ===== */
const OPT_PATH = process.env.OPT_PATH || "/data/options.json";

async function loadOptions() {
    try {
        return JSON.parse(await fsp.readFile(OPT_PATH, "utf8"));
    } catch (e) {
        log("ERR", `options: ${e.message}`);
        return {};
    }
}

function parseCameras(opt) {
    let cams = opt.cameras ?? [];
    if (Array.isArray(cams)) {
        cams = cams
            .map((line) => {
                if (typeof line !== "string") return null;
                const [name, url, selector] = line.split("|");
                return {
                    name: (name || "").trim(),
                    player_url: (url || "").trim(),
                    iframe_selector: (selector || "").trim(),
                };
            })
            .filter((c) => c && c.name && c.player_url);
    } else if (typeof cams === "string") {
        try {
            cams = JSON.parse(cams);
        } catch {
            cams = [];
        }
    }
    return Array.isArray(cams) ? cams : [];
}

/* ===== Camera Manager ===== */
class CameraManager {
    constructor(opts) {
        this.opts = opts;
        this.browser = null;
        this.pages = new Map();

        this.maxConcurrent = Number(opts.max_concurrent || 2);
        this.active = 0;
        this.queue = [];

        this.captureTimeoutMs = Number(opts.capture_timeout_ms || 15000);
    }

    capture = (job) => {
        return new Promise((resolve, reject) => {
            const item = { job, resolve, reject, enqueuedAt: Date.now() };
            this.queue.push(item);
            this._next();

            if (this.captureTimeoutMs > 0) {
                setTimeout(() => {
                    if (this.queue.includes(item)) {
                        this.queue = this.queue.filter((i) => i !== item);
                        reject(new Error("Queue timeout"));
                    }
                }, this.captureTimeoutMs);
            }
        });
    };

    _next = async () => {
        if (this.active >= this.maxConcurrent) return;
        const item = this.queue.shift();
        if (!item) return;

        this.active++;
        try {
            const res = await this._doCapture(item.job);
            item.resolve(res);
        } catch (err) {
            item.reject(err);
        } finally {
            this.active--;
            await this._next();
        }
    };

    _doCapture = async ({ name, player_url }) => {
        const known = parseCameras(this.opts).find((c) => c.name === name);
        const cam = known || { name, player_url, iframe_selector: "iframe" };
        if (!cam.player_url) throw new Error("player_url required");

        const st = await this.ensurePage(cam);
        st.busy = true;
        st.lastUse = Date.now();

        const buf = await this._captureFromAny(st);
        if (!buf) throw new Error("no frame");

        const baseName = `${name}-${ts()}`;
        const saveDir = this.opts.save_dir || def_save_dir;
        await fsp.mkdir(saveDir, { recursive: true });
        const jpg = path.join(saveDir, `${baseName}.jpg`);
        await fsp.writeFile(jpg, buf);

        log("SAVE", jpg);
        st.busy = false;

        return { file: path.basename(jpg), camera: name, ok: true };
    };

    ensureBrowser = async () => {
        if (this.browser && this.browser.isConnected()) return this.browser;
        this.browser = await puppeteer.launch({
            headless: "new",
            args: [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process",
                `--window-size=${this.opts.view_w || 1280},${this.opts.view_h || 720}`,
            ],
        });
        this.browser.on("disconnected", () => (this.browser = null));
        return this.browser;
    };

    ensurePage = async (cam) => {
        if (this.pages.size >= (this.opts.max_pages || 3)) {
            const oldest = [...this.pages.entries()].sort(
                (a, b) => a[1].lastUse - b[1].lastUse
            )[0];
            try {
                await oldest[1].page.close();
            } catch {}
            this.pages.delete(oldest[0]);
        }

        let st = this.pages.get(cam.name);
        if (!st || !st.page || st.page.isClosed()) {
            await this.ensureBrowser();
            const page = await this.browser.newPage();
            await page.setViewport({
                width: Number(this.opts.view_w || 1280),
                height: Number(this.opts.view_h || 720),
            });
            st = {
                page,
                url: cam.player_url,
                iframe_selector: cam.iframe_selector || "iframe",
                busy: false,
                lastUse: Date.now(),
            };
            this.pages.set(cam.name, st);
            await this.navigate(st);
        }
        return st;
    };

    navigate = async (st) => {
        try {
            await st.page.goto(st.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await sleep(500);
        } catch (e) {
            log("WARN", `navigate failed: ${e.message}`);
        }
    };

    _captureFromAny = async (st) => {
        const { page, iframe_selector } = st;
        const PLAY_WAIT_MS = Number(this.opts.play_wait_ms || 800);

        const tryVideo = async () => {
            for (const f of page.frames()) {
                const h = (await f.$("video")) || (await f.$("canvas"));
                if (h) {
                    await sleep(PLAY_WAIT_MS);
                    return h.screenshot({ type: "jpeg", quality: 70 });
                }
            }
            return null;
        };

        const tryIframe = async () => {
            const el = await page.$(iframe_selector);
            if (!el) return null;
            await sleep(PLAY_WAIT_MS);
            return el.screenshot({ type: "jpeg", quality: 70 });
        };

        return (await tryVideo()) || (await tryIframe()) || page.screenshot({ type: "jpeg", quality: 70 });
    };
}


/* ===== HTTP server ===== */
async function startHttp(opts, manager) {
    const PORT = Number(opts.http_port || 8099);
    const BIND = opts.http_bind || "0.0.0.0";
    const SAVE_DIR = opts.save_dir || def_save_dir;
    const PUBLIC_PREFIX = opts.public_prefix || "/shots";

    await fsp.mkdir(SAVE_DIR, { recursive: true });

    const srv = http.createServer(async (req, res) => {
        try {
            const { url, method } = req;
            if (method === "GET" && url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            if (method === "GET" && url.startsWith(PUBLIC_PREFIX)) {
                const rel = decodeURIComponent(url.slice(PUBLIC_PREFIX.length + 1));
                const abs = path.resolve(SAVE_DIR, rel);
                if (!abs.startsWith(path.resolve(SAVE_DIR))) {
                    res.writeHead(403).end("Forbidden");
                    return;
                }
                try {
                    const stat = await fsp.stat(abs);
                    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": stat.size });
                    fs.createReadStream(abs).pipe(res);
                } catch {
                    res.writeHead(404).end("Not found");
                }
                return;
            }

            if (method === "GET" && url.startsWith("/capture")) {
                const u = new URL(req.url, `http://${req.headers.host}`);
                const camera = u.searchParams.get("camera");
                const playerUrl = u.searchParams.get("player_url");
                if (!camera && !playerUrl) {
                    res.writeHead(400).end(JSON.stringify({ ok: false, error: "camera required" }));
                    return;
                }
                try {
                    const r = await manager.capture({ name: camera || "adhoc", player_url: playerUrl });
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify(r));
                } catch (e) {
                    res.writeHead(500).end(JSON.stringify({ ok: false, error: e.message }));
                }
                return;
            }

            res.writeHead(404).end();
        } catch (e) {
            res.writeHead(500).end(e.message);
        }
    });

    srv.listen(PORT, BIND, () => {
        log("HTTP", `listening on ${BIND}:${PORT}, serving ${SAVE_DIR}`);
    });
}

/* ===== bootstrap ===== */
(async () => {
    const opts = await loadOptions();
    const manager = new CameraManager(opts);
    await startHttp(opts, manager);

    const SAVE_DIR = opts.save_dir || def_save_dir;

    // idle cleanup страниц
    setInterval(() => {
        const now = Date.now();
        for (const [name, st] of manager.pages.entries()) {
            if (!st.busy && now - st.lastUse > 5 * 60_000) {
                st.page.close().catch(() => {});
                manager.pages.delete(name);
                log("CLEANUP", `closed idle page ${name}`);
            }
        }
    }, 60_000);

    // idle cleanup браузера (закрываем весь Chromium)
    setInterval(async () => {
        const now = Date.now();
        const idleMs = Number(opts.browser_idle_minutes || 15) * 60_000;
        if (manager.browser && manager.pages.size === 0) {
            const lastUse = manager.lastUse || 0;
            if (now - lastUse > idleMs) {
                try {
                    await manager.browser.close();
                    manager.browser = null;
                    log("CLEANUP", `closed idle browser after ${idleMs / 60000}m`);
                } catch {}
            }
        }
    }, 60_000);

    // авто-чистка старых файлов
    setInterval(async () => {
        const cutoff = Date.now() - (opts.file_ttl_hours || 6) * 60 * 60 * 1000;
        try {
            for (const f of await fsp.readdir(SAVE_DIR)) {
                const full = path.join(SAVE_DIR, f);
                try {
                    const stat = await fsp.stat(full);
                    if (stat.mtimeMs < cutoff) {
                        await fsp.unlink(full);
                        log("CLEANUP", `deleted old file ${f}`);
                    }
                } catch {}
            }
        } catch {}
    }, 10 * 60_000); // каждые 10 минут

    log("READY", "GET /health | GET /capture?camera=X | GET /shots/...");
})();

