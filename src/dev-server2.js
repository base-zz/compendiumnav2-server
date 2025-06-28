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
import { StateManager2 } from "./relay/core/state/StateManager2.js";
import { BluetoothService } from "./services/BluetoothService.js";

// Create Express app
const app = express();
app.use(express.json());
const server = http.createServer(app);

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
  log("Initializing services...");

  try {
    // Initialize Bluetooth service
    log("Bluetooth service will be initialized by service manager");

    console.log("[DEV-SERVER2] Initializing NewStateServiceDemo...");

    // Initialize the demo service, which loads data from the DB
    const stateService = newStateServiceDemo;
    await stateService.start();
    await stateService.loadInitialData();

    // Register the state service with the service manager
    serviceManager.registerService("state", stateService);

    // Start mock data generation for other systems
    console.log("[DEV-SERVER2] Starting mock data generation...");
    stateService.startMockMultipleTanksAndBatteries(5000); // Update every 5 seconds

    console.log("[DEV-SERVER2] NewStateServiceDemo initialized.");
    return true;
  } catch (error) {
    console.error(
      "[DEV-SERVER2] Failed to initialize NewStateServiceDemo:",
      error
    );
    throw error;
  }
}

// --- Bridge state and initialize dependent services ---
async function bridgeStateToRelay() {
  console.log(
    "[DEV-SERVER2] Starting state bridge and initializing dependent services"
  );
  try {
    
    // Get the state service instance that was already created
    const stateService = serviceManager.getService("state");
    if (!stateService) {
      throw new Error("State service not found in service manager");
    }
    
    // Initialize StateManager2 with initial state
    const stateManager = new StateManager2(stateData);
    stateManager.initialState = stateService.getState();

    // --- Wire up state events from provider to manager ---
    console.log("[DEV-SERVER2] Wiring NewStateServiceDemo to StateManager2");
    stateService.on("state:patch", ({ data }) => {
      try {
        // console.log("[DEV-SERVER2] 'state:patch' event received. Forwarding to StateManager2.");
        stateManager.applyPatchAndForward(data);
      } catch (err) {
        console.error("[DEV-SERVER2] Error applying patch in relay:", err);
      }
    });

    stateService.on("state:full-update", ({ data }) => {
      try {
        console.log(
          "[DEV-SERVER2] 'state:full-update' event received. Forwarding to StateManager2."
        );
        stateManager.receiveExternalStateUpdate(data);
      } catch (err) {
        console.error(
          "[DEV-SERVER2] Error applying full update in relay:",
          err
        );
      }
    });

    // --- Initialize secondary services ---
    setTimeout(() => {
      initializeSecondaryServices(stateManager, serviceManager);
      stateService.startPlayback();
      console.log(
        "[DEV-SERVER2] State bridge to relay activated and all services running."
      );
    }, 1000);

  } catch (err) {
    console.error("[DEV-SERVER2] Failed to set up state bridge:", err);
    throw err;
  }
}

 
// --- Bridge state and initialize dependent services ---
async function initializeSecondaryServices(stateManager, serviceManager) {
  console.log("[DEV-SERVER2] Starting secondary services...");

  const stateService = serviceManager.getService("state");
  const tidalService = new TidalService(stateService);
  const weatherService = new WeatherService(stateService);
  const bluetoothService = new BluetoothService();

  serviceManager.registerService("tidal", tidalService);
  serviceManager.registerService("weather", weatherService);
  serviceManager.registerService("bluetooth", bluetoothService);

  // --- Wire up tide and weather updates back to the state manager ---
  if (tidalService) {
    console.log(
      "[DEV-SERVER2] Setting up tide:update listener on tidalService"
    );
    tidalService.on("tide:update", (data) => {
      console.log(
        "[DEV-SERVER2] Received tide:update, forwarding to state manager"
      );
      stateManager.setTideData(data);
    });
  }

  if (weatherService) {
    console.log(
      "[DEV-SERVER2] Setting up weather:update listener on weatherService"
    );
    weatherService.on("weather:update", (data) => {
      console.log(
        "[DEV-SERVER2] Received weather:update, forwarding to state manager"
      );
      stateManager.setWeatherData(data);
    });
  }

  if (bluetoothService) {
    console.log("[DEV-SERVER2] Setting up Bluetooth service event listeners");
    
    // Initialize the Bluetooth service
    try {
      // Start the Bluetooth service and log detailed information about the process
      console.log("[DEV-SERVER2] Starting Bluetooth service with detailed logging...");
      await bluetoothService.start();
      console.log("[DEV-SERVER2] Bluetooth service start() method completed");
      
      // Always register parsers at startup
      const parserRegistry = bluetoothService.parserRegistry;
      if (parserRegistry) {
        const allParsers = parserRegistry.getAllParsers ? parserRegistry.getAllParsers() : [];
        console.log(`[DEV-SERVER2] Bluetooth service parser registry contains ${allParsers.length || 0} parsers`);
        
        // Always register RuuviParser explicitly
        console.log("[DEV-SERVER2] Registering RuuviParser...");
        const { RuuviParser } = await import("./bluetooth/parsers/RuuviParser.js");
        console.log("[DEV-SERVER2] RuuviParser imported:", {
          exists: !!RuuviParser,
          manufacturerId: RuuviParser ? RuuviParser.manufacturerId : undefined
        });
        if (RuuviParser && RuuviParser.manufacturerId) {
          const result = bluetoothService.registerParser(RuuviParser.manufacturerId, RuuviParser);
          console.log(`[DEV-SERVER2] RuuviParser registration result: ${result}`);
        } else {
          console.log("[DEV-SERVER2] ERROR: RuuviParser or its manufacturerId is undefined");
        }
      }
      
      // Update Bluetooth service status
      stateManager.updateBluetoothStatus({ 
        state: 'enabled',
        error: null 
      });
      
      // Device discovery events
      bluetoothService.on("device:discovered", (device) => {
        // Only log device discoveries if debug mode is enabled
        if (process.env.LOG_DEVICE_DISCOVERIES === 'true') {
          console.log(`[DEV-SERVER2] Device discovered: ${device.id} (${device.name || 'Unnamed'})`);
        }
        stateManager.updateBluetoothDevice(device);
      });
      
      // Device update events (sensor data changes, etc.)
      bluetoothService.on("device:updated", (device) => {
        stateManager.updateBluetoothDevice(device);
      });
      
      // Device sensor data events (parsed data from sensors)
      bluetoothService.on("device:data", ({ id, data }) => {
        console.log(`[DEV-SERVER2] Received sensor data for device ${id}`);
        
        // Log data preview
        const dataPreview = {};
        if (data.temperature) dataPreview.temperature = data.temperature.value;
        if (data.humidity) dataPreview.humidity = data.humidity.value;
        if (data.pressure) dataPreview.pressure = data.pressure.value;
        if (data.battery && data.battery.voltage) dataPreview.battery = data.battery.voltage.value;
        
        console.log(`[DEV-SERVER2] Sensor data preview: ${JSON.stringify(dataPreview)}`);
        console.log(`[DEV-SERVER2] Forwarding sensor data to state manager...`);
        
        // Update state with sensor data
        const result = stateManager.updateBluetoothDeviceSensorData(id, data);
        console.log(`[DEV-SERVER2] State update ${result ? 'successful' : 'failed'}`);
      });
      
      // Set up periodic state inspection for debugging
      const stateInspectionInterval = 30000; // 30 seconds
      console.log(`[DEV-SERVER2] Setting up state inspection every ${stateInspectionInterval/1000} seconds`);
      
      setInterval(() => {
        // Get all Bluetooth devices from state
        const bluetoothState = stateManager.appState?.bluetooth;
        if (!bluetoothState || !bluetoothState.devices) {
          console.log('[DEV-SERVER2] No Bluetooth devices in state');
          return;
        }
        
        // Count devices with sensor data
        const allDevices = Object.values(bluetoothState.devices);
        const devicesWithSensorData = allDevices.filter(device => device.sensorData);
        
        console.log(`[DEV-SERVER2] STATE INSPECTION: ${allDevices.length} total devices, ${devicesWithSensorData.length} with sensor data`);
        
        // Log details of devices with sensor data
        if (devicesWithSensorData.length > 0) {
          devicesWithSensorData.forEach(device => {
            const sensorDataPreview = {};
            const sensorData = device.sensorData;
            
            if (sensorData.temperature) sensorDataPreview.temperature = sensorData.temperature.value;
            if (sensorData.humidity) sensorDataPreview.humidity = sensorData.humidity.value;
            if (sensorData.pressure) sensorDataPreview.pressure = sensorData.pressure.value;
            if (sensorData.battery && sensorData.battery.voltage) {
              sensorDataPreview.battery = sensorData.battery.voltage.value;
            }
            
            console.log(`[DEV-SERVER2] Device ${device.id} (${device.name || 'Unknown'}) sensor data:`, sensorDataPreview);
          });
        }
      }, stateInspectionInterval);
      
      // Device selection events
      bluetoothService.on("device:selected", (device) => {
        console.log(`[DEV-SERVER2] Device selected: ${device.id}`);
        stateManager.setBluetoothDeviceSelected(device.id, true);
      });
      
      bluetoothService.on("device:unselected", (device) => {
        console.log(`[DEV-SERVER2] Device unselected: ${device.id}`);
        stateManager.setBluetoothDeviceSelected(device.id, false);
      });
      
      // Bluetooth service status events
      bluetoothService.on("scanStart", () => {
        console.log("[DEV-SERVER2] Bluetooth scan started");
        stateManager.updateBluetoothStatus({
          scanning: true,
          state: 'enabled'
        });
      });
      
      // Add debounce for device count logging
      let lastScanStopTime = 0;
      const scanStopDebounceTime = 500; // 500ms debounce
      
      bluetoothService.on("scanStop", () => {
        console.log("[DEV-SERVER2] Bluetooth scan stopped");
        
        // Update state immediately
        stateManager.updateBluetoothStatus({
          scanning: false
        });
        
        // Debounce the device count logging to prevent multiple logs per scan cycle
        const now = Date.now();
        if (now - lastScanStopTime > scanStopDebounceTime) {
          lastScanStopTime = now;
          
          // Log the number of discovered and selected devices
          setTimeout(() => {
            const allDevices = bluetoothService.getDevices();
            const selectedDevices = bluetoothService.getSelectedDevices();
            console.log(`[BluetoothService] Devices: ${allDevices.length} discovered, ${selectedDevices.length} selected`);
          }, 200); // Small delay to ensure all processing is complete
        }
      });
      
      bluetoothService.on("error", (error) => {
        console.error("[DEV-SERVER2] Bluetooth service error:", error);
        stateManager.updateBluetoothStatus({ 
          state: 'error',
          error: error.message || 'Unknown Bluetooth error' 
        });
      });
      
    } catch (error) {
      console.error("[DEV-SERVER2] Failed to initialize Bluetooth service:", error);
      stateManager.updateBluetoothStatus({ 
        state: 'error',
        error: error.message || 'Failed to initialize Bluetooth service' 
      });
    }
  }

    // --- Start all other services ---
  console.log("[DEV-SERVER2] Starting all services (Tidal, Weather, Bluetooth)...");
  await serviceManager.startAll(); // This will start tidal and weather services

  // --- Set up Bluetooth API endpoints ---
  console.log("[DEV-SERVER2] Setting up Bluetooth API endpoints...");
  app.use(express.json());
  
  // Bluetooth API endpoints
  function setupBluetoothRoutes(app) {
    try {
      const bluetoothService = serviceManager.getService('bluetooth');
      if (!bluetoothService) {
        console.warn('Bluetooth service not available. Bluetooth API endpoints will not be available.');
        return;
      }
      
      console.log('Bluetooth service found, setting up routes...');
      const router = express.Router();
      
      // Get list of discovered devices
      router.get('/devices', async (req, res) => {
        try {
          const devices = bluetoothService.getDevices();
          res.json(devices);
        } catch (error) {
          console.error('Error getting devices:', error);
          res.status(500).json({ error: 'Failed to get devices' });
        }
      });

      // Start/stop scanning
      router.post('/scan', async (req, res) => {
        try {
          const { action } = req.body;
          if (!action) {
            return res.status(400).json({ error: 'Action is required' });
          }
          
          if (action === 'start') {
            await bluetoothService.start();
            res.json({ 
              status: 'scanning',
              message: 'Bluetooth scanning started successfully'
            });
          } else if (action === 'stop') {
            await bluetoothService.stop();
            res.json({ 
              status: 'stopped',
              message: 'Bluetooth scanning stopped'
            });
          } else {
            res.status(400).json({ 
              error: 'Invalid action',
              validActions: ['start', 'stop']
            });
          }
        } catch (error) {
          console.error('Error controlling scan:', error);
          res.status(500).json({ 
            error: 'Failed to control scanning',
            details: error.message 
          });
        }
      });

      // Get scan status
      router.get('/status', (req, res) => {
        try {
          res.json({
            status: 'success',
            data: {
              isRunning: bluetoothService.isRunning,
              isScanning: bluetoothService.scanning,
              lastScan: bluetoothService.lastScanTime,
              serviceAvailable: true
            }
          });
        } catch (error) {
          console.error('Error getting status:', error);
          res.status(500).json({ 
            error: 'Failed to get status',
            details: error.message 
          });
        }
      });

      // Health check endpoint
      router.get('/health', (req, res) => {
        res.json({
          status: 'ok',
          service: 'bluetooth',
          available: true,
          timestamp: new Date().toISOString()
        });
      });

      app.use('/api/bluetooth', router);
      console.log('[DEV-SERVER2] Bluetooth API endpoints registered at /api/bluetooth');
      
    } catch (error) {
      console.error('Failed to set up Bluetooth routes:', error);
    }
  }

  // Setup Bluetooth routes if service is available
  if (serviceManager.getService('bluetooth')) {
    setupBluetoothRoutes(app);
  } else {
    console.warn('Bluetooth service not available. Bluetooth API endpoints will not be registered.');
  }
}

