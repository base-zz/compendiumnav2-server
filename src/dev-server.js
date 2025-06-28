// Import module alias configuration first
import './module-alias.js';

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import express from 'express';
import stateServiceDemo from './state/StateServiceDemo.js';
import { startRelayServer, startDirectServerWrapper } from './relay/server/index.js';
import { registerBoatInfoRoutes, getBoatInfo } from './server/api/boatInfo.js';
import { registerVpsRoutes } from './server/vps/registration.js';
import debug from 'debug';
import https from 'https';
import http from 'http';
import fs from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';

const log = debug('compendium:dev-server');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log("Loading .env file from:", resolve(__dirname, '../.env'));
dotenv.config({ path: resolve(__dirname, '../.env') });

// Using key-based authentication now
console.log('Authentication: key-based');

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

    // 4. Build relay and direct server configs
    // Validate required environment variables
    const requiredVars = [
      'DEV_RELAY_PORT',
      'DIRECT_WS_PORT',
      'DIRECT_WS_HOST',
      'DEV_SIGNALK_REFRESH_RATE',
      'DEV_DEFAULT_THROTTLE_RATE',
      'DEV_MAX_PAYLOAD_SIZE',
      'RECONNECT_DELAY',
      'MAX_RETRIES'
    ];
    
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
    
    const relayPort = parseInt(process.env.DEV_RELAY_PORT, 10);
    const directPort = parseInt(process.env.DIRECT_WS_PORT, 10);
    
    if (isNaN(relayPort) || isNaN(directPort)) {
      throw new Error('DEV_RELAY_PORT and DIRECT_WS_PORT must be valid numbers');
    }
    
    console.log(`[DEV-SERVER] Starting WebSocket server on port ${directPort}`);
    
    // Ensure the relay port is different from the direct port
    const relayPortFinal = relayPort === directPort ? directPort + 1 : relayPort;

    const relayConfig = {
      port: relayPortFinal,
      signalKRefreshRate: parseInt(process.env.DEV_SIGNALK_REFRESH_RATE, 10),
      defaultThrottleRate: parseInt(process.env.DEV_DEFAULT_THROTTLE_RATE, 10),
      // Key-based authentication is now used exclusively
      vpsUrl: buildVpsUrl(),
    };

    const directConfig = {
      port: directPort,
      host: process.env.DIRECT_WS_HOST,
      maxPayload: parseInt(process.env.DEV_MAX_PAYLOAD_SIZE, 10)
    };
    if (!relayConfig.port || isNaN(relayConfig.port))
      throw new Error("RelayServer: port must be set via env");
    // We only use key-based authentication now
    if (!relayConfig.vpsUrl)
      throw new Error("RelayServer: vpsUrl must be set via env");

    // 5. Start relay server
    console.log(`[DEV-SERVER] Starting relay server on port ${relayPort}`);
    console.log(`[DEV-SERVER] VPS URL: ${relayConfig.vpsUrl || 'NOT SET'}`);
    console.log(`[DEV-SERVER] Authentication: key-based`);
    
    // Use the URL from environment configuration
    console.log(`[DEV-SERVER] Using VPS URL: ${relayConfig.vpsUrl}`);
    
    // Using key-based authentication
    console.log(`[DEV-SERVER] Using key-based authentication`);
    
    // Set connection parameters from environment
    relayConfig.reconnectInterval = parseInt(process.env.RECONNECT_DELAY, 10);
    relayConfig.maxRetries = parseInt(process.env.MAX_RETRIES, 10);
    
    const relayServer = await startRelayServer(relayConfig);
    
    // Log when the relay server connects to the VPS
    if (relayServer && relayServer.vpsConnector) {
      relayServer.vpsConnector.on('connected', () => {
        console.log(`[DEV-SERVER] Successfully connected to VPS at ${relayConfig.vpsUrl}`);
      });
      
      relayServer.vpsConnector.on('disconnected', () => {
        console.log(`[DEV-SERVER] Disconnected from VPS`);
      });
      
      relayServer.vpsConnector.on('error', (error) => {
        console.error(`[DEV-SERVER] VPS connection error:`, error.message);
      });
    }

    // 6. Start direct server
    console.log(`[DEV-SERVER] Starting direct server on port ${directPort}`);
    await startDirectServerWrapper(directConfig);

    // 7. Create Express app and set up API routes
    const app = express();
    
    // Middleware
    app.use(express.json());
    app.use((req, res, next) => {
      console.log(`[HTTP] ${new Date().toISOString()} ${req.method} ${req.url}`);
      next();
    });
    
    // Enable CORS for all routes
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      next();
    });
    
    // Simple root endpoint
    app.get('/', (req, res) => {
      res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        endpoints: [
          '/api/boat-info',
          '/api/vps/register',
          '/api/vps/health'
        ]
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
      log('No VPS URL configured. VPS registration will be disabled.');
    }
    
    // 8. Start HTTPS server with Express
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    if (isNaN(PORT)) {
      throw new Error('PORT must be a valid number');
    }
    
    log(`[DEBUG] Configured HTTPS server port: ${PORT}`);
    
    // SSL configuration
    const sslDir = join(__dirname, '../../../ssl');
    const sslOptions = {
      key: fs.readFileSync(join(sslDir, 'compendium.local.key')),
      cert: fs.readFileSync(join(sslDir, 'compendium.local.cert')),
      requestCert: false,
      rejectUnauthorized: false // Set to true in production with valid certificates
    };
    
    const httpsServer = https.createServer(sslOptions, app);
    
    // Add error handler for the HTTPS server
    httpsServer.on('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        log(`[ERROR] Port ${PORT} is already in use. Please check for other running instances.`);
      } else {
        log(`[ERROR] HTTPS server error: ${error?.message || 'Unknown error'}`);
      }
      process.exit(1);
    });
    
    log(`[DEBUG] Attempting to start HTTPS server on port ${PORT}...`);
    
    // Start the HTTPS server
    httpsServer.listen(PORT, '0.0.0.0', () => {
      const address = httpsServer.address();
      console.log(`[HTTPS] Server started on port ${PORT}`);
      console.log(`[HTTPS] Access the API at https://localhost:${PORT}/`);
      console.log('\nAvailable endpoints (HTTPS):');
      console.log(`  GET  https://localhost:${PORT}/api/boat-info`);
      console.log(`  POST https://localhost:${PORT}/api/vps/register`);
      console.log(`  GET  https://localhost:${PORT}/api/vps/health\n`);
    });
    
    // Redirect HTTP to HTTPS (optional, for development)
    if (process.env.NODE_ENV === 'production') {
      const httpApp = express();
      httpApp.use((req, res) => {
        res.redirect(301, `https://${req.headers.host}${req.url}`);
      });
      const httpServer = http.createServer(httpApp);
      httpServer.listen(80, '0.0.0.0');
      console.log('[HTTP] HTTP server listening on port 80 (redirecting to HTTPS)');
    }
    
    // Error handling for HTTPS server
    httpsServer.on('error', (error) => {
      console.error('[HTTPS] Server error:', error);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        console.error(`[ERROR] Port ${PORT} is already in use. Please stop the other process or use a different port.`);
      }
      process.exit(1);
    });

    console.log("[DEV-SERVER] Development server started successfully");
  } catch (error) {
}
    
