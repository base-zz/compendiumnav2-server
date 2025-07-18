// Import module alias configuration first
import "./module-alias.js";

import dotenv from "dotenv";
dotenv.config();
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import express from "express";
import { serviceManager } from "./services/ServiceManager.js";
import newStateServiceDemo from "./services/NewStateServiceDemo.js";
import { TidalService } from "./services/TidalService.js";
import { WeatherService } from "./services/WeatherService.js";
import { PositionService } from "./services/PositionService.js";
import {
  startRelayServer,
  startDirectServerWrapper,
} from "./relay/server/index.js";
import { registerBoatInfoRoutes, getBoatInfo } from "./server/api/boatInfo.js";
import { registerVpsRoutes } from "./server/vps/registration.js";
import debug from "debug";
import http from "http";
import fs from "fs";
import path from "path";
import { stateData } from "./state/StateData.js";
import { StateManager } from "./relay/core/state/StateManager.js";
import { BluetoothService } from "./services/BluetoothService.js";


// Create Express app
const app = express();
app.use(express.json());
const server = http.createServer(app);

const log = debug("dev-server2");
const logError = debug("dev-server2:error");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

log("Loading .env file from:", resolve(__dirname, "../.env"));
dotenv.config({ path: resolve(__dirname, "../.env") });

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
    if (!process.env.VPS_PATH) {
      throw new Error("VPS_PATH must be set in environment variables");
    }
    const path = process.env.VPS_PATH;
    return `${proto}://${host}${port}${path}`;
  }
  throw new Error("VPS_HOST must be set in environment variables");
}

// --- Initialize and register services ---
async function initializeServices() {
  log("Initializing services...");

  try {
    // Initialize Bluetooth service
    log("Initializing NewStateServiceDemo...");

    // Initialize the demo service, which loads data from the DB
    const stateService = newStateServiceDemo;
    await stateService.start();
    await stateService.loadInitialData();

    // Register the state service with the service manager
    serviceManager.registerService("state", stateService);

    // Start mock data generation for other systems
    log("Starting mock data generation...");
    stateService.startMockMultipleTanksAndBatteries(5000); // Update every 5 seconds

    log("NewStateServiceDemo initialized.");
    return true;
  } catch (error) {
    logError(
      "Failed to initialize NewStateServiceDemo:",
      error
    );
    throw error;
  }
}

// --- Bridge state and initialize dependent services ---
async function bridgeStateToRelay() {
  log(
    "Starting state bridge and initializing dependent services"
  );
  const { StateManager } = await import(
    "./relay/core/state/StateManager.js"
  );
  try {
    // Get the state service instance that was already created
    const stateService = serviceManager.getService("state");
    if (!stateService) {
      throw new Error("State service not found in service manager");
    }

    // Initialize StateManager2 with initial state
    const stateManager = new StateManager(stateData);
    stateManager.initialState = stateService.getState();

    // --- Wire up state events from all services to the manager ---
    log("Wiring services to StateManager2");

    // Service event listeners are now attached via stateManager.listenToService()
    // in the initializeSecondaryServices function for better modularity.

    stateService.on("state:full-update", ({ data }) => {
      try {
        log(
          "'state:full-update' event received. Forwarding to StateManager2."
        );
        stateManager.receiveExternalStateUpdate(data);
      } catch (err) {
        logError(
          "Error applying full update in relay:",
          err
        );
      }
    });

    // --- Initialize secondary services ---
    initializeSecondaryServices(stateManager, serviceManager);
    stateService.startPlayback();
    log("State bridge to relay activated and all services running.");

    return stateManager;
  } catch (err) {
    logError("Failed to set up state bridge:", err);
    throw err;
  }
}

// --- Bridge state and initialize dependent services ---
async function initializeSecondaryServices(stateManager, serviceManager) {
  log("Starting secondary services...");

  const stateService = serviceManager.getService("state");
  const tidalService = new TidalService(stateService);
  const weatherService = new WeatherService();

  // --- Initialize Position Service ---
  const positionSources = {
    gps: { priority: 1, timeout: 10000 },
    ais: { priority: 2, timeout: 15000 },
    state: { priority: 3, timeout: 20000 }
  };
  const positionService = new PositionService({ sources: positionSources });
  const bluetoothService = new BluetoothService({
    scanDuration: 10000,
    scanInterval: 30000,
    debug: true,
    logLevel: "debug",
    stateManager: stateManager,
  });

  serviceManager.registerService("tidal", tidalService);
  serviceManager.registerService("weather", weatherService);
  serviceManager.registerService("position", positionService);
  // SignalK position provider removed in favor of direct PositionService integration
  serviceManager.registerService("bluetooth", bluetoothService);

  // --- Wire up services to the State Manager ---
  // StateManager will now listen for 'state:patch' events from these services.
  log("Wiring services to StateManager2...");
  stateManager.listenToService(stateService);
  stateManager.listenToService(positionService);
  stateManager.listenToService(tidalService);
  stateManager.listenToService(weatherService);
  log("Service wiring complete.");

  // --- Start all services ---
  log("Starting all registered services...");
  await serviceManager.startAll();

}



