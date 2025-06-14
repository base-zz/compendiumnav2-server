// Import module alias configuration first
import "./module-alias.js";

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import express from "express";
import { serviceManager } from "./services/ServiceManager.js";
import newStateServiceDemo from "./services/NewStateServiceDemo.js";
import { TidalService } from "./services/TidalService.js";
import { WeatherService } from "./services/WeatherService.js";
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

const log = debug("compendium:dev-server2");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log("Loading .env file from:", resolve(__dirname, "../.env"));
dotenv.config({ path: resolve(__dirname, "../.env") });

// Using key-based authentication
console.log("Authentication: key-based");

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
  try {
    console.log("[DEV-SERVER2] Initializing NewStateServiceDemo...");

    // Initialize the demo service
    const stateService = newStateServiceDemo;
    await stateService.start();

    // Register the state service with the service manager
    serviceManager.registerService("state", stateService);

    // Start mock data generation
    console.log("[DEV-SERVER2] Starting mock data generation...");
    stateService.startMockMultipleTanksAndBatteries(5000); // Update every 5 seconds

    // Initialize and register other services with the state service
    console.log(
      "[DEV-SERVER2] Initializing TidalService and WeatherService..."
    );
    const tidalService = new TidalService(stateService);
    const weatherService = new WeatherService(stateService);

    serviceManager.registerService("tidal", tidalService);
    serviceManager.registerService("weather", weatherService);

    // Start all services
    console.log("[DEV-SERVER2] Starting all services...");
    await serviceManager.startAll();

    console.log("[DEV-SERVER2] All services initialized and started");
    return true;
  } catch (error) {
    console.error("[DEV-SERVER2] Failed to initialize services:", error);
    throw error;
  }
}

// --- Bridge canonical state into relay state manager ---
async function bridgeStateToRelay() {
  console.log("[DEV-SERVER2] Starting state bridge to relay");
  try {
    const { stateManager } = await import("./relay/core/state/StateManager.js");

    // Get the state service instance that was already created and started
    const stateService = serviceManager.getService("state");
    if (!stateService) {
      throw new Error("State service not found in service manager");
    }


    // Get the current state and send initial update
    const currentState = stateService.getState();

    // Update the state data and relay
    stateData.batchUpdate(currentState);
    stateManager.receiveExternalStateUpdate(currentState);
    stateManager.emitFullState();

    // Set up event listener for state updates
    stateService.on("state:updated", ({ data }) => {
      try {
        stateManager.receiveExternalStateUpdate(data);
      } catch (err) {
        console.error("[DEV-SERVER2] Error updating state in relay:", err);
      }
    });

    // Add listeners for tide and weather updates
    const tidalService = serviceManager.getService("tidal");
    const weatherService = serviceManager.getService("weather");

    if (tidalService) {
      console.log('[DEV-SERVER2] Setting up tide:update listener on tidalService');
      
      // Remove any existing listeners to prevent duplicates
      tidalService.removeAllListeners("tide:update");
      
      // Set up the new listener
      const onTideUpdate = (data) => {
        console.log(
          "[DEV-SERVER2] Received tide:update, forwarding to state manager"
        );
        stateManager.setTideData(data);
      };
      
      tidalService.on("tide:update", onTideUpdate);
      
      // Log the listener count for debugging
      const listenerCount = tidalService.listenerCount("tide:update");
      console.log(`[DEV-SERVER2] TidalService now has ${listenerCount} tide:update listeners`);
      
      // Manually trigger an update to test
      tidalService.run().catch(err => {
        console.error('[DEV-SERVER2] Error triggering manual tide update:', err);
      });
    } else {
      console.error('[DEV-SERVER2] Tidal service not found!');
      console.log('[DEV-SERVER2] Available services:', serviceManager.listServices());
    }

    if (weatherService) {
      console.log('[DEV-SERVER2] Setting up weather:update listener on weatherService');
      
      // Remove any existing listeners to prevent duplicates
      weatherService.removeAllListeners("weather:update");
      
      // Set up the new listener
      const onWeatherUpdate = (data) => {
        console.log(
          "[DEV-SERVER2] Received weather:update, forwarding to state manager"
        );
        stateManager.setWeatherData(data);
      };
      
      weatherService.on("weather:update", onWeatherUpdate);
      
      // Log the listener count for debugging
      const listenerCount = weatherService.listenerCount("weather:update");
      console.log(`[DEV-SERVER2] WeatherService now has ${listenerCount} weather:update listeners`);
      
      // Manually trigger an update to test
      weatherService.run().catch(err => {
        console.error('[DEV-SERVER2] Error triggering manual weather update:', err);
      });
    } else {
      console.error('[DEV-SERVER2] Weather service not found!');
      console.log('[DEV-SERVER2] Available services:', serviceManager.listServices());
    }

    console.log("[DEV-SERVER2] State bridge to relay activated");
  } catch (err) {
    console.error("[DEV-SERVER2] Failed to set up state bridge:", err);
    throw err; // Re-throw to be caught by the caller
  }
}