const relayPort = parseInt(process.env.DEV_RELAY_PORT, 10);
const directPort = parseInt(process.env.DIRECT_WS_PORT, 10);
    
if (isNaN(relayPort) || isNaN(directPort)) {
  throw new Error('DEV_RELAY_PORT and DIRECT_WS_PORT must be valid numbers');
}
    
console.log(`[DEV-SERVER] Starting WebSocket server on port ${directPort}`);
    
// Ensure the relay port is different from the direct port
const relayPortFinal = relayPort === directPort ? directPort + 1 : relayPort;

const relayConfig = {
  port: relayPortFinal,
  signalKRefreshRate: parseInt(process.env.DEV_SIGNALK_REFRESH_RATE, 10),
  defaultThrottleRate: parseInt(process.env.DEV_DEFAULT_THROTTLE_RATE, 10),
  // Key-based authentication is now used exclusively
  vpsUrl: buildVpsUrl(),
};

const directConfig = {
  port: directPort,
  host: process.env.DIRECT_WS_HOST,
  maxPayload: parseInt(process.env.DEV_MAX_PAYLOAD_SIZE, 10)
};
if (!relayConfig.port || isNaN(relayConfig.port))
  throw new Error("RelayServer: port must be set via env");
// We only use key-based authentication now
if (!relayConfig.vpsUrl)
  throw new Error("RelayServer: vpsUrl must be set via env");

// 5. Start relay server
console.log(`[DEV-SERVER] Starting relay server on port ${relayPort}`);
console.log(`[DEV-SERVER] VPS URL: ${relayConfig.vpsUrl || 'NOT SET'}`);
console.log(`[DEV-SERVER] Authentication: key-based`);
    
// Use the URL from environment configuration
console.log(`[DEV-SERVER] Using VPS URL: ${relayConfig.vpsUrl}`);
    