//////////////////////

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
    const directServer = await startDirectServerWrapper(directConfig);

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
    registerVpsRoutes(app, { vpsUrl: process.env.VPS_URL });

    // Set up Bluetooth API routes if Bluetooth service is available
    try {
      const bluetoothService = serviceManager.getService('bluetooth');
      if (bluetoothService) {
        const router = express.Router();
        
        // Get list of discovered devices
        router.get('/bluetooth/devices', async (req, res) => {
          try {
            const devices = bluetoothService.getDevices();
            res.json(devices);
          } catch (error) {
            console.error('Error getting devices:', error);
            res.status(500).json({ error: 'Failed to get devices' });
          }
        });

        // Start/stop scanning
        router.post('/bluetooth/scan', async (req, res) => {
          try {
            const { action } = req.body;
            if (action === 'start') {
              await bluetoothService.start();
              res.json({ status: 'scanning' });
            } else if (action === 'stop') {
              await bluetoothService.stop();
              res.json({ status: 'stopped' });
            } else {
              res.status(400).json({ error: 'Invalid action' });
            }
          } catch (error) {
            console.error('Error controlling scan:', error);
            res.status(500).json({ error: 'Failed to control scanning' });
          }
        });

        // Get scan status
        router.get('/bluetooth/status', (req, res) => {
          try {
            res.json({
              isRunning: bluetoothService.isRunning,
              isScanning: bluetoothService.scanning,
              lastScan: bluetoothService.lastScanTime
            });
          } catch (error) {
            console.error('Error getting status:', error);
            res.status(500).json({ error: 'Failed to get status' });
          }
        });

        app.use('/api', router);
        console.log("Bluetooth API endpoints registered at /api/bluetooth/*");
      }
    } catch (error) {
      console.error('Failed to set up Bluetooth API:', error);
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
      console.log(`[HTTP] Server started on port ${PORT}`);
      console.log(`[HTTP] Access the API at http://localhost:${PORT}/`);
      console.log("\nAvailable endpoints:");
      console.log(`  GET  http://localhost:${PORT}/api/boat-info`);
      console.log(`  POST http://localhost:${PORT}/api/vps/register`);
      console.log(`  GET  http://localhost:${PORT}/api/vps/health`);
    });

    console.log("[DEV-SERVER2] Development server started with HTTP");

    // Return all server instances for graceful shutdown
    return { relayServer, directServer, httpServer };
  } catch (error) {
    console.error("[DEV-SERVER2] Fatal error during startup:", error);
    process.exit(1);
  }
}

