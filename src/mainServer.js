import dotenv from "dotenv";
import http from "http";
import https from "https";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  startRelayServer,
  startDirectServerWrapper,
} from "./relay/server/index.js";
import {
  getStateManager,
  setStateManagerInstance,
} from "./relay/core/state/StateManager.js";
import { registerBoatInfoRoutes, getBoatInfo } from "./server/api/boatInfo.js";
import { registerVpsRoutes } from "./server/vps/registration.js";
import { registerVictronRoutes } from "./server/api/victron.js";
import { registerRouteImportRoutes } from "./server/api/routes.js";
import { registerFuelPipelineRoutes } from "./server/api/fuelPipeline.js";
import debug from "debug";
import {
  bootstrapServices,
  startRegisteredServices,
} from "./services/bootstrap.js";
import { serviceManager } from "./services/ServiceManager.js";
import { requireService } from "./services/serviceLocator.js";
import storageService from "./bluetooth/services/storage/storageService.js";
import { NewStateService } from "./services/NewStateService.js";
import { PositionService } from "./services/PositionService.js";
import { TidalService } from "./services/TidalService.js";
import { BridgeHudService } from "./services/BridgeHudService.js";
import { AnchorageHudService } from "./services/AnchorageHudService.js";
import { MarinaService } from "./services/MarinaService.js";
import { WeatherService } from "./services/WeatherService.js";
import { BluetoothService } from "./services/BluetoothService.js";
import { VictronModbusService } from "./services/VictronModbusService.js";
import { MasterSyncService } from "./services/MasterSyncService.js";
import DemoRecorderService from "./services/DemoRecorderService.js";
import RecordedDemoService from "./services/RecordedDemoService.js";
import { MarinaDiscoveryService } from "./services/MarinaDiscoveryService.js";
import { getOrCreateKeyPair } from "./state/keyPair.js";

const log = debug("server:main");
const verboseStartupLogs = process.env.VERBOSE_STARTUP_LOGS === "true";
const startupLog = (...args) => {
  if (verboseStartupLogs) {
    console.log(...args);
  }
};
const healthTelemetryLogsEnabled = process.env.HEALTH_TELEMETRY_LOGS === "true";
let shutdownStarted = false;
let httpServerInstance = null;
let httpsServerInstance = null;
let relayServerInstance = null;
let directServerInstance = null;

startupLog("[SERVER] TOP: mainServer.js imports completed, entering top-level code...");

startupLog("[SERVER] TOP: before getStateManager()");
const stateManager = getStateManager();
startupLog("[SERVER] TOP: after getStateManager(), before setStateManagerInstance()");
setStateManagerInstance(stateManager);
startupLog("[SERVER] TOP: after setStateManagerInstance(), before dotenv.config");

startupLog("Loading .env");
dotenv.config({ path: ".env" });
startupLog("[SERVER] TOP: after dotenv.config, before CLI flag parsing");

// Periodic memory usage logging to diagnose heap growth
const memoryLogInterval = setInterval(() => {
  const memory = process.memoryUsage();
  const formatMb = (value) => `${(value / 1024 / 1024).toFixed(1)}MB`;
  console.log("[SERVER] Memory usage", {
    rss: formatMb(memory.rss),
    heapTotal: formatMb(memory.heapTotal),
    heapUsed: formatMb(memory.heapUsed),
    external: formatMb(memory.external),
    arrayBuffers: formatMb(memory.arrayBuffers || 0),
  });
}, 300000);

// --- CLI flag parsing ---
startupLog("[SERVER] Parsing CLI flags...");
const recordFlag = process.argv.includes('--record');
const demoFlag = process.argv.includes('--demo');
if (recordFlag && demoFlag) {
  console.error('[SERVER] Cannot use --record and --demo together');
  process.exit(1);
}
if (recordFlag) {
  console.log('[SERVER] Demo recording enabled via --record flag');
}
if (demoFlag) {
  console.log('[SERVER] Demo playback enabled via --demo flag');
}

