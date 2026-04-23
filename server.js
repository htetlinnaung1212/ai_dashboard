const express = require("express");
require("dotenv").config();
const session = require("express-session");
const bcrypt = require("bcrypt");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const {
  USER_ROLES,
  canManageUsers,
  canCreateRole,
  canEditTargetUser,
  canDeleteTargetUser,
  normalizeUserRow
} = require("./models/User");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HEARTBEAT_TIMEOUT = 4 * 60 * 1000;
const NODE_RED_TIMEOUT = 3 * 60 * 1000;
const isProduction = process.env.NODE_ENV === "production";

if (isProduction) {
  app.set("trust proxy", 1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ================= LOGIN / SESSION ================= */

app.use(
  session({
    name: "ai_dashboard.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

function requirePageAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const role = req.session.user.role;
  if (role !== "admin" && role !== "super-admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  next();
}

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
  const payload = {
    box_code: entry.boxCode ?? null,
    source: entry.source ?? null,
    ip: entry.ip ?? null,
    online_status: entry.online_status ?? null,
    service_name: entry.service_name ?? null,
    service_status: entry.service_status ?? null,
    type: entry.type ?? null,
    timestamp: new Date().toISOString()
  };

  const { error } = await supabase.from("logs").insert(payload);
  if (error) {
    throw error;
  }
}

function mapLogRow(row) {
  return {
    id: row.id,
    timestamp: formatTime(row.timestamp),
    boxCode: row.box_code,
    source: row.source,
    ip: row.ip,
    online_status: row.online_status,
    service_name: row.service_name,
    service_status: row.service_status,
    type: row.type
  };
}

function mapLocationRow(row) {
  return {
    id: row.id,
    boxCode: row.box_code,
    lat: row.lat,
    lng: row.lng
  };
}

function mapBoxMetaRow(row) {
  return {
    id: row.id,
    boxCode: row.box_code,
    boxName: row.box_name,
    deviceName: row.device_name
  };
}

async function getLatestLog(boxCode, source, type, serviceName = null) {
  let query = supabase
    .from("logs")
    .select("*")
    .eq("box_code", boxCode)
    .eq("source", source)
    .eq("type", type)
    .order("timestamp", { ascending: false })
    .limit(1);

  if (serviceName) {
    query = query.eq("service_name", serviceName);
  }

  const { data, error } = await query;
  if (error) throw error;

  return data?.[0] || null;
}

async function getDistinctBoxCodesFromLogs(source = null) {
  let query = supabase
    .from("logs")
    .select("box_code")
    .not("box_code", "is", null);

  if (source) {
    query = query.eq("source", source);
  }

  const { data, error } = await query;
  if (error) throw error;

  return [...new Set(data.map((row) => row.box_code).filter(Boolean))];
}

/* ================= PAGE ROUTES ================= */

app.get("/dashboard-admin.html", requirePageAuth, (req, res) => {
  const role = req.session.user.role;

  if (role !== "admin" && role !== "super-admin") {
    return res.redirect("/dashboard-user.html");
  }

  res.sendFile(path.join(__dirname, "public", "dashboard-admin.html"));
});

app.get("/dashboard-user.html", requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard-user.html"));
});

app.get("/user-management.html", (req, res) => {
  try {
    if (!req.session || !req.session.user) {
      return res.redirect("/login.html");
    }

    const role = req.session.user.role;

    if (role !== "admin" && role !== "super-admin") {
      return res.redirect("/");
    }

    return res.sendFile(path.join(__dirname, "public", "user-management.html"));
  } catch (err) {
    console.error("User management page error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

app.use(express.static("public", { index: false }));

app.get("/", requirePageAuth, (req, res) => {
  const role = req.session.user.role;

  if (role === "user") {
    return res.redirect("/dashboard-user.html");
  }

  if (role === "admin" || role === "super-admin") {
    return res.redirect("/dashboard-admin.html");
  }

  return res.redirect("/login.html");
});

/* ================= AUTH ROUTES ================= */

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const trimmedUsername = username.trim();

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("username", trimmedUsername)
      .maybeSingle();

    if (error) {
      console.error("Login query error:", error);
      return res.status(500).json({ error: "Login failed" });
    }

    if (!user || !user.is_active) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role
    };

    return res.json({
      ok: true,
      user: {
        username: user.username,
        role: user.role
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).json({ error: "Logout failed" });
    }

    res.clearCookie("ai_dashboard.sid");
    return res.json({ ok: true });
  });
});

app.get("/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.json({
    user: req.session.user
  });
});

/* ================= USER MANAGEMENT ================= */