// Using key-based authentication
console.log(`[DEV-SERVER] Using key-based authentication`);
    
// Set connection parameters from environment
relayConfig.reconnectInterval = parseInt(process.env.RECONNECT_DELAY, 10);
relayConfig.maxRetries = parseInt(process.env.MAX_RETRIES, 10);
  
const relayServer = await startRelayServer(relayConfig);
  
// Log when the relay server connects to the VPS
if (relayServer && relayServer.vpsConnector) {
  relayServer.vpsConnector.on('connected', () => {
    console.log(`[DEV-SERVER] Successfully connected to VPS at ${relayConfig.vpsUrl}`);
  });
  
  relayServer.vpsConnector.on('disconnected', () => {
    console.log(`[DEV-SERVER] Disconnected from VPS`);
  });
  
  relayServer.vpsConnector.on('error', (error) => {
    console.error(`[DEV-SERVER] VPS connection error:`, error.message);
  });
}

// 6. Start direct server
console.log(`[DEV-SERVER] Starting direct server on port ${directPort}`);
await startDirectServerWrapper(directConfig);

// 7. Create Express app and set up API routes
const app = express();
  
// Middleware
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[HTTP] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});
  
// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});
  
// Simple root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: [
      '/api/boat-info',
      '/api/vps/register',
      '/api/vps/health'
    ]
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
  log('No VPS URL configured. VPS registration will be disabled.');
}
  
  try {
    // 8. Start HTTP server with Express
    const PORT = parseInt(process.env.PORT || '3000', 10);
    if (isNaN(PORT)) {
      throw new Error('PORT must be a valid number');
    }
    
    log(`[DEBUG] Configured HTTP server port: ${PORT}`);
    
    const httpServer = http.createServer(app);
    
    // Add error handler for the HTTP server
    httpServer.on('error', (error) => {
      console.error('[HTTP] Server error:', error);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        console.error(`[ERROR] Port ${PORT} is already in use. Please stop the other process or use a different port.`);
      } else {
        console.error(`[ERROR] HTTP server error: ${error?.message || 'Unknown error'}`);
      }
      process.exit(1);
    });
    
    log(`[DEBUG] Attempting to start HTTP server on port ${PORT}...`);
    
    // Start the HTTP server
    httpServer.listen(PORT, '0.0.0.0', () => {
      const address = httpServer.address();
      console.log(`[HTTP] Server started on port ${PORT}`);
      console.log(`[HTTP] Access the API at http://localhost:${PORT}/`);
      console.log('\nAvailable endpoints:');
      console.log(`  GET  http://localhost:${PORT}/api/boat-info`);
      console.log(`  POST http://localhost:${PORT}/api/vps/register`);
      console.log(`  GET  http://localhost:${PORT}/api/vps/health\n`);
      
      console.log("[DEV-SERVER] Development server started successfully");
    });
  } catch (error) {
    console.error("[DEV-SERVER] Failed to start development server:", error);
    process.exit(1);
  }
}

// Patch console methods to filter out unwanted logs
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug
};

// Whitelist of allowed log patterns
const ALLOWED_PATTERNS = [
  'bluetooth',
  'Bluetooth',
  'error',
  'Error',
  'exception',
  'Exception'
];

// Function to check if a log message should be shown
function shouldShowLog(message) {
  if (typeof message !== 'string') {
    // For non-string messages, only allow if they're errors
    return false;
  }
  
  // Check if this is an error message (always show errors)
  if (message.toLowerCase().includes('error') || 
      message.toLowerCase().includes('exception') ||
      message.toLowerCase().includes('failed')) {
    return true;
  }
  
  // Check if this is a Bluetooth-related message
  if (message.toLowerCase().includes('bluetooth')) {
    return true;
  }
  
  // Check if this is a startup message
  if (message.includes('Server started') || 
      message.includes('listening on') ||
      message.includes('Console logging configured')) {
    return true;
  }
  
  // By default, hide all other messages
  return false;
}

// Override console methods
const createConsoleMethod = (original) => {
  return function(...args) {
    // Only process the first argument for simplicity
    if (args.length > 0 && shouldShowLog(String(args[0]))) {
      original.apply(console, args);
    }
  };
};

console.log = createConsoleMethod(originalConsole.log);
console.info = createConsoleMethod(originalConsole.info);
console.warn = createConsoleMethod(originalConsole.warn);
console.debug = createConsoleMethod(originalConsole.debug);

// Always show errors
console.error = originalConsole.error;

console.log('Console logging configured to show only Bluetooth and error messages');

// Start the dev server
startDevServer().catch(console.error);
