//@ts-nocheck
import noble from "@abandonware/noble";
import fs from "fs/promises";
import * as yaml from "js-yaml";
import path from "path";
import { fileURLToPath, URL } from "url";
import { EventEmitter } from "events";
import { ParserRegistry } from "../bluetooth/parsers/ParserRegistry.js";
import { DeviceManager } from "../bluetooth/services/DeviceManager.js";
import ParserFactory from "../bluetooth/parsers/ParserFactory.js";
import ContinuousService from "./ContinuousService.js";

/**
 * Bluetooth Service for managing BLE device discovery and communication
 * Extends ContinuousService to provide continuous BLE scanning functionality
 */
export class BluetoothService extends ContinuousService {
  /**
   * Default configuration options for the BluetoothService
   * @type {Object}
   * @property {number} scanDuration - Duration of each scan in ms (default: 10000)
   * @property {string} ymlPath - Path to company identifiers YML file
   * @property {number} scanInterval - Time between scans in ms (default: 30000)
   */
  static DEFAULTS = Object.freeze({
    // Bluetooth scanning options
    scanDuration: 10000, // 10 seconds per scan
    scanInterval: 30000, // 30 seconds between scans
    ymlPath: path.join(
      process.cwd(),
      "src",
      "bluetooth",
      "config",
      "btman.yml"
    ),
    debug: false, // Enable debug logging
    logLevel: "info", // Default log level
    filters: {
      minRssi: -100,
      allowedTypes: null,
    },
  });

  /**
   * @type {number} - Duration of each BLE scan in milliseconds
   */
  scanDuration;

  /**
   * @type {number} - Time between scans in milliseconds
   */
  scanInterval;

  /**
   * @type {boolean} - Flag to indicate if the service is currently in the process of stopping a scan
   */
  isStopping = false;

  /**
   * @type {string} - Path to the YAML file containing company identifiers
   */
  ymlPath;

  /**
   * @type {NodeJS.Timeout|null} - Timer for the next scan
   */
  scanTimer = null;

  /**
   * Parser registry instance for handling different device manufacturers
   * @type {ParserRegistry}
   */
  parserRegistry;

  /**
   * Device manager instance for tracking discovered devices
   * @type {DeviceManager}
   */
  deviceManager;

  /**
   * @type {Object}
   */
  filters;

  /**
   * @type {boolean}
   */
  autoSelectRuuvi;

  /**
   * @type {boolean}
   */
  debug;

  /**
   * @type {string}
   */
  logLevel;

  /**
   * @type {Function}
   */
  _onDiscover;

  /**
   * @type {Function}
   */
  _onStateChange;

  /**
   * @type {Function}
   */
  _onScanStart;

  /**
   * @type {Function}
   */
  _onScanStop;

  /**
   * Whether a scan is currently in progress
   * @type {boolean}
   */
  scanning = false;

  /**
   * Timeout reference for the current scan
   * @type {NodeJS.Timeout|null}
   */
  scanTimeout = null;

  /**
   * Map of company IDs to company names
   * @type {Map<number, string>}
   */
  companyMap = new Map();

  /**
   * Create a new BluetoothService instance
   * @param {Object} [options] - Configuration options
   * @param {number} [options.scanDuration] - Duration of each scan in ms (default: 10000)
   * @param {number} [options.scanInterval] - Time between scans in ms (default: 30000)
   * @param {string} [options.ymlPath] - Path to company identifiers YML file
   */
  /**
   * @typedef {Object} DeviceFilterOptions
   * @property {number} [minRssi] - Minimum RSSI value for device discovery
   * @property {string[]|null} [allowedTypes] - Array of allowed device types (null = all types)
   */

  /**
   * @typedef {Object} BluetoothServiceOptions
   * @property {number} [scanDuration] - Duration of each scan in ms
   * @property {number} [scanInterval] - Time between scans in ms
   * @property {string} [ymlPath] - Path to company identifiers YML file
   * @property {Object} [filters] - Device filtering options
   * @property {boolean} [autoSelectRuuvi] - Whether to automatically select Ruuvi devices
   * @property {boolean} [debug] - Enable debug logging
   * @property {string} [logLevel] - Logging level (e.g., 'info', 'debug', 'error')
   * @property {DeviceFilterOptions} [filters] - Device filtering options
   * @property {boolean} [autoSelectRuuvi] - Whether to automatically select Ruuvi devices when discovered
   * @property {Object} [stateManager] - StateManager instance for state updates
   */

