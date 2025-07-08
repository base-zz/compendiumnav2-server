import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { stateData } from "../state/StateData.js";
import ContinuousService from "./ContinuousService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class NewStateServiceDemo extends ContinuousService {
  constructor() {
    super("newStateServiceDemo");
    // this.log = console.log.bind(console, "[StateService]");

    // Configuration
    this.config = {
      dbPath:
        process.env.DATABASE_PATH || path.join(__dirname, "../signalk_dev.db"),
      batchSize: 1000,
      defaultPlaybackSpeed: 1.0,
      mockDataUpdateInterval: 5000,
    };

    // State
    this.db = null;
    this.recordedData = [];
    this.currentIndex = 0;
    this.isPlaying = false;
    this.playbackInterval = null;
    this.playbackSpeed = 1.0;
    this.isReady = false;
    this.mockDataInterval = null;

    // Mock data state
    this.mockState = {
      tanks: {
        freshWater1: { level: 100 },
        freshWater2: { level: 95 },
        wasteWater1: { level: 10 },
        wasteWater2: { level: 15 },
        blackWater1: { level: 20 },
        blackWater2: { level: 25 },
      },
      batteries: {
        battery1: { level: 95, voltage: 12.5, current: 5.2 },
        battery2: { level: 90, voltage: 12.3, current: 4.8 },
        battery3: { level: 85, voltage: 12.4, current: 5.0 },
        battery4: { level: 80, voltage: 12.2, current: 4.5 },
      },
    };

    // Initialize state data structures
    this._initializeState();
  }

  /**
   * Returns the current state object.
   * @returns {object} The application state.
   */
  getState() {
    return stateData;
  }

  /**
   * Initialize the state data structures according to Signal K specification
   * @private
   */
  _initializeState() {
    try {
      // Ensure we have the required state data structure
      if (!stateData) {
        throw new Error("stateData is not available");
      }

      // Initialize the full Signal K state structure if it doesn't exist
      if (!stateData.vessels) {
        stateData.vessels = {};
      }

      // Ensure we have a self vessel
      const vesselId = "self";
      if (!stateData.vessels[vesselId]) {
        stateData.vessels[vesselId] = {};
      }

      // Initialize navigation structure
      if (!stateData.vessels[vesselId].navigation) {
        stateData.vessels[vesselId].navigation = {};
      }

      // Initialize position structure
      if (!stateData.vessels[vesselId].navigation.position) {
        stateData.vessels[vesselId].navigation.position = {
          latitude: null,
          longitude: null,
          altitude: 0,
          timestamp: null,
          source: "demo",
          $source: "demo",
          pgn: 129025,
          sxtype: "GNSS",
        };
      }

      // Initialize course structure
      if (!stateData.vessels[vesselId].navigation.courseOverGroundTrue) {
        stateData.vessels[vesselId].navigation.courseOverGroundTrue = {
          value: null,
          timestamp: null,
          $source: "demo",
          pgn: 129026,
        };
      }

      // Initialize speed structure
      if (!stateData.vessels[vesselId].navigation.speedOverGround) {
        stateData.vessels[vesselId].navigation.speedOverGround = {
          value: null,
          timestamp: null,
          $source: "demo",
          pgn: 128259,
        };
      }

      this.log("State initialized with Signal K structure");
      // this.log("State structure:", {
      //   hasVessels: !!stateData.vessels,
      //   hasSelfVessel: !!(stateData.vessels && stateData.vessels.self),
      //   hasPosition: !!stateData.vessels?.self?.navigation?.position,
      //   hasBatchUpdate: typeof stateData.batchUpdate === "function",
      // });
    } catch (error) {
      this.log("Error initializing state:", error);
      throw error;
    }
  }

  // ====================
  // Lifecycle Methods
  // ====================

  async start() {
    await super.start();
    this.log(`[StateService] Starting service at ${new Date().toISOString()}`);
    this.isReady = false;

    try {
      // Initialize database connection
      await this.connectToDatabase();

      // Load initial state data
      const initialStateLoaded = await this.loadInitialData();

      if (!initialStateLoaded) {
        this.log("Warning: Could not load initial state from database");
        // Initialize with default state structure
        this._initializeState();
      }

      // Start mock data generation
      this.startMockDataUpdates();

      // Mark as ready after initial data is loaded
      this.isReady = true;
      this.emit("ready");

      // Log initial state before loading any data
      // this.log("[StateService] Initial state before loading data:", {
      //   hasStateData: !!stateData,
      //   hasVessels: !!(stateData && stateData.vessels),
      //   hasSelfVessel: !!(
      //     stateData &&
      //     stateData.vessels &&
      //     stateData.vessels.self
      //   ),
      // });

      this.isReady = true;
      this.emit && this.emit("ready");
    } catch (error) {
      this.log("Error starting service:", error);
      this.isReady = false;
      throw error;
    }
  }

  async stop() {
    this.log("Stopping State Service");
    this.stopPlayback();
    this.stopMockDataUpdates();

    if (this.db) {
      await new Promise((resolve) => {
        this.db.close(resolve);
      });
      this.db = null;
    }

    await super.stop();
    this.log("Service stopped");
  }

  // ====================
  // Database Methods
  // ====================

  async connectToDatabase() {
    return new Promise((resolve, reject) => {
      this.log(`Connecting to database: ${this.config.dbPath}`);

      this.db = new sqlite3.Database(this.config.dbPath, (err) => {
        if (err) {
          this.log("Database connection error:", err.message);
          return reject(err);
        }

        this.log("Database connected");
        resolve();
      });
    });
  }

  async query(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  }

  async loadInitialData() {
    try {
      // Load recorded data
      await this.loadRecordedData();

      this.log(
        "[StateService] Loaded ---->>>>>>>>>>>>",
        this.recordedData.length,
        "rows from DB"
      );

      // Start with the first data point
      if (this.recordedData.length > 0) {
        this.startPlayback();
        
        // Mark as ready and emit ready event after data is loaded
        this.isReady = true;
        this.emit("ready");
        this.log("[StateService] Emitted ready event after loading initial data");
        
        return true;
      }
      return false;
    } catch (error) {
      this.log("Error loading initial data:", error);
      throw error;
    }
  }

  async loadRecordedData() {
    try {
      this.log("Loading filtered patches from database...");

      // First, ensure the filtered table exists
      await this.ensureFilteredTable();

      // Load only filtered patches with valid position data
      const rows = await this.query(`
        SELECT * 
        FROM sk_patches_filtered 
        ORDER BY timestamp ASC 
        LIMIT 3000
      `);

      this.recordedData = rows.map((row) => ({
        timestamp: new Date(row.timestamp).getTime(),
        data: JSON.parse(row.patch_json),
      }));

      this.log(
        `Loaded ${this.recordedData.length} filtered records from database`
      );

      if (this.recordedData.length > 0) {
        const first = new Date(this.recordedData[0].timestamp);
        const last = new Date(
          this.recordedData[this.recordedData.length - 1].timestamp
        );
        this.log(
          `Data time range: ${first.toISOString()} to ${last.toISOString()}`
        );

        // Start playback automatically
        this.startPlayback();
      } else {
        this.log("No filtered records found in database");
      }

      return this.recordedData;
    } catch (error) {
      this.log("Error loading filtered data:", error);
      throw error;
    }
  }

  async ensureFilteredTable() {
    try {
      // Check if filtered table exists
      const tableExists = await this.query(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='sk_patches_filtered'
    `);

      if (tableExists.length === 0) {
        this.log("Creating filtered patches table...");

        // Create the filtered table with the same structure as sk_patches
        await this.query(`
        CREATE TABLE sk_patches_filtered AS
        SELECT * FROM sk_patches
        WHERE json_extract(patch_json, '$.navigation.position.latitude') IS NOT NULL
        AND json_extract(patch_json, '$.navigation.position.longitude') IS NOT NULL
      `);

        this.log("Created sk_patches_filtered table with position data only");
      }
    } catch (error) {
      this.log("Error ensuring filtered table:", error);
      throw error;
    }
  }

  // ====================
  // Playback Methods
  // ====================

  startPlayback(speed = this.config.defaultPlaybackSpeed) {
    console.log("FIRST Starting playback at", speed, "x speed");
    if (this.isPlaying) return;

    this.log(`Starting playback at ${speed}x speed`);
    this.isPlaying = true;
    this.playbackSpeed = speed;
    this.currentIndex = 0;

    // Start with the first data point
    setTimeout(() => {
      this.playNext();
    }, 1000);
  }

  stopPlayback() {
    if (!this.isPlaying) return;

    this.log("Stopping playback");
    this.isPlaying = false;

    if (this.playbackInterval) {
      clearTimeout(this.playbackInterval);
      this.playbackInterval = null;
    }
  }

  setPlaybackSpeed(speed) {
    if (!this.isPlaying) return;

    this.playbackSpeed = speed;
    this.log(`Playback speed set to ${speed}x`);

    // Restart the playback with the new speed
    if (this.playbackInterval) {
      clearTimeout(this.playbackInterval);
      this.playNext();
    }
  }

  playNext() {
    try {
      // Check if we have data to play
      if (!this.recordedData || !Array.isArray(this.recordedData)) {
        this.log("No recorded data available");
        return;
      }

      // Handle end of data or stopped playback
      if (!this.isPlaying || this.currentIndex >= this.recordedData.length) {
        if (this.isPlaying) {
          this.currentIndex = 0;
          this.log("Reached end of data, looping back to start");
        } else {
          this.log("Playback stopped or no more data");
          return;
        }
      }

      // Get current data point
      const currentData = this.recordedData[this.currentIndex];
      if (!currentData) {
        this.log(`No data at index ${this.currentIndex}, skipping`);
        this.currentIndex++;
        return this.playNext(); // Skip to next point
      }

      if (this.currentIndex % 10 === 0) {
        this.log(
          `Processing data point ${this.currentIndex + 1}/${
            this.recordedData.length
          }`
        );
      }

      // Apply the data to the state
      try {
        this.applyDataPoint(currentData);
      } catch (error) {
        this.log(`Error applying data point: ${error.message}`);
      }

      // Move to next index
      this.currentIndex++;

      // Schedule the next update if there's more data
      if (this.currentIndex < this.recordedData.length) {
        const nextData = this.recordedData[this.currentIndex];
        if (!nextData) {
          this.log(`No next data at index ${this.currentIndex}, skipping`);
          return this.playNext(); // Skip to next point
        }

        const timeDiff = nextData.timestamp - currentData.timestamp;
        const delay = Math.max(0, timeDiff / this.playbackSpeed);

        // this.log(
        //   `Next update in ${delay.toFixed(0)}ms (${timeDiff}ms / ${
        //     this.playbackSpeed
        //   }x)`
        // );

        // Clear any existing timeout to prevent multiple timeouts
        if (this.playbackInterval) {
          clearTimeout(this.playbackInterval);
        }

        this.playbackInterval = setTimeout(() => {
          this.playNext();
        }, delay);
      }
    } catch (error) {
      this.log(`Error in playNext: ${error.message}`);
      if (error.stack) {
        this.log(error.stack);
      }
    }
  }

  async _initializeDatabase() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.log("Database already initialized");
        return resolve();
      }

      const dbPath = this.config.dbPath;
      this.log("Initializing database connection to:", dbPath);

      this.db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
          this.log("Error opening database:", err.message);
          this.db = null;
          return reject(err);
        }
        this.log("Database connection established");
        resolve();
      });
    });
  }

  // ====================
  // Debug Utilities
  // ====================

  /**
   * Debug method to manually trigger a position update check
   */
  triggerPositionUpdate() {
    if (!stateData || !stateData.getState) {
      this.log("Error: stateData.getState is not available");
      return;
    }

    const position = stateData.getState("/navigation/position");
    this.log("Current position from state:", JSON.stringify(position, null, 2));

    // Emit a position update event to trigger any listeners
    if (position) {
      this.emit("state:update", {
        type: "position",
        data: position,
        timestamp: Date.now(),
      });
      this.log("Emitted position update event");
    } else {
      this.log("No position data available in state");
    }
  }

  // ====================
  // Data Processing
  // ====================

  parseDataRow(row) {
    try {
      if (!row || !row.patch_json) return null;

      const data = JSON.parse(row.patch_json);
      return {
        timestamp: new Date(row.timestamp).getTime(),
        data,
      };
    } catch (error) {
      this.log("Error parsing data row:", error);
      return null;
    }
  }

  applyDataPoint(dataPoint) {
    if (!dataPoint) {
      this.log("No data point provided");
      return;
    }

    if (!dataPoint.data) {
      this.log("No data in data point");
      return;
    }

    try {
      // Log the first few paths being updated for debugging
      const paths = Object.keys(dataPoint.data);
      // this.log(`Updating ${paths.length} paths, first few:`, paths.slice(0, 3));
      
      // Log the full data structure for debugging
      // this.log("DataPoint structure:", JSON.stringify(dataPoint.data, null, 2));

      if (!stateData || typeof stateData.batchUpdate !== "function") {
        throw new Error("stateData.batchUpdate is not a function");
      }
      
      // Find position patch
      const positionPatch = dataPoint.data.find(patch =>
        patch.path === "/navigation/position" && patch.value &&
        patch.value.latitude && patch.value.longitude);
      
      if (positionPatch) {
        
        // Ensure navigation and position exist
        if (!stateData.navigation) {
          this.log("Creating navigation object in state");
          stateData.navigation = {};
        }
        
        if (!stateData.navigation.position) {
          this.log("Creating position structure in state");
          stateData.navigation.position = {
            latitude: { value: null, units: "deg", label: "Lat", displayLabel: "Latitude", description: "Latitude" },
            longitude: { value: null, units: "deg", label: "Lon", displayLabel: "Longitude", description: "Longitude" },
            timestamp: null
          };
        } else {
          this.log("Position structure already exists in state");
        }
        
        // Apply position values directly
        const oldLat = stateData.navigation.position.latitude.value;
        const oldLon = stateData.navigation.position.longitude.value;
        const oldTimestamp = stateData.navigation.position.timestamp;
        
        stateData.navigation.position.latitude.value = positionPatch.value.latitude.value;
        stateData.navigation.position.longitude.value = positionPatch.value.longitude.value;
        stateData.navigation.position.timestamp = positionPatch.value.timestamp;
        
        this.log(`Applied position directly: lat=${stateData.navigation.position.latitude.value} (was ${oldLat}), lon=${stateData.navigation.position.longitude.value} (was ${oldLon}), timestamp=${stateData.navigation.position.timestamp} (was ${oldTimestamp})`);
      } else {
        this.log("No position patch found in this data point");
      }
      
      // Apply all patches
      this.log("Applying all patches via batchUpdate...");
      const result = stateData.batchUpdate(dataPoint.data);
      if (result && result.error) {
        this.log("Batch update failed with error:", result.error);
        throw new Error(`Batch update failed: ${result.error}`);
      } else {
        this.log("Batch update completed successfully");
      }
      
      // Emit an event if position data is available after update
      if (stateData.navigation?.position?.latitude?.value != null && 
          stateData.navigation?.position?.longitude?.value != null) {
        this.log("Emitting position:available event");
        this.emit('position:available', {
          latitude: stateData.navigation.position.latitude.value,
          longitude: stateData.navigation.position.longitude.value,
          timestamp: stateData.navigation.position.timestamp
        });
      }

      // Emit event for listeners
      const updateEvent = {
        type: "patch",
        data: dataPoint.data,
        timestamp: dataPoint.timestamp,
      };

      this.emit("state:patch", updateEvent);
      // this.log(`Emitted state:patch for patch event`);
    } catch (error) {
      this.log("Error in applyDataPoint:", error);
      if (error.stack) {
        this.log(error.stack);
      }
    }
  }

  // ====================
  // Mock Data Generation
  // ====================

  /**
   * Starts automatic updates for mock tank and battery data
   * @param {number} [intervalMs=5000] - Update interval in milliseconds
   */
  startMockMultipleTanksAndBatteries(intervalMs = 5000) {
    this.log("Starting mock data updates...");

    // Clear any existing interval
    this.stopMockDataUpdates();

    // Initial update
    this.updateMockData();

    // Set up periodic updates
    this.mockDataInterval = setInterval(() => {
      this.updateMockData();
    }, intervalMs);

    this.log("Started mock data updates");
  }

  startMockDataUpdates() {
    // For backward compatibility, call the new method with default interval
    this.startMockMultipleTanksAndBatteries(this.config.mockDataUpdateInterval);
  }

  stopMockDataUpdates() {
    if (this.mockDataInterval) {
      clearInterval(this.mockDataInterval);
      this.mockDataInterval = null;
      this.log("Stopped mock data updates");
    }
  }

  updateMockData() {
    // Update tank levels
    this.updateTankLevels();

    // Update battery levels
    this.updateBatteryLevels();

    // Update engine status
    this.updateEngineStatus();

    // Create the state update
    const update = this.createMockStateUpdate();

    // Apply the update
    stateData.batchUpdate(update);

    // Emit the update
    this.emit("state:update", {
      type: "mock-update",
      data: update,
      timestamp: Date.now(),
    });
  }

  updateTankLevels() {
    // Implement tank level simulation
    // This would include the logic from generateMockMultipleTanksAndBatteries
    // but simplified and better organized
  }

  updateBatteryLevels() {
    // Implement battery level simulation
  }

  updateEngineStatus() {
    // Implement engine status simulation
  }

  createMockStateUpdate() {
    // Create a state update object from the current mock state
    return {
      vessel: {
        systems: {
          tanks: this.mockState.tanks,
          electrical: {
            batteries: this.mockState.batteries,
          },
          propulsion: {
            engines: this.mockState.engines,
          },
        },
      },
    };
  }

  async _loadInitialData() {
    if (!this.db) {
      this.log("Database not connected");
      return false;
    }

    try {
      // First try to load the most recent full state
      const fullStateRow = await new Promise((resolve) => {
        this.db.get(
          "SELECT data FROM full_state ORDER BY timestamp DESC LIMIT 1",
          (err, row) => {
            if (err) {
              this.log("Error querying full_state:", err.message);
              resolve(null);
            } else {
              resolve(row);
            }
          }
        );
      });

      if (fullStateRow && fullStateRow.data) {
        try {
          const fullState = JSON.parse(fullStateRow.data);
          this.log("Loaded full state from database");

          // Apply the full state update
          stateData.batchUpdate(fullState);
          this.log("Applied full state to stateData");
          return true;
        } catch (error) {
          this.log("Error parsing full state:", error);
          // Continue to try loading from patches if full state fails
        }
      }

      this.log("No valid full state found, will load from patches");

      // If we get here, we need to load from patches
      // First check if we have any patches
      const patchCount = await new Promise((resolve) => {
        this.db.get("SELECT COUNT(*) as count FROM sk_patches", (err, row) =>
          resolve(row ? row.count : 0)
        );
      });

      if (patchCount === 0) {
        this.log("No patches found in database, starting with empty state");
        return false;
      }

      // Get the most recent patch that contains navigation data
      const navPatch = await new Promise((resolve) => {
        this.db.get(
          `
          SELECT patch_json 
          FROM sk_patches 
          WHERE patch_json LIKE '%"navigation"%' 
          ORDER BY timestamp DESC 
          LIMIT 1
        `,
          (err, row) => resolve(row)
        );
      });

      if (navPatch && navPatch.patch_json) {
        try {
          const patchData = JSON.parse(navPatch.patch_json);
          this.log("Applying latest navigation patch");
          stateData.batchUpdate(patchData);
          return true;
        } catch (error) {
          this.log("Error applying navigation patch:", error);
          return false;
        }
      }

      return false;
    } catch (error) {
      this.log("Error loading initial data:", error);
      return false;
    }
    // State is now ready
    this.isReady = true;
    this.emit && this.emit("ready");
  }

  // ====================
  // Public API
  // ====================

  async waitUntilReady(timeout = 5000) {
    if (this.isReady) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timeout waiting for StateService to be ready"));
      }, timeout);

      const onReady = () => {
        clearTimeout(timer);
        this.off("ready", onReady);
        resolve();
      };

      this.on("ready", onReady);
    });
  }
}

// Create and export singleton instance
export default new NewStateServiceDemo();
