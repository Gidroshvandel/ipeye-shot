// runner.js
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path"); // <— ВАЖНО: добавили

const OPT_PATH = "/data/options.json";

async function loadOptions() {
    try { return JSON.parse(await fs.readFile(OPT_PATH, "utf8")); }
    catch { return {}; }
}

function runJob(job, opts) {
    return new Promise((resolve) => {
        const env = {
            ...process.env,
            PLAYER_URL: job.player_url || opts.default_player_url || "",
            CAMERA: job.camera || opts.default_camera || "porch",
            DT_URL: opts.dt_url || "http://192.168.50.99:3000/api/recognize/upload",
            SAVE_DIR: opts.save_dir || "/share/ipeye_shots",
            SAVE_ALWAYS: String(opts.save_always ?? false),
            PLAY_WAIT_MS: String(opts.play_wait_ms ?? 1200),
            VIEW_W: String(opts.view_w ?? 1280),
            VIEW_H: String(opts.view_h ?? 720),
            HEADLESS: String(opts.headless ?? "new"),
            IFRAME_SELECTOR: String(opts.iframe_selector ?? "iframe"),
            RETRIES: String(opts.retries ?? 1),
            RETRY_DELAY_MS: String(opts.retry_delay_ms ?? 500),
        };
        const script = path.join(__dirname, "capture-and-send.js"); // путь рядом с runner.js
        const child = spawn(process.execPath, [script], { env, stdio: "inherit" });
        child.on("exit", (code) => resolve(code));
    });
}

let busy = false;
const queue = [];

async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
        const job = queue.shift();
        const opts = await loadOptions();
        if (!(job.player_url || opts.default_player_url)) {
            console.error("[ipeye-shot] empty player_url; skip");
            continue;
        }
        const code = await runJob(job, opts);
        console.log("[ipeye-shot] job finished:", code);
    }
    busy = false;
}
function enqueue(job) { queue.push(job); pump().catch(console.error); }

/* ---------- HTTP server (singleton) ---------- */
let serverInstance = null;
let serverAddr = "";

async function startHttp() {
    if (serverInstance) {
        console.log(`[ipeye_shot] HTTP already started at ${serverAddr}`);
        return serverInstance;
    }

    const opts = await loadOptions();
    const PORT = Number(opts.http_port || 8099);
    const BIND = String(opts.http_bind || "0.0.0.0");

    const server = http.createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, {"content-type":"application/json"});
            res.end(JSON.stringify({ok:true, busy, q:queue.length}));
            return;
        }
        if (req.method === "POST" && req.url === "/capture") {
            let body = "";
            req.on("data", c => body += c);
            req.on("end", async () => {
                try {
                    const data = JSON.parse(body || "{}");
                    const cfg = await loadOptions();
                    if (!data.player_url && !cfg.default_player_url) {
                        res.writeHead(400, {"content-type":"application/json"});
                        res.end(JSON.stringify({ok:false, error:"player_url required"}));
                        return;
                    }
                    enqueue({ player_url: data.player_url, camera: data.camera });
                    res.writeHead(202, {"content-type":"application/json"});
                    res.end(JSON.stringify({ok:true, queued:true}));
                } catch (e) {
                    res.writeHead(400, {"content-type":"application/json"});
                    res.end(JSON.stringify({ok:false, error:String(e.message||e)}));
                }
            });
            return;
        }
        res.writeHead(404); res.end();
    });

    server.on("error", (e) => {
        if (e.code === "EADDRINUSE") {
            console.error(`[ipeye_shot] Port in use: ${BIND}:${PORT}. Второй сервер не стартуем — первый уже слушает.`);
            return; // оставляем процесс жить
        }
        console.error("[ipeye-shot] HTTP server error:", e);
        process.exit(1);
    });

    server.listen(PORT, BIND, () => {
        serverInstance = server;
        serverAddr = `${BIND}:${PORT}`;
        console.log(`[ipeye_shot] HTTP listening on ${serverAddr}`);
    });

    const shutdown = () => server.close(() => process.exit(0));
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    return server;
}

/* ---------- addon_stdin support (singleton) ---------- */
let stdinStarted = false;
function startStdin() {
    if (stdinStarted) return;
    stdinStarted = true;

    let buf = "";
    process.stdin.on("data", chunk => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try { enqueue(JSON.parse(line)); }
            catch (e) { console.error("[ipeye-shot] bad JSON on stdin:", e.message); }
        }
    });
    console.log("[ipeye-shot] ready for addon_stdin and HTTP /capture");
}

/* ---------- bootstrap ---------- */
startHttp().catch(console.error);
startStdin();
