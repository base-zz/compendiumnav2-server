// Import module alias configuration first
import './module-alias.js';

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import stateServiceDemo from './state/StateServiceDemo.js';
import { startRelayServer, startDirectServerWrapper } from './relay/server/index.js';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log("Loading .env file from:", resolve(__dirname, '../.env'));
dotenv.config({ path: resolve(__dirname, '../.env') });

// Log the token secret for debugging (remove in production)
console.log('TOKEN_SECRET:', process.env.TOKEN_SECRET ? '*** (set)' : 'NOT SET');

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
  console.log("[DEV-SERVER] Starting state bridge to relay");
  try {
    const { stateData } = await import("./state/StateData.js");
    const { stateManager } = await import(
      "./relay/core/state/StateManager.js"
    );

    // Set up state update handlers
    stateServiceDemo.on("state:full-update", (msg) => {
      // Update the state data
      stateData.batchUpdate(msg.data);
      // Forward the update to the state manager
      stateManager.receiveExternalStateUpdate(msg.data);
      // Emit the full state
      stateManager.emitFullState();
    });
    console.log("     [DEV-SERVER] State update handler initialized");

    // Set up patch handler
    stateServiceDemo.on("state:patch", (msg) => {
      stateManager.applyPatchAndForward(msg.data);
    });
    console.log("     [DEV-SERVER] State patch handler initialized");

    console.log("     [DEV-SERVER] All Server bridges activated.");
  } catch (err) {
    console.error("[DEV-SERVER] !!!!!! Failed to set up state bridge:", err);
  }
}

async function startDevServer() {
  try {
    // 1. Initialize StateServiceDemo first
    console.log("[DEV-SERVER] Initializing StateServiceDemo...");
    await stateServiceDemo.initialize();
    
    // 2. Set up event listeners before the bridge
    stateServiceDemo.on('state:full-update', (msg) => {
      // console.log("[DEV-SERVER] StateServiceDemo full update:", JSON.stringify(msg.data, null, 2));
    });
    stateServiceDemo.on('state:patch', (msg) => {
      // console.log("[DEV-SERVER] StateServiceDemo patch update:", JSON.stringify(msg.data, null, 2));
    });

    // 3. Bridge canonical state into relay state manager
    await bridgeStateToRelay();
    
    // Start generating mock data for multiple tanks and batteries
    // We can now run this alongside the limited SQLite data without memory issues
    stateServiceDemo.startMockMultipleTanksAndBatteries(5000); // Update every 5 seconds
    console.log("[DEV-SERVER] Started mock data generation for multiple tanks and batteries");

    // 4. Build relay and direct server configs - using 3009 for WebSocket
    const relayPort = 3008; // Different port for relay
    const directPort = 3009; // WebSocket server on 3009 to match client
    
    console.log(`[DEV-SERVER] Starting WebSocket server on port ${directPort}`);
    
    // Ensure the relay port is different from the direct port
    const relayPortInput = relayPort;
    const relayPortFinal = relayPortInput === directPort ? directPort + 1 : relayPortInput;

    const relayConfig = {
      port: relayPortFinal,
      signalKRefreshRate: parseInt(
        process.env.SIGNALK_REFRESH_RATE || "1000",
        10
      ),
      defaultThrottleRate: parseInt(
        process.env.DEFAULT_THROTTLE_RATE || "5000",
        10
      ),
      requireAuth: process.env.REQUIRE_AUTH === "true",
      tokenSecret: process.env.TOKEN_SECRET,
      vpsUrl: buildVpsUrl(),
      // Add any other needed config here
    };

    const directConfig = {
      port: directPort,
      host: '0.0.0.0', // Explicitly bind to all interfaces
      maxPayload: 1024 * 1024 // 1MB default
    };
    if (!relayConfig.port || isNaN(relayConfig.port))
      throw new Error("RelayServer: port must be set via env");
    if (!relayConfig.tokenSecret)
      throw new Error("RelayServer: tokenSecret must be set via env");
    if (!relayConfig.vpsUrl)
      throw new Error("RelayServer: vpsUrl must be set via env");

    // 5. Start relay server
    console.log(`[DEV-SERVER] Starting relay server on port ${relayPort}`);
    await startRelayServer(relayConfig);

    // 6. Start direct server
    console.log(`[DEV-SERVER] Starting direct server on port ${directPort}`);
    await startDirectServerWrapper(directConfig);

    // 7. Start HTTP server
    const PORT = process.env.PORT || 3009;
    const httpServer = http.createServer();
    httpServer.listen(PORT, () => {
      console.log(`[DEV-SERVER] HTTP server listening on port ${PORT}`);
    });

    console.log("[DEV-SERVER] Development server started successfully");
  } catch (error) {
    console.error("[DEV-SERVER] Failed to start development server:", error);
    process.exit(1);
  }
}

startDevServer();