async function startDevServer() {
  try {
    // 1. Initialize all services
    log("Initializing services...");
    await initializeServices();

    // 2. Bridge state to relay and get stateManager
    const stateManager = await bridgeStateToRelay();
    if (!stateManager) {
      throw new Error(
        "bridgeStateToRelay did not return a stateManager instance."
      );
    }

    // 3. Build relay and direct server configs
    const requiredVars = [
      "DEV_RELAY_PORT",
      "DIRECT_WS_PORT",
      "DIRECT_WS_HOST",
      "DEV_SIGNALK_REFRESH_RATE",
      "DEV_DEFAULT_THROTTLE_RATE",
      "DEV_MAX_PAYLOAD_SIZE",
      "RECONNECT_DELAY",
      "MAX_RETRIES",
    ];

    const missingVars = requiredVars.filter((varName) => !process.env[varName]);
    if (missingVars.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingVars.join(", ")}`
      );
    }

    const relayPort = parseInt(process.env.DEV_RELAY_PORT, 10);
    const directPort = parseInt(process.env.DIRECT_WS_PORT, 10);

    if (isNaN(relayPort) || isNaN(directPort)) {
      throw new Error(
        "DEV_RELAY_PORT and DIRECT_WS_PORT must be valid numbers"
      );
    }

    log(
      `Starting WebSocket server on port ${directPort}`
    );

    // Ensure the relay port is different from the direct port
    const relayPortFinal =
      relayPort === directPort ? directPort + 1 : relayPort;

    const relayConfig = {
      port: relayPortFinal,
      signalKRefreshRate: parseInt(process.env.DEV_SIGNALK_REFRESH_RATE, 10),
      defaultThrottleRate: parseInt(process.env.DEV_DEFAULT_THROTTLE_RATE, 10),
      vpsUrl: buildVpsUrl(),
    };

    const directConfig = {
      port: directPort,
      host: process.env.DIRECT_WS_HOST,
      maxPayload: parseInt(process.env.DEV_MAX_PAYLOAD_SIZE, 10),
    };

    if (!relayConfig.port || isNaN(relayConfig.port)) {
      throw new Error("RelayServer: port must be set via env");
    }

    if (!relayConfig.vpsUrl) {
      throw new Error("RelayServer: vpsUrl must be set via env");
    }

    // 4. Start relay server
    log(
      `Starting relay server on port ${relayPortFinal}`
    );
    log(`VPS URL: ${relayConfig.vpsUrl}`);

    // Set connection parameters from environment
    relayConfig.reconnectInterval = parseInt(process.env.RECONNECT_DELAY, 10);
    relayConfig.maxRetries = parseInt(process.env.MAX_RETRIES, 10);

    const relayServer = await startRelayServer(stateManager, relayConfig);

    // Log when the relay server connects to the VPS
    if (relayServer && relayServer.vpsConnector) {
      relayServer.vpsConnector.on("connected", () => {
        log(
          `Successfully connected to VPS at ${relayConfig.vpsUrl}`
        );
      });

      relayServer.vpsConnector.on("disconnected", () => {
        log(`Disconnected from VPS`);
      });

      relayServer.vpsConnector.on("error", (error) => {
        logError(`VPS connection error:`, error.message);
      });
    }

    // 5. Start direct server
    log(`Starting direct server on port ${directPort}`);
    const directServer = await startDirectServerWrapper(directConfig);

    // 6. Create Express app and set up API routes
    const app = express();

    // Middleware
    app.use(express.json());
    app.use((req, res, next) => {
      log(
        `[HTTP] ${new Date().toISOString()} ${req.method} ${req.url}`
      );
      next();
    });

    // Enable CORS for all routes
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept"
      );
      next();
    });

    // Simple root endpoint
    app.get("/", (req, res) => {
      res.json({
        status: "running",
        timestamp: new Date().toISOString(),
        endpoints: ["/api/boat-info", "/api/vps/register", "/api/vps/health"],
      });
    });

    // Register API routes
    registerBoatInfoRoutes(app);
    registerVpsRoutes(app, { vpsUrl: process.env.VPS_URL });

    // Set up Bluetooth API routes if Bluetooth service is available
    try {
      const bluetoothService = serviceManager.getService("bluetooth");
      if (bluetoothService) {
        const router = express.Router();

        // Get list of discovered devices
        router.get("/bluetooth/devices", async (req, res) => {
          try {
            const devices = bluetoothService.getDevices();
            res.json(devices);
          } catch (error) {
            logError("Error getting devices:", error);
            res.status(500).json({ error: "Failed to get devices" });
          }
        });

        // Start/stop scanning
        router.post("/bluetooth/scan", async (req, res) => {
          try {
            const { action } = req.body;
            if (action === "start") {
              await bluetoothService.start();
              res.json({ status: "scanning" });
            } else if (action === "stop") {
              await bluetoothService.stop();
              res.json({ status: "stopped" });
            } else {
              res.status(400).json({ error: "Invalid action" });
            }
          } catch (error) {
            logError("Error controlling scan:", error);
            res.status(500).json({ error: "Failed to control scanning" });
          }
        });

        // Get scan status
        router.get("/bluetooth/status", (req, res) => {
          try {
            res.json({
              isRunning: bluetoothService.isRunning,
              isScanning: bluetoothService.scanning,
              lastScan: bluetoothService.lastScanTime,
            });
          } catch (error) {
            logError("Error getting status:", error);
            res.status(500).json({ error: "Failed to get status" });
          }
        });

        app.use("/api", router);
        log("Bluetooth API endpoints registered at /api/bluetooth/*");
      }
    } catch (error) {
      logError("Failed to set up Bluetooth API:", error);
    }

    // Build VPS URL from environment variables
    const vpsUrl = (() => {
      if (process.env.VPS_URL) return process.env.VPS_URL;
      if (process.env.RELAY_SERVER_URL) return process.env.RELAY_SERVER_URL;
      if (process.env.VPS_HOST) {
        const proto = process.env.VPS_WS_PORT === "443" ? "https" : "http";
        const host = process.env.VPS_HOST;
        const port =
          process.env.VPS_WS_PORT &&
            process.env.VPS_WS_PORT !== "80" &&
            process.env.VPS_WS_PORT !== "443"
            ? `:${process.env.VPS_WS_PORT}`
            : "";
        const path = process.env.VPS_PATH || "/api/register";
        return `${proto}://${host}${port}${path}`;
      }
      return undefined;
    })();

    if (vpsUrl) {
      log(`Using VPS URL: ${vpsUrl}`);
      registerVpsRoutes(app, { vpsUrl });
    } else {
      log("No VPS URL configured. VPS registration will be disabled.");
    }

    // 7. Start HTTP server with Express
    const PORT = parseInt(process.env.PORT || "3000", 10);
    if (isNaN(PORT)) {
      throw new Error("PORT must be a valid number");
    }

    log(`[DEBUG] Configured HTTP server port: ${PORT}`);

    // Create HTTP server
    const httpServer = http.createServer(app);

    // Add error handler for the HTTP server
    httpServer.on("error", (error) => {
      // Check if this is a Node.js error with a code property
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "EADDRINUSE") {
          log(
            `[ERROR] Port ${PORT} is already in use. Please check for other running instances.`
          );
          process.exit(1);
        }
      }

      // For all other errors, just log the message
      const errorMessage =
        error && typeof error === "object" && "message" in error
          ? error.message
          : String(error);
      log(`[ERROR] HTTP server error: ${errorMessage}`);
      process.exit(1);
    });

    // Start the server
    httpServer.listen(PORT, "0.0.0.0", () => {
      log(`[HTTP] Server started on port ${PORT}`);
      log(`[HTTP] Access the API at http://localhost:${PORT}/`);
      log("\nAvailable endpoints:");
      log(`  GET  http://localhost:${PORT}/api/boat-info`);
      log(`  POST http://localhost:${PORT}/api/vps/register`);
      log(`  GET  http://localhost:${PORT}/api/vps/health`);
    });

    log("Development server started with HTTP");

    // Return all server instances for graceful shutdown
    return { relayServer, directServer, httpServer };
  } catch (error) {
    logError("Fatal error during startup:", error);
    process.exit(1);
  }
}

