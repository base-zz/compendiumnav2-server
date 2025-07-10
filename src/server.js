import dotenv from "dotenv";
import { serviceManager } from "./services/ServiceManager.js";
// import { stateService } from "./state/StateService.js";
import { startRelayServer, startDirectServer } from "./relay/server/index.js";
import { stateManager } from "./relay/core/state/StateManager.js";
import { registerBoatInfoRoutes, getBoatInfo } from "./server/api/boatInfo.js";
import { registerVpsRoutes } from "./server/vps/registration.js";
import { TidalService } from "./services/TidalService.js";
import { WeatherService } from "./services/WeatherService.js/index.js";
import { newStateService } from "./services/NewStateService.js";
import debug from 'debug';

const log = debug('server:main');

// Load environment variables
dotenv.config({ path: ".env" });

// --- Helper to build the VPS URL ---
function buildVpsUrl() {
  if (process.env.VPS_URL) return process.env.VPS_URL;
  if (process.env.RELAY_SERVER_URL) return process.env.RELAY_SERVER_URL;
  if (process.env.VPS_HOST) {
    const proto = process.env.VPS_WS_PORT === "443" ? "wss" : "ws";
    const host = process.env.VPS_HOST;
    const port = process.env.VPS_WS_PORT &&
                process.env.VPS_WS_PORT !== "80" &&
                process.env.VPS_WS_PORT !== "443"
                ? `:${process.env.VPS_WS_PORT}`
                : "";
    const path = process.env.VPS_PATH || "/relay";
    return `${proto}://${host}${port}${path}`;
  }
  return undefined;
}

// --- Initialize and register services ---
async function initializeServices() {
    try {
      // First register the state service
      serviceManager.registerService('state', newStateService);
      
      // Get the state service instance to pass to other services
      const stateService = serviceManager.getService('state');
      
      // Register other services with the state service
      serviceManager.registerService('tidal', new TidalService(stateService));
      serviceManager.registerService('weather', new WeatherService());
  
      // Start all services
      await serviceManager.startAll();
      
      // Bridge state to relay after services are started
      await bridgeStateToRelay();
      
      return true;
    } catch (error) {
      console.error('Failed to initialize services:', error);
      throw error;
    }
  }

// --- Bridge canonical state into relay state manager ---
async function bridgeStateToRelay() {
    if (!stateManager) {
      throw new Error("State manager not initialized");
    }
    
    log("Starting state bridge to relay");
    
    // Get the registered service instance
    const stateService = serviceManager.getService('state');
    
    // Pass initial state into StateManager2
    stateManager.initialState = stateService.getState();

    // Bridge NewStateService events to relay stateManager
    stateService.on("state:full-update", (msg) => {
      stateManager.receiveExternalStateUpdate(msg.data);
    });
  
    stateService.on("state:patch", (msg) => {
      stateManager.applyPatchAndForward(msg.data);
    });

    // Add listeners for tide and weather updates
    const tidalService = serviceManager.getService("tidal");
    const weatherService = serviceManager.getService("weather");

    if (tidalService) {
      tidalService.on("tide:update", (data) => {
        console.log("[DEV-SERVER2] Received tide update, forwarding to state manager");
        stateManager.setTideData(data);
      });
    }

    if (weatherService) {
      weatherService.on("weather:update", (data) => {
        console.log("[DEV-SERVER2] Received weather update, forwarding to state manager");
        stateManager.setWeatherData(data);
      });
    }    
  
    log("State bridge to relay activated");
  }

// --- Main server startup ---
async function startServer() {
  try {
    // 1. Initialize all services
    await initializeServices();

    // 2. Build relay config
    const relayConfig = {
      port: parseInt(
        process.env.RELAY_PORT ||
        process.env.RELAY_SERVER_PORT ||
        process.env.PORT ||
        "8081",
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
    };

    if (!relayConfig.port || isNaN(relayConfig.port)) {
      throw new Error("RelayServer: port must be set via env");
    }

    // 3. Start the relay server
    const { httpServer } = await startRelayServer(relayConfig);
    log(`Relay server started on port ${relayConfig.port}`);

    // 4. Set up graceful shutdown
    setupGracefulShutdown(httpServer);

  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// --- Graceful shutdown handling ---
function setupGracefulShutdown(server) {
  const shutdown = async (signal) => {
    log(`Received ${signal}, shutting down gracefully...`);
    
    try {
      // Stop all services
      await serviceManager.stopAll();
      
      // Close the server
      server.close(() => {
        log("Server closed");
        process.exit(0);
      });
      
      // Force close if needed
      setTimeout(() => {
        console.error("Could not close connections in time, forcefully shutting down");
        process.exit(1);
      }, 10000);
      
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  };

  // Handle different shutdown signals
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection at:', reason);
    shutdown('unhandledRejection');
  });
}

// Start the server
startServer().catch(error => {
  console.error("Fatal error during startup:", error);
  process.exit(1);
});