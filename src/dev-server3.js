// Import module alias configuration first
import "./module-alias.js";

import dotenv from "dotenv";
dotenv.config();
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import express from "express";
import { serviceManager } from "./services/ServiceManager.js";
import { requireService } from "./services/serviceLocator.js";
import { bootstrapServices, startRegisteredServices } from "./services/bootstrap.js";
import { NewStateServiceDemo } from "./services/NewStateServiceDemo.js";
import { TidalService } from "./services/TidalService.js";
import { WeatherService } from "./services/WeatherService.js";
import { PositionService } from "./services/PositionService.js";
import { registerBoatInfoRoutes, getBoatInfo } from "./server/api/boatInfo.js";
import { registerVpsRoutes } from "./server/vps/registration.js";
import debug from "debug";
import http from "http";
import fs from "fs";
import path from "path";
import { stateData } from "./state/StateData.js";
import { getStateManager, setStateManagerInstance } from "./relay/core/state/StateManager.js";
import { BluetoothService } from "./services/BluetoothService.js";

// --- NEW IMPORTS FOR REFACTORED ARCHITECTURE ---
import { startDirectServerWrapper, startRelayServer } from "./relay/server/index.js";
import { StateMediator } from "./relay/core/StateMediator.js";

// Create Express app
const app = express();
app.use(express.json());
const server = http.createServer(app);

const log = debug("dev-server3");
const logError = debug("error:dev-server3");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let servers = {};

// --- Helper to build the VPS URL ---
function buildVpsUrl() {
  const vpsHost = process.env.VPS_HOST || "localhost";
  const vpsPort = process.env.VPS_PORT || 8080;
  const vpsProtocol = process.env.VPS_PROTOCOL || "ws";
  return `${vpsProtocol}://${vpsHost}:${vpsPort}`;
}

// --- Initialize and register services ---
async function initializeServices() {
  const manifest = [
    {
      name: "state",
      create: () => new NewStateServiceDemo(),
    },
    {
      name: "position",
      dependencies: ["state"],
      create: ({ options }) => new PositionService(options),
      options: {
        sources: {
          gps: { priority: 1, timeout: 10000 },
          ais: { priority: 2, timeout: 15000 },
          state: { priority: 3, timeout: 20000 },
        },
      },
    },
    {
      name: "tidal",
      dependencies: ["state", "position"],
      create: () => new TidalService(),
    },
    {
      name: "weather",
      dependencies: ["state", "position"],
      create: () => new WeatherService(),
    },
    {
      name: "bluetooth",
      create: () =>
        new BluetoothService({
          scanDuration: 10000,
          scanInterval: 30000,
          debug: true,
          logLevel: "debug",
          stateManager: null,
        }),
    },
  ];

  const { failures } = await bootstrapServices(manifest);
  if (failures.length > 0) {
    throw new Error(
      `Service bootstrap failures: ${failures
        .map((failure) => `${failure.name}: ${failure.reason}`)
        .join(", ")}`
    );
  }

  await startRegisteredServices();

  const stateService = requireService("state");
  if (typeof stateService.startMockMultipleTanksAndBatteries === "function") {
    stateService.startMockMultipleTanksAndBatteries(5000);
  }

  const positionService = requireService("position");
  const tidalService = requireService("tidal");
  const weatherService = requireService("weather");
  const bluetoothService = serviceManager.getService("bluetooth");

  if (bluetoothService) {
    bluetoothService.stateManager = getStateManager();
  }

  log("Services initialized via ServiceManager.");
}

async function startDevServer() {
  try {
    log("Starting development server...");

    // --- 1. Initialize all services ---
    await initializeServices();

    // --- 2. Initialize State Manager and Mediator ---
    const stateService = requireService("state");
    const initialState = stateService.getState();
    const stateManager = getStateManager(initialState);
    setStateManagerInstance(stateManager);
    
    // Connect the StateManager to the state service
    log("Connecting StateManager to state service events");
    stateService.on('state:patch', (patch) => {
      log("Forwarding state:patch from stateService to stateManager");
      stateManager.emit('state:patch', patch);
    });
    
    stateService.on('state:full-update', (state) => {
      log("Forwarding state:full-update from stateService to stateManager");
      stateManager.emit('state:full-update', state);
    });
    
    // Connect the StateManager to listen for tide and weather updates
    log("Connecting StateManager to tidal and weather services");
    const tidalService = requireService("tidal");
    const weatherService = requireService("weather");
    const positionService = requireService("position");
    
    if (tidalService) {
      log("Connecting TidalService to StateManager");
      stateManager.listenToService(tidalService);
    } else {
      logError("TidalService not found in serviceManager");
    }
    
    if (weatherService) {
      log("Connecting WeatherService to StateManager");
      stateManager.listenToService(weatherService);
    } else {
      logError("WeatherService not found in serviceManager");
    }
    
    if (positionService) {
      log("Connecting PositionService to StateManager");
      stateManager.listenToService(positionService);
    } else {
      logError("PositionService not found in serviceManager");
    }    
    const stateMediator = new StateMediator({ stateManager });

    // --- 4. Register transports with the mediator ---
    const directServer = await startDirectServerWrapper(stateManager, {
      port: parseInt(process.env.DIRECT_WS_PORT || "3001", 10),
      host: process.env.DIRECT_WS_HOST || "localhost",
    });

    const relayServer = await startRelayServer(stateManager, {
      port: parseInt(process.env.RELAY_PORT || "8090", 10),
      vpsUrl: buildVpsUrl(),
      vpsReconnectInterval: parseInt(process.env.RECONNECT_DELAY || "5000", 10),
      vpsMaxRetries: parseInt(process.env.MAX_RETRIES || "10", 10),
    });

    stateMediator.registerTransport(directServer);
    stateMediator.registerTransport(relayServer);
    log("All transports registered with StateMediator.");
    
    // Set up a test interval to trigger state updates for debugging
    const testStateUpdateInterval = setInterval(() => {
      log("Triggering test state update from StateManager");
      // Emit state:patch event with the correct format
      stateManager.emit("state:patch", {
        type: "state:patch",
        data: [
          { op: "replace", path: "/test/serverTimestamp", value: Date.now() },
          { op: "replace", path: "/test/message", value: "Test update from dev-server3" }
        ],
        timestamp: Date.now()
      });
      log("Test state update triggered");
    }, 15000); // Every 15 seconds

    // --- 6. Setup Express API routes ---
    await getBoatInfo(); // Get boat info but don't pass it to registerBoatInfoRoutes
    registerBoatInfoRoutes(app); // Only pass the app parameter
    registerVpsRoutes(app, { vpsUrl: buildVpsUrl() });

    const httpPort = process.env.HTTP_PORT || 3000;
    server.listen(httpPort, () => {
      log(`HTTP server listening on http://localhost:${httpPort}`);
    });

    log("Development server started successfully.");
  } catch (error) {
    logError("Failed to start development server:", error);
    process.exit(1);
  }
}

// Graceful shutdown handler
async function shutdown(signal) {
  log(`Received ${signal}. Shutting down gracefully...`);
  try {
    log("Stopping HTTP server...");
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    log("Stopping all services...");
    await serviceManager.stopAll();
    log("All services and servers shut down. Exiting.");
    process.exit(0);
  } catch (error) {
    logError("Error during shutdown:", error);
    process.exit(1);
  }
}

async function main() {
  await startDevServer();
}

// Register signal handlers
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  logError("Unhandled error in main execution:", error);
  process.exit(1);
});