// Graceful shutdown handler
async function shutdown(signal) {
  log(`\n${signal} received. Shutting down gracefully...`);

  try {
    // Clean up Bluetooth service if it was initialized
    const bluetoothService = serviceManager.getService("bluetooth");
    if (bluetoothService) {
      await bluetoothService.stop();
    }
    // Stop all background services
    await serviceManager.stopAll();
    log("All services stopped.");

    // Close the HTTP server
    if (servers.httpServer) {
      await new Promise((resolve) => servers.httpServer.close(resolve));
      log("HTTP server closed.");
    }

    // Close the Direct server
    if (
      servers.directServer &&
      typeof servers.directServer.shutdown === "function"
    ) {
      await servers.directServer.shutdown();
      log("Direct server closed.");
    } else if (
      servers.directServer &&
      typeof servers.directServer.close === "function"
    ) {
      // Fallback for older directServer instances that might still return wss directly
      await servers.directServer.close();
      log("Direct server (old style) closed.");
    } else {
      log(
        "[WARN] Direct server object found, but no recognized close or shutdown method."
      );
    }

    // Close the Relay server
    if (servers.relayServer) {
      log("Closing relay server...");
      if (typeof servers.relayServer.shutdown === "function") {
        servers.relayServer.shutdown();
        log("Relay server shutdown initiated.");
      } else if (typeof servers.relayServer.close === "function") {
        servers.relayServer.close(() => {
          log("Relay server closed.");
        });
      } else {
        log(
          "Relay server has no close or shutdown method."
        );
      }
    }

    log("Shutdown complete.");
    process.exit(0);
  } catch (error) {
    logError("Error during graceful shutdown:", error);
    process.exit(1);
  }
}

let servers = {};

async function main() {
  try {
    servers = await startDevServer();
    log("All components started successfully.");
  } catch (error) {
    logError("Failed to start development server:", error);
    process.exit(1);
  }
}

// Register signal handlers
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the application
main();

// Enable debug output for our services
debug.enable("*");