async function startDevServer() {
  try {
    // 1. Initialize all services
    console.log("[DEV-SERVER2] Initializing services...");
    await initializeServices();

    // 2. Bridge state to relay
    await bridgeStateToRelay();

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

    console.log(
      `[DEV-SERVER2] Starting WebSocket server on port ${directPort}`
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
    console.log(
      `[DEV-SERVER2] Starting relay server on port ${relayPortFinal}`
    );
    console.log(`[DEV-SERVER2] VPS URL: ${relayConfig.vpsUrl}`);

    // Set connection parameters from environment
    relayConfig.reconnectInterval = parseInt(process.env.RECONNECT_DELAY, 10);
    relayConfig.maxRetries = parseInt(process.env.MAX_RETRIES, 10);

    const relayServer = await startRelayServer(relayConfig);

    // Log when the relay server connects to the VPS
    if (relayServer && relayServer.vpsConnector) {
      relayServer.vpsConnector.on("connected", () => {
        console.log(
          `[DEV-SERVER2] Successfully connected to VPS at ${relayConfig.vpsUrl}`
        );
      });

      relayServer.vpsConnector.on("disconnected", () => {
        console.log(`[DEV-SERVER2] Disconnected from VPS`);
      });

      relayServer.vpsConnector.on("error", (error) => {
        console.error(`[DEV-SERVER2] VPS connection error:`, error.message);
      });
    }

    // 5. Start direct server
    console.log(`[DEV-SERVER2] Starting direct server on port ${directPort}`);
    await startDirectServerWrapper(directConfig);

    // 6. Create Express app and set up API routes
    const app = express();

    // Middleware
    app.use(express.json());
    app.use((req, res, next) => {
      console.log(
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
    const server = http.createServer(app);

    // Add error handler for the HTTP server
    server.on("error", (error) => {
      // Check if this is a Node.js error with a code property
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === "EADDRINUSE") {
          log(
            `[ERROR] Port ${PORT} is already in use. Please check for other running instances.`
          );
          process.exit(1);
        }
      }
      
      // For all other errors, just log the message
      const errorMessage = error && typeof error === 'object' && 'message' in error 
        ? error.message 
        : String(error);
      log(`[ERROR] HTTP server error: ${errorMessage}`);
      process.exit(1);
    });

    // Start the server
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[HTTP] Server started on port ${PORT}`);
      console.log(`[HTTP] Access the API at http://localhost:${PORT}/`);
      console.log("\nAvailable endpoints:");
      console.log(`  GET  http://localhost:${PORT}/api/boat-info`);
      console.log(`  POST http://localhost:${PORT}/api/vps/register`);
      console.log(`  GET  http://localhost:${PORT}/api/vps/health\n`);
      console.log("[DEV-SERVER2] Development server started with HTTP");
    });

    // Graceful shutdown handler
    const shutdown = async () => {
      console.log("\n[DEV-SERVER2] Shutting down gracefully...");

      try {
        // Stop all services
        await serviceManager.stopAll();

        // Close the HTTP server
        server.close(() => {
          console.log("[DEV-SERVER2] HTTP server closed");
          process.exit(0);
        });

        // Force close after timeout
        setTimeout(() => {
          console.error(
            "[DEV-SERVER2] Could not close connections in time, forcefully shutting down"
          );
          process.exit(1);
        }, 10000);
      } catch (error) {
        console.error("[DEV-SERVER2] Error during shutdown:", error);
        process.exit(1);
      }
    };

    // Handle shutdown signals
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    console.error("[DEV-SERVER2] Failed to start development server:", error);
    process.exit(1);
  }
}

// Enable debug output for our services
debug.enable("cn2:*");

// Start the dev server
startDevServer().catch(console.error);
