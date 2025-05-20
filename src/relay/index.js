//VPS Relay Proxy
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import express from "express";
import bodyParser from "body-parser";
import { config } from "dotenv";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { join } from "path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import cors from "cors";
import nodemailer from "nodemailer";

config();
const TOKEN_SECRET = process.env.TOKEN_SECRET;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(",") || [];
const PORT = process.env.INTERNAL_PORT || 8080;
const AUTH_PORT = process.env.AUTH_PORT || 3001;

// --- LOWDB SETUP ---
const dbFile = join(process.cwd(), "db.json");
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { users: [], boats: [], user_boats: [] });

// --- UTILS ---
function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}
function generateToken(payload) {
  return jwt.sign(payload, TOKEN_SECRET, { expiresIn: "1d" });
}
function verifyToken(token) {
  try {
    return jwt.verify(token, TOKEN_SECRET);
  } catch {
    return null;
  }
}

// --- EXPRESS APP FOR AUTH & BOAT MGMT ---
const app = express();
app.use(bodyParser.json());
app.use(cors());

// USER REGISTRATION
app.post("/api/register", async (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password)
      return res
        .status(400)
        .json({ success: false, error: "Username and password required" });
    await db.read();
    if (db.data.users.find((u) => u.username === username))
      return res
        .status(400)
        .json({ success: false, error: "Username already exists" });
    db.data.users.push({
      username,
      passwordHash: hashPassword(password),
      email,
    });
    await db.write();
    res.json({ success: true, message: "User registered!" });
  } catch (e) {
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// USER LOGIN
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  await db.read();
  const user = db.data.users.find((u) => u.username === username);
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res
      .status(401)
      .json({ success: false, error: "Invalid credentials" });
  }
  const userBoatIds = db.data.user_boats
    .filter((ub) => ub.username === username)
    .map((ub) => ub.boatId);
  const userBoats = db.data.boats.filter((b) => userBoatIds.includes(b.boatId));
  const token = generateToken({ username, boats: userBoats });
  res.json({ success: true, token, boats: userBoats });
});

// BOAT REGISTRATION
app.post("/api/boat/register", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const decoded = verifyToken(token);
  if (!decoded)
    return res.status(401).json({ success: false, error: "Invalid token" });
  await db.read();
  const { boatName, boatType, loa, beam, draft, airDraft, mmsi } = req.body;
  if (!boatName)
    return res
      .status(400)
      .json({ success: false, error: "boatName is required" });

  const boatId = crypto.randomUUID();
  db.data.boats.push({
    boatId,
    boatName,
    boatType,
    loa,
    beam,
    draft,
    airDraft,
    mmsi,
    registeredBy: decoded.username,
    createdAt: new Date().toISOString(),
  });
  db.data.user_boats.push({ username: decoded.username, boatId });
  await db.write();
  res.json({ success: true, boatId });
});

// ASSOCIATE USER TO BOAT
app.post("/api/boat/join", async (req, res) => {
  const { boatId } = req.body;
  const token = req.headers.authorization?.split(" ")[1];
  const decoded = verifyToken(token);
  if (!decoded)
    return res.status(401).json({ success: false, error: "Invalid token" });
  await db.read();
  if (!db.data.boats.find((b) => b.boatId === boatId))
    return res.status(404).json({ success: false, error: "Boat not found" });
  if (
    !db.data.user_boats.find(
      (ub) => ub.username === decoded.username && ub.boatId === boatId
    )
  ) {
    db.data.user_boats.push({ username: decoded.username, boatId });
    await db.write();
  }
  res.json({
    success: true,
    message: `User ${decoded.username} joined boat ${boatId}`,
  });
});

// LIST USER'S BOATS
app.get("/api/boats", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const decoded = verifyToken(token);
  if (!decoded)
    return res.status(401).json({ success: false, error: "Invalid token" });
  await db.read();
  const boatIds = db.data.user_boats
    .filter((ub) => ub.username === decoded.username)
    .map((ub) => ub.boatId);
  const userBoats = db.data.boats.filter((b) => boatIds.includes(b.boatId));
  res.json({ success: true, boats: userBoats });
});

// PASSWORD RESET REQUEST
app.post("/api/password-reset", async (req, res) => {
  const { email } = req.body;
  await db.read();
  const user = db.data.users.find((u) => u.email === email);
  if (user) {
    const resetToken = jwt.sign({ username: user.username }, TOKEN_SECRET, {
      expiresIn: "1h",
    });
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    const resetUrl = `${
      process.env.FRONTEND_URL || "http://localhost:5173"
    }/reset-password?token=${resetToken}`;
    await transporter.sendMail({
      to: email,
      from: process.env.SMTP_FROM || "no-reply@compendiumnav.com",
      subject: "Password Reset",
      text: `To reset your password, click the following link: ${resetUrl}`,
    });
  }
  res.json({
    message: "If your email is registered, a reset link has been sent.",
  });
});

// PASSWORD RESET SUBMISSION
app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    const payload = jwt.verify(token, TOKEN_SECRET);
    await db.read();
    const user = db.data.users.find((u) => u.username === payload.username);
    if (!user) return res.status(400).json({ error: "Invalid token." });
    user.passwordHash = hashPassword(newPassword);
    await db.write();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: "Invalid or expired token." });
  }
});

// HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    version: process.env.npm_package_version,
    uptime: process.uptime(),
  });
});

// --- START AUTH API ---
app.listen(AUTH_PORT, () => {
  console.log(`Auth API running on port ${AUTH_PORT}`);
});
 