// Graceful shutdown handler
async function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  try {
    // Clean up Bluetooth service if it was initialized
    const bluetoothService = serviceManager.getService('bluetooth');
    if (bluetoothService) {
      await bluetoothService.stop();
    }
    // Stop all background services
    await serviceManager.stopAll();
    console.log("[DEV-SERVER2] All services stopped.");

    // Close the HTTP server
    if (servers.httpServer) {
      await new Promise((resolve) => servers.httpServer.close(resolve));
      console.log("[DEV-SERVER2] HTTP server closed.");
    }

    // Close the Direct server
    if (
      servers.directServer &&
      typeof servers.directServer.shutdown === "function"
    ) {
      await servers.directServer.shutdown();
      console.log("[DEV-SERVER2] Direct server closed.");
    } else if (
      servers.directServer &&
      typeof servers.directServer.close === "function"
    ) {
      // Fallback for older directServer instances that might still return wss directly
      await servers.directServer.close();
      console.log("[DEV-SERVER2] Direct server (old style) closed.");
    } else {
      console.warn(
        "[DEV-SERVER2] Direct server object found, but no recognized close or shutdown method."
      );
    }

    // Close the Relay server
    if (servers.relayServer) {
      console.log("[DEV-SERVER2] Closing relay server...");
      if (typeof servers.relayServer.shutdown === "function") {
        servers.relayServer.shutdown();
        console.log("[DEV-SERVER2] Relay server shutdown initiated.");
      } else if (typeof servers.relayServer.close === "function") {
        servers.relayServer.close(() => {
          console.log("[DEV-SERVER2] Relay server closed.");
        });
      } else {
        console.log(
          "[DEV-SERVER2] Relay server has no close or shutdown method."
        );
      }
    }

    console.log("[DEV-SERVER2] Shutdown complete.");
    process.exit(0);
  } catch (error) {
    console.error("[DEV-SERVER2] Error during graceful shutdown:", error);
    process.exit(1);
  }
}

let servers = {};

async function main() {
  try {
    servers = await startDevServer();
    console.log("[DEV-SERVER2] All components started successfully.");
  } catch (error) {
    console.error("[DEV-SERVER2] Failed to start development server:", error);
    process.exit(1);
  }
}

// Register signal handlers
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the application
main();

// Enable debug output for our services
debug.enable("cn2:*");
