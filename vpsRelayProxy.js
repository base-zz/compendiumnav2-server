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
import apn from "apn";
import { GoogleAuth } from "google-auth-library";

config();
const TOKEN_SECRET = process.env.TOKEN_SECRET;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(",") || [];
const PORT = process.env.INTERNAL_PORT || 8080;
const AUTH_PORT = process.env.AUTH_PORT || 3001;

let apnProvider = null;
let apnProviderConfigKey = null;

let fcmAuthClient = null;
let fcmAccessTokenCache = null;

function _getFcmServiceAccountConfig() {
  const serviceAccountJson = process.env.FCM_SERVICE_ACCOUNT_JSON;
  const serviceAccountFile = process.env.FCM_SERVICE_ACCOUNT_FILE;

  if (serviceAccountJson && typeof serviceAccountJson === "string") {
    try {
      return { credentials: JSON.parse(serviceAccountJson) };
    } catch (err) {
      return null;
    }
  }

  if (serviceAccountFile && typeof serviceAccountFile === "string") {
    return { keyFile: serviceAccountFile };
  }

  return null;
}

function _getFcmProjectId() {
  const projectId = process.env.FCM_PROJECT_ID;
  if (projectId && typeof projectId === "string") {
    return projectId;
  }

  const config = _getFcmServiceAccountConfig();
  const embeddedProjectId = config?.credentials?.project_id;
  if (embeddedProjectId && typeof embeddedProjectId === "string") {
    return embeddedProjectId;
  }

  return null;
}

async function getFcmAccessToken() {
  const config = _getFcmServiceAccountConfig();
  if (!config) {
    return null;
  }

  const now = Date.now();
  if (
    fcmAccessTokenCache &&
    typeof fcmAccessTokenCache.token === "string" &&
    typeof fcmAccessTokenCache.expiresAtMs === "number" &&
    now + 30000 < fcmAccessTokenCache.expiresAtMs
  ) {
    return fcmAccessTokenCache.token;
  }

  const auth = new GoogleAuth({
    ...config,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });

  const client = await auth.getClient();
  fcmAuthClient = client;

  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse?.token;
  if (!token || typeof token !== "string") {
    return null;
  }

  const expiresAtMs = typeof client.credentials?.expiry_date === "number"
    ? client.credentials.expiry_date
    : now + 50 * 60 * 1000;

  fcmAccessTokenCache = { token, expiresAtMs };
  return token;
}

function _coerceFcmDataValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function buildFcmDataPayload(payload) {
  const out = {};
  if (!payload || typeof payload !== "object") return out;

  Object.entries(payload).forEach(([key, value]) => {
    if (!key || typeof key !== "string") return;
    out[key] = _coerceFcmDataValue(value);
  });

  return out;
}

function isFcmUnregisteredError(errorBody) {
  const errorCode = errorBody?.error?.details?.find(
    (d) => d && typeof d === "object" && d["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError"
  )?.errorCode;

  return errorCode === "UNREGISTERED";
}

async function sendFcmNotificationToTokens({ tokens, title, body, dataPayload }) {
  const projectId = _getFcmProjectId();
  if (!projectId) {
    return { success: false, error: "FCM_PROJECT_ID must be set (or included in service account JSON)", sent: 0, failed: tokens.length, tokensToRemove: [] };
  }

  const accessToken = await getFcmAccessToken();
  if (!accessToken) {
    return { success: false, error: "FCM service account not configured (FCM_SERVICE_ACCOUNT_FILE or FCM_SERVICE_ACCOUNT_JSON required)", sent: 0, failed: tokens.length, tokensToRemove: [] };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const tokensToRemove = [];
  let sent = 0;
  let failed = 0;

  for (const token of tokens) {
    if (!token || typeof token !== "string") {
      failed++;
      continue;
    }

    const message = {
      message: {
        token,
        notification: {
          title,
          body,
        },
        data: buildFcmDataPayload(dataPayload),
        android: {
          priority: "HIGH",
        },
      },
    };

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });
    } catch (err) {
      failed++;
      continue;
    }

    if (response.ok) {
      sent++;
      continue;
    }

    failed++;
    let errorBody = null;
    try {
      errorBody = await response.json();
    } catch (err) {}

    if (isFcmUnregisteredError(errorBody)) {
      tokensToRemove.push(token);
    }
  }

  return { success: true, sent, failed, tokensToRemove };
}