  /**
   * @param {BluetoothServiceOptions} [options={}] - Configuration options
   */
  constructor(options = {}) {
    const defaults = BluetoothService.DEFAULTS;
    const {
      scanDuration = defaults.scanDuration,
      scanInterval = defaults.scanInterval,
      ymlPath = defaults.ymlPath,
      filters = {},
      autoSelectRuuvi = false,
      debug = defaults.debug,
      logLevel = defaults.logLevel,
      stateManager = null,
    } = options;

    // Initialize ContinuousService
    super("bluetooth");

    // Initialize instance properties
    this.scanDuration = scanDuration;
    this.scanInterval = scanInterval;
    this.ymlPath = ymlPath;
    this.autoSelectRuuvi = autoSelectRuuvi;
    this.debug = debug;
    this.logLevel = logLevel;
    this.stateManager = stateManager; // Store the state manager reference

    /** @type {DeviceFilterOptions} */
    this.filters = {
      minRssi: -100, // Minimum RSSI for device discovery
      allowedTypes: null, // Array of allowed device types (null = all types)
      ...filters,
    };

    this.parserRegistry = new ParserRegistry();
    this.deviceManager = new DeviceManager();
    this.scanning = false;
    this.scanTimeout = null;
    this.scanTimer = null;
    this.companyMap = new Map();
    this.isStarting = false;

    // Debounce properties for scan stop logging
    this.lastScanStopTime = 0;
    this.scanStopDebounceTime = 500; // 500ms
    
    // Map to store device updates during a scan cycle
    this.deviceUpdates = new Map(); // Map of device ID -> device info
    this.lastDbUpdateTime = Date.now();
    this.dbUpdateInterval = 5000; // Update database every 5 seconds

    // Initialize event handlers with proper binding
    this._onDiscover = (peripheral) => this._handleDeviceDiscovery(peripheral);
    this._onStateChange = (state) => this._handleStateChange(state);
    this._onScanStart = () => this._handleScanStart();
    this._onScanStop = () => this._handleScanStop();
    
    // Set up internal event listeners for state management if stateManager is provided
    if (this.stateManager) {
      this._setupStateManagement();
    }
  }
  
  /**
   * Set the state manager instance after construction
   * @param {Object} stateManager - StateManager instance
   */
  setStateManager(stateManager) {
    if (!stateManager) {
      this.log('Warning: Attempted to set null stateManager');
      return;
    }
    
    this.stateManager = stateManager;
    this._setupStateManagement();
  }
  
  /**
   * Set up internal event listeners for state management
   * @private
   */
  _setupStateManagement() {
    if (!this.stateManager) {
      this.log(
        "Cannot set up state management: No state manager provided",
        "warn"
      );
      return;
    }

    this.log("Setting up state management integration");

    // Handle device discovery events internally
    this.on("device:discovered", (device) => {
      // this.log(
      //   `Updating state for discovered device: ${device.id} (${
      //     device.name || "Unnamed"
      //   })`
      // );
      this.stateManager.updateBluetoothDevice(device, "discovery");
    });

    // Handle device update events internally
    this.on("device:updated", (device) => {
      // this.log(
      //   `Updating state for updated device: ${device.id} (${
      //     device.name || "unnamed"
      //   })`
      // );
      this.stateManager.updateBluetoothDevice(device, "update");
    });

    // Handle device sensor data events internally
    this.on("device:data", ({ id, data }) => {
      this.log(`Updating state with sensor data for device ${id}`);
      this.stateManager.updateBluetoothDeviceSensorData(id, data);
    });

    // Handle device selection events
    this.on("device:selected", (device) => {
      this.log(`Device selected: ${device.id}`);
      this.stateManager.setBluetoothDeviceSelected(device.id, true);
    });

    this.on("device:unselected", (device) => {
      this.log(`Device unselected: ${device.id}`);
      this.stateManager.setBluetoothDeviceSelected(device.id, false);
    });

    // Handle service status events
    this.on("scanStart", () => {
      this.log("Bluetooth scan started");
      this.stateManager.updateBluetoothStatus({
        scanning: true,
        state: "enabled",
      });
    });

    this.on("scanStop", () => {
      this.stateManager.updateBluetoothStatus({
        scanning: false,
      });
    });

    this.on("error", (error) => {
      this.logError(`Bluetooth service error: ${error.message}`);
      this.stateManager.updateBluetoothStatus({
        state: "error",
        error: error.message || "Unknown Bluetooth error",
      });
    });
  }