// --- RELAY SERVER (WS + HTTP) ---
const httpServer = createServer();
const wss = new WebSocketServer({ noServer: true });

// Connection tracking using two separate maps
const clientConnections = new Map(); // boatId -> Set of client connections
const serverConnections = new Map(); // boatId -> Set of server connections

httpServer.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const ip = req.socket.remoteAddress;
    console.log(`[WS] New connection from ${ip}`);
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  ws.role = null; // Will be set when identified
  ws.boatIds = new Set(); // Tracks all boat IDs this connection is subscribed to
  const ip = req.socket.remoteAddress;

  ws.on("message", (msg) => {
    let message;
    try {
      message = JSON.parse(msg);
    } catch {
      console.warn(`[WS] Invalid JSON from ${ip}: ${msg}`);
      return;
    }

    // Handle identity/role declaration
    if (message.type === "identity" && message.role && message.boatId) {
      handleIdentity(ws, message);
      return;
    }

    // Handle subscription requests
    if (message.type === "register" || message.type === "subscribe") {
      if (Array.isArray(message.boatIds)) {
        // Handle multi-boat registration
        message.boatIds.forEach((boatId) => {
          handleSubscription(ws, {
            type: message.type,
            boatId: boatId,
            role: message.role || ws.role,
          });
        });
        return;
      } else if (message.boatId) {
        // Handle single-boat registration
        handleSubscription(ws, message);
        return;
      }
    }

    // Handle unsubscription
    if (message.type === "unsubscribe" && message.boatId) {
      handleUnsubscription(ws, message.boatId);
      return;
    }

    // Handle regular messages
    if (message.boatId) {
      handleMessageRouting(ws, message, msg);
    }
  });

  ws.on("close", () => {
    // Clean up all subscriptions
    ws.boatIds.forEach((boatId) => {
      handleUnsubscription(ws, boatId);
    });
    console.log(
      `[WS] Connection closed (${ws.role || "unidentified"} from ${ip})`
    );
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error from ${ip}:`, err);
  });
});

// Helper functions
function handleIdentity(ws, message) {
  ws.role = message.role;
  console.log(`[WS] ${ws.role} identified for boat ${message.boatId}`);

  // Auto-subscribe if not already
  if (!ws.boatIds.has(message.boatId)) {
    handleSubscription(ws, {
      type: "subscribe",
      boatId: message.boatId,
      role: message.role,
    });
  }
}

function handleSubscription(ws, message) {
  const boatId = message.boatId;
  ws.boatIds.add(boatId);

  // Add to appropriate connection map
  if (message.role === "boat-server") {
    if (!serverConnections.has(boatId)) {
      serverConnections.set(boatId, new Set());
    }
    serverConnections.get(boatId).add(ws);
  } else {
    if (!clientConnections.has(boatId)) {
      clientConnections.set(boatId, new Set());
    }
    clientConnections.get(boatId).add(ws);
  }

  console.log(`[WS] ${message.role} subscribed to ${boatId}`);
  updateConnectionStatus(boatId);
}

function handleUnsubscription(ws, boatId) {
  ws.boatIds.delete(boatId);

  // Remove from connection maps
  if (ws.role === "boat-server" && serverConnections.has(boatId)) {
    serverConnections.get(boatId).delete(ws);
    if (serverConnections.get(boatId).size === 0) {
      serverConnections.delete(boatId);
    }
  } else if (clientConnections.has(boatId)) {
    clientConnections.get(boatId).delete(ws);
    if (clientConnections.get(boatId).size === 0) {
      clientConnections.delete(boatId);
    }
  }

  updateConnectionStatus(boatId);
  console.log(`[WS] ${ws.role} unsubscribed from ${boatId}`);
}

function handleMessageRouting(ws, message, rawMsg) {
  const boatId = message.boatId;

  // Server sending to clients
  if (ws.role === "boat-server") {
    if (clientConnections.has(boatId)) {
      const clients = clientConnections.get(boatId);
      let sentCount = 0;

      clients.forEach((client) => {
        if (client.readyState === 1 && client !== ws) {
          client.send(rawMsg);
          sentCount++;
        }
      });

      console.log(`[WS] Server message routed to ${sentCount} clients`);
    } else {
      console.log(`[WS] No clients to receive server message`);
    }
  }
  // Client sending to server
  else if (ws.role === "client") {
    if (serverConnections.has(boatId)) {
      const servers = serverConnections.get(boatId);
      let sentCount = 0;

      servers.forEach((server) => {
        if (server.readyState === 1) {
          server.send(rawMsg);
          sentCount++;
        }
      });

      console.log(`[WS] Client message routed to ${sentCount} servers`);
    } else {
      console.log(`[WS] No servers to receive client message`);
    }
  }
}

function updateConnectionStatus(boatId) {
  const clientCount = clientConnections.has(boatId)
    ? clientConnections.get(boatId).size
    : 0;
  const hasServers =
    serverConnections.has(boatId) && serverConnections.get(boatId).size > 0;

  // Notify servers about client connection changes
  if (hasServers) {
    const statusMessage = JSON.stringify({
      type: "connectionStatus",
      boatId,
      clientCount,
      timestamp: Date.now(),
    });

    serverConnections.get(boatId).forEach((server) => {
      if (server.readyState === 1) {
        server.send(statusMessage);
      }
    });
  }

  console.log(
    `[WS] Status updated for ${boatId}: ${clientCount} clients, ${
      hasServers ? "server connected" : "no server"
    }`
  );
}

httpServer.listen(PORT, () => {
  console.log(`[WS] VPS relay proxy listening on port ${PORT}`);
});














