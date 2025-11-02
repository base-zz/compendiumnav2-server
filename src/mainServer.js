import dotenv from "dotenv";
import http from "http";
import express from "express";
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

const log = debug("server:main");

const stateManager = getStateManager();
setStateManagerInstance(stateManager);

console.log("Loading .env");
dotenv.config({ path: ".env" });

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
  const positionSources = {
    gps: { priority: 1, timeout: 10000 },
    ais: { priority: 2, timeout: 15000 },
    state: { priority: 3, timeout: 20000 },
  };

  return [
    {
      name: "state",
      create: () => new NewStateService(),
    },
    {
      name: "position",
      create: () => new PositionService({ sources: positionSources }),
    },
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
    },
    {
      name: "tidal",
      create: () => new TidalService(),
    },
    {
      name: "weather",
      create: () => new WeatherService(),
    },
  ];
}

async function startSecondaryServices() {
  const services = [
    "position",
    "tidal",
    "weather",
    "bluetooth",
    "victron-modbus",
  ];

  for (const name of services) {
    const service = serviceManager.getService(name);
    if (!service) {
      throw new Error(`Service '${name}' was not registered correctly`);
    }
  }

  const stateService = requireService("state");
  const positionService = requireService("position");
  const tidalService = requireService("tidal");
  const weatherService = requireService("weather");
  const bluetoothService = requireService("bluetooth");
  const victronService = requireService("victron-modbus");

  stateManager.listenToService(positionService);
  stateManager.listenToService(tidalService);
  stateManager.listenToService(weatherService);
  stateManager.listenToService(bluetoothService);
  stateManager.listenToService(victronService);

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

async function startServer() {
  try {
    const manifest = buildServiceManifest();
    const { failures } = await bootstrapServices(manifest);
    if (failures.length > 0) {
      throw new Error(
        `Service bootstrap failures: ${failures
          .map((f) => `${f.name}:${f.reason}`)
          .join(", ")}`
      );
    }

    await startRegisteredServices();
    await serviceManager.waitForAllReady();

    await bridgeStateToRelay();
    await startSecondaryServices();

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
    await startRelayServer(stateManager, relayConfig);

    // 5. Create and configure Express app for API endpoints
    const app = express();
    app.use(express.json());

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
