import dotenv from "dotenv";
import http from "http";
import express from "express";
import fetch from 'node-fetch';
import { stateService, setStateManager } from "./state/StateService.js";
import { startRelayServer, startDirectServer } from "./relay/server/index.js";
import { stateManager } from "./relay/core/state/StateManager.js";
import { registerBoatInfoRoutes, getBoatInfo } from "./server/api/boatInfo.js";
import { registerVpsRoutes } from "./server/vps/registration.js";
import debug from 'debug';

const log = debug('compendium:server:main');

// Set up circular dependency
setStateManager(stateManager);

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
  console.log("[SERVER] Starting state bridge to relay");
  try {
    const { stateData } = await import("./state/StateData.js");
    const { stateManager } = await import(
      "./relay/core/state/StateManager.js"
    );

    // Bridge canonical StateService events to relay stateManager
    stateService.on("state:full-update", (msg) => {
      // console.log("[SERVER] Received full state update from StateService:", JSON.stringify(msg) );
      stateManager.receiveExternalStateUpdate(msg.data);
    });
    console.log("     [SERVER] Initiated StateService full update listener");

    stateService.on("state:patch", (msg) => {
      // console.log("[SERVER] Received patch update from StateService:", msg);
      stateManager.applyPatchAndForward(msg.data);
    });
    console.log(".    [SERVER] Initiated StateService patch listener");

    console.log("     [SERVER] All Server bridges activated.");
  } catch (err) {
    console.error("[SERVER] !!!!!! Failed to set up state bridge:", err);
  }
}

async function startServer() {
  try {
    // 0. Start StateService (SignalK, data ingestion)
    await stateService.initialize();

    // 1. Bridge canonical state into relay state manager
    await bridgeStateToRelay();

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
      // Add any other needed config here
    };
    if (!relayConfig.port || isNaN(relayConfig.port))
      throw new Error("RelayServer: port must be set via env");
    // tokenSecret is now optional with key-based authentication
    if (!relayConfig.vpsUrl)
      throw new Error("RelayServer: vpsUrl must be set via env");

    // 3. Start relay server
    await startRelayServer(relayConfig);

    // 4. Create and configure Express app for API endpoints
    const app = express();
    app.use(express.json());
    
    // Register API routes
    registerBoatInfoRoutes(app);
    registerVpsRoutes(app, { vpsUrl: relayConfig.vpsUrl });
    
    // Simple health check endpoint
    app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version
      });
    });
    
    // Add request logging in development
    if (process.env.NODE_ENV !== 'production') {
      app.use((req, res, next) => {
        log(`${req.method} ${req.path}`);
        next();
      });
    }
    
    // 5. Start HTTP server
    const PORT = process.env.PORT || 8080;
    const httpServer = http.createServer(app);
    httpServer.listen(PORT, '0.0.0.0', () => {
      const host = `http://localhost:${PORT}`;
      console.log(`[SERVER] HTTP server listening on port ${PORT}`);
      console.log(`[SERVER] API endpoints:`);
      console.log(`  - ${host}/api/boat-info - Get boat information`);
      console.log(`  - ${host}/api/vps/health - VPS connection health`);
      console.log(`  - ${host}/api/vps/register - Register with VPS`);
      console.log(`  - ${host}/health - Server health check`);
    });
    
    // Auto-register with VPS on startup if configured
    if (process.env.VPS_AUTO_REGISTER === 'true') {
      log('Auto-registration with VPS is enabled');
      // Small delay to ensure the server is fully up
      setTimeout(async () => {
        try {
          const boatInfo = getBoatInfo();
          log(`Attempting auto-registration with VPS for boat ${boatInfo.boatId}`);
          
          // Auto-register with VPS
          const response = await fetch(`http://localhost:${PORT}/api/vps/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          
          if (response.ok) {
            const result = await response.json();
            log('Auto-registration with VPS successful:', result);
          } else {
            const error = await response.json().catch(() => ({}));
            log('Auto-registration with VPS failed:', error);
          }
        } catch (error) {
          log('Auto-registration with VPS failed:', error);
        }
      }, 5000); // 5 second delay
    }

    // 5. Relay state updates to VPS (optional, placeholder for future logic)
    stateService.on("state-updated", (data) => {
      // VPS relay logic can be added here if needed in the future
    });

    // 6. Start Direct WebSocket server (optional)
    if (process.env.DIRECT_WS_PORT) {
      const directServer = await startDirectServer({
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
        httpServer.close(() => process.exit(0));
      });
    }
  } catch (err) {
    console.error("[SERVER] Failed to start:", err);
    process.exit(1);
  }
}

startServer();
