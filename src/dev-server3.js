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
    log("Creating service instances...");
    const bluetoothService = new BluetoothService();
    log("BluetoothService created");
    
    // Initialize PositionService with source configurations
    const positionSources = {
      gps: { priority: 1, timeout: 10000 },
      ais: { priority: 2, timeout: 15000 },
      state: { priority: 3, timeout: 20000 }
    };
    const positionService = new PositionService({ sources: positionSources });
    const tidalService = new TidalService(newStateService, positionService);
    const weatherService = new WeatherService(newStateService, positionService);

    log("Registering services with serviceManager...");
    serviceManager.registerService("bluetooth", bluetoothService);
    log("Registered bluetooth service");
    
    serviceManager.registerService("position-service", positionService);
    log("Registered position service");
    
    serviceManager.registerService("tidal-service", tidalService);
    log("Registered tide service");
    
    serviceManager.registerService("weather-service", weatherService);
    log("Registered weather service");
    // State service already registered above
    

    // --- Register Transport Servers as Services ---
    const directConfig = {
      port: process.env.DIRECT_WS_PORT || 3001,
      host: process.env.DIRECT_WS_HOST || "localhost",
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

    log("Starting all services via serviceManager.startAll()...");
    await serviceManager.startAll();
    log("All services started successfully.");
    
    // Log the status of key services
    log("Service status check:");
    log("- TidalService running:", tidalService.isRunning);
    log("- WeatherService running:", weatherService.isRunning);
    log("- PositionService running:", positionService.isRunning);
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
    const tidalService = serviceManager.getService("tidal-service");
    const weatherService = serviceManager.getService("weather-service");
    const positionService = serviceManager.getService("position-service");
    
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
    const directServerInstance = serviceManager.getService("direct");
    const relayServerInstance = serviceManager.getService("relay");
    stateMediator.registerTransport(directServerInstance);
    stateMediator.registerTransport(relayServerInstance);
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