  /**
   * Start the Bluetooth service
   * @override
   * @returns {Promise<void>}
   */
  async start() {
    this.log(`BluetoothService.start() called, isRunning=${this.isRunning}`);
    
    if (this.isRunning) {
      this.log("⚠️  Bluetooth service is already running, returning early");
      return;
    }

    try {
      this.log("Starting Bluetooth service...");
      await super.start();
      
      // Initialize DeviceManager with error handling
      try {
        // Check if there's a lock file and remove it if it exists
        const lockFilePath = path.join(process.cwd(), 'data', 'devices.db', 'LOCK');
        
        try {
          // Check for stale lock file and remove it asynchronously.
          await fs.stat(lockFilePath);
          await fs.unlink(lockFilePath);
          this.log(`Removed stale lock file`);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            this.logError(`Error handling stale lock file: ${error.message}`);
          }
        }
        
        // Reinitialize the DeviceManager
        if (!this.deviceManager || !this.deviceManager.isInitialized) {
          this.log(`Initializing DeviceManager...`);
          this.deviceManager = new DeviceManager();
          await this.deviceManager.initialize();
          this.log(`DeviceManager initialized successfully`);
        }
      } catch (deviceManagerError) {
        this.log(`DeviceManager initialization failed, but continuing without device persistence: ${deviceManagerError.message}`);
        // Create a simple in-memory device manager as fallback
        this.deviceManager = {
          isInitialized: true,
          registerDevice: (id, device) => {
            // this.log(`In-memory device registration: ${id}`);
            return Promise.resolve(device);
          },
          getDevice: (id) => Promise.resolve(null),
          getAllDevices: () => Promise.resolve([]),
          selectedDevices: new Set(),
          connectedDevices: new Set()
        };
      }
      
      // Update Bluetooth status in state if state manager is available
      if (this.stateManager) {
        try {
          this.stateManager.updateBluetoothStatus({
            state: 'enabled',
            error: null
          });
          this.log('Updated Bluetooth status in state manager');
        } catch (statusError) {
          this.logError(`Error updating Bluetooth status: ${statusError.message}`);
        }
      }

      // Ensure ParserRegistry exists
      if (!this.parserRegistry) {
        this.parserRegistry = new ParserRegistry();
        this.log("Created new ParserRegistry instance");
      }
      
      // Load parsers from configuration files
      this.log("Loading parsers from configuration files...");
      const parserFactory = new ParserFactory();
      await parserFactory.loadAllParsers();
      
      // Register all loaded parsers
      const configParsers = parserFactory.getAllParsers();
      for (const [manufacturerId, parser] of configParsers) {
        this.registerParser(manufacturerId, parser);
        this.log(`Registered ${parser.name} for manufacturer ID: 0x${manufacturerId.toString(16).toUpperCase()}`);
      }

      // Initialize the device manager if not already done
      if (!this.deviceManager) {
        this.deviceManager = new DeviceManager({
          log: this.log,
          logError: this.logError,
        });
      }

      // Load company identifiers
      await this._loadCompanyMap();
      this.log("Company map loaded");

      // Initialize the BLE stack
      await this._initNoble();
      this.log("Noble initialized");

      // Start the scan cycle
      await this._startScanCycle();
      this.log("Scan cycle started");
      this.log("Bluetooth service started successfully");
    } catch (error) {
      this.logError(`❌ Failed to start Bluetooth service: ${error.message}`);
      this.logError(`Stack: ${error.stack}`);
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Initialize the Noble BLE library
   * @private
   * @returns {Promise<void>}
   */
  async _initNoble() {
    try {
      // First, remove any existing listeners to prevent duplicates
      this._removeNobleListeners();

      // Set up the event listeners
      noble.on("discover", this._onDiscover);
      noble.on("stateChange", this._onStateChange);
      noble.on("scanStart", this._onScanStart);
      noble.on("scanStop", this._onScanStop);

      return new Promise((resolve, reject) => {
        this.log(
          `Initializing Bluetooth adapter, current state: ${noble.state}`
        );

        // If already powered on, we're good to go
        if (noble.state === "poweredOn") {
          this.log("Bluetooth adapter is already powered on");
          return resolve();
        }

        // Set up a timeout for the state change
        const timeout = setTimeout(() => {
          noble.removeListener("stateChange", stateChangeHandler);
          reject(new Error("Bluetooth adapter initialization timed out"));
        }, 10000); // 10 second timeout

        const stateChangeHandler = (state) => {
          this.log(`Bluetooth adapter state changed to: ${state}`);

          if (state === "poweredOn") {
            clearTimeout(timeout);
            noble.removeListener("stateChange", stateChangeHandler);
            this.log("Bluetooth adapter is now powered on");
            resolve();
          } else if (
            state === "unsupported" ||
            state === "unauthorized" ||
            state === "poweredOff"
          ) {
            clearTimeout(timeout);
            noble.removeListener("stateChange", stateChangeHandler);
            reject(new Error(`Bluetooth not available: ${state}`));
          }
        };

        // Add the state change handler
        noble.on("stateChange", stateChangeHandler);

        // If we're not in a terminal state, wait for poweredOn
        if (noble.state === "poweredOff") {
          this.log("Bluetooth is powered off, please turn on Bluetooth");
          // Don't reject here, just wait for state change
        } else if (noble.state === "unauthorized") {
          noble.removeListener("stateChange", stateChangeHandler);
          clearTimeout(timeout);
          reject(new Error("Bluetooth access is not authorized"));
        } else if (noble.state === "unsupported") {
          noble.removeListener("stateChange", stateChangeHandler);
          clearTimeout(timeout);
          reject(new Error("Bluetooth is not supported on this device"));
        } else if (noble.state === "unknown") {
          this.log("Bluetooth state is unknown, waiting for state change...");
        } else if (noble.state === "resetting") {
          this.log("Bluetooth adapter is resetting, waiting...");
        } else {
          this.log(`Current Bluetooth state: ${noble.state}`);
        }
      });
    } catch (error) {
      this.logError(`Error initializing Bluetooth: ${error.message}`);
      if (error.stack) {
        this.logError(`Stack trace: ${error.stack}`);
      }
      throw error;
    }
  }

  /**
   * Stop the Bluetooth service
   * @override
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.isRunning) {
      this.log("Bluetooth service is not running");
      return;
    }

    this.log("Stopping Bluetooth service...");

    try {
      // Stop any ongoing scans
      if (this.scanning) {
        await this._stopScan();
      }

      // Clear any pending scan timers
      if (this.scanTimer) {
        clearTimeout(this.scanTimer);
        this.scanTimer = null;
      }

      // Clean up noble
      this._removeNobleListeners();

      this.isRunning = false;
      this.emit("stopped");
      this.log("Bluetooth service stopped");
    } catch (error) {
      this.logError(`Error stopping Bluetooth service: ${error.message}`);
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Clean up resources
   */
  cleanup() {
    try {
      // Clear any remaining timers
      if (this.scanTimer) {
        clearTimeout(this.scanTimer);
        this.scanTimer = null;
      }

      if (this.scanTimeout) {
        clearTimeout(this.scanTimeout);
        this.scanTimeout = null;
      }

      // Reset state
      this.scanning = false;
      this.isRunning = false;

      // Remove all listeners to prevent memory leaks
      this.removeAllListeners();

      this.log("Bluetooth service resources cleaned up", "debug");
    } catch (error) {
      this.error("Error during Bluetooth service cleanup:", error);
    }
  }

  /**
   * Load company identifiers from YAML file
   * @private
   */
  async _loadCompanyMap() {
    try {
      const ymlPath =
        this.ymlPath ||
        path.join(process.cwd(), "src", "bluetooth", "config", "btman.yml");

      // Debug: Log the current working directory and full YML path
      this.log("\n=== YAML CHECK ===");
      this.log("Current working directory:", process.cwd());
      this.log("YML path:", ymlPath);

      // Check if the file exists
      try {
        await fs.access(ymlPath);
        this.log("Located company identifier YAML file");
      } catch (err) {
        this.logError("YAML file does not exist:", err);
        return;
      }

      // Read the YAML file
      const fileContent = await fs.readFile(ymlPath, "utf8");

      // Parse YAML
      const ymlData = yaml.load(fileContent);

      if (!ymlData || !Array.isArray(ymlData.company_identifiers)) {
        this.log("Invalid or empty YML data", "warn");
        return;
      }

      let loadedCount = 0;

      for (const entry of ymlData.company_identifiers) {
        if (!entry || !entry.value || !entry.name) {
          this.log("Skipping invalid company entry", "debug");
          continue;
        }

        let id = entry.value;
        const originalId = id;

        // Handle both string and number IDs
        if (typeof id === "string") {
          if (id.startsWith("0x")) {
            id = parseInt(id.substring(2), 16);
          } else {
            id = parseInt(id, 10);
          }
        }

        if (isNaN(id)) {
          this.log(
            `Invalid company ID: ${originalId} (${typeof originalId})`,
            "warn"
          );
          continue;
        }

        this.companyMap.set(id, entry.name);
        loadedCount++;

        // Log Apple's entry specifically
        if (id === 0x004c) {
          this.log(`Found Apple entry: ${entry.name} (0x004C)`);
        }
      }

      this.log(
        `Successfully loaded ${loadedCount}/${ymlData.company_identifiers.length} company identifiers`
      );

      // Verify Apple's ID
      const appleName = this.companyMap.get(0x004c);
      this.log(`Apple company name: ${appleName || "Not found!"}`);

      if (noble.state === "poweredOn") {
        return;
      }

      return new Promise((resolve, reject) => {
        const stateChangeHandler = (state) => {
          if (state === "poweredOn") {
            noble.removeListener("stateChange", stateChangeHandler);
            resolve();
          } else if (state === "unsupported" || state === "unauthorized") {
            noble.removeListener("stateChange", stateChangeHandler);
            reject(new Error(`Bluetooth not available: ${state}`));
          }
        };

        noble.on("stateChange", stateChangeHandler);
      });
    } catch (error) {
      this.logError(`Error loading company identifiers: ${error.message}`, "error");
      throw error; // Re-throw to allow caller to handle the error
    }
  }

  /**
   * Set up noble event listeners
   * @private
   */
  _setupNobleListeners() {
    if (!noble) return;

    // Remove any existing listeners to avoid duplicates
    this._removeNobleListeners();

    // Set up new listeners
    noble.on("discover", this._onDiscover);
    noble.on("stateChange", this._onStateChange);
    noble.on("scanStart", this._onScanStart);
    noble.on("scanStop", this._onScanStop);
  }

  /**
   * Remove noble event listeners
   * @private
   */
  _removeNobleListeners() {
    if (!noble) {
      return;
    }

    try {
      // First, remove all listeners to prevent memory leaks
      if (typeof noble.removeAllListeners === "function") {
        noble.removeAllListeners("discover");
        noble.removeAllListeners("stateChange");
        noble.removeAllListeners("scanStart");
        noble.removeAllListeners("scanStop");
        noble.removeAllListeners("warning");
        noble.removeAllListeners("error");
      }

      // Then re-add just our bound handlers
      if (typeof noble.on === "function") {
        noble.on("discover", this._onDiscover);
        noble.on("stateChange", this._onStateChange);
        noble.on("scanStart", this._onScanStart);
        noble.on("scanStop", this._onScanStop);
      }

      this.log("Noble event listeners reset", "debug");
    } catch (error) {
      this.logError(`Error in _removeNobleListeners: ${error.message}`);
      if (error.stack) {
        this.logError(`Stack trace: ${error.stack}`);
      }
    }
  }

  /**
   * Handle BLE scan start events
   * @private
   */
  _handleScanStart() {
    this.log("✅ Bluetooth scan started - actively scanning for devices");
    this.scanning = true;
    this.isStarting = false;
    // No need to clear deviceUpdates as it's a Map that prevents duplicates by key
  }

  /**
   * Handle BLE scan stop events
   * @private
   */
  async _handleScanStop() {
    // Prevent duplicate calls from race conditions
    if (!this.scanning && !this.isStopping) {
      return;
    }

    this.log("Bluetooth scan stopped");
    this.scanning = false;
    this.isStopping = false;

    // Process all device updates at the end of the scan cycle
    if (this.deviceUpdates.size > 0 && this.deviceManager) {
      this.log(`Processing ${this.deviceUpdates.size} device updates`, "debug");

      try {
        // Process device updates in batches to avoid overwhelming the database
        const batchSize = 10;
        const devices = Array.from(this.deviceUpdates.values());

        for (let i = 0; i < devices.length; i += batchSize) {
          const batch = devices.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (deviceInfo) => {
              try {
                await this.deviceManager.registerDevice(
                  deviceInfo.id,
                  deviceInfo
                );
              } catch (error) {
                this.log(
                  `Error updating device ${deviceInfo.id}: ${error.message}`,
                  "error"
                );
              }
            })
          );
        }

        this.log(
          `Completed processing ${this.deviceUpdates.size} device updates`,
          "debug"
        );
      } catch (error) {
        this.log(`Error processing device updates: ${error.message}`, "error");
      }
    }

