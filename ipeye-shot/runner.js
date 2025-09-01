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
        this.pages = new Map();

        this.maxConcurrent = Number(opts.max_concurrent || 2);
        this.active = 0;
        this.queue = [];
        this.captureTimeoutMs = Number(opts.capture_timeout_ms || 15000);
    }

    capture = (job) => {
        return new Promise((resolve, reject) => {
            const item = { job, resolve, reject };
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
            void this._next();
        }
    };

    _doCapture = async ({ name, player_url }) => {
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

        // формируем публичный URL
        const pubBase =
            this.opts.public_base_url ||
            `http://127.0.0.1:${this.opts.http_port || 8099}`;
        const pref = (this.opts.public_prefix || "/shots").replace(/\/$/, "");
        const imageUrl = `${pubBase}${pref}/${encodeURIComponent(
            path.basename(jpg)
        )}`;

        log("SAVE", `${jpg} -> ${imageUrl}`);

        // если настроен DT_URL — отправляем туда
        if (this.opts.dt_url) {
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
                if (!res.ok) throw new Error(`DT error ${res.status}`);
            } catch (e) {
                log("ERR", `DT request failed: ${e.message}`);
            }
        }

        st.busy = false;

        return {
            file: path.basename(jpg),
            url: imageUrl,
            camera: name,
            ok: true,
        };
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
                iframe_selector: "iframe",
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
            await st.page.goto(st.url, {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
            });
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

        return (
            (await tryVideo()) ||
            (await tryIframe()) ||
            page.screenshot({ type: "jpeg", quality: 70 })
        );
    };
}

/* ===== bootstrap ===== */
(async () => {
    const opts = {
        save_dir: def_save_dir,
        http_port: 8099,
        http_bind: "0.0.0.0",
        public_prefix: "/shots",
        dt_url: process.env.DT_URL || null,
        max_concurrent: 2,
        capture_timeout_ms: 15000,
        browser_idle_minutes: 15,
        file_ttl_hours: 6,
    };

    const manager = new CameraManager(opts);

    // rate limit
    await fastify.register(rateLimit, { max: 10, timeWindow: "1 minute" });

    // health check
    fastify.get("/health", async () => ({ ok: true }));

    // capture API
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
            if (e.message.includes("timeout")) {
                reply.code(503).send({ ok: false, error: "Queue timeout" });
            } else {
                reply.code(500).send({ ok: false, error: e.message });
            }
        }
    });

    // static files
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
