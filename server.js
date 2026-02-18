const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const LOG_FILE = path.join(__dirname, "status_log.json");
const HEARTBEAT_TIMEOUT = 4 * 60 * 1000;

/* ================= UTILITIES ================= */
const SERVICE_MAP = {
    HMXTKE6BEJHBJ0317: [
        "mediaserver.service",
        "aiserver.service"
    ]
};

function formatTime(ts) {
    const d = new Date(ts);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function parseTS(ts) {
    const [d, t] = ts.split(" ");
    const [dd, mm, yyyy] = d.split("/");
    return new Date(`${yyyy}-${mm}-${dd}T${t}`);
}

function readLogs() {
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "[]");
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
}

function saveLog(entry) {
    const logs = readLogs();
    logs.push(entry);
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}
function getServiceStatusAt(boxCode) {
    const logs = readLogs()
        .filter(l =>
            l.type === "service_status" &&
            l.boxCode === boxCode
        )
        .sort((a, b) => parseTS(b.timestamp) - parseTS(a.timestamp));

    if (!logs.length) return "-";

    return logs.map(l =>
        `${l.service_name}: ${l.service_status}`
    ).join(", ");
}




/* =================================================
   PART 1 — AI BOX HEARTBEAT
   ================================================= */
app.post("/heartbeat", (req, res) => {
    const now = Date.now();
    const ip = req.ip.replace("::ffff:", "");
    const boxCode = req.body?.boxCode || "Unknown";

    console.log(`AI BOX HB | ${boxCode} | ${ip} | ${formatTime(now)}`);

    // save heartbeat
    saveLog({
        timestamp: formatTime(now),
        boxCode,
        ip,
        source: "AI_BOX",
        online_status: "online",
        type: "heartbeat"
    });

    // detect OFFLINE → ONLINE
    const logs = readLogs().filter(
        l => l.boxCode === boxCode && l.source === "AI_BOX"
    );

    const lastStatus = [...logs]
        .reverse()
        .find(l => l.type === "status_change");

    if (!lastStatus || lastStatus.online_status === "offline") {
        saveLog({
            timestamp: formatTime(now),
            boxCode,
            ip,
            source: "AI_BOX",
            online_status: "online",
            type: "status_change"
        });

        console.log(`AI BOX STATUS: ${boxCode} OFFLINE → ONLINE`);
    }

    res.json({ ok: true });
});

app.get("/stats", (req, res) => {
    const { boxCode, from, to } = req.query;
    const logs = readLogs();


    const heartbeats = logs.filter(l => {
        if (l.type !== "heartbeat") return false;
        if (l.source !== "AI_BOX") return false;
        if (boxCode && l.boxCode !== boxCode) return false;

        if (from || to) {
            const t = parseTS(l.timestamp);
            if (from && t < new Date(from + "T00:00:00")) return false;
            if (to && t > new Date(to + "T23:59:59")) return false;
        }
        return true;
    });

    // STATUS CHANGES (for duration only)
    const statusLogs = logs
        .filter(l => l.type === "status_change" && l.source === "AI_BOX")
        .sort((a, b) => parseTS(a.timestamp) - parseTS(b.timestamp));

    let totalOnlineMs = 0;
    let totalOfflineMs = 0;

    for (let i = 0; i < statusLogs.length - 1; i++) {
        const start = parseTS(statusLogs[i].timestamp);
        const end = parseTS(statusLogs[i + 1].timestamp);
        const diff = end - start;

        if (statusLogs[i].online_status === "online") {
            totalOnlineMs += diff;
        } else {
            totalOfflineMs += diff;
        }
    }

    res.json({
        totalHeartbeats: heartbeats.length,
        totalOnlineMs,
        totalOfflineMs
    });
});


/* =================================================
   PART 2 — NODE-RED HEARTBEAT
   ================================================= */
app.post("/nodered/heartbeat", (req, res) => {
    const now = Date.now();
    const ip = req.ip.replace("::ffff:", "");

    console.log(`NODE-RED HB | ${ip} | ${formatTime(now)}`);

    saveLog({
        timestamp: formatTime(now),
        source: "NODE_RED",
        ip,
        type: "heartbeat"
    });

    res.json({ ok: true });
});

/* =================================================
   PART 3 — SERVICE STATUS (FROM NODE-RED)
   ================================================= */
app.post("/service-status", (req, res) => {
    const now = Date.now();
    const { boxCode, services, source } = req.body;

    if (!boxCode || !Array.isArray(services)) {
        return res.status(400).json({ error: "Invalid payload" });
    }

    // console.log(`\nSERVICE STATUS | ${boxCode}`);
    // services.forEach(s => {
    //     console.log(`  ${s.service_name} → ${s.status}`);
    // });

    services.forEach(s => {
        saveLog({
            timestamp: formatTime(now),
            boxCode,
            source: source || "NODE_RED",
            service_name: s.service_name,
            service_status: s.status,
            type: "service_status"
        });
    });

    res.json({ ok: true });
});

/* ================= NODE-RED STATUS ================= */
app.get("/nodered/status", (req, res) => {
    const logs = readLogs().filter(
        l => l.source === "NODE_RED" && l.type === "heartbeat"
    );

    if (!logs.length) {
        return res.json({ online: false, last_heartbeat: null });
    }

    const last = logs.sort(
        (a, b) => parseTS(b.timestamp) - parseTS(a.timestamp)
    )[0];

    const online =
        Date.now() - parseTS(last.timestamp).getTime() < HEARTBEAT_TIMEOUT;

    res.json({
        online,
        last_heartbeat: last.timestamp
    });
});