    // Debounced logging for device count
    if (this.debug) {
      const now = Date.now();
      if (now - this.lastScanStopTime > this.scanStopDebounceTime) {
        this.lastScanStopTime = now;

        // Use a small delay to ensure all processing is complete
        setTimeout(() => {
          const allDevices = this.getDevices();
          const selectedDevices = this.getSelectedDevices();
          this.log(
            `Devices: ${allDevices.length} discovered, ${selectedDevices.length} selected`
          );
        }, 200);
      }
    }

    this.emit("scanStop");
  }

  /**
   * Start the BLE scan cycle
   * This manages the scan/rest cycle for BLE scanning
   * @private
   * @returns {Promise<void>}
   */
  async _startScanCycle() {
    if (this.scanCycleActive) {
      this.log("⚠️  Scan cycle already active");
      return;
    }

    this.scanCycleActive = true;
    this.log("🔄 Starting BLE scan cycle");

    const scanTime = this.scanTime || 10000; // 10 seconds
    const restTime = this.restTime || 5000; // 5 seconds

    const scanCycle = async () => {
      if (!this.scanCycleActive) {
        this.log("⚠️  Scan cycle stopped");
        return;
      }

      try {
        this.log(`🔍 Starting scan (${scanTime}ms scan, ${restTime}ms rest)...`);
        // Start scanning - _startScan will handle the scanning state and events
        await this._startScan();

        // Scan for the specified duration
        await new Promise((resolve) => setTimeout(resolve, scanTime));

        // Stop scanning - _stopScan will handle the scanning state and events
        await this._stopScan();

        // Rest before next scan
        this.log(`Resting for ${restTime}ms before next scan...`);
        await new Promise((resolve) => setTimeout(resolve, restTime));

        // Continue the cycle
        if (this.scanCycleActive) {
          setImmediate(scanCycle);
        }
      } catch (error) {
        this.logError(`Error in scan cycle: ${error.message}`);
        this.emit("error", error);

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 10000));
        if (this.scanCycleActive) {
          setImmediate(scanCycle);
        }
      }
    };

    // Start the first scan cycle
    setImmediate(scanCycle);
  }

  /**
   * Stop the current BLE scan
   * @private
   * @returns {Promise<boolean>} Resolves with true if scan was stopped successfully
   */
  async _stopScan() {
    if (!this.scanning || this.isStopping) {
      this.log("Not currently scanning or already stopping", "debug");
      return true;
    }

    this.isStopping = true;
    this.log(`Scan complete. Discovered ${this.deviceUpdates ? this.deviceUpdates.size : 0} devices in this scan cycle.`);
    
    try {
      this.log("Calling noble.stopScanning()", "debug");
      noble.stopScanning();
      // The global 'scanStop' handler (_handleScanStop) will take care of the rest.
    } catch (error) {
      this.logError(`Native error during noble.stopScanning(): ${error.message}`);
      // If stopping fails, we should probably reset the state manually
      this.scanning = false;
      this.isStopping = false;
      this.emit("scanStop"); // Manually emit if noble fails
    }
    
    return true;
  }

  /**
   * Start the BLE scan
   * @private
   * @returns {Promise<boolean>} Resolves with true if scan started successfully
   */
  async _startScan() {
    if (this.scanning || this.isStarting) {
      this.log("Scan start already in progress.", "debug");
      return;
    }

    this.isStarting = true;
    this.isStopping = false;

    if (!noble) {
      this.logError("Noble module is not available");
      this.isStarting = false; // Reset lock
      return;
    }

    if (noble.state !== "poweredOn") {
      this.log(
        `Waiting for Bluetooth to be powered on (current state: ${noble.state})`,
        "debug"
      );
      this.isStarting = false; // Release lock while we wait
      noble.once("stateChange", (state) => {
        if (state === "poweredOn") {
          this._startScan(); // Re-call to try again
        } else {
          this.log(`Bluetooth state changed to ${state}, not starting scan.`);
        }
      });
      return;
    }

    this.log("Starting BLE scan...", "debug");

    try {
      noble.startScanning([], true, (error) => {
        if (error) {
          this.logError(`Error during scan: ${error.message}`);
          this.emit("error", error);
        }
      });

      if (this.scanDuration > 0) {
        if (this.scanTimeout) clearTimeout(this.scanTimeout);
        this.scanTimeout = setTimeout(() => {
          this.log(`Stopping scan after ${this.scanDuration}ms`, "debug");
          this._stopScan().catch((e) => {
            this.logError(`Error stopping scan: ${e.message}`);
          });
        }, this.scanDuration);
      }
    } catch (error) {
      this.logError(`Exception during noble.startScanning(): ${error.message}`);
      this.isStarting = false; // Reset lock on catastrophic failure
      this.emit("error", error);
    }
  }

  /**
        break;

      default:
        this.log(`Unhandled Bluetooth state: ${state}`, "warn");
    }
  }

  /**
   * Handle discovery of a BLE peripheral
   * @param {Object} peripheral - The discovered BLE peripheral
   * @private
   */
  async _handleDeviceDiscovery(peripheral) {
    try {
      // Skip if we're not scanning
      if (!this.scanning) {
        this.log("⚠️  Skipping device discovery - not currently scanning", "debug");
        return;
      }
      
      // Extract device information
      const { id, address, addressType, rssi, advertisement } = peripheral;
      const { localName, txPowerLevel, manufacturerData } = advertisement;

      // Use MAC address if available (Linux/Windows), otherwise use system UUID (macOS/iOS)
      // This ensures consistent IDs across platforms where possible
      const deviceId = address || id;

      // Create device info object
      const deviceInfo = {
        id: deviceId,
        systemId: id,  // Keep original system ID for reference
        address,       // MAC address (if available)
        addressType,
        rssi,
        name:
          localName ||
          (address ? `Unknown (${address})` : `Unknown (${id.slice(-6)})`),
        userLabel: null,  // User-defined label (set via updateBluetoothDeviceMetadata)
        txPower: txPowerLevel,
        lastSeen: new Date().toISOString(),
        state: peripheral.state,
        manufacturerData: manufacturerData
          ? manufacturerData.toString("hex")
          : null,
      };

      // Store manufacturer ID if available
      if (manufacturerData && manufacturerData.length >= 2) {
        // Extract manufacturer ID from the first 2 bytes (little endian)
        const manufacturerId = manufacturerData.readUInt16LE(0);
        deviceInfo.manufacturerId = manufacturerId;
        
        // Debug logging for Ruuvi devices
        if (manufacturerId === 0x0499) {
          this.log(`[RUUVI] Device ${deviceId} manufacturer data: ${manufacturerData.toString('hex')}`);
          this.log(`[RUUVI] Manufacturer data length: ${manufacturerData.length}`);
        }
        
        // Parse sensor data using registered parsers
        const parsedData = this._parseManufacturerData(manufacturerData, deviceId);
        if (parsedData) {
          deviceInfo.sensorData = parsedData;
          this.log(`Parsed sensor data for device ${deviceId}:`, JSON.stringify(parsedData, null, 2));
          
          // Always emit sensor data event - StateManager will handle it for selected devices
          this.emit("device:data", { id: deviceId, data: parsedData });
        } else if (manufacturerId === 0x0499) {
          this.log(`[RUUVI] Failed to parse data for device ${deviceId}`);
        }
      }

      // Update device in device manager
      await this.deviceManager.registerDevice(deviceInfo.id, deviceInfo);
      
      // Check if device is in selectedDevices Set
      const isSelected = this.deviceManager.selectedDevices.has(deviceInfo.id);

      // Emit both event names to be safe
      this.emit("deviceDiscovered", deviceInfo);
      this.emit("device:discovered", deviceInfo);
    } catch (error) {
      this.log(`Error handling device discovery: ${error.message}`, "error");
    }
  }

  /**
   * Parse manufacturer data using registered parsers
   * @param {Buffer} manufacturerData - Raw manufacturer data buffer
   * @param {string} deviceId - Device ID to retrieve encryption key from metadata
   * @returns {Object|null} - Parsed data or null if no parser found
   * @private
   */
  _parseManufacturerData(manufacturerData, deviceId) {
    if (!manufacturerData || !manufacturerData.length) {
      return null;
    }

    try {
      // Debug: Check manufacturer ID first
      const manufacturerId = manufacturerData.readUInt16LE(0);
      
      // Use the findParserFor method to get the appropriate parser
      const parser = this.parserRegistry
        ? this.parserRegistry.findParserFor(manufacturerData)
        : null;
      
      if (!parser) {
        return null;
      }

      // Get device metadata to check for encryption key
      const device = this.deviceManager.getDevice(deviceId);
      const encryptionKey = device?.metadata?.encryptionKey;

      // Set encryption key on parser instance if available
      if (encryptionKey && parser.encryptionKey !== encryptionKey) {
        parser.encryptionKey = encryptionKey;
      }

      // Parse the data using the parser's parse method
      const result = parser.parse(manufacturerData);
      
      return result;
    } catch (error) {
      this.log(`Error parsing manufacturer data: ${error.message}`, "error");
      return null;
    }
  }
  
  /**
   * Handle BLE state change events
   * @param {string} state - The new BLE state
   * @private
   */
  _handleStateChange(state) {
    this.log(`Bluetooth adapter state changed: ${state}`, "debug");
    
    // Update state in state manager if available
    if (this.stateManager) {
      const stateInfo = {
        state: state,
        error: state === 'poweredOn' ? null : `Bluetooth state: ${state}`
      };
      
      this.stateManager.updateBluetoothStatus(stateInfo);
    }

    switch (state) {
      case "poweredOn":
        this.log("Bluetooth adapter is powered on and ready");
        this.emit("poweredOn");
        this.emit("ready");
        break;

      case "poweredOff":
        this.log("Bluetooth adapter is powered off");
        this.emit("poweredOff");
        this._stopScan().catch((err) => {
          this.log(`Error stopping scan on power off: ${err.message}`, "error");
        });
        break;

      case "unauthorized":
        this.log("Bluetooth adapter is unauthorized", "error");
        this.emit("unauthorized");
        this.emit("error", new Error("Bluetooth adapter is unauthorized"));
        this._stopScan().catch((err) => {
          this.log(
            `Error stopping scan on unauthorized: ${err.message}`,
            "error"
          );
        });
        break;

      case "unsupported":
        this.log("Bluetooth adapter is not supported", "error");
        this.emit("unsupported");
        this.emit("error", new Error("Bluetooth adapter is not supported"));
        break;

      case "resetting":
        this.log("Bluetooth adapter is resetting...", "debug");
        this.emit("resetting");
        break;

      default:
        this.log(`Unhandled Bluetooth state: ${state}`, "warn");
    }
  }

  /**
   * Register a parser for a specific manufacturer ID
   * @param {number} manufacturerId - The manufacturer ID to register the parser for
   * @param {Object} parser - The parser object with a parse method
   * @returns {boolean} True if the parser was registered successfully
   */
  registerParser(manufacturerId, parser) {
    this.log(`registerParser called with manufacturerId: 0x${manufacturerId.toString(16).toUpperCase()}`);
    this.log(`Parser details:`, {
      type: typeof parser,
      hasParse: typeof parser.parse === 'function',
      hasMatches: typeof parser.matches === 'function',
      name: parser.name || parser.constructor?.name,
      properties: Object.keys(parser)
    });
    
    if (
      !this.parserRegistry ||
      typeof this.parserRegistry.registerParser !== "function"
    ) {
      this.log(`ERROR: Parser registry not available or missing registerParser method`);
      this.log(
        "Parser registry not available or missing registerParser method",
        "warn"
      );
      return false;
    }

    try {
      // First check if the parser is already registered to avoid duplicates
      const existingParsers = this.parserRegistry.getByManufacturer(manufacturerId);
      this.log(`Existing parsers for manufacturerId 0x${manufacturerId.toString(16).toUpperCase()}:`, 
                 existingParsers ? existingParsers.size : 0);
      
      // Pass manufacturerId directly as the first parameter, not as an object
      this.log(`Calling parserRegistry.registerParser with manufacturerId:`, manufacturerId);
      const result = this.parserRegistry.registerParser(manufacturerId, parser);
      this.log(`registerParser call completed, result:`, result);
      
      // Verify the parser was added to the manufacturer map
      const mfrParsers = this.parserRegistry.manufacturerParsers.get(manufacturerId);
      this.log(`After registration, manufacturer map for 0x${manufacturerId.toString(16).toUpperCase()} has:`, 
                 mfrParsers ? mfrParsers.size : 0, 'parsers');
      
      // Verify registration worked
      const allParsers = this.parserRegistry.getAllParsers ? this.parserRegistry.getAllParsers() : [];
      this.log(`After registration, total parsers:`, allParsers.size || 0);
      
      // Check if our parser is in the manufacturers map
      const manufacturerParsers = this.parserRegistry.manufacturerParsers?.get?.(manufacturerId);
      this.log(`Parsers for manufacturerId 0x${manufacturerId.toString(16).toUpperCase()}:`, 
                 manufacturerParsers ? manufacturerParsers.size : 'none');
      
      this.log(
        `Registered parser for manufacturer ID: 0x${manufacturerId
          .toString(16)
          .toUpperCase()}`
      );
      return true;
    } catch (error) {
      this.log(`ERROR registering parser:`, error);
      this.log(`Failed to register parser: ${error.message}`, "error");
      return false;
    }
  }

  /**
   * Get devices matching the specified filters
   * @param {Object} [filters] - Filter criteria
   * @param {string} [filters.type] - Device type to filter by
   * @param {boolean} [filters.selected] - Whether the device is selected
   * @param {boolean} [filters.connected] - Whether the device is connected
   * @returns {Array<Object>} Filtered list of devices
   */
  getDevices(filters = {}) {
    if (!this.deviceManager) {
      this.log("Device manager not initialized", "warn");
      return [];
    }

    // Get devices from the in-memory map
    let devices = [];
    
    // First check if the devices Map exists and has entries
    if (this.deviceManager.devices && this.deviceManager.devices.size > 0) {
      devices = Array.from(this.deviceManager.devices.values());
      this.log(`Retrieved ${devices.length} devices from in-memory map`, "debug");
      this.log(`Retrieved ${new Set(devices.map(d => d.id)).size} unique devices from in-memory set`, "debug");
    } else {
      // If no devices in memory, check if we have any in the discoveryService
      try {
        // Check if we have access to the discovery service
        const discoveryService = global.discoveryService || (global.services && global.services.discovery);
        if (discoveryService && typeof discoveryService.getDevices === 'function') {
          const discoveredDevices = discoveryService.getDevices() || [];
          this.log(`Retrieved ${discoveredDevices.length} devices from discovery service`, "debug");
          
          // Add these devices to our collection
          discoveredDevices.forEach(device => {
            if (device && device.id && !this.deviceManager.devices.has(device.id)) {
              this.deviceManager.registerDevice(device.id, device);
            }
          });
          
          // Update our devices array
          devices = Array.from(this.deviceManager.devices.values());
        }
      } catch (error) {
        this.log(`Error accessing discovery service: ${error.message}`, "error");
      }
    }

    // Apply filters
    if (filters.type) {
      devices = devices.filter((device) => device.type === filters.type);
    }

    if (filters.selected !== undefined) {
      devices = devices.filter(
        (device) => this.deviceManager.selectedDevices.has(device.id) === filters.selected
      );
    }

    if (filters.connected !== undefined) {
      devices = devices.filter(
        (device) => device.isConnected === filters.connected
      );
    }

    return devices;
  }

  /**
   * Get all selected devices
   * @returns {Array<Object>} - Array of selected devices
   */
  getSelectedDevices() {
    return this.getDevices({ selected: true });
  }

  /**
   * Get all connected devices
   * @returns {Array<Object>} - Array of connected devices
   */
  getConnectedDevices() {
    return this.getDevices({ connected: true });
  }

  /**
   * Get devices by type
   * @param {string} type - The device type to filter by
   * @returns {Array<Object>} - Array of devices of the specified type
   */
  getDevicesByType(type) {
    return this.getDevices({ type });
  }

  /**
   * Update device metadata
   * @param {string} deviceId - The ID of the device
   * @param {Object} metadata - Metadata to update
   * @returns {Promise<boolean>} - True if successful, false otherwise
   */
  async updateDeviceMetadata(deviceId, metadata) {
    try {
      const device = await this.deviceManager.updateDeviceMetadata(
        deviceId,
        metadata
      );
      if (device) {
        this.emit("device:updated", { ...device });
        return true;
      }
      return false;
    } catch (error) {
      this.log(
        `Failed to update device metadata for ${deviceId}: ${error.message}`,
        "error"
      );
      this.emit(
        "error",
        new Error(`Device metadata update error: ${error.message}`)
      );
      return false;
    }
  }

  /**
   * Set device metadata (alias for updateDeviceMetadata)
   * @param {string} deviceId - The ID of the device
   * @param {Object} metadata - Metadata to update
   * @returns {Promise<boolean>} - True if successful, false otherwise
   */
  async setDeviceMetadata(deviceId, metadata) {
    return this.updateDeviceMetadata(deviceId, metadata);
  }

  /**
   * Select a device for detailed monitoring and data parsing
   * @param {string} deviceId - The ID of the device to select
   * @returns {Promise<boolean>} - True if the device was selected, false if already selected
   */
  async selectDevice(deviceId) {
    if (!this.deviceManager) {
      this.log(`Cannot select device: Device manager not available`, "error");
      return false;
    }
    
    try {
      const result = await this.deviceManager.selectDevice(deviceId);
      if (result) {
        this.log(`Device ${deviceId} selected for monitoring`, "info");
        this.emit("device:selected", { id: deviceId });
      }
      return result;
    } catch (error) {
      this.log(`Error selecting device ${deviceId}: ${error.message}`, "error");
      return false;
    }
  }
  
  /**
   * Unselect a device to stop detailed monitoring and data parsing
   * @param {string} deviceId - The ID of the device to unselect
   * @returns {Promise<boolean>} - True if the device was unselected, false if not selected
   */
  async unselectDevice(deviceId) {
    if (!this.deviceManager) {
      this.log(`Cannot unselect device: Device manager not available`, "error");
      return false;
    }
    
    try {
      const result = await this.deviceManager.unselectDevice(deviceId);
      if (result) {
        this.log(`Device ${deviceId} unselected from monitoring`, "info");
        this.emit("device:unselected", { id: deviceId });
      }
      return result;
    } catch (error) {
      this.log(`Error unselecting device ${deviceId}: ${error.message}`, "error");
      return false;
    }
  }
}

export default BluetoothService;
