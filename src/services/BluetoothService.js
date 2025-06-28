//@ts-nocheck
import noble from "@abandonware/noble";
import { promises as fs } from "fs";
import * as yaml from "js-yaml";
import path from "path";
import { fileURLToPath, URL } from "url";
import { EventEmitter } from "events";
import { ParserRegistry } from "../bluetooth/parsers/ParserRegistry.js";
import { DeviceManager } from "../bluetooth/services/DeviceManager.js";
import { RuuviParser } from "../bluetooth/parsers/RuuviParser.js";
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
   * @property {number} [scanInterval] - Time between scans in ms
   * @property {string} [ymlPath] - Path to company identifiers YML file
   * @property {DeviceFilterOptions} [filters] - Device filtering options
   * @property {boolean} [autoSelectRuuvi] - Whether to automatically select Ruuvi devices when discovered
   * @property {boolean} [debug] - Enable debug logging
   * @property {string} [logLevel] - Logging level (e.g., 'debug', 'info', 'warn', 'error')
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
    
    // Map to store device updates during a scan cycle
    this.deviceUpdates = new Map(); // Map of device ID -> device info
    this.lastDbUpdateTime = Date.now();
    this.dbUpdateInterval = 5000; // Update database every 5 seconds

    // Initialize event handlers with proper binding
    this._onDiscover = (peripheral) => this._handleDeviceDiscovery(peripheral);
    this._onStateChange = (state) => this._handleStateChange(state);
    this._onScanStart = () => this._handleScanStart();
    this._onScanStop = () => this._handleScanStop();
  }

  /**
   * Start the Bluetooth service
   * @override
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isRunning) {
      this.log("Bluetooth service is already running");
      return;
    }

    try {
      this.log("Starting Bluetooth service...");
      
      // Debug RuuviParser import
      console.log("[BluetoothService] RuuviParser import check:", {
        exists: !!RuuviParser,
        type: typeof RuuviParser,
        isClass: typeof RuuviParser === 'function',
        manufacturerId: RuuviParser ? RuuviParser.manufacturerId : undefined,
        staticParse: RuuviParser ? (typeof RuuviParser.parse === 'function') : undefined,
        prototype: RuuviParser ? Object.getOwnPropertyNames(RuuviParser.prototype || {}) : undefined
      });

      // Initialize the parser registry if not already done
      if (!this.parserRegistry) {
        this.parserRegistry = new ParserRegistry();
        console.log("[BluetoothService] Created new ParserRegistry instance");
        
        // Use the RuuviParser instance directly - it now has the expected interface
        console.log(`[BluetoothService] Using RuuviParser instance with manufacturerId: 0x${RuuviParser.manufacturerId.toString(16).toUpperCase()}`);
        console.log(`[BluetoothService] RuuviParser instance:`, {
          name: RuuviParser.name,
          hasParse: typeof RuuviParser.parse === 'function',
          hasMatches: typeof RuuviParser.matches === 'function'
        });
        
        // Register the RuuviParser with the correct manufacturer ID
        const registrationResult = this.registerParser(RuuviParser.manufacturerId, RuuviParser);
        console.log(`[BluetoothService] RuuviParser registration result: ${registrationResult}`);
        
        // Verify registration
        const allParsers = this.parserRegistry.getAllParsers ? this.parserRegistry.getAllParsers() : new Map();
        console.log(`[BluetoothService] Total parsers after registration: ${allParsers.size || 'unknown'}`);
        
        this.log(`Registered RuuviParser for manufacturer ID: 0x${RuuviParser.manufacturerId.toString(16).toUpperCase()}`);
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

      // Initialize the BLE stack
      await this._initNoble();

      // Start the scan cycle
      await this._startScanCycle();

      this.isRunning = true;
      this.emit("started");
      this.log("Bluetooth service started successfully");
    } catch (error) {
      this.logError(`Failed to start Bluetooth service: ${error.message}`);
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
      console.error("Error during Bluetooth service cleanup:", error);
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
      console.log("\n=== YAML CHECK ===");
      console.log("Current working directory:", process.cwd());
      console.log("YML path:", ymlPath);

      // Check if the file exists
      try {
        await fs.access(ymlPath);
        console.log("YAML file exists");
      } catch (err) {
        console.error("YAML file does not exist:", err);
        return;
      }

      // Read the YAML file
      const fileContent = await fs.readFile(ymlPath, "utf8");
      console.log(
        "File content (first 200 chars):",
        fileContent.substring(0, 200)
      );

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
      this.log(`Error loading company identifiers: ${error.message}`, "error");
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
    this.log("BLE scan started", "debug");
    // Clear the map of device updates for this new scan cycle
    this.deviceUpdates.clear();
    this.emit("scanStart");
  }

  /**
   * Handle BLE scan stop events
   * @private
   */
  async _handleScanStop() {
    this.log("BLE scan stopped", "debug");
    
    // Process all device updates at the end of the scan cycle
    if (this.deviceUpdates.size > 0 && this.deviceManager) {
      this.log(`Processing ${this.deviceUpdates.size} device updates`, "debug");
      
      try {
        // Process device updates in batches to avoid overwhelming the database
        const batchSize = 10;
        const devices = Array.from(this.deviceUpdates.values());
        
        for (let i = 0; i < devices.length; i += batchSize) {
          const batch = devices.slice(i, i + batchSize);
          await Promise.all(batch.map(async (deviceInfo) => {
            try {
              await this.deviceManager.registerDevice(deviceInfo.id, deviceInfo);
            } catch (error) {
              this.log(`Error updating device ${deviceInfo.id}: ${error.message}`, "error");
            }
          }));
        }
        
        this.log(`Completed processing ${this.deviceUpdates.size} device updates`, "debug");
      } catch (error) {
        this.log(`Error processing device updates: ${error.message}`, "error");
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
      this.log("Scan cycle already active");
      return;
    }

    this.scanCycleActive = true;
    this.log("Starting BLE scan cycle");

    const scanTime = this.scanTime || 10000; // 10 seconds
    const restTime = this.restTime || 5000; // 5 seconds

    const scanCycle = async () => {
      if (!this.scanCycleActive) {
        return;
      }

      try {
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
   * Stop the BLE scan cycle
   * @private
   * @returns {Promise<void>}
   */
  async _stopScanCycle() {
    this.scanCycleActive = false;
    this.log("Stopping BLE scan cycle");

    // Stop any active scan
    if (this.scanning) {
      await this._stopScan();
    }
  }

  /**
   * Stop the current BLE scan
   * @private
   * @returns {Promise<boolean>} Resolves with true if scan was stopped successfully
   */
  async _stopScan() {
    if (!this.scanning) {
      this.log("No active scan to stop", "debug");
      return true;
    }

    return new Promise((resolve, reject) => {
      let cleanup = () => {};
      let timeout;
      let scanStopped = false;

      const onScanStop = () => {
        if (scanStopped) return;
        scanStopped = true;

        this.log("BLE scan stopped event received", "debug");
        cleanup();
        this.scanning = false;
        this.emit("scanStop");
        resolve(true);
      };

      const onError = (error) => {
        this.logError(`Error stopping BLE scan: ${error.message}`, error);
        if (!scanStopped) {
          cleanup();
          this.emit("error", error);
          reject(error);
        }
      };

      // Cleanup function to remove all listeners
      cleanup = () => {
        this.log("Cleaning up stopScan listeners", "debug");
        clearTimeout(timeout);
        try {
          noble.removeListener("scanStop", onScanStop);
          noble.removeListener("error", onError);
        } catch (e) {
          this.logError(`Error during stopScan cleanup: ${e.message}`);
        }
      };

      // Set up event listeners
      try {
        noble.once("scanStop", onScanStop);
        noble.once("error", onError);
        this.log("Stop scan event listeners set up", "debug");
      } catch (e) {
        this.logError(`Error setting up stopScan listeners: ${e.message}`);
        reject(e);
        return;
      }

      // Stop scanning
      try {
        this.log("Calling noble.stopScanning()", "debug");
        
        try {
          noble.stopScanning();
          this.log("Stop scan initiated, waiting for confirmation...", "debug");
        } catch (nativeError) {
          // Catch and log native errors but don't let them crash the process
          this.logError(`Native error during scan stop: ${nativeError.message || 'Unknown error'}`);
          this.emit("error", nativeError);
          
          // Force scan stop state since the native call failed
          scanStopped = true;
          this.scanning = false;
          this.emit("scanStop");
          cleanup();
          resolve(true);
          return;
        }

        // Set a timeout in case the scan doesn't stop
        timeout = setTimeout(() => {
          if (!scanStopped) {
            this.log("Warning: BLE scan stop timeout, forcing stop", "warn");
            scanStopped = true;
            this.scanning = false;
            this.emit("scanStop");
            cleanup();
            resolve(true);
          }
        }, 5000); // 5 second timeout
      } catch (error) {
        this.logError(`Exception in stopScanning: ${error.message}`);
        if (error.stack) {
          this.logError(`Stack trace: ${error.stack}`);
        }
        cleanup();
        reject(error);
      }
    }).catch((error) => {
      this.logError(`Error in _stopScan: ${error.message}`);
      if (error.stack) {
        this.logError(`Stack trace: ${error.stack}`);
      }
      throw error; // Re-throw to be caught by the caller
    });
  }

  /**
   * Start the BLE scan
   * @private
   * @returns {Promise<boolean>} Resolves with true if scan started successfully
   */
  async _startScan() {
    // Double-check if scanning is already in progress
    if (this.scanning) {
      this.log("Scan already in progress", "debug");
      return true;
    }

    // Simple check for noble
    if (!noble) {
      this.logError("Noble module is not available");
      return false;
    }

    // Log the current state for debugging
    this.log(`Noble state: ${noble.state}`, "debug");

    // If not powered on, wait for state change
    if (noble.state !== "poweredOn") {
      this.log(
        `Waiting for Bluetooth to be powered on (current state: ${noble.state})`,
        "debug"
      );
      return new Promise((resolve) => {
        const onStateChange = (state) => {
          if (state === "poweredOn") {
            noble.removeListener("stateChange", onStateChange);
            this._startScan().then(resolve);
          }
        };
        noble.on("stateChange", onStateChange);
      });
    }

    return new Promise((resolve) => {
      // Mark that we're scanning
      this.scanning = true;
      
      // Set up a simple timeout to stop scanning after the specified duration
      if (this.scanDuration > 0) {
        this.scanTimeout = setTimeout(() => {
          this.log(`Stopping scan after ${this.scanDuration}ms`, "debug");
          this._stopScan().catch((e) => {
            this.logError(`Error stopping scan: ${e.message}`);
          });
        }, this.scanDuration);
      }
      
      // Start scanning with empty array (all services) and allow duplicates
      this.log("Starting BLE scan...", "debug");
      
      try {
        // Use the simplest possible call to startScanning, matching test-bluetooth.js
        try {
          noble.startScanning([], true);
          
          // Emit scan start event
          this.log("BLE scan started", "debug");
          this.emit("scanStart");
        } catch (nativeError) {
          // Catch and log native errors but don't let them crash the process
          this.logError(`Native error during scan start: ${nativeError.message || 'Unknown error'}`);
          this.emit("error", nativeError);
        }
        
        // Resolve the promise - we consider it successful even if there was a native error
        // because we want the process to continue
        resolve(true);
      } catch (error) {
        // Handle any synchronous errors
        this.logError(`Exception during scan start: ${error.message}`);
        this.scanning = false;
        if (this.scanTimeout) {
          clearTimeout(this.scanTimeout);
          this.scanTimeout = null;
        }
        this.emit("error", error);
        resolve(false);
      }
    });
  }

  /**
   * Handle BLE state change events
   * @param {string} state - The new BLE state
   * @private
   */
  _handleStateChange(state) {
    this.log(`Bluetooth adapter state changed: ${state}`, "debug");

    switch (state) {
      case "poweredOn":
        this.emit("poweredOn");
        break;

      case "poweredOff":
        this.emit("poweredOff");
        this._stopScan().catch((err) => {
          this.log(`Error stopping scan on power off: ${err.message}`, "error");
        });
        break;

      case "unauthorized":
        this.emit("unauthorized");
        this._stopScan().catch((err) => {
          this.log(
            `Error stopping scan on unauthorized: ${err.message}`,
            "error"
          );
        });
        break;

      case "unsupported":
        this.emit("unsupported");
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
   * Handle discovery of a BLE peripheral
   * @param {Object} peripheral - The discovered BLE peripheral
   * @private
   */
  async _handleDeviceDiscovery(peripheral) {
    try {
      // Skip if we're not scanning
      if (!this.scanning) {
        this.log("Skipping device discovery - not currently scanning", "debug");
        return;
      }

      // Extract device information
      const { id, address, addressType, rssi, advertisement } = peripheral;
      const { localName, txPowerLevel, manufacturerData } = advertisement;

      // Create device info object
      const deviceInfo = {
        id,
        address,
        addressType,
        rssi,
        name: localName || `Unknown (${address})`,
        txPower: txPowerLevel,
        lastSeen: new Date().toISOString(),
        state: peripheral.state,
        manufacturerData: manufacturerData
          ? manufacturerData.toString("hex")
          : null,
      };

      // Process manufacturer data if available
      if (manufacturerData && manufacturerData.length > 0) {
        const parsedData = this._parseManufacturerData(manufacturerData);
        if (parsedData) {
          Object.assign(deviceData, parsedData);
        }
      }

      // Update device in device manager
      this.deviceManager.updateDevice(deviceData);

      // Emit device discovered event
      this.emit("deviceDiscovered", deviceData);
    } catch (error) {
      this.log(`Error handling device discovery: ${error.message}`, "error");
    }
  }

  /**
   * Parse manufacturer data using registered parsers
   * @param {Buffer} manufacturerData - Raw manufacturer data buffer
   * @returns {Object|null} - Parsed data or null if no parser found
   * @private
   */
  _parseManufacturerData(manufacturerData) {
    if (!manufacturerData || !manufacturerData.length) return null;

    try {
      // Use the findParserFor method to get the appropriate parser
      const parser = this.parserRegistry
        ? this.parserRegistry.findParserFor(manufacturerData)
        : null;
      if (!parser) {
        // No parser found for this manufacturer
        return null;
      }

      // Parse the data using the parser's parse method
      return parser.parse(manufacturerData);
    } catch (error) {
      this.log(`Error parsing manufacturer data: ${error.message}`, "error");
      return null;
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
        this.log("Skipping device discovery - not currently scanning", "debug");
        return;
      }

      // Extract device information
      const { id, address, addressType, rssi, advertisement } = peripheral;
      const { localName, txPowerLevel, manufacturerData } = advertisement;
      
      // Check if we've already discovered this device in the current scan cycle
      const isNewDiscovery = !this.deviceUpdates.has(id);
      
      // Create device info object
      const deviceInfo = {
        id,
        address,
        addressType,
        rssi,
        name: localName || "Unknown",
        txPower: txPowerLevel,
        lastSeen: new Date(),
        manufacturerData: manufacturerData
          ? manufacturerData.toString("hex")
          : null,
      };

      // Check if this is a Ruuvi device by examining the manufacturer data
      let isRuuviDevice = false;
      if (manufacturerData && manufacturerData.length >= 2) {
        // Check for Ruuvi manufacturer ID (0x0499)
        const manufacturerId = manufacturerData.readUInt16LE(0);
        isRuuviDevice = (manufacturerId === 0x0499);
        
        if (isRuuviDevice && this.deviceManager && !this.deviceManager.isDeviceSelected(id)) {
          // Auto-select Ruuvi devices
          console.log(`[BluetoothService] Auto-selecting Ruuvi device: ${id}`);
          this.selectDevice(id).then(selected => {
            if (selected) {
              console.log(`[BluetoothService] Successfully selected Ruuvi device: ${id}`);
            }
          });
        }
      }
      
      // Parse manufacturer data for selected devices
      if (manufacturerData && this.parserRegistry && this.deviceManager && this.deviceManager.isDeviceSelected(id)) {
        try {
          // Log manufacturer data details
          const manufacturerId = manufacturerData.readUInt16LE(0);
          console.log(`[BluetoothService] Selected device ${id} has manufacturer ID: 0x${manufacturerId.toString(16).toUpperCase()}`);
          console.log(`[BluetoothService] Manufacturer data: ${manufacturerData.toString('hex')}`);
          
          // Check if we have any parsers registered
          const allParsers = this.parserRegistry.getAllParsers ? this.parserRegistry.getAllParsers() : new Set();
          console.log(`[BluetoothService] Total registered parsers: ${allParsers ? allParsers.size : 0}`);
          
          // Debug the parser registry state
          console.log(`[BluetoothService] Parser registry manufacturer map:`, {
            size: this.parserRegistry.manufacturerParsers ? this.parserRegistry.manufacturerParsers.size : 0,
            hasRuuviId: this.parserRegistry.manufacturerParsers ? this.parserRegistry.manufacturerParsers.has(0x0499) : false
          });
          
          // Log registered manufacturer IDs
          console.log(`[BluetoothService] Checking for parser for manufacturer ID: 0x${manufacturerId.toString(16).toUpperCase()}`);
          
          // First, identify which parser would handle this data
          const parser = this.parserRegistry.findParserFor(manufacturerData);
          if (parser) {
            console.log(`[BluetoothService] Using ${parser.constructor.name} for device ${id}`);
            
            // Parse the data
            const parsedData = parser.parse(manufacturerData);
            if (parsedData) {
              deviceInfo.parsedData = parsedData;
              
              // Log the parsed data in a more readable format
              const dataPreview = {};
              if (parsedData.temperature) dataPreview.temperature = parsedData.temperature.value;
              if (parsedData.humidity) dataPreview.humidity = parsedData.humidity.value;
              if (parsedData.pressure) dataPreview.pressure = parsedData.pressure.value;
              if (parsedData.battery) dataPreview.battery = parsedData.battery.voltage.value;
              
              console.log(`[BluetoothService] Parsed data for device ${id}: ${JSON.stringify(dataPreview)}`);
              
              // Emit a specific event for selected device data
              this.emit("device:data", { id, data: parsedData });
            } else {
              console.log(`[BluetoothService] Parser returned no data for device ${id}`);
            }
          } else {
            console.log(`[BluetoothService] No parser found for selected device ${id} with manufacturer ID: 0x${manufacturerId.toString(16).toUpperCase()}`);
          }
        } catch (error) {
          this.log(
            `Error parsing manufacturer data for ${id}: ${error.message}`,
            "error"
          );
        }
      }

      // Store the device info in our updates map
      this.deviceUpdates.set(id, deviceInfo);
      
      // Only emit discovery event if this is a new device in this scan cycle
      if (isNewDiscovery) {
        this.emit("device:discovered", deviceInfo);
      }
    } catch (error) {
      this.log(`Error in device discovery handler: ${error.message}`, "error");
    }
  }

  /**
   * Register a parser for a specific manufacturer ID
   * @param {number} manufacturerId - The manufacturer ID to register the parser for
   * @param {Object} parser - The parser object with a parse method
   * @returns {boolean} True if the parser was registered successfully
   */
  registerParser(manufacturerId, parser) {
    console.log(`[BluetoothService] registerParser called with manufacturerId: 0x${manufacturerId.toString(16).toUpperCase()}`);
    console.log(`[BluetoothService] Parser details:`, {
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
      console.log(`[BluetoothService] ERROR: Parser registry not available or missing registerParser method`);
      this.log(
        "Parser registry not available or missing registerParser method",
        "warn"
      );
      return false;
    }

    try {
      // First check if the parser is already registered to avoid duplicates
      const existingParsers = this.parserRegistry.getByManufacturer(manufacturerId);
      console.log(`[BluetoothService] Existing parsers for manufacturerId 0x${manufacturerId.toString(16).toUpperCase()}:`, 
                 existingParsers ? existingParsers.size : 0);
      
      // Pass manufacturerId as an object with manufacturerId property
      console.log(`[BluetoothService] Calling parserRegistry.registerParser with:`, { manufacturerId });
      const result = this.parserRegistry.registerParser({ manufacturerId }, parser);
      console.log(`[BluetoothService] registerParser call completed, result:`, result);
      
      // Verify the parser was added to the manufacturer map
      const mfrParsers = this.parserRegistry.manufacturerParsers.get(manufacturerId);
      console.log(`[BluetoothService] After registration, manufacturer map for 0x${manufacturerId.toString(16).toUpperCase()} has:`, 
                 mfrParsers ? mfrParsers.size : 0, 'parsers');
      
      // Verify registration worked
      const allParsers = this.parserRegistry.getAllParsers ? this.parserRegistry.getAllParsers() : [];
      console.log(`[BluetoothService] After registration, total parsers:`, allParsers.length || 0);
      
      // Check if our parser is in the manufacturers map
      const manufacturerParsers = this.parserRegistry.manufacturerParsers?.get?.(manufacturerId);
      console.log(`[BluetoothService] Parsers for manufacturerId 0x${manufacturerId.toString(16).toUpperCase()}:`, 
                 manufacturerParsers ? manufacturerParsers.size : 'none');
      
      this.log(
        `Registered parser for manufacturer ID: 0x${manufacturerId
          .toString(16)
          .toUpperCase()}`
      );
      return true;
    } catch (error) {
      console.log(`[BluetoothService] ERROR registering parser:`, error);
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
    if (!this.deviceManager || !this.deviceManager.devices) {
      this.log("Device manager not initialized", "warn");
      return [];
    }

    let devices = Array.from(this.deviceManager.devices.values());

    if (filters.type) {
      devices = devices.filter((device) => device.type === filters.type);
    }

    if (filters.selected !== undefined) {
      devices = devices.filter(
        (device) => device.isSelected === filters.selected
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
