// Import module alias configuration first
import "./module-alias.js";

import dotenv from "dotenv";
dotenv.config();
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import express from "express";
import { serviceManager } from "./services/ServiceManager.js";
import { NewStateServiceDemo } from "./services/NewStateServiceDemo.js";
import { TidalService } from "./services/TidalService.js";
import { WeatherService } from "./services/WeatherService.js";
import { PositionService } from "./services/PositionService.js";
import { SignalKPositionProvider } from "./services/SignalKPositionProvider.js";
import { registerBoatInfoRoutes, getBoatInfo } from "./server/api/boatInfo.js";
import { registerVpsRoutes } from "./server/vps/registration.js";
import debug from "debug";
import http from "http";
import fs from "fs";
import path from "path";
import { stateData } from "./state/StateData.js";
import { StateManager } from "./relay/core/state/StateManager.js";
import { BluetoothService } from "./services/BluetoothService.js";

// --- NEW IMPORTS FOR REFACTORED ARCHITECTURE ---
import { DirectServer } from "./relay/server/DirectServer2.js";
import { RelayServer } from "./relay/server/RelayServer2.js";
import { StateMediator } from "./relay/core/StateMediator.js";

// Create Express app
const app = express();
app.use(express.json());
const server = http.createServer(app);

const log = debug("cn2:dev-server3");
const logError = debug("cn2:error:dev-server3");

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
  try {
    log("Initializing services...");
    const newStateService = new NewStateServiceDemo();
    
    // Register services with the service manager first
    log("Registering services with service manager...");
    serviceManager.registerService("state", newStateService);
    
    // Start the state service and wait for it to be ready
    log("Starting state service...");
    await newStateService.start();
    
    // Explicitly load initial data
    log("Ensuring state service has loaded initial data...");
    await newStateService.loadInitialData();
    log("Initial state data loaded successfully");
    
    // Wait for state service to be fully ready
    log("Waiting for state service to be fully ready...");
    await new Promise((resolve) => {
      if (newStateService.isReady) {
        log("State service is already ready");
        resolve();
      } else {
        log("Waiting for state service ready event...");
        newStateService.once("ready", () => {
          log("Received state service ready event");
          resolve();
        });
      }
    });
    log("State service is ready, initializing other services...");

    // Initialize other services with the ready state service
    const bluetoothService = new BluetoothService();
    const positionService = new PositionService(newStateService);
    const tidalService = new TidalService(newStateService);
    const weatherService = new WeatherService(newStateService);

    serviceManager.registerService("bluetooth", bluetoothService);
    serviceManager.registerService("position", positionService);
    serviceManager.registerService("tide", tidalService);
    serviceManager.registerService("weather", weatherService);
    // State service already registered above
    

    // --- Register Transport Servers as Services ---
    const directConfig = {
      port: process.env.DIRECT_PORT || 3001,
      host: process.env.DIRECT_HOST || "localhost",
    };
    const directServer = new DirectServer(directConfig);
    serviceManager.registerService("direct", directServer);

    const relayConfig = {
      vpsUrl: buildVpsUrl(),
      vpsReconnectInterval: process.env.RECONNECT_DELAY || 5000,
      vpsMaxRetries: process.env.MAX_RETRIES || 10,
    };
    const relayServer = new RelayServer(relayConfig);
    serviceManager.registerService("relay", relayServer);

    await serviceManager.startAll();
    log("All services started.");
  } catch (error) {
    logError("Error initializing services:", error);
    throw error;
  }
}

async function startDevServer() {
  try {
    log("Starting development server...");

    // --- 1. Initialize all services ---
    await initializeServices();

    // --- 2. Initialize State Manager and Mediator ---
    const stateService = serviceManager.getService("state");
    const initialState = stateService.getState();
    const stateManager = new StateManager(initialState);
    const stateMediator = new StateMediator({ stateManager });

    // --- 4. Register transports with the mediator ---
    const directServerInstance = serviceManager.getService("direct");
    const relayServerInstance = serviceManager.getService("relay");
    stateMediator.registerTransport(directServerInstance);
    stateMediator.registerTransport(relayServerInstance);
    log("All transports registered with StateMediator.");

    // --- 6. Setup Express API routes ---
    const boatInfo = await getBoatInfo();
    registerBoatInfoRoutes(app, boatInfo);
    const relayServer = serviceManager.getService("relay");
    registerVpsRoutes(app, { vpsUrl: relayServer.config.vpsUrl });

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
