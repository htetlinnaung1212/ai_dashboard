const express = require("express");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HEARTBEAT_TIMEOUT = 4 * 60 * 1000;

/* ================= MONGOOSE SETUP ================= */

mongoose.set("bufferCommands", false);

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

const Log = mongoose.model("Log", logSchema);

/* ================= UTILITIES ================= */

function formatTime(ts) {
  return new Date(ts)
    .toLocaleString("en-GB", {
      timeZone: "Asia/Bangkok",
      hour12: false
    })
    .replace(",", "");
}

function parseTS(ts) {
  const [d, t] = ts.split(" ");
  const [dd, mm, yyyy] = d.split("/");
  return new Date(`${yyyy}-${mm}-${dd}T${t}`);
}

async function saveLog(entry) {
  await Log.create(entry);
}

/* ================= ROOT ================= */

app.get("/", (req, res) => {
  res.send("AI Dashboard Backend Running ✅");
});

/* =================================================
   AI BOX HEARTBEAT
================================================= */

app.post("/heartbeat", async (req, res) => {
  try {
    const now = Date.now();
    const ip = req.ip.replace("::ffff:", "");
    const boxCode = req.body?.boxCode || "Unknown";

    console.log(`AI BOX HB | ${boxCode} | ${ip} | ${formatTime(now)}`);

    await saveLog({
      timestamp: formatTime(now),
      boxCode,
      ip,
      source: "AI_BOX",
      online_status: "online",
      type: "heartbeat"
    });

    const lastStatus = await Log.findOne({
      boxCode,
      source: "AI_BOX",
      type: "status_change"
    }).sort({ _id: -1 });

    if (!lastStatus || lastStatus.online_status === "offline") {
      await saveLog({
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Heartbeat failed" });
  }
});

/* =================================================
   NODE-RED HEARTBEAT
================================================= */

app.post("/nodered/heartbeat", async (req, res) => {
  try {
    const now = Date.now();
    const ip = req.ip.replace("::ffff:", "");
    const { boxCode } = req.body;

    if (!boxCode) {
      return res.status(400).json({ error: "Missing boxCode" });
    }

    console.log(`NODE-RED HB | ${boxCode} | ${ip} | ${formatTime(now)}`);

    await saveLog({
      timestamp: formatTime(now),
      boxCode,
      source: "NODE_RED",
      ip,
      type: "heartbeat"
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Node-RED heartbeat failed" });
  }
});

/* =================================================
   SERVICE STATUS
================================================= */

app.post("/service-status", async (req, res) => {
  try {
    const now = Date.now();
    const { boxCode, services, source } = req.body;

    if (!boxCode || !Array.isArray(services)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    for (const s of services) {
      await saveLog({
        timestamp: formatTime(now),
        boxCode,
        source: source || "NODE_RED",
        service_name: s.service_name,
        service_status: s.status,
        type: "service_status"
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Service status failed" });
  }
});

/* =================================================
   LIVE STATUS
================================================= */

app.get("/boxes", async (req, res) => {
  try {
    const now = Date.now();
    const boxCodes = await Log.distinct("boxCode");

    const rows = [];

    for (const boxCode of boxCodes) {
      const lastBoxHB = await Log.findOne({
        boxCode,
        source: "AI_BOX",
        type: "heartbeat"
      }).sort({ _id: -1 });

      const lastNodeHB = await Log.findOne({
        boxCode,
        source: "NODE_RED",
        type: "heartbeat"
      }).sort({ _id: -1 });

      const media = await Log.findOne({
        boxCode,
        type: "service_status",
        service_name: "mediaserver.service"
      }).sort({ _id: -1 });

      const aiServer = await Log.findOne({
        boxCode,
        type: "service_status",
        service_name: "aiserver.service"
      }).sort({ _id: -1 });

      rows.push({
        site: boxCode,
        aiBoxStatus:
          lastBoxHB &&
          now - parseTS(lastBoxHB.timestamp).getTime() < HEARTBEAT_TIMEOUT
            ? "online"
            : "offline",

        mediaStatus:
          media && media.service_status === "running"
            ? "running"
            : "stopped",

        aiServerStatus:
          aiServer && aiServer.service_status === "running"
            ? "running"
            : "stopped",

        nodeStatus:
          lastNodeHB &&
          now - parseTS(lastNodeHB.timestamp).getTime() < 2 * 60 * 1000
            ? "online"
            : "offline"
      });
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Boxes fetch failed" });
  }
});

/* =================================================
   OFFLINE CHECKER
================================================= */

async function startOfflineChecker() {
  setInterval(async () => {
    const boxCodes = await Log.distinct("boxCode", {
      source: "AI_BOX"
    });

    for (const boxCode of boxCodes) {
      const lastHeartbeat = await Log.findOne({
        boxCode,
        source: "AI_BOX",
        type: "heartbeat"
      }).sort({ _id: -1 });

      const lastStatus = await Log.findOne({
        boxCode,
        source: "AI_BOX",
        type: "status_change"
      }).sort({ _id: -1 });

      if (!lastHeartbeat || !lastStatus) continue;

      const lastHBTime = parseTS(lastHeartbeat.timestamp).getTime();

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
    }
  }, 5000);
}

/* =================================================
   START SERVER
================================================= */
app.use(express.static("public"));
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB Connected");

    await startOfflineChecker();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("MongoDB Error:", err);
    process.exit(1);
  });