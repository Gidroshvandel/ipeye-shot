// deps: puppeteer, form-data, node-fetch@3
const puppeteer = require("puppeteer");
const fs = require("fs/promises");
const path = require("path");
const FormData = require("form-data");
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

/* ===== env & defaults ===== */
const PLAYER_URL = process.env.PLAYER_URL || "";
const DT_URL = process.env.DT_URL || "http://192.168.50.99:3000/api/recognize/upload";
const CAMERA = process.env.CAMERA || "porch";
const SAVE_DIR = process.env.SAVE_DIR || "/share/ipeye_shots";
const SAVE_ALWAYS = /^1|true|yes$/i.test(process.env.SAVE_ALWAYS || "false");
const VIEW_W = Number(process.env.VIEW_W || 1280);
const VIEW_H = Number(process.env.VIEW_H || 720);
const HEADLESS = process.env.HEADLESS ?? "new";
const IFRAME_SELECTOR = process.env.IFRAME_SELECTOR || "iframe";
const PLAY_WAIT_MS = Number(process.env.PLAY_WAIT_MS || 1200);
const RETRIES = Number(process.env.RETRIES || 1);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 500);

/* ===== utils ===== */
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDir(dir) {
    try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

async function saveArtifacts(buf, baseName, res) {
    await ensureDir(SAVE_DIR);
    const jpg = path.join(SAVE_DIR, `${baseName}.jpg`);
    const json = path.join(SAVE_DIR, `${baseName}.json`);
    if (buf && SAVE_ALWAYS) {
        await fs.writeFile(jpg, buf);
        console.log("[save] jpg:", jpg);
    }
    if (res && SAVE_ALWAYS) {
        const text = await res.text().catch(() => "");
        await fs.writeFile(json, text || "{}");
        console.log("[save] response:", json);
    }
}

async function postToDoubleTake(buf) {
    const form = new FormData();
    form.append("files[]", buf, { filename: "frame.jpg", contentType: "image/jpeg" });
    form.append("camera", CAMERA);
    form.append("save", "true");
    return fetch(DT_URL, { method: "POST", body: form });
}

async function tryWithRetries(fn, label) {
    let lastErr;
    for (let i = 0; i <= RETRIES; i++) {
        try {
            const val = await fn();
            if (val) return val;
            throw new Error(`${label} returned empty result`);
        } catch (e) {
            lastErr = e;
            if (i < RETRIES) {
                console.warn(`[retry] ${label} failed: ${e.message}. retry in ${RETRY_DELAY_MS}ms…`);
                await sleep(RETRY_DELAY_MS);
            }
        }
    }
    throw lastErr;
}

/* ===== capture strategies (return Buffer) ===== */
async function captureFromVideoOrCanvas(page) {
    // ищем <video>/<canvas> в любом frame
    let el = null, fr = null;
    for (const f of page.frames()) {
        try {
            el = await f.$("video") || await f.$("canvas");
            if (el) { fr = f; break; }
        } catch { /* cross-origin frame — игнор */ }
    }
    if (!el) return null;

    // попробовать воспроизвести <video>
    try {
        await fr?.evaluate((node) => {
            if (node && node.tagName && node.tagName.toLowerCase() === "video") {
                node.muted = true;
                // eslint-disable-next-line promise/catch-or-return
                node.play().catch(() => {});
            }
        }, el);
    } catch { /* не критично */ }

    await sleep(PLAY_WAIT_MS);
    return el.screenshot({ type: "jpeg", quality: 85 });
}

async function captureFromIframe(page) {
    const iframeEl = await page.$(IFRAME_SELECTOR);
    if (!iframeEl) return null;
    await sleep(PLAY_WAIT_MS);
    return iframeEl.screenshot({ type: "jpeg", quality: 85 });
}

async function captureFromPage(page) {
    return page.screenshot({ type: "jpeg", quality: 85, fullPage: false });
}

/* ===== main ===== */
(async () => {
    if (!PLAYER_URL) {
        console.error("PLAYER_URL is empty");
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: HEADLESS,
        args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--autoplay-policy=no-user-gesture-required",
            `--window-size=${VIEW_W},${VIEW_H}`
        ]
    });

    /** @type {import('puppeteer').Page} */
    const page = await browser.newPage();
    await page.setViewport({width: VIEW_W, height: VIEW_H});

    try {
        await page.goto(PLAYER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(800);

        const baseName = `${CAMERA}-${ts()}`;

        // pipeline: video/canvas → iframe → page
        const strategies = [
            { name: "video/canvas", fn: () => captureFromVideoOrCanvas(page) },
            { name: "iframe", fn: () => captureFromIframe(page) },
            { name: "page", fn: () => captureFromPage(page) }
        ];

        let buffer = null, used = null;

        for (const s of strategies) {
            try {
                buffer = await tryWithRetries(s.fn, s.name);
                used = s.name;
                console.log("[capture] success via:", used);
                break;
            } catch (e) {
                console.warn(`[capture] ${s.name} failed: ${e.message}`);
            }
        }

        if (!buffer) throw new Error("all capture strategies failed");

        const res = await postToDoubleTake(buffer);
        await saveArtifacts(buffer, baseName, res);

        if (!res.ok) throw new Error(`Double-Take upload failed: ${res.status} ${res.statusText}`);

        console.log(`[done] OK (${used})`);
    } catch (e) {
        console.error("[error]", e?.message || e);
        await saveArtifacts(null, `${CAMERA}-${ts()}`, null);
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
