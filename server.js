const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
require("dotenv").config();
const mongoose = require("mongoose");


  const logSchema = new mongoose.Schema({
  timestamp: String,
  boxCode: String,
  source: String,
  ip: String,
  online_status: String,
  service_name: String,
  service_status: String,
  type: String
});
console.log("Render MONGO_URI:", process.env.MONGO_URI);
const Log = mongoose.model("Log", logSchema);
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
    return new Date(ts).toLocaleString("en-GB", {
        timeZone: "Asia/Bangkok",
        hour12: false
    }).replace(",", "");
}


function parseTS(ts) {
    const [d, t] = ts.split(" ");
    const [dd, mm, yyyy] = d.split("/");
    return new Date(`${yyyy}-${mm}-${dd}T${t}`);
}

async function readLogs() {
    return await Log.find();
}
async function saveLog(entry) {
    await Log.create(entry);
}
async function getServiceStatusAt(boxCode) {
    const logs = await readLogs();

    const filtered = logs
        .filter(l =>
            l.type === "service_status" &&
            l.boxCode === boxCode
        )
        .sort((a, b) => parseTS(b.timestamp) - parseTS(a.timestamp));

    if (!filtered.length) return "-";

    return filtered.map(l =>
        `${l.service_name}: ${l.service_status}`
    ).join(", ");
}




/* =================================================
   PART 1 — AI BOX HEARTBEAT
   ================================================= */
app.post("/heartbeat", async (req, res) => {
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
    const logs = (await readLogs()).filter(
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

app.get("/stats", async function (req, res) {
        const { boxCode, from, to } = req.query;
        const logs = await readLogs();


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
    const { boxCode } = req.body;

    if (!boxCode) {
        return res.status(400).json({ error: "Missing boxCode" });
    }

    console.log(`NODE-RED HB | ${boxCode} | ${ip} | ${formatTime(now)}`);

    saveLog({
        timestamp: formatTime(now),
        boxCode,
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



/* ================= AI BOX LIVE STATUS ================= */
app.get("/boxes",async (req, res) => {
    const logs = await readLogs();
    const now = Date.now();

    const boxes = [...new Set(
        logs
            .filter(l => l.boxCode)
            .map(l => l.boxCode)
    )];

    const rows = boxes.map(boxCode => {

        /* ---- AI BOX HEARTBEAT ---- */
        const lastBoxHB = logs
            .filter(l =>
                l.boxCode === boxCode &&
                l.source === "AI_BOX" &&
                l.type === "heartbeat"
            )
            .sort((a, b) => parseTS(b.timestamp) - parseTS(a.timestamp))[0];

        const boxOnline =
            lastBoxHB &&
            now - parseTS(lastBoxHB.timestamp).getTime() < HEARTBEAT_TIMEOUT;

        /* ---- NODE-RED HEARTBEAT (PER BOX) ---- */
        const lastNodeHB = logs
            .filter(l =>
                l.boxCode === boxCode &&
                l.source === "NODE_RED" &&
                l.type === "heartbeat"
            )
            .sort((a, b) => parseTS(b.timestamp) - parseTS(a.timestamp))[0];

        const nodeOnline =
            lastNodeHB &&
            now - parseTS(lastNodeHB.timestamp).getTime() < 2 * 60 * 1000;

        /* ---- MEDIA SERVICE ---- */
        const media = logs
            .filter(l =>
                l.boxCode === boxCode &&
                l.type === "service_status" &&
                l.service_name === "mediaserver.service"
            )
            .sort((a, b) => parseTS(b.timestamp) - parseTS(a.timestamp))[0];

        const mediaRunning =
            media &&
            now - parseTS(media.timestamp).getTime() < 3 * 60 * 1000 &&
            media.service_status === "running";

        /* ---- AI SERVER ---- */
        const aiServer = logs
            .filter(l =>
                l.boxCode === boxCode &&
                l.type === "service_status" &&
                l.service_name === "aiserver.service"
            )
            .sort((a, b) => parseTS(b.timestamp) - parseTS(a.timestamp))[0];

        const aiServerRunning =
            aiServer &&
            now - parseTS(aiServer.timestamp).getTime() < 3 * 60 * 1000 &&
            aiServer.service_status === "running";

        return {
            site: boxCode,
            aiBoxStatus: boxOnline ? "online" : "offline",
            aiBoxLast: lastBoxHB ? lastBoxHB.timestamp : "-",

            mediaStatus: mediaRunning ? "running" : "stopped",
            mediaLast: media ? media.timestamp : "-",

            aiServerStatus: aiServerRunning ? "running" : "stopped",
            aiServerLast: aiServer ? aiServer.timestamp : "-",

            nodeStatus: nodeOnline ? "online" : "offline",
            nodeLast: lastNodeHB ? lastNodeHB.timestamp : "-"
        };
    });

    res.json(rows);
});
app.get("/debug-files", (req, res) => {
    const files = fs.readdirSync(__dirname);
    res.json(files);
});
app.get("/heartbeat",
(req, res) => {
    console.log("AI BOX GET RECEIVED:", req.query);
    res.send("GET OK");
});

/* ================= AI BOX STATUS HISTORY ================= */
app.get("/logs", async (req, res) => {
    let logs = await readLogs();

    const { boxCode, from, to } = req.query;

    // only AI BOX status changes
    let statusLogs =  logs.filter(
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
setInterval(async() => {
    const logs = await readLogs();
 
    // get unique box codes
    const boxCodes = [...new Set(
        logs
            .filter(l => l.source === "AI_BOX")
            .map(l => l.boxCode)
    )];

    boxCodes.forEach(async boxCode => {
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
            await saveLog({
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
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log(" MongoDB Connected");

    app.listen(PORT, () => {
      console.log(` Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error(" MongoDB Error:", err);
    process.exit(1);
  });