app.post("/users", requireAuth, async (req, res) => {
  try {
    const currentRole = req.session.user.role;
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
      return res.status(400).json({ error: "Username, password, and role are required" });
    }

    if (!canManageUsers(currentRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!canCreateRole(currentRole, role)) {
      return res.status(403).json({ error: "Admin can create only user accounts" });
    }

    const trimmedUsername = username.trim();

    const { data: existingUser, error: existingError } = await supabase
      .from("users")
      .select("id")
      .eq("username", trimmedUsername)
      .maybeSingle();

    if (existingError) {
      console.error("Create user lookup error:", existingError);
      return res.status(500).json({ error: "Failed to create user" });
    }

    if (existingUser) {
      return res.status(409).json({ error: "Username already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { error: insertError } = await supabase.from("users").insert({
      username: trimmedUsername,
      password_hash: passwordHash,
      role,
      is_active: true
    });

    if (insertError) {
      console.error("Create user insert error:", insertError);
      return res.status(500).json({ error: "Failed to create user" });
    }

    return res.json({ ok: true, message: "User created successfully" });
  } catch (err) {
    console.error("Create user error:", err);
    return res.status(500).json({ error: "Failed to create user" });
  }
});

app.get("/users", requireAuth, async (req, res) => {
  try {
    const currentRole = req.session.user.role;

    if (!canManageUsers(currentRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { data: users, error } = await supabase
      .from("users")
      .select("id, username, role, is_active, created_at, updated_at")
      .neq("role", USER_ROLES.SUPER_ADMIN)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Fetch users error:", error);
      return res.status(500).json({ error: "Failed to fetch users" });
    }

    return res.json({
      ok: true,
      users: (users || []).map(normalizeUserRow)
    });
  } catch (err) {
    console.error("Fetch users error:", err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.put("/users/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, password, role } = req.body;
    const currentRole = req.session.user.role;

    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    if (!canManageUsers(currentRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { data: targetUser, error: targetError } = await supabase
      .from("users")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (targetError) {
      console.error("Target user fetch error:", targetError);
      return res.status(500).json({ error: "Failed to update user" });
    }

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!canEditTargetUser(currentRole, targetUser.role)) {
      return res.status(403).json({
        error:
          targetUser.role === USER_ROLES.SUPER_ADMIN
            ? "Super-admin is protected"
            : "Admin can edit only user accounts"
      });
    }

    const trimmedUsername = username.trim();

    const { data: existingUser, error: existingError } = await supabase
      .from("users")
      .select("id")
      .eq("username", trimmedUsername)
      .neq("id", id)
      .maybeSingle();

    if (existingError) {
      console.error("Username conflict check error:", existingError);
      return res.status(500).json({ error: "Failed to update user" });
    }

    if (existingUser) {
      return res.status(409).json({ error: "Username already exists" });
    }

    const updateData = {
      username: trimmedUsername
    };

    if (password) {
      updateData.password_hash = await bcrypt.hash(password, 10);
    }

    if (currentRole === USER_ROLES.SUPER_ADMIN) {
      if (role && [USER_ROLES.ADMIN, USER_ROLES.USER].includes(role)) {
        updateData.role = role;
      }
    }

    const { error: updateError } = await supabase
      .from("users")
      .update(updateData)
      .eq("id", id);

    if (updateError) {
      console.error("Update user query error:", updateError);
      return res.status(500).json({ error: "Failed to update user" });
    }

    return res.json({ ok: true, message: "User updated successfully" });
  } catch (err) {
    console.error("Update user error:", err);
    return res.status(500).json({ error: "Failed to update user" });
  }
});

app.delete("/users/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const currentRole = req.session.user.role;

    if (!canManageUsers(currentRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { data: targetUser, error: targetError } = await supabase
      .from("users")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (targetError) {
      console.error("Delete target fetch error:", targetError);
      return res.status(500).json({ error: "Failed to delete user" });
    }

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!canDeleteTargetUser(currentRole, targetUser.role)) {
      return res.status(403).json({
        error:
          targetUser.role === USER_ROLES.SUPER_ADMIN
            ? "Super-admin is protected"
            : "Admin can delete only user accounts"
      });
    }

    const { error: deleteError } = await supabase
      .from("users")
      .delete()
      .eq("id", id);

    if (deleteError) {
      console.error("Delete user error:", deleteError);
      return res.status(500).json({ error: "Failed to delete user" });
    }

    return res.json({ ok: true, message: "User removed successfully" });
  } catch (err) {
    console.error("Delete user error:", err);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

/* ================= LOGS (HISTORY) ================= */

app.get("/logs", async (req, res) => {
  try {
    const { type, from, to, boxCode, status } = req.query;

    let query = supabase
      .from("logs")
      .select("*")
      .eq("type", "status_change")
      .not("online_status", "is", null);

    if (type && type !== "ALL") {
      query = query.eq("source", type);
    }

    if (boxCode && boxCode.trim() !== "") {
      query = query.eq("box_code", boxCode.trim());
    }

    if (status && status !== "all") {
      query = query.eq("online_status", status);
    }

    if (from) {
      const fromDate = new Date(from).toISOString();
      query = query.gte("timestamp", fromDate);
    }

    if (to) {
      const toDate = new Date(to);
      toDate.setSeconds(59);
      toDate.setMilliseconds(999);
      query = query.lte("timestamp", toDate.toISOString());
    }

    const { data: logs, error } = await query
      .order("timestamp", { ascending: false })
      .limit(1000);

    if (error) {
      console.error("Logs Error:", error);
      return res.status(500).json({ error: "Failed to fetch logs" });
    }

    return res.json((logs || []).map(mapLogRow));
  } catch (err) {
    console.error("Logs Error:", err);
    return res.status(500).json({ error: "Failed to fetch logs" });
  }
});

/* ================= FILTERS ================= */

app.get("/filters", async (req, res) => {
  try {
    const boxCodes = await getDistinctBoxCodesFromLogs();
    return res.json({ boxCodes });
  } catch (err) {
    console.error("Filter load error:", err);
    return res.status(500).json({ error: "Failed to load filters" });
  }
});

/* ================= LOCATIONS ================= */

app.get("/locations", async (req, res) => {
  try {
    const { data: locations, error } = await supabase
      .from("locations")
      .select("*")
      .order("box_code", { ascending: true });

    if (error) {
      console.error("Failed to fetch locations:", error);
      return res.status(500).json({ error: "Failed to fetch locations" });
    }

    return res.json((locations || []).map(mapLocationRow));
  } catch (err) {
    console.error("Failed to fetch locations:", err);
    return res.status(500).json({ error: "Failed to fetch locations" });
  }
});

app.post("/locations", requireAdmin, async (req, res) => {
  try {
    const { boxCode, lat, lng } = req.body;

    if (!boxCode || lat == null || lng == null) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const { error } = await supabase.from("locations").upsert(
      {
        box_code: boxCode,
        lat,
        lng
      },
      { onConflict: "box_code" }
    );

    if (error) {
      console.error("Failed to save location:", error);
      return res.status(500).json({ error: "Failed to save location" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Failed to save location:", err);
    return res.status(500).json({ error: "Failed to save location" });
  }
});

/* ================= AI BOX HEARTBEAT ================= */

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

    const lastStatus = await getLatestLog(boxCode, "AI_BOX", "status_change");

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

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Heartbeat failed" });
  }
});

/* ================= NODE-RED HEARTBEAT ================= */

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

    const lastStatus = await getLatestLog(boxCode, "NODE_RED", "status_change");

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

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Node-RED heartbeat failed" });
  }
});

/* ================= SERVICE STATUS ================= */

app.post("/service-status", async (req, res) => {
  try {
    const { boxCode, services, source } = req.body;

    if (!boxCode || !Array.isArray(services)) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const rows = services.map((s) => ({
      box_code: boxCode,
      source: source || "NODE_RED",
      service_name: s.service_name,
      service_status: s.status,
      type: "service_status",
      timestamp: new Date().toISOString()
    }));

    const { error } = await supabase.from("logs").insert(rows);

    if (error) {
      console.error("Service status insert error:", error);
      return res.status(500).json({ error: "Service status failed" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Service status failed" });
  }
});

/* ================= BOX META ================= */

app.get("/box-meta", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("box_meta")
      .select("*")
      .order("box_code", { ascending: true });

    if (error) {
      console.error("Box meta fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch box meta" });
    }

    return res.json((data || []).map(mapBoxMetaRow));
  } catch (err) {
    console.error("Box meta fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch box meta" });
  }
});

app.post("/box-meta", requireAdmin, async (req, res) => {
  try {
    const { boxCode, boxName, deviceName } = req.body;

    if (!boxCode) {
      return res.status(400).json({ error: "Missing boxCode" });
    }

    const { error } = await supabase.from("box_meta").upsert(
      {
        box_code: boxCode,
        box_name: boxName ?? null,
        device_name: deviceName ?? null
      },
      { onConflict: "box_code" }
    );

    if (error) {
      console.error("Box meta save error:", error);
      return res.status(500).json({ error: "Failed to save box meta" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Box meta save error:", err);
    return res.status(500).json({ error: "Failed to save box meta" });
  }
});

/* ================= LIVE STATUS ================= */

app.get("/boxes", async (req, res) => {
  try {
    const now = Date.now();
    const boxCodes = await getDistinctBoxCodesFromLogs();
    const rows = [];

    for (const boxCode of boxCodes) {
      const lastBoxHB = await getLatestLog(boxCode, "AI_BOX", "heartbeat");
      const lastNodeHB = await getLatestLog(boxCode, "NODE_RED", "heartbeat");
      const media = await getLatestLog(
        boxCode,
        "NODE_RED",
        "service_status",
        "mediaserver.service"
      );
      const aiServer = await getLatestLog(
        boxCode,
        "NODE_RED",
        "service_status",
        "aiserver.service"
      );

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
        if (now - new Date(lastNodeHB.timestamp).getTime() < NODE_RED_TIMEOUT) {
          nodeStatus = "online";
        }
      }

      let mediaStatus = "stopped";
      let mediaLast = "-";

      if (media?.timestamp) {
        mediaLast = formatTime(media.timestamp);
        const diff = now - new Date(media.timestamp).getTime();

        if (diff < NODE_RED_TIMEOUT && media.service_status === "running") {
          mediaStatus = "running";
        }
      }

      let aiServerStatus = "stopped";
      let aiServerLast = "-";

      if (aiServer?.timestamp) {
        aiServerLast = formatTime(aiServer.timestamp);
        const diff = now - new Date(aiServer.timestamp).getTime();

        if (diff < NODE_RED_TIMEOUT && aiServer.service_status === "running") {
          aiServerStatus = "running";
        }
      }

      const { data: meta, error: metaError } = await supabase
        .from("box_meta")
        .select("*")
        .eq("box_code", boxCode)
        .maybeSingle();

      if (metaError) {
        throw metaError;
      }

      rows.push({
        site: boxCode,
        aiBoxStatus,
        aiBoxLast,
        mediaStatus,
        mediaLast,
        aiServerStatus,
        aiServerLast,
        nodeStatus,
        nodeLast,
        deviceName: meta?.device_name || "-"
      });
    }

    let totalAi = rows.length;
let onlineAi = 0;
let offlineAi = 0;

let totalNode = rows.length;
let onlineNode = 0;
let offlineNode = 0;

for (const row of rows) {

  // AI BOX
  if (row.aiBoxStatus === "online") {
    onlineAi++;
  } else {
    offlineAi++;
  }

  // NODE RED
  if (row.nodeStatus === "online") {
    onlineNode++;
  } else {
    offlineNode++;
  }
}

    return res.json({
      boxes: rows,
      summary: {
        ai: {
          total: totalAi,
          online: onlineAi,
          offline: offlineAi
        },
        node: {
          total: totalNode,
          online: onlineNode,
          offline: offlineNode
        }
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Boxes fetch failed" });
  }
});

/* ================= OFFLINE CHECKER ================= */

async function startOfflineChecker() {
  setInterval(async () => {
    try {
      const aiBoxes = await getDistinctBoxCodesFromLogs("AI_BOX");

      for (const boxCode of aiBoxes) {
        const lastHeartbeat = await getLatestLog(boxCode, "AI_BOX", "heartbeat");
        const lastStatus = await getLatestLog(boxCode, "AI_BOX", "status_change");

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

      const nodeBoxes = await getDistinctBoxCodesFromLogs("NODE_RED");

      for (const boxCode of nodeBoxes) {
        const lastHeartbeat = await getLatestLog(boxCode, "NODE_RED", "heartbeat");
        const lastStatus = await getLatestLog(boxCode, "NODE_RED", "status_change");

        if (!lastHeartbeat?.timestamp || !lastStatus) continue;

        if (
          lastStatus.online_status === "online" &&
          Date.now() - new Date(lastHeartbeat.timestamp).getTime() > NODE_RED_TIMEOUT
        ) {
          await saveLog({
            boxCode,
            ip: lastHeartbeat.ip,
            source: "NODE_RED",
            online_status: "offline",
            type: "status_change"
          });

          console.log(`NODE-RED STATUS: ${boxCode} ONLINE → OFFLINE`);
        }
      }
    } catch (err) {
      console.error("Offline checker error:", err);
    }
  }, 5000);
}

/* ================= START SERVER ================= */

(async () => {
  try {
    const { error } = await supabase.from("users").select("id").limit(1);

    if (error && error.code !== "PGRST116") {
      console.error("Supabase connection error:", error);
      process.exit(1);
    }

    console.log("Supabase Connected");
    await startOfflineChecker();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
})();