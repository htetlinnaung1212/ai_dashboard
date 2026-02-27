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
  timestamp: {
    type: Date,
    default: Date.now
  },
  boxCode: String,
  source: String,
  ip: String,
  online_status: String,
  service_name: String,
  service_status: String,
  type: String
});



/* ================= UTILITIES ================= */

function formatTime(ts) {
  if (!ts) return "-";
  return new Date(ts)
    .toLocaleString("en-GB", {
      timeZone: "Asia/Bangkok",
      hour12: false
    })
    .replace(",", "");
}

async function saveLog(entry) {
  await Log.create(entry);
}

/* =================================================
   LOGS (HISTORY)
================================================= */

app.get("/logs", async (req, res) => {
  try {
    const { type, from, to, boxCode } = req.query;

   let query = {
  type: "status_change",
  online_status: { $exists: true }
};

    if (type && type !== "ALL") {
      query.source = type;
    }

    if (boxCode && boxCode.trim() !== "") {
      query.boxCode = boxCode.trim();
    }

    const logs = await Log.find(query)
      .sort({ _id: -1 })
      .limit(1000);

    let filteredLogs = logs;

    if (from || to) {
      filteredLogs = logs.filter(log => {
        const logTime = log.timestamp
          ? new Date(log.timestamp).getTime()
          : null;

        const fromTime = from ? new Date(from).getTime() : null;
        const toTime = to ? new Date(to).getTime() : null;

        if (!logTime) return false;
        if (fromTime && logTime < fromTime) return false;
        if (toTime && logTime > toTime) return false;

        return true;
      });
    }

    res.json(
      filteredLogs.map(log => ({
        ...log.toObject(),
        timestamp: formatTime(log.timestamp)
      }))
    );

  } catch (err) {
    console.error("Logs Error:", err);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

/* =================================================
   FILTERS
================================================= */

app.get("/filters", async (req, res) => {
  try {
    const boxCodes = await Log.distinct("boxCode", {
      boxCode: { $ne: null }
    });

    res.json({ boxCodes });
  } catch (err) {
    console.error("Filter load error:", err);
    res.status(500).json({ error: "Failed to load filters" });
  }
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
      boxCode,
      ip,
      source: "NODE_RED",
      online_status: "online",
      type: "heartbeat"
    });

    const lastStatus = await Log.findOne({
      boxCode,
      source: "NODE_RED",
      type: "status_change"
    }).sort({ _id: -1 });

    if (!lastStatus || lastStatus.online_status === "offline") {
      await saveLog({
        boxCode,
        ip,
        source: "NODE_RED",
        online_status: "online",
        type: "status_change"
      });

      console.log(`NODE-RED STATUS: ${boxCode} OFFLINE → ONLINE`);
    }

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
    const { boxCode, services, source } = req.body;

    if (!boxCode || !Array.isArray(services)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    for (const s of services) {
      await saveLog({
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

      let aiBoxStatus = "offline";
      let aiBoxLast = "-";

      if (lastBoxHB?.timestamp) {
        aiBoxLast = formatTime(lastBoxHB.timestamp);
        if (now - new Date(lastBoxHB.timestamp).getTime() < HEARTBEAT_TIMEOUT) {
          aiBoxStatus = "online";
        }
      }

      let nodeStatus = "offline";
      let nodeLast = "-";

      if (lastNodeHB?.timestamp) {
        nodeLast = formatTime(lastNodeHB.timestamp);
        if (now - new Date(lastNodeHB.timestamp).getTime() < 3 * 60 * 1000) {
          nodeStatus = "online";
        }
      }

      rows.push({
        site: boxCode,
        aiBoxStatus,
        aiBoxLast,
        mediaStatus:
          media?.service_status === "running" ? "running" : "stopped",
        mediaLast: media?.timestamp ? formatTime(media.timestamp) : "-",
        aiServerStatus:
          aiServer?.service_status === "running" ? "running" : "stopped",
        aiServerLast: aiServer?.timestamp ? formatTime(aiServer.timestamp) : "-",
        nodeStatus,
        nodeLast
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

    const boxCodes = await Log.distinct("boxCode", { source: "AI_BOX" });

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

      if (!lastHeartbeat?.timestamp || !lastStatus) continue;

      if (
        lastStatus.online_status === "online" &&
        Date.now() - new Date(lastHeartbeat.timestamp).getTime() > HEARTBEAT_TIMEOUT
      ) {
        await saveLog({
          boxCode,
          ip: lastHeartbeat.ip,
          source: "AI_BOX",
          online_status: "offline",
          type: "status_change"
        });
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