/* ================= AI BOX LIVE STATUS ================= */
app.get("/boxes", (req, res) => {
    const logs = readLogs();
    const now = Date.now();

    /* ---------------- AI BOX HEARTBEAT ---------------- */
    const lastBoxHB = {};
    logs
        .filter(l => l.type === "heartbeat" && l.source === "AI_BOX")
        .forEach(l => {
            const ts = parseTS(l.timestamp).getTime();
            if (!lastBoxHB[l.boxCode] || lastBoxHB[l.boxCode].ts < ts) {
                lastBoxHB[l.boxCode] = { ...l, ts };
            }
        });

    /* ---------------- NODE-RED HEARTBEAT ---------------- */
    const nodeHB = logs
        .filter(l => l.type === "heartbeat" && l.source === "NODE_RED")
        .sort((a, b) => parseTS(b.timestamp) - parseTS(a.timestamp))[0];

    const nodeOnline =
        nodeHB &&
        now - parseTS(nodeHB.timestamp).getTime() < HEARTBEAT_TIMEOUT;

    /* ---------------- SERVICE STATUS (SOURCE OF TRUTH) ---------------- */
    const latestService = {};
    logs
        .filter(l => l.type === "service_status")
        .forEach(l => {
            const key = `${l.boxCode}_${l.service_name}`;
            const ts = parseTS(l.timestamp).getTime();
            if (!latestService[key] || latestService[key].ts < ts) {
                latestService[key] = { ...l, ts };
            }
        });

    const rows = [];

    Object.entries(SERVICE_MAP).forEach(([boxCode, services]) => {
        const hb = lastBoxHB[boxCode];
        const boxOnline =
            hb && now - hb.ts < HEARTBEAT_TIMEOUT;

        services.forEach(service => {
            const key = `${boxCode}_${service}`;
            const s = latestService[key];

            //  CORRECT SERVICE STATUS RULE
            let serviceStatus = "stopped";

            if (
                s &&
                now - s.ts < 3 * 60 * 1000 &&
                s.service_status === "running"
            ) {
                serviceStatus = "running";
            }

            rows.push({
                service_name: service,
                online_status: boxOnline ? "online" : "offline",
                service_status: serviceStatus,
                last_heartbeat: hb ? hb.timestamp : "-"
            });
        });
    });

    res.json(rows.map((r, i) => ({ no: i + 1, ...r })));
});

/* ================= AI BOX STATUS HISTORY ================= */
app.get("/logs", (req, res) => {
    let logs = readLogs();

    const { boxCode, from, to } = req.query;

    // only AI BOX status changes
    let statusLogs = logs.filter(
        l => l.source === "AI_BOX" && l.type === "status_change"
    );

    if (boxCode) statusLogs = statusLogs.filter(l => l.boxCode === boxCode);

    if (from || to) {
        const fromD = from ? new Date(from + "T00:00:00") : null;
        const toD = to ? new Date(to + "T23:59:59") : null;

        statusLogs = statusLogs.filter(l => {
            const t = parseTS(l.timestamp);
            if (fromD && t < fromD) return false;
            if (toD && t > toD) return false;
            return true;
        });
    }

    // attach service status to each status_change
    statusLogs = statusLogs.map(s => {
        const serviceLogs = logs
            .filter(l =>
                l.type === "service_status" &&
                l.boxCode === s.boxCode &&
                parseTS(l.timestamp) <= parseTS(s.timestamp)
            )
            .sort((a, b) => parseTS(b.timestamp) - parseTS(a.timestamp));

        return {
            ...s,
            service_status: serviceLogs.length
                ? serviceLogs.map(x => `${x.service_name}: ${x.service_status}`).join(", ")
                : "-"
        };
    });

    res.json(statusLogs);
});

/* ================= OFFLINE CHECKER (AI BOX ONLY) ================= */
setInterval(() => {
    const logs = readLogs();

    // get unique box codes
    const boxCodes = [...new Set(
        logs
            .filter(l => l.source === "AI_BOX")
            .map(l => l.boxCode)
    )];

    boxCodes.forEach(boxCode => {
        const boxLogs = logs.filter(
            l => l.boxCode === boxCode && l.source === "AI_BOX"
        );

        const lastHeartbeat = [...boxLogs]
            .reverse()
            .find(l => l.type === "heartbeat");

        const lastStatus = [...boxLogs]
            .reverse()
            .find(l => l.type === "status_change");

        // nothing to check yet
        if (!lastHeartbeat || !lastStatus) return;

        const lastHBTime = parseTS(lastHeartbeat.timestamp).getTime();

        //  ONLINE → OFFLINE
        if (
            lastStatus.online_status === "online" &&
            Date.now() - lastHBTime > HEARTBEAT_TIMEOUT
        ) {
            saveLog({
                timestamp: formatTime(Date.now()),
                boxCode,
                ip: lastHeartbeat.ip,
                source: "AI_BOX",
                online_status: "offline",
                type: "status_change"
            });

            console.log(`AI BOX STATUS: ${boxCode} ONLINE → OFFLINE`);
        }
    });
}, 5000);

/* ================= START ================= */
app.use(express.static("public"));
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

