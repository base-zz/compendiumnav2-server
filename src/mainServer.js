import dotenv from "dotenv";
import http from "http";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { readFileSync } from "fs";
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
import debug from "debug";
import {
  bootstrapServices,
  startRegisteredServices,
} from "./services/bootstrap.js";
import { serviceManager } from "./services/ServiceManager.js";
import { requireService } from "./services/serviceLocator.js";
import { NewStateService } from "./services/NewStateService.js";
import { PositionService } from "./services/PositionService.js";
import { TidalService } from "./services/TidalService.js";
import { WeatherService } from "./services/WeatherService.js";
import { BluetoothService } from "./services/BluetoothService.js";
import { VictronModbusService } from "./services/VictronModbusService.js";
import DemoRecorderService from "./services/DemoRecorderService.js";
import RecordedDemoService from "./services/RecordedDemoService.js";

console.log("[SERVER] TOP: mainServer.js imports completed, entering top-level code...");
const log = debug("server:main");

console.log("[SERVER] TOP: before getStateManager()");
const stateManager = getStateManager();
console.log("[SERVER] TOP: after getStateManager(), before setStateManagerInstance()");
setStateManagerInstance(stateManager);
console.log("[SERVER] TOP: after setStateManagerInstance(), before dotenv.config");

console.log("Loading .env");
dotenv.config({ path: ".env" });
console.log("[SERVER] TOP: after dotenv.config, before CLI flag parsing");

// Periodic memory usage logging to diagnose heap growth
setInterval(() => {
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
console.log("[SERVER] Parsing CLI flags...");
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

// --- Bridge canonical state into relay state manager ---
async function bridgeStateToRelay() {
  if (!stateManager) {
    console.error("[SERVER] State manager not initialized");
    return;
  }
  log("Starting state bridge to relay");
  try {
    const { stateData } = await import("./state/StateData.js");
    const { getStateManager: resolveStateManager } = await import(
      "./relay/core/state/StateManager.js"
    );
    const relayStateManager = resolveStateManager();
    const stateService = requireService("state");

    stateService.on("state:full-update", (msg) => {
      relayStateManager.receiveExternalStateUpdate(msg.data);
    });

    stateService.on("state:patch", (msg) => {
      relayStateManager.applyPatchAndForward(msg.data);
    });
    log("StateService patch listener registered");
    log("State bridge activated");
  } catch (err) {
    console.error("[SERVER] !!!!!! Failed to set up state bridge:", err);
    throw err;
  }
}

function buildServiceManifest() {
  console.log("[SERVER] buildServiceManifest() called");
  const positionSources = {
    gps: { priority: 1, timeout: 10000 },
    ais: { priority: 2, timeout: 15000 },
    state: { priority: 3, timeout: 20000 },
  };

  const manifest = [];
  console.log("[SERVER] buildServiceManifest(): initializing manifest array");

  console.log("[SERVER] buildServiceManifest(): adding state service (NewStateService / RecordedDemoService)");
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
    console.log("[SERVER] buildServiceManifest(): demoFlag is false, adding bluetooth and victron-modbus services");
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
    console.log("[SERVER] buildServiceManifest(): recordFlag is true, adding demo-recorder service");
    manifest.push({
      name: "demo-recorder",
      create: () => new DemoRecorderService(),
    });
  }

  console.log("[SERVER] buildServiceManifest(): manifest complete with services:", manifest.map(m => m.name));
  return manifest;
}

async function startSecondaryServices() {
  console.log("[SERVER] startSecondaryServices() called");
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

  console.log("[SERVER] startSecondaryServices(): resolved services:", {
    hasPosition: !!positionService,
    hasTidal: !!tidalService,
    hasWeather: !!weatherService,
    hasBluetooth: !!bluetoothService,
    hasVictron: !!victronService,
  });

  // Listeners already set up before services started
  console.log("[SERVER] startSecondaryServices(): StateManager already listening to active services");

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
}

async function startServer() {
  try {
    console.log("[SERVER] startServer() called, beginning bootstrap...");
    const manifest = buildServiceManifest();
    console.log("[SERVER] Service manifest built with entries:", manifest.map(m => m.name));
    console.log("[SERVER] Calling bootstrapServices(manifest)...");
    const { failures } = await bootstrapServices(manifest);
    console.log("[SERVER] bootstrapServices() completed, failures count:", failures.length);
    if (failures.length > 0) {
      throw new Error(
        `Service bootstrap failures: ${failures
          .map((f) => `${f.name}:${f.reason}`)
          .join(", ")}`
      );
    }

    console.log("[SERVER] Starting registered services...");
    
    // Get service references before starting them so we can set up listeners
    const positionService = serviceManager.getService('position');
    const tidalService = serviceManager.getService('tidal');
    const weatherService = serviceManager.getService('weather');
    const bluetoothService = serviceManager.getService('bluetooth');
    const victronService = serviceManager.getService('victron-modbus');

    // CRITICAL: Set up StateManager listeners BEFORE starting services
    // Services emit initial data immediately on startup (weather:update, tide:update, etc.)
    // If listeners are attached after service start, the initial data will be missed
    console.log("[SERVER] Setting up StateManager listeners BEFORE starting services...");
    [positionService, tidalService, weatherService, bluetoothService, victronService]
      .filter(Boolean)
      .forEach((service) => {
        stateManager.listenToService(service);
      });
    console.log("[SERVER] StateManager now listening to active services");

    await startRegisteredServices();
    console.log("[SERVER] Registered services started, waiting for all ready...");
    await serviceManager.waitForAllReady();
    console.log("[SERVER] All services reported ready. Proceeding to bridge state and start secondary services.");

    await bridgeStateToRelay();
    console.log("[SERVER] bridgeStateToRelay() completed");
    await startSecondaryServices();
    console.log("[SERVER] startSecondaryServices() completed");

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
    console.log("[SERVER] Starting relay server with config:", relayConfig);
    await startRelayServer(stateManager, relayConfig);
    console.log("[SERVER] Relay server started");

    // 5. Create and configure Express app for API endpoints
    console.log("[SERVER] Creating Express app and configuring middleware...");
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

    // Register Victron routes (victronModbusService will be set after initialization)
    if (global.victronModbusService) {
      registerVictronRoutes(app, global.victronModbusService);
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

    console.log(`[SERVER] About to call httpServer.listen on PORT=${PORT}...`);
    httpServer.listen(PORT, "0.0.0.0", () => {
      const host = `http://localhost:${PORT}`;
      console.log(`[SERVER] HTTP server listening on port ${PORT}`);
      console.log(`[SERVER] API endpoints (HTTP):`);
      console.log(`  - ${host}/api/boat-info - Get boat information`);
      console.log(`  - ${host}/api/vps/health - VPS connection health`);
      console.log(`  - ${host}/api/vps/register - Register with VPS`);
      console.log(`  - ${host}/health - Server health check`);
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
      console.log(
        `[SERVER] Direct WebSocket server started on port ${process.env.DIRECT_WS_PORT}`
      );
      // Handle graceful shutdown for directServer if needed
      process.on("SIGINT", async () => {
        console.log("\n[SERVER] Shutting down gracefully...");
        if (directServer && directServer.shutdown) {
          directServer.shutdown();
        }
        if (httpServer) {
          httpServer.close(() => process.exit(0));
        } else {
          process.exit(0);
        }
      });
    }

    // Bluetooth state logger removed - state is available via WebSocket updates
  } catch (err) {
    console.error("[SERVER] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