function getApnProvider() {
  const apnsKeyId = process.env.APNS_KEY_ID;
  const apnsTeamId = process.env.APNS_TEAM_ID;
  const apnsKeyFile = process.env.APNS_KEY_FILE;
  const apnsTopic = process.env.APNS_TOPIC;
  const apnsProductionRaw = process.env.APNS_PRODUCTION;

  if (!apnsKeyId || !apnsTeamId || !apnsKeyFile || !apnsTopic) {
    return null;
  }

  if (apnsProductionRaw !== "true" && apnsProductionRaw !== "false") {
    return null;
  }

  const apnsProduction = apnsProductionRaw === "true";
  const configKey = `${apnsKeyId}:${apnsTeamId}:${apnsKeyFile}:${apnsTopic}:${apnsProductionRaw}`;

  if (apnProvider && apnProviderConfigKey === configKey) {
    return apnProvider;
  }

  if (apnProvider) {
    try {
      apnProvider.shutdown();
    } catch (err) {}
    apnProvider = null;
    apnProviderConfigKey = null;
  }

  apnProvider = new apn.Provider({
    token: {
      key: apnsKeyFile,
      keyId: apnsKeyId,
      teamId: apnsTeamId,
    },
    production: apnsProduction,
  });

  apnProviderConfigKey = configKey;
  return apnProvider;
}

// --- LOWDB SETUP ---
const dbFile = join(process.cwd(), "db.json");
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { users: [], boats: [], user_boats: [], boat_keys: [], push_tokens: [], push_events: [] });

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

function requireAuth(req, res) {
  const token = req.headers.authorization?.split(" ")[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    res.status(401).json({ success: false, error: "Invalid token" });
    return null;
  }
  return decoded;
}