// --- Helper to build the VPS URL ---
function buildVpsUrl() {
  if (process.env.VPS_URL) return process.env.VPS_URL;
  if (process.env.RELAY_SERVER_URL) return process.env.RELAY_SERVER_URL;
  if (process.env.VPS_HOST) {
    const proto = process.env.VPS_WS_PORT === "443" ? "wss" : "ws";
    const host = process.env.VPS_HOST;
    const port =
      process.env.VPS_WS_PORT &&
      process.env.VPS_WS_PORT !== "80" &&
      process.env.VPS_WS_PORT !== "443"
        ? `:${process.env.VPS_WS_PORT}`
        : "";
    const path = process.env.VPS_PATH || "/relay";
    return `${proto}://${host}${port}${path}`;
  }
  return undefined;
}

async function closeHttpServer(server) {
  if (!server) {
    return;
  }

  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function getHttpsCredentials() {
  const certDir = process.env.SSL_CERT_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "ssl");
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");

  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
  }

  return null;
}

async function shutdown(signal) {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  console.log(`\n[SERVER] Shutting down gracefully (${signal})...`);

  const forceExitTimer = setTimeout(() => {
    console.error("[SERVER] Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 8000);

  try {
    clearInterval(memoryLogInterval);

    if (directServerInstance && typeof directServerInstance.shutdown === "function") {
      await directServerInstance.shutdown();
    }

    if (relayServerInstance && typeof relayServerInstance.shutdown === "function") {
      relayServerInstance.shutdown();
    } else if (relayServerInstance && typeof relayServerInstance.close === "function") {
      relayServerInstance.close();
    }

    await closeHttpServer(httpServerInstance);
    await closeHttpServer(httpsServerInstance);
    await serviceManager.stopAll();
    await storageService.close();

    clearTimeout(forceExitTimer);
    console.log("[SERVER] Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    clearTimeout(forceExitTimer);
    console.error("[SERVER] Error during graceful shutdown:", err);
    process.exit(1);
  }
}

process.once("SIGINT", () => {
  shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

// --- Bridge canonical state into relay state manager ---
async function bridgeStateToRelay() {
  console.log("[SERVER] Starting state bridge to relay");
  log("Starting state bridge to relay");
  try {
    console.log("[SERVER] Importing StateData...");
    const { stateData } = await import("./state/StateData.js");
    console.log("[SERVER] Importing StateManager...");
    const { getStateManager: resolveStateManager } = await import(
      "./relay/core/state/StateManager.js"
    );
    console.log("[SERVER] Resolving StateManager...");
    const relayStateManager = resolveStateManager();
    console.log("[SERVER] Getting state service...");
    const stateService = requireService("state");
    console.log("[SERVER] Setting up state update listeners...");

    stateService.on("state:full-update", (msg) => {
      relayStateManager.receiveExternalStateUpdate(msg.data);
    });

    stateService.on("state:patch", (msg) => {
      relayStateManager.applyPatchAndForward(msg.data);
    });
    console.log("[SERVER] State bridge activated");
    log("StateService patch listener registered");
    log("State bridge activated");
  } catch (err) {
    console.error("[SERVER] !!!!!! Failed to set up state bridge:", err);
    throw err;
  }
}

function buildServiceManifest() {
  startupLog("[SERVER] buildServiceManifest() called");

  const positionSources = {
    gps: { priority: 1, timeout: 10000 },
    ais: { priority: 2, timeout: 15000 },
    state: { priority: 3, timeout: 20000 },
  };

  const manifest = [];
  startupLog("[SERVER] buildServiceManifest(): initializing manifest array");

  startupLog("[SERVER] buildServiceManifest(): adding state service (NewStateService / RecordedDemoService)");
  manifest.push({
    name: "state",
    create: () => (demoFlag ? new RecordedDemoService() : new NewStateService()),
  });

  manifest.push({
    name: "position",
    create: () => new PositionService({ sources: positionSources }),
  });

  manifest.push({
    name: "tidal",
    create: () => new TidalService(),
  });

  manifest.push({
    name: "weather",
    create: () => new WeatherService(),
  });

  if (!demoFlag) {
    startupLog("[SERVER] buildServiceManifest(): demoFlag is false, adding bluetooth and victron-modbus services");
    manifest.push(
      {
        name: "bluetooth",
        create: () => new BluetoothService({ stateManager }),
      },
      {
        name: "victron-modbus",
        create: () =>
          new VictronModbusService({
            host: "192.168.50.158",
            port: 502,
            pollInterval: 5000,
          }),
      }
    );
  }

  if (recordFlag) {
    startupLog("[SERVER] buildServiceManifest(): recordFlag is true, adding demo-recorder service");
    manifest.push({
      name: "demo-recorder",
      create: () => new DemoRecorderService(),
    });
  }

  // Add BridgeHudService if enabled
  const bridgeHudEnabled = process.env.BRIDGE_HUD_ENABLED === "true";
  const bridgeDbPath = process.env.BRIDGE_DB_PATH;

  if (bridgeHudEnabled) {
    if (!bridgeDbPath) {
      console.warn(
        "[SERVER] BRIDGE_HUD_ENABLED=true but BRIDGE_DB_PATH is undefined. Set BRIDGE_DB_PATH to enable BridgeHudService."
      );
    } else {
      manifest.push({
        name: "bridge-hud",
        create: () =>
          new BridgeHudService({
            boatId: getBoatInfo().boatId,
            dbPath: bridgeDbPath,
            spatiaLitePath: process.env.SPATIALITE_PATH || "/usr/lib/aarch64-linux-gnu/mod_spatialite.so",
          }),
      });
      startupLog(
        "[SERVER] buildServiceManifest(): added bridge-hud service"
      );
    }
  }

  const anchorageHudEnabled = process.env.ANCHORAGE_HUD_ENABLED === "true";
  const anchorageDbPath = process.env.ANCHORAGE_DB_PATH;
  const anchorageShorelineDbPath = fileURLToPath(new URL("../data/icw_navigation.sqlite", import.meta.url));
  const anchorageSpatiaLitePath = process.env.SPATIALITE_PATH;

  if (anchorageHudEnabled) {
    if (!anchorageDbPath) {
      console.warn(
        "[SERVER] ANCHORAGE_HUD_ENABLED=true but ANCHORAGE_DB_PATH is undefined. Set ANCHORAGE_DB_PATH to enable AnchorageHudService."
      );
    } else {
      if (!existsSync(anchorageShorelineDbPath)) {
        console.warn(
          `[SERVER] Anchorage shoreline DB not found at ${anchorageShorelineDbPath}. Copy the shoreline spatial DB into this path to enable topology scoring.`
        );
      }
      if (!anchorageSpatiaLitePath) {
        console.warn(
          "[SERVER] SPATIALITE_PATH is undefined. Set SPATIALITE_PATH so AnchorageHudService can load SpatiaLite and query shoreline topology."
        );
      }

      manifest.push({
        name: "anchorage-hud",
        create: () =>
          new AnchorageHudService({
            dbPath: anchorageDbPath,
            shorelineDbPath: anchorageShorelineDbPath,
            shorelineSpatiaLitePath: anchorageSpatiaLitePath,
          }),
      });
      startupLog(
        "[SERVER] buildServiceManifest(): added anchorage-hud service"
      );
    }
  }

  // Add MarinaService if enabled
  const marinaHudEnabled = process.env.MARINA_HUD_ENABLED === "true";
  const marinaDbPath = process.env.MARINA_DB_PATH;

  if (marinaHudEnabled) {
    if (!marinaDbPath) {
      console.warn(
        "[SERVER] MARINA_HUD_ENABLED=true but MARINA_DB_PATH is undefined. Set MARINA_DB_PATH to enable MarinaService."
      );
    } else {
      manifest.push({
        name: "marina-hud",
        create: () =>
          new MarinaService({
            dbPath: marinaDbPath,
          }),
      });
      startupLog(
        "[SERVER] buildServiceManifest(): added marina-hud service"
      );
    }
  }

  // Add MarinaDiscoveryService if enabled
  const marinaDiscoveryEnabled = process.env.MARINA_DISCOVERY_ENABLED === "true";
  const discoveryDbPath = process.env.MARINA_DB_PATH || marinaDbPath;

  if (marinaDiscoveryEnabled) {
    if (!discoveryDbPath) {
      console.warn(
        "[SERVER] MARINA_DISCOVERY_ENABLED=true but MARINA_DB_PATH is undefined. Set MARINA_DB_PATH to enable MarinaDiscoveryService."
      );
    } else {
      manifest.push({
        name: "marina-discovery",
        create: () =>
          new MarinaDiscoveryService({
            dbPath: discoveryDbPath,
            thresholdMiles: parseFloat(process.env.MARINA_DISCOVERY_THRESHOLD_MILES || "10"),
            minIntervalHours: parseFloat(process.env.MARINA_DISCOVERY_MIN_INTERVAL_HOURS || "1"),
            debug: process.env.MARINA_DISCOVERY_DEBUG === "true",
          }),
      });
      startupLog(
        "[SERVER] buildServiceManifest(): added marina-discovery service"
      );
    }
  }

  startupLog("[SERVER] buildServiceManifest(): manifest complete with services:", manifest.map(m => m.name));
  return manifest;
}

async function startSecondaryServices() {
  startupLog("[SERVER] startSecondaryServices() called");
  const stateService = requireService("state");
  const resolveService = (name, { required = false } = {}) => {
    const service = serviceManager.getService(name);
    if (!service && required) {
      throw new Error(`Service '${name}' was not registered correctly`);
    }
    return service;
  };

  const positionService = resolveService("position", { required: true });
  const tidalService = resolveService("tidal", { required: true });
  const weatherService = resolveService("weather", { required: true });
  const bluetoothService = resolveService("bluetooth");
  const victronService = resolveService("victron-modbus");

  startupLog("[SERVER] startSecondaryServices(): resolved services:", {
    hasPosition: !!positionService,
    hasTidal: !!tidalService,
    hasWeather: !!weatherService,
    hasBluetooth: !!bluetoothService,
    hasVictron: !!victronService,
  });

  // Listeners already set up before services started
  startupLog("[SERVER] startSecondaryServices(): StateManager already listening to active services");

  if (bluetoothService) {
    stateManager.on(
      "bluetooth:metadata-updated",
      async ({ deviceId, metadata }) => {
        try {
          await bluetoothService.updateDeviceMetadata(deviceId, metadata);
        } catch (error) {
          console.error(
            `[SERVER] Failed to update BluetoothService DeviceManager:`,
            error
          );
        }
      }
    );
  }

  // Add MasterSyncService if enabled (boat info should be available now)
  const masterSyncEnabled = process.env.MASTER_SYNC_ENABLED === "true";
  const masterSyncDbPath = process.env.MARINA_DB_PATH;
  const vpsHost = process.env.VPS_HOST;

  if (masterSyncEnabled) {
    if (!masterSyncDbPath) {
      console.warn(
        "[SERVER] MASTER_SYNC_ENABLED=true but MARINA_DB_PATH is undefined. Set MARINA_DB_PATH to enable MasterSyncService."
      );
    } else if (!vpsHost) {
      console.warn(
        "[SERVER] MASTER_SYNC_ENABLED=true but VPS_HOST is undefined. Set VPS_HOST to enable MasterSyncService."
      );
    } else {
      const boatInfo = getBoatInfo();
      const keyPair = getOrCreateKeyPair();
      if (!boatInfo.boatId || !keyPair.privateKey) {
        console.warn(
          "[SERVER] MASTER_SYNC_ENABLED=true but boatId or privateKey is missing. Cannot enable MasterSyncService."
        );
      } else {
        const masterSyncService = new MasterSyncService({
          dbPath: masterSyncDbPath,
          vpsHost: vpsHost,
          boatId: boatInfo.boatId,
          privateKey: keyPair.privateKey,
          syncIntervalMs: 5 * 60 * 1000, // 5 minutes
          batchSize: 10,
        });
        await serviceManager.registerService("master-sync", masterSyncService);
        await masterSyncService.start();
        startupLog("[SERVER] startSecondaryServices(): added master-sync service");
      }
    }
  }
}

async function startServer() {
  try {
    startupLog("[SERVER] startServer() called, beginning bootstrap...");
    const manifest = buildServiceManifest();
    startupLog("[SERVER] Service manifest built with entries:", manifest.map(m => m.name));
    startupLog("[SERVER] Calling bootstrapServices(manifest)...");
    const { failures } = await bootstrapServices(manifest);
    startupLog("[SERVER] bootstrapServices() completed, failures count:", failures.length);
    if (failures.length > 0) {
      throw new Error(
        `Service bootstrap failures: ${failures
          .map((f) => `${f.name}:${f.reason}`)
          .join(", ")}`
      );
    }

    startupLog("[SERVER] Starting registered services...");
    
    // Get service references before starting them so we can set up listeners
    const positionService = serviceManager.getService('position');
    const tidalService = serviceManager.getService('tidal');
    const weatherService = serviceManager.getService('weather');
    const stateServiceForHealth = serviceManager.getService('state');
    const bluetoothService = serviceManager.getService('bluetooth');
    const victronService = serviceManager.getService('victron-modbus');

    // CRITICAL: Set up StateManager listeners BEFORE starting services
    // Services emit initial data immediately on startup (weather:update, tide:update, etc.)
    // If listeners are attached after service start, the initial data will be missed
    startupLog("[SERVER] Setting up StateManager listeners BEFORE starting services...");
    [positionService, tidalService, weatherService, bluetoothService, victronService]
      .filter(Boolean)
      .forEach((service) => {
        stateManager.listenToService(service);
      });
    startupLog("[SERVER] StateManager now listening to active services");

    await startRegisteredServices();
    startupLog("[SERVER] Registered services started, waiting for all ready...");
    await serviceManager.waitForAllReady();
    startupLog("[SERVER] All services reported ready. Proceeding to bridge state and start secondary services.");

    await bridgeStateToRelay();
    startupLog("[SERVER] bridgeStateToRelay() completed");
    await startSecondaryServices();
    startupLog("[SERVER] startSecondaryServices() completed");

    // Set up MarinaDiscoveryService listener to trigger fuel pipeline discovery
    const marinaDiscoveryService = serviceManager.getService('marina-discovery');
    if (marinaDiscoveryService) {
      const marinaDbPath = process.env.MARINA_DB_PATH;
      if (marinaDbPath) {
        marinaDiscoveryService.on('marina:discovery:trigger', async (data) => {
          console.log('[SERVER] Marina discovery triggered:', data);
          try {
            const { triggerDiscovery } = await import('./server/api/fuelPipeline.js');
            await triggerDiscovery({
              dbPath: marinaDbPath,
              lat: data.lat,
              lon: data.lon,
              sweepRadius: 50,
              discoveryRadius: 5,
              gridSpacing: 10,
              timeout: 45,
              scrollCycles: 10,
            });
            console.log('[SERVER] Marina discovery completed successfully');
          } catch (error) {
            console.error('[SERVER] Marina discovery failed:', error);
          }
        });
        startupLog('[SERVER] Marina discovery event listener registered');
      } else {
        console.warn('[SERVER] MarinaDiscoveryService registered but MARINA_DB_PATH not set, discovery trigger disabled');
      }
    }

    if (healthTelemetryLogsEnabled) {
      const healthTelemetryIntervalRaw = process.env.HEALTH_TELEMETRY_INTERVAL_MS;
      const healthTelemetryIntervalMs = Number.parseInt(healthTelemetryIntervalRaw, 10);

      if (Number.isFinite(healthTelemetryIntervalMs) && healthTelemetryIntervalMs > 0) {
        setInterval(() => {
          const signalKLastMessage = stateServiceForHealth?.connections?.signalK?.lastMessage;
          const signalKMessageAgeMs = Number.isFinite(signalKLastMessage)
            ? Date.now() - signalKLastMessage
            : null;

          const btScanning = bluetoothService?.scanning === true;
          const btLastScanStartedAt = bluetoothService?.lastScanStartedAt;
          const btScanAgeMs = btScanning && Number.isFinite(btLastScanStartedAt)
            ? Date.now() - btLastScanStartedAt
            : null;

          console.log("[HEALTH] stream status", {
            signalKConnected: stateServiceForHealth?.connections?.signalK?.connected === true,
            signalKMessageAgeMs,
            bluetoothScanning: btScanning,
            bluetoothScanAgeMs: btScanAgeMs,
            bluetoothScanCycleActive: bluetoothService?.scanCycleActive === true,
          });
        }, healthTelemetryIntervalMs);
      } else {
        console.warn("[HEALTH] HEALTH_TELEMETRY_LOGS=true but HEALTH_TELEMETRY_INTERVAL_MS is invalid; telemetry logs disabled");
      }
    }

    // 3. Build relay config
    const relayConfig = {
      port: parseInt(
        process.env.RELAY_PORT ||
          process.env.RELAY_SERVER_PORT ||
          process.env.INTERNAL_PORT ||
          "8080",
        10
      ),
      signalKRefreshRate: parseInt(
        process.env.SIGNALK_REFRESH_RATE || "1000",
        10
      ),
      defaultThrottleRate: parseInt(
        process.env.DEFAULT_THROTTLE_RATE || "5000",
        10
      ),
      vpsUrl: buildVpsUrl(),
      // Add any other needed config here
    };
    if (!relayConfig.port || isNaN(relayConfig.port))
      throw new Error("RelayServer: port must be set via env");
    // tokenSecret is now optional with key-based authentication
    if (!relayConfig.vpsUrl)
      throw new Error("RelayServer: vpsUrl must be set via env");

    // 4. Start relay server
    startupLog("[SERVER] Starting relay server with config:", relayConfig);
    relayServerInstance = await startRelayServer(stateManager, relayConfig);
    startupLog("[SERVER] Relay server started");

    // 5. Create and configure Express app for API endpoints
    startupLog("[SERVER] Creating Express app and configuring middleware...");
    const app = express();
    app.use(express.json());

    const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);

    app.use(
      cors({
        origin(origin, callback) {
          if (!origin) {
            return callback(null, true);
          }

          try {
            const parsedOrigin = new URL(origin);
            if (
              parsedOrigin.hostname.endsWith("compendium.local") ||
              allowedOrigins.includes(origin) ||
              (parsedOrigin.protocol === "capacitor:" &&
                (parsedOrigin.hostname === "localhost" || parsedOrigin.hostname === "compendiumnav.com"))
            ) {
              return callback(null, true);
            }
          } catch (error) {}

          callback(new Error(`Origin not allowed: ${origin}`));
        },
        credentials: true,
      })
    );

    // Register API routes
    registerBoatInfoRoutes(app);
    registerVpsRoutes(app, { vpsUrl: relayConfig.vpsUrl });
    registerRouteImportRoutes(app);

    // Register Victron routes (victronModbusService will be set after initialization)
    if (global.victronModbusService) {
      registerVictronRoutes(app, global.victronModbusService);
    }

    // Register fuel pipeline routes (requires MARINA_DB_PATH)
    if (process.env.MARINA_DB_PATH) {
      registerFuelPipelineRoutes(app, { dbPath: process.env.MARINA_DB_PATH });
    }

    // Simple health check endpoint
    app.get("/health", (req, res) => {
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version,
      });
    });

    // Add request logging in development
    if (process.env.NODE_ENV !== "production") {
      app.use((req, res, next) => {
        log(`${req.method} ${req.path}`);
        next();
      });
    }

    // 6. Start HTTP server
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000; // Default to 3000 for HTTP
    const httpServer = http.createServer(app);
    httpServerInstance = httpServer;

    // 6b. Start HTTPS server (dual-stack) if certs exist
    const HTTPS_PORT = process.env.HTTPS_PORT ? parseInt(process.env.HTTPS_PORT, 10) : 3443;
    const sslCredentials = getHttpsCredentials();
    if (sslCredentials) {
      const httpsServer = https.createServer(sslCredentials, app);
      httpsServerInstance = httpsServer;
      httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
        console.log(`[SERVER] HTTPS server listening on port ${HTTPS_PORT}`);
      });
    } else {
      console.log(`[SERVER] HTTPS not started — no certs found at certs/key.pem + certs/cert.pem`);
      console.log(`[SERVER] To enable HTTPS, generate self-signed certs: openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes`);
    }

    // Auto-register with VPS on startup if configured
    if (process.env.VPS_AUTO_REGISTER === "true") {
      log("Auto-registration with VPS is enabled");
      // Small delay to ensure the server is fully up
      setTimeout(async () => {
        try {
          const boatInfo = getBoatInfo();
          log(
            `Attempting auto-registration with VPS for boat ${boatInfo.boatId}`
          );

          // Auto-register with VPS
          const response = await fetch(
            `http://localhost:${PORT}/api/vps/register`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            }
          );

          if (response.ok) {
            const result = await response.json();
            log("Auto-registration with VPS successful:", result);
          } else {
            const error = await response.json().catch(() => ({}));
            log("Auto-registration with VPS failed:", error);
          }
        } catch (error) {
          log("Auto-registration with VPS failed:", error);
        }
      }, 5000); // 5 second delay
    }

    startupLog(`[SERVER] About to call httpServer.listen on PORT=${PORT}...`);
    httpServer.listen(PORT, "0.0.0.0", () => {
      const host = `http://localhost:${PORT}`;
      console.log(`[SERVER] HTTP server listening on port ${PORT}`);
      console.log(`[SERVER] API endpoints (HTTP):`);
      console.log(`  - ${host}/api/boat-info - Get boat information`);
      console.log(`  - ${host}/api/vps/health - VPS connection health`);
      console.log(`  - ${host}/api/vps/register - Register with VPS`);
      console.log(`  - ${host}/api/routes/import - Import GPX route`);
      console.log(`  - ${host}/health - Server health check`);
      if (sslCredentials) {
        const httpsHost = `https://localhost:${HTTPS_PORT}`;
        console.log(`[SERVER] API endpoints (HTTPS):`);
        console.log(`  - ${httpsHost}/api/boat-info - Get boat information`);
        console.log(`  - ${httpsHost}/api/routes/import - Import GPX route`);
        console.log(`  - ${httpsHost}/health - Server health check`);
      }
    });

    // 7. Relay state updates to VPS (optional, placeholder for future logic)
    const stateService = requireService("state");
    stateService.on("state-updated", (data) => {
      // VPS relay logic can be added here if needed in the future
    });

    // 8. Start Direct WebSocket server (optional)
    if (process.env.DIRECT_WS_PORT) {
      const directServer = await startDirectServerWrapper(stateManager, {
        port: parseInt(process.env.DIRECT_WS_PORT, 10),
      });
      directServerInstance = directServer;
      console.log(
        `[SERVER] Direct WebSocket server started on port ${process.env.DIRECT_WS_PORT}`
      );
    }

    // Bluetooth state logger removed - state is available via WebSocket updates
  } catch (err) {
    console.error("[SERVER] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
