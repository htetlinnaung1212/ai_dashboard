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
 timestamp: Date,
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



async function saveLog(entry) {
  await Log.create(entry);
}

app.get("/logs", async (req, res) => {
  try {
   const { type, from, to, boxCode } = req.query;

    let query = {
  type: "status_change"
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

    // TIME FILTER (done after fetch because timestamp is string)
    let filteredLogs = logs;

    if (from || to) {
      filteredLogs = logs.filter(log => {
       const logTime = new Date(log.timestamp).getTime();
        const fromTime = from ? new Date(from).getTime() : null;
        const toTime = to ? new Date(to).getTime() : null;

        if (fromTime && logTime < fromTime) return false;
        if (toTime && logTime > toTime) return false;

        return true;
      });
    }

    res.json(filteredLogs);
  } catch (err) {
    console.error("Logs Error:", err);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});
app.get("/filters", async (req, res) => {
  try {
    const boxCodes = await Log.distinct("boxCode", {
      boxCode: { $ne: null }
    });


    res.json({
      boxCodes,
    });
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
      timestamp: new Date(),
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
       timestamp: new Date(),
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
      timestamp: new Date(),
      boxCode,
      source: "NODE_RED",
      ip,
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
        timestamp: new Date(),
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
    const now = Date.now();
    const { boxCode, services, source } = req.body;

    if (!boxCode || !Array.isArray(services)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    for (const s of services) {
      await saveLog({
        timestamp: new Date(),
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

      // ================= AI BOX LAST HEARTBEAT =================
      const lastBoxHB = await Log.findOne({
        boxCode,
        source: "AI_BOX",
        type: "heartbeat"
      }).sort({ _id: -1 });

      // ================= NODE-RED LAST HEARTBEAT =================
      const lastNodeHB = await Log.findOne({
        boxCode,
        source: "NODE_RED",
        type: "heartbeat"
      }).sort({ _id: -1 });

      // ================= SERVICE STATUS =================
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

      // ================= SAFE TIME PARSE FUNCTION =================
      function safeParse(ts) {
        if (!ts) return null;

        try {
          const [d, t] = ts.split(" ");
          const [dd, mm, yyyy] = d.split("/");

          // Force Bangkok timezone (UTC+7)
          const date = new Date(`${yyyy}-${mm}-${dd}T${t}+07:00`);

          return isNaN(date.getTime()) ? null : date.getTime();
        } catch {
          return null;
        }
      }

      // ================= AI BOX STATUS =================
      let aiBoxStatus = "offline";
      let aiBoxLast = "-";

      if (lastBoxHB) {
        aiBoxLast = lastBoxHB.timestamp;

        const lastTime = safeParse(lastBoxHB.timestamp);

        if (lastTime && now - lastTime < HEARTBEAT_TIMEOUT) {
          aiBoxStatus = "online";
        }
      }

      // ================= NODE-RED STATUS =================
      let nodeStatus = "offline";
      let nodeLast = "-";

      if (lastNodeHB) {
        nodeLast = lastNodeHB.timestamp;

        const lastTime = safeParse(lastNodeHB.timestamp);

        if (lastTime && now - lastTime < 3 * 60 * 1000) {
          nodeStatus = "online";
        }
      }

      // ================= PUSH ROW =================
      rows.push({
        site: boxCode,

        aiBoxStatus,
        aiBoxLast,

        mediaStatus:
          media && media.service_status === "running"
            ? "running"
            : "stopped",

        mediaLast: media ? media.timestamp : "-",

        aiServerStatus:
          aiServer && aiServer.service_status === "running"
            ? "running"
            : "stopped",

        aiServerLast: aiServer ? aiServer.timestamp : "-",

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

    /* ================= AI BOX CHECK ================= */

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

    /* ================= NODE-RED CHECK ================= */

    const nodeBoxes = await Log.distinct("boxCode", {
      source: "NODE_RED"
    });

    for (const boxCode of nodeBoxes) {
      const lastHeartbeat = await Log.findOne({
        boxCode,
        source: "NODE_RED",
        type: "heartbeat"
      }).sort({ _id: -1 });

      const lastStatus = await Log.findOne({
        boxCode,
        source: "NODE_RED",
        type: "status_change"
      }).sort({ _id: -1 });

      if (!lastHeartbeat || !lastStatus) continue;

      const lastHBTime = parseTS(lastHeartbeat.timestamp).getTime();

      if (
        lastStatus.online_status === "online" &&
        Date.now() - lastHBTime > 2 * 60 * 1000
      ) {
        await saveLog({
          timestamp: formatTime(Date.now()),
          boxCode,
          ip: lastHeartbeat.ip,
          source: "NODE_RED",
          online_status: "offline",
          type: "status_change"
        });

        console.log(`NODE-RED STATUS: ${boxCode} ONLINE → OFFLINE`);
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