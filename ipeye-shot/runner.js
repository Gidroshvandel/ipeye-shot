const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const puppeteer = require("puppeteer");
const fastify = require("fastify")({ logger: true });
const fastifyStatic = require("@fastify/static");
const rateLimit = require("@fastify/rate-limit");

const def_save_dir = "./ipeye-shots";
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (lvl, msg, ...args) =>
    console.log(`[${new Date().toISOString()}] [${lvl}]`, msg, ...args);

const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

/* ===== CameraManager ===== */
class CameraManager {
    constructor(opts) {
        this.opts = opts;
        this.browser = null;
        this.pages = new Map();   // камера → { page, busy, lastUse }
        this.queues = new Map();  // камера → очередь запросов
        this.active = new Map();  // камера → число активных задач
        this.maxConcurrentPerCam = Number(opts.max_concurrent_per_cam || 1);
    }

    async ensureBrowser() {
        if (this.browser && this.browser.isConnected()) return this.browser;
        this.browser = await puppeteer.launch({
            headless: "new",
            args: [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-software-rasterizer",
                "--mute-audio",
                "--disable-extensions",
                "--disable-sync",
                "--disable-background-networking",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--enable-logging",
                "--v=1",
                `--window-size=${this.opts.view_w || 1280},${this.opts.view_h || 720}`,
            ],
        });
        this.browser.on("disconnected", () => (this.browser = null));
        return this.browser;
    }

    async ensurePage(cam) {
        let st = this.pages.get(cam.name);
        if (!st || !st.page || st.page.isClosed()) {
            await this.ensureBrowser();
            const page = await this.browser.newPage();

            await page.setViewport({
                width: Number(this.opts.view_w || 1280),
                height: Number(this.opts.view_h || 720),
            });

            // ==== ЛОГИ БРАУЗЕРА ====
            page.on("console", msg =>
                log("PAGE_CONSOLE", `[${cam.name}]`, msg.type(), msg.text())
            );
            page.on("pageerror", err =>
                log("PAGE_ERROR", `[${cam.name}]`, err.message)
            );
            page.on("response", res =>
                log("PAGE_NET", `[${cam.name}]`, res.status(), res.url())
            );
            // ======================

            st = { page, url: cam.player_url, busy: false, lastUse: Date.now() };
            this.pages.set(cam.name, st);
            await this.navigate(st);
        }
        return st;
    }

    async navigate(st) {
        try {
            await st.page.goto(st.url, {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
            });
            await sleep(500);
        } catch (e) {
            log("WARN", `navigate failed: ${e.message}`);
        }
    }

    async capture(job) {
        return new Promise((resolve, reject) => {
            const q = this.queues.get(job.name) || [];
            q.push({ job, resolve, reject });
            this.queues.set(job.name, q);
            this._next(job.name);
        });
    }

    async _next(name) {
        const active = this.active.get(name) || 0;
        const q = this.queues.get(name) || [];
        if (!q.length || active >= this.maxConcurrentPerCam) return;

        const item = q.shift();
        this.queues.set(name, q);
        this.active.set(name, active + 1);

        try {
            const res = await this._doCapture(item.job);
            item.resolve(res);
        } catch (err) {
            item.reject(err);
        } finally {
            this.active.set(name, (this.active.get(name) || 1) - 1);
            this._next(name); // запускаем следующий в очереди для этой камеры
        }
    }

    async _doCapture({ name, player_url }) {
        if (!player_url) throw new Error("player_url required");

        const st = await this.ensurePage({ name, player_url });
        st.busy = true;
        st.lastUse = Date.now();

        const buf = await this._captureFromAny(st);
        if (!buf) throw new Error("no frame");

        const baseName = `${name}-${ts()}`;
        const saveDir = this.opts.save_dir || def_save_dir;
        await fsp.mkdir(saveDir, { recursive: true });
        const jpg = path.join(saveDir, `${baseName}.jpg`);
        await fsp.writeFile(jpg, buf);

        const pubBase =
            this.opts.public_base_url ||
            `http://127.0.0.1:${this.opts.http_port || 8099}`;
        const pref = (this.opts.public_prefix || "/shots").replace(/\/$/, "");
        const imageUrl = `${pubBase}${pref}/${encodeURIComponent(
            path.basename(jpg)
        )}`;

        log("SAVE", `${jpg} -> ${imageUrl}`);

        if (this.opts.dt_url) {
            setImmediate(async () => {
                const qs = new URLSearchParams({
                    url: imageUrl,
                    camera: name,
                    save: "true",
                });
                const dtUrl = `${String(this.opts.dt_url).replace(/\/$/, "")}?${qs}`;
                log("DT", `GET ${dtUrl}`);
                try {
                    const res = await fetch(dtUrl);
                    const text = await res.text().catch(() => "");
                    await fsp.writeFile(
                        path.join(saveDir, `${baseName}.json`),
                        text || "{}"
                    );
                    if (!res.ok) log("ERR", `DT error ${res.status}`);
                } catch (e) {
                    log("ERR", `DT request failed: ${e.message}`);
                }
            });
        }

        st.busy = false;

        return { file: path.basename(jpg), url: imageUrl, camera: name, ok: true };
    }

    async _captureFromAny(st) {
        const { page } = st;
        const PLAY_WAIT_MS = Number(this.opts.play_wait_ms || 800);

        const tryIframe = async () => {
            const el = await page.$("iframe");
            if (!el) return null;
            await sleep(PLAY_WAIT_MS);
            return el.screenshot({ type: "jpeg", quality: 70 });
        };

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

        return (
            (await tryIframe()) ||
            (await tryVideo()) ||
            page.screenshot({ type: "jpeg", quality: 70 })
        );
    }
}

/* ===== bootstrap ===== */
(async () => {
    let opts = {};
    try {
        const raw = await fsp.readFile(
            process.env.OPT_PATH || "/data/options.json",
            "utf8"
        );
        opts = JSON.parse(raw);
    } catch {
        opts = {};
    }

    opts = {
        save_dir: opts.save_dir || def_save_dir,
        http_port: opts.http_port || 8099,
        http_bind: opts.http_bind || "0.0.0.0",
        public_prefix: opts.public_prefix || "/shots",
        public_base_url: process.env.PUBLIC_BASE_URL || opts.public_base_url || null,
        dt_url: process.env.DT_URL || opts.dt_url || null,
        max_concurrent_per_cam: opts.max_concurrent_per_cam || 1,
        play_wait_ms: opts.play_wait_ms || 800,
        browser_idle_minutes: opts.browser_idle_minutes || 15,
        file_ttl_hours: opts.file_ttl_hours || 6,
    };

    const manager = new CameraManager(opts);

    await fastify.register(rateLimit, { max: 50, timeWindow: "1 second" });

    fastify.get("/health", async () => ({ ok: true }));

    fastify.get("/capture", async (req, reply) => {
        const camera = req.query.camera || "adhoc";
        const playerUrl = req.query.player_url;
        if (!playerUrl) {
            reply.code(400).send({ ok: false, error: "player_url required" });
            return;
        }
        try {
            const r = await manager.capture({ name: camera, player_url: playerUrl });
            return r;
        } catch (e) {
            reply.code(500).send({ ok: false, error: e.message });
        }
    });

    await fastify.register(fastifyStatic, {
        root: path.resolve(opts.save_dir),
        prefix: opts.public_prefix + "/",
    });

    // idle cleanup браузера
    setInterval(async () => {
        const now = Date.now();
        const idleMs = Number(opts.browser_idle_minutes || 15) * 60_000;
        if (manager.browser && manager.pages.size === 0) {
            if (manager.lastUse && now - manager.lastUse > idleMs) {
                try {
                    await manager.browser.close();
                    manager.browser = null;
                    log("CLEANUP", "closed idle browser");
                } catch {}
            }
        }
    }, 60_000);

    // авто-закрытие неиспользуемых страниц
    setInterval(async () => {
        const now = Date.now();
        for (const [name, st] of manager.pages) {
            if (!st.busy && now - st.lastUse > 60_000) { // idle 1 минута
                try {
                    await st.page.close();
                    manager.pages.delete(name);
                    log("CLEANUP", `closed idle page ${name}`);
                } catch {}
            }
        }
    }, 60_000);

    // авто-чистка файлов
    setInterval(async () => {
        const SAVE_DIR = opts.save_dir;
        const cutoff = Date.now() - (opts.file_ttl_hours || 6) * 3600 * 1000;
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
    }, 10 * 60_000);

    await fastify.listen({ port: opts.http_port, host: opts.http_bind });
})();