function getRequestBodyHash(body) {
  const payload = JSON.stringify(body);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

async function requireBoatSignature(req, res) {
  const boatId = req.headers["x-boat-id"];
  const timestampHeader = req.headers["x-timestamp"];
  const signature = req.headers["x-signature"];

  if (!boatId || typeof boatId !== "string") {
    res.status(401).json({ success: false, error: "Missing x-boat-id" });
    return null;
  }
  if (!timestampHeader || typeof timestampHeader !== "string") {
    res.status(401).json({ success: false, error: "Missing x-timestamp" });
    return null;
  }
  if (!signature || typeof signature !== "string") {
    res.status(401).json({ success: false, error: "Missing x-signature" });
    return null;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    res.status(401).json({ success: false, error: "Invalid x-timestamp" });
    return null;
  }

  const now = Date.now();
  const maxSkewMs = Number(process.env.PUSH_TRIGGER_MAX_SKEW_MS);
  if (!Number.isFinite(maxSkewMs)) {
    res.status(500).json({ success: false, error: "PUSH_TRIGGER_MAX_SKEW_MS must be set" });
    return null;
  }

  if (Math.abs(now - timestamp) > maxSkewMs) {
    res.status(401).json({ success: false, error: "Request timestamp outside allowed window" });
    return null;
  }

  await db.read();
  const keyEntry = db.data.boat_keys.find((k) => k.boatId === boatId);
  if (!keyEntry?.publicKey) {
    res.status(401).json({ success: false, error: "No public key registered for boatId" });
    return null;
  }

  const bodyHash = getRequestBodyHash(req.body);
  const message = `${boatId}:${timestamp}:${bodyHash}`;
  const ok = verifySignature(message, signature, keyEntry.publicKey);
  if (!ok) {
    res.status(401).json({ success: false, error: "Invalid signature" });
    return null;
  }

  return { boatId, timestamp, bodyHash };
}

// Verify a signature using a public key
function verifySignature(message, signature, publicKey) {

  console.log(`[AUTH-DETAILED] Verifying signature:`, {
      message,
      signatureLength: signature.length,
      publicKeyStart: publicKey.substring(0, 20) + '...'
  });

  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(message);
    verify.end();
    return verify.verify(publicKey, signature, 'base64');
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
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

// REGISTER DEVICE PUSH TOKEN (APNs token)
app.post("/api/push/register-token", async (req, res) => {
  const decoded = requireAuth(req, res);
  if (!decoded) {
    return;
  }

  const { boatId, token, platform } = req.body;

  if (!boatId || typeof boatId !== "string") {
    return res.status(400).json({ success: false, error: "boatId is required" });
  }
  if (!token || typeof token !== "string") {
    return res.status(400).json({ success: false, error: "token is required" });
  }
  if (!platform || typeof platform !== "string") {
    return res.status(400).json({ success: false, error: "platform is required" });
  }

  await db.read();

  const hasBoatAccess = db.data.user_boats.some(
    (ub) => ub.username === decoded.username && ub.boatId === boatId
  );
  if (!hasBoatAccess) {
    return res
      .status(403)
      .json({ success: false, error: "User not authorized for this boatId" });
  }

  const nowIso = new Date().toISOString();
  const normalizedPlatform = platform.toLowerCase();

  const existingIndex = db.data.push_tokens.findIndex(
    (pt) =>
      pt.username === decoded.username &&
      pt.boatId === boatId &&
      pt.platform === normalizedPlatform &&
      pt.token === token
  );

  if (existingIndex >= 0) {
    db.data.push_tokens[existingIndex].updatedAt = nowIso;
  } else {
    db.data.push_tokens.push({
      id: crypto.randomUUID(),
      username: decoded.username,
      boatId,
      platform: normalizedPlatform,
      token,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  await db.write();
  res.json({ success: true });
});

// TEST PUSH (user -> VPS)
app.post("/api/push/test", async (req, res) => {
  const decoded = requireAuth(req, res);
  if (!decoded) {
    return;
  }

  const { boatId, title, body, eventId, timestamp, data } = req.body || {};

  if (!boatId || typeof boatId !== "string") {
    return res.status(400).json({ success: false, error: "boatId is required" });
  }
  if (!title || typeof title !== "string") {
    return res.status(400).json({ success: false, error: "title is required" });
  }
  if (!body || typeof body !== "string") {
    return res.status(400).json({ success: false, error: "body is required" });
  }
  if (!eventId || typeof eventId !== "string") {
    return res.status(400).json({ success: false, error: "eventId is required" });
  }
  if (!timestamp || typeof timestamp !== "string") {
    return res.status(400).json({ success: false, error: "timestamp is required" });
  }
  if (data !== undefined && data !== null && typeof data !== "object") {
    return res.status(400).json({ success: false, error: "data must be an object" });
  }

  await db.read();

  const hasBoatAccess = db.data.user_boats.some(
    (ub) => ub.username === decoded.username && ub.boatId === boatId
  );
  if (!hasBoatAccess) {
    return res
      .status(403)
      .json({ success: false, error: "User not authorized for this boatId" });
  }

  const iosTokens = db.data.push_tokens.filter(
    (pt) => pt.boatId === boatId && pt.platform === "ios" && typeof pt.token === "string"
  );

  const androidTokens = db.data.push_tokens.filter(
    (pt) => pt.boatId === boatId && pt.platform === "android" && typeof pt.token === "string"
  );

  const responsePayload = { success: true, boatId, ios: null, android: null };

  // iOS (APNs)
  if (iosTokens.length > 0) {
    const apnsKeyId = process.env.APNS_KEY_ID;
    const apnsTeamId = process.env.APNS_TEAM_ID;
    const apnsKeyFile = process.env.APNS_KEY_FILE;
    const apnsTopic = process.env.APNS_TOPIC;
    const apnsProductionRaw = process.env.APNS_PRODUCTION;

    if (!apnsKeyId || !apnsTeamId || !apnsKeyFile || !apnsTopic) {
      responsePayload.ios = {
        success: false,
        error: "APNs not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_FILE, APNS_TOPIC are required)",
        tokenCount: iosTokens.length,
      };
    } else if (apnsProductionRaw !== "true" && apnsProductionRaw !== "false") {
      responsePayload.ios = {
        success: false,
        error: "APNs not configured (APNS_PRODUCTION must be set to 'true' or 'false')",
        tokenCount: iosTokens.length,
      };
    } else {
      const provider = getApnProvider();
      if (!provider) {
        responsePayload.ios = {
          success: false,
          error: "APNs provider could not be initialized",
          tokenCount: iosTokens.length,
        };
      } else {
        const note = new apn.Notification();
        note.topic = apnsTopic;
        note.pushType = "alert";
        note.alert = { title, body };
        note.payload = {
          boatId,
          type: "test",
          severity: "info",
          eventId,
          timestamp,
          data: data || {},
        };

        let apnsResult;
        try {
          apnsResult = await provider.send(note, iosTokens.map((t) => t.token));
        } catch (error) {
          responsePayload.ios = {
            success: false,
            error: error?.message || "APNs send failed",
            tokenCount: iosTokens.length,
          };
        }

        if (apnsResult) {
          const failed = Array.isArray(apnsResult?.failed) ? apnsResult.failed : [];
          const sent = Array.isArray(apnsResult?.sent) ? apnsResult.sent : [];

          if (failed.length > 0) {
            const tokensToRemove = new Set();
            failed.forEach((failure) => {
              const reason = failure?.response?.reason;
              const status = failure?.status;
              const device = failure?.device;

              const shouldRemove =
                device &&
                (reason === "BadDeviceToken" ||
                  reason === "Unregistered" ||
                  status === 410 ||
                  status === 400);

              if (shouldRemove) {
                tokensToRemove.add(String(device));
              }
            });

            if (tokensToRemove.size > 0) {
              db.data.push_tokens = db.data.push_tokens.filter(
                (pt) => !(pt.boatId === boatId && pt.platform === "ios" && tokensToRemove.has(pt.token))
              );
              await db.write();
            }
          }

          responsePayload.ios = {
            success: true,
            tokenCount: iosTokens.length,
            sent: sent.length,
            failed: failed.length,
          };
        }
      }
    }
  } else {
    responsePayload.ios = { success: true, tokenCount: 0, sent: 0, failed: 0 };
  }

  // Android (FCM)
  if (androidTokens.length > 0) {
    const fcmResult = await sendFcmNotificationToTokens({
      tokens: androidTokens.map((t) => t.token),
      title,
      body,
      dataPayload: {
        boatId,
        type: "test",
        severity: "info",
        eventId,
        timestamp,
        data: data || {},
      },
    });

    if (fcmResult?.tokensToRemove?.length > 0) {
      await db.read();
      const removeSet = new Set(fcmResult.tokensToRemove);
      db.data.push_tokens = db.data.push_tokens.filter(
        (pt) => !(pt.boatId === boatId && pt.platform === "android" && removeSet.has(pt.token))
      );
      await db.write();
    }

    responsePayload.android = {
      success: !!fcmResult?.success,
      error: fcmResult?.error,
      tokenCount: androidTokens.length,
      sent: fcmResult?.sent ?? 0,
      failed: fcmResult?.failed ?? androidTokens.length,
    };
  } else {
    responsePayload.android = { success: true, tokenCount: 0, sent: 0, failed: 0 };
  }

  return res.json(responsePayload);
});

// TRIGGER PUSH (boat server -> VPS)
app.post("/api/push/trigger", async (req, res) => {
  const auth = await requireBoatSignature(req, res);
  if (!auth) {
    return;
  }

  const {
    boatId,
    type,
    severity,
    title,
    body,
    eventId,
    timestamp,
    data,
  } = req.body || {};

  if (!boatId || typeof boatId !== "string") {
    return res.status(400).json({ success: false, error: "boatId is required" });
  }
  if (boatId !== auth.boatId) {
    return res.status(401).json({ success: false, error: "boatId mismatch" });
  }
  if (!type || typeof type !== "string") {
    return res.status(400).json({ success: false, error: "type is required" });
  }
  if (!severity || typeof severity !== "string") {
    return res.status(400).json({ success: false, error: "severity is required" });
  }
  if (!title || typeof title !== "string") {
    return res.status(400).json({ success: false, error: "title is required" });
  }
  if (!body || typeof body !== "string") {
    return res.status(400).json({ success: false, error: "body is required" });
  }
  if (!eventId || typeof eventId !== "string") {
    return res.status(400).json({ success: false, error: "eventId is required" });
  }
  if (!timestamp || typeof timestamp !== "string") {
    return res.status(400).json({ success: false, error: "timestamp is required" });
  }
  if (data !== undefined && data !== null && typeof data !== "object") {
    return res.status(400).json({ success: false, error: "data must be an object" });
  }

  await db.read();

  const dedupeKey = `${boatId}:${eventId}`;
  const existingEvent = db.data.push_events.find((e) => e.dedupeKey === dedupeKey);
  if (existingEvent) {
    return res.json({ success: true, deduped: true });
  }

  const nowIso = new Date().toISOString();
  db.data.push_events.push({
    id: crypto.randomUUID(),
    boatId,
    eventId,
    dedupeKey,
    createdAt: nowIso,
    type,
    severity,
  });

  const iosTokens = db.data.push_tokens.filter(
    (pt) => pt.boatId === boatId && pt.platform === "ios" && typeof pt.token === "string"
  );

  const androidTokens = db.data.push_tokens.filter(
    (pt) => pt.boatId === boatId && pt.platform === "android" && typeof pt.token === "string"
  );

  await db.write();

  const responsePayload = { success: true, boatId, ios: null, android: null };

  // iOS (APNs)
  if (iosTokens.length > 0) {
    const apnsKeyId = process.env.APNS_KEY_ID;
    const apnsTeamId = process.env.APNS_TEAM_ID;
    const apnsKeyFile = process.env.APNS_KEY_FILE;
    const apnsTopic = process.env.APNS_TOPIC;
    const apnsProductionRaw = process.env.APNS_PRODUCTION;

    if (!apnsKeyId || !apnsTeamId || !apnsKeyFile || !apnsTopic) {
      responsePayload.ios = {
        success: false,
        error: "APNs not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_FILE, APNS_TOPIC are required)",
        tokenCount: iosTokens.length,
      };
    } else if (apnsProductionRaw !== "true" && apnsProductionRaw !== "false") {
      responsePayload.ios = {
        success: false,
        error: "APNs not configured (APNS_PRODUCTION must be set to 'true' or 'false')",
        tokenCount: iosTokens.length,
      };
    } else {
      const provider = getApnProvider();
      if (!provider) {
        responsePayload.ios = {
          success: false,
          error: "APNs provider could not be initialized",
          tokenCount: iosTokens.length,
        };
      } else {
        const note = new apn.Notification();
        note.topic = apnsTopic;
        note.pushType = "alert";
        note.alert = { title, body };
        note.payload = {
          boatId,
          type,
          severity,
          eventId,
          timestamp,
          data: data || {},
        };

        let apnsResult;
        try {
          apnsResult = await provider.send(note, iosTokens.map((t) => t.token));
        } catch (error) {
          responsePayload.ios = {
            success: false,
            error: error?.message || "APNs send failed",
            tokenCount: iosTokens.length,
          };
        }

        if (apnsResult) {
          const failed = Array.isArray(apnsResult?.failed) ? apnsResult.failed : [];
          const sent = Array.isArray(apnsResult?.sent) ? apnsResult.sent : [];

          if (failed.length > 0) {
            await db.read();

            const tokensToRemove = new Set();
            failed.forEach((failure) => {
              const reason = failure?.response?.reason;
              const status = failure?.status;
              const device = failure?.device;

              const shouldRemove =
                device &&
                (reason === "BadDeviceToken" ||
                  reason === "Unregistered" ||
                  status === 410 ||
                  status === 400);

              if (shouldRemove) {
                tokensToRemove.add(String(device));
              }
            });

            if (tokensToRemove.size > 0) {
              db.data.push_tokens = db.data.push_tokens.filter(
                (pt) => !(pt.boatId === boatId && pt.platform === "ios" && tokensToRemove.has(pt.token))
              );
              await db.write();
            }
          }

          responsePayload.ios = {
            success: true,
            tokenCount: iosTokens.length,
            sent: sent.length,
            failed: failed.length,
          };
        }
      }
    }
  } else {
    responsePayload.ios = { success: true, tokenCount: 0, sent: 0, failed: 0 };
  }

  // Android (FCM)
  if (androidTokens.length > 0) {
    const fcmResult = await sendFcmNotificationToTokens({
      tokens: androidTokens.map((t) => t.token),
      title,
      body,
      dataPayload: {
        boatId,
        type,
        severity,
        eventId,
        timestamp,
        data: data || {},
      },
    });

    if (fcmResult?.tokensToRemove?.length > 0) {
      await db.read();
      const removeSet = new Set(fcmResult.tokensToRemove);
      db.data.push_tokens = db.data.push_tokens.filter(
        (pt) => !(pt.boatId === boatId && pt.platform === "android" && removeSet.has(pt.token))
      );
      await db.write();
    }

    responsePayload.android = {
      success: !!fcmResult?.success,
      error: fcmResult?.error,
      tokenCount: androidTokens.length,
      sent: fcmResult?.sent ?? 0,
      failed: fcmResult?.failed ?? androidTokens.length,
    };
  } else {
    responsePayload.android = { success: true, tokenCount: 0, sent: 0, failed: 0 };
  }

  const anySucceeded =
    (responsePayload.ios && responsePayload.ios.success && responsePayload.ios.sent > 0) ||
    (responsePayload.android && responsePayload.android.success && responsePayload.android.sent > 0);

  if (!anySucceeded) {
    return res.status(503).json({
      success: false,
      error: "No pushes were sent (check APNs/FCM configuration)",
      ...responsePayload,
    });
  }

  return res.json(responsePayload);
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

// BOAT PUBLIC KEY REGISTRATION
app.post("/api/boat/register-key", async (req, res) => {
  const { boatId, publicKey } = req.body;
  
  if (!boatId || !publicKey) {
    return res.status(400).json({ 
      success: false, 
      error: "boatId and publicKey are required" 
    });
  }
  
  await db.read();
  
  // Check if boat exists - if not, create it as an unregistered boat
  let boat = db.data.boats.find(b => b.boatId === boatId);
  if (!boat) {
    boat = {
      boatId,
      boatName: `Unregistered Boat ${boatId.substring(0, 8)}`,
      createdAt: new Date().toISOString(),
      isUnregistered: true
    };
    db.data.boats.push(boat);
  }
  
  // Update or create key entry
  const existingKeyIndex = db.data.boat_keys.findIndex(k => k.boatId === boatId);
  if (existingKeyIndex >= 0) {
    db.data.boat_keys[existingKeyIndex].publicKey = publicKey;
    db.data.boat_keys[existingKeyIndex].updatedAt = new Date().toISOString();
  } else {
    db.data.boat_keys.push({ 
      boatId, 
      publicKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  
  await db.write();
  res.json({ 
    success: true, 
    message: "Public key registered successfully",
    boatId
  });
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
  console.log(`[WS-DETAILED] New connection from ${ip} with headers:`, req.headers);

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
      console.log(`[WS-DETAILED] Identity message received from ${ip}:`, {
        boatId: message.boatId,
        role: message.role,
        hasSignature: !!message.signature,
        hasTimestamp: !!message.timestamp
      });
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
async function handleIdentity(ws, message) {
  // Check if this is a signed identity message (key-based auth)
  if (message.signature && message.timestamp) {
    console.log(`[AUTH-DETAILED] Processing signed identity for boat ${message.boatId}`);

    try {
      await db.read();
      const keyEntry = db.data.boat_keys.find(k => k.boatId === message.boatId);

      if (!keyEntry) {
        console.warn(`[WS] No public key found for boat ${message.boatId}`);
        // Allow connection but log warning - the boat should register its key
        ws.role = message.role;
        console.log(`[WS] ${ws.role} identified for boat ${message.boatId} (NO KEY - INSECURE)`);
      } else {
        // Verify the signature
        console.log(`[AUTH-DETAILED] Found public key for boat ${message.boatId}, verifying signature`);

        const isValid = verifySignature(
          `${message.boatId}:${message.timestamp}`, 
          message.signature, 
          keyEntry.publicKey
        );

        if (!isValid) {
          console.warn(`[WS] Invalid signature from boat ${message.boatId}`);
          ws.close(4000, 'Authentication failed: Invalid signature');
          return;
        } else {
          console.log(`[AUTH-DETAILED] Signature verification SUCCEEDED for boat ${message.boatId}`);

          // Signature verified, proceed with identity setup
          ws.role = message.role;
          console.log(`[WS] ${ws.role} authenticated for boat ${message.boatId} (SECURE)`);
        }
      }
    } catch (error) {
      console.error(`[WS] Error during key verification:`, error);
      // Fall back to regular identity handling
      ws.role = message.role;
      console.log(`[WS] ${ws.role} identified for boat ${message.boatId} (VERIFICATION ERROR)`);
    }
  } else {
    // Legacy identity handling (without signature)
    ws.role = message.role;
    console.log(`[WS] ${ws.role} identified for boat ${message.boatId} (LEGACY)`);
  }
  
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