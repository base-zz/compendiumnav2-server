import PouchDB from 'pouchdb';
import PouchDBFind from 'pouchdb-find';
import path from 'path';
import fs from 'fs';
import os from 'os';
import EventEmitter from 'events';
import { fileURLToPath } from 'url';

// Initialize PouchDB plugins
PouchDB.plugin(PouchDBFind);

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class StorageService extends EventEmitter {
  constructor() {
    super(); // Call parent constructor first
    this.basePath = path.join(process.cwd(), 'data');
    this.devicesDB = null;
    this.readingsDBs = new Map();
    this.initialized = false;
    this.retentionPolicies = {
      raw: 30 * 24 * 60 * 60 * 1000,       // 30 days
      hourly: 90 * 24 * 60 * 60 * 1000,    // 90 days
      daily: 365 * 24 * 60 * 60 * 1000,    // 1 year
      monthly: 5 * 365 * 24 * 60 * 60 * 1000 // 5 years
    };
    
    // Initialize in-memory cache for devices
    this.deviceCache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes TTL
    
    // Set up periodic cache cleanup
    this.cacheCleanupInterval = setInterval(() => {
      this._cleanupCache();
    }, 5 * 60 * 1000); // Run every 5 minutes
    
    // Make sure to clean up the interval when the process exits
    process.on('exit', () => {
      clearInterval(this.cacheCleanupInterval);
    });
  }

  async initialize() {
    if (this.initialized) return;
    
    // Ensure data directory exists
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }

    // Initialize devices database
    this.devicesDB = new PouchDB(path.join(this.basePath, 'devices.db'), {
      auto_compaction: true
    });

    // Create design documents for queries
    await this._ensureDesignDocs();
    this.initialized = true;
  }

  // === Settings Management ===

  /**
   * Get a setting value
   * @param {string} key - Setting key
   * @param {any} defaultValue - Default value if setting doesn't exist
   * @returns {Promise<any>} The setting value or default
   */
  async getSetting(key, defaultValue = null) {
    this._checkInitialized();
    
    try {
      const doc = await this.devicesDB.get(`_local/settings`).catch(err => {
        if (err.status === 404) return null;
        throw err;
      });
      
      return doc?.[key] ?? defaultValue;
    } catch (error) {
      console.error('Error getting setting:', error);
      return defaultValue;
    }
  }

  /**
   * Set a setting value
   * @param {string} key - Setting key
   * @param {any} value - Setting value (must be JSON-serializable)
   * @returns {Promise<boolean>} True if successful
   */
  async setSetting(key, value) {
    this._checkInitialized();
    
    try {
      // Get existing settings doc or create new one
      let doc;
      try {
        doc = await this.devicesDB.get('_local/settings');
      } catch (err) {
        if (err.status !== 404) throw err;
        doc = { _id: '_local/settings' };
      }
      
      // Update setting
      doc[key] = value;
      
      // Save back to database
      await this.devicesDB.put(doc);
      return true;
    } catch (error) {
      console.error('Error saving setting:', error);
      return false;
    }
  }

  // === Device Management ===

  /**
   * Remove all devices from the database
   * @returns {Promise<boolean>} True if successful
   */
  async clearAllDevices() {
    this._checkInitialized();
    
    try {
      // Get all devices
      const result = await this.devicesDB.allDocs({ include_docs: true });
      
      // Create bulk operation to delete all devices
      const bulkOps = result.rows
        .filter(row => !row.id.startsWith('_')) // Skip design docs and _local docs
        .map(row => ({
          _id: row.id,
          _rev: row.value.rev,
          _deleted: true
        }));
      
      if (bulkOps.length > 0) {
        await this.devicesDB.bulkDocs(bulkOps);
      }
      
      // Clear cache
      this.deviceCache.clear();
      
      return true;
    } catch (error) {
      console.error('Error clearing devices:', error);
      return false;
    }
  }

  async getAllDevices({ forceRefresh = false } = {}) {
    this._checkInitialized();
    
    // Check if we have a cached version and it's not a forced refresh
    const cacheKey = 'all_devices';
    const now = Date.now();
    const cached = this.deviceCache.get(cacheKey);
    
    if (!forceRefresh && cached && (now - cached.timestamp) < this.cacheTTL) {
      return cached.devices;
    }
    
    try {
      const result = await this.devicesDB.allDocs({
        include_docs: true
      });
      
      const devices = result.rows.map(row => row.doc);
      
      // Update cache
      this.deviceCache.set(cacheKey, {
        devices,
        timestamp: now
      });
      
      // Update individual device caches
      for (const device of devices) {
        this.deviceCache.set(device._id, {
          device,
          timestamp: now
        });
      }
      
      return devices;
    } catch (error) {
      console.error('Error fetching all devices:', error);
      
      // If we have a cached version, return it even if it's stale
      if (cached) {
        console.warn('Using cached devices due to error');
        return cached.devices;
      }
      
      throw new Error(`Failed to fetch devices: ${error.message}`);
    }
  }

  async getDevice(deviceId, { forceRefresh = false } = {}) {
    this._checkInitialized();
    if (!deviceId) {
      throw new Error('Device ID is required');
    }
    
    // Check cache first if not forcing refresh
    const cached = this.deviceCache.get(deviceId);
    const now = Date.now();
    
    if (!forceRefresh && cached && (now - cached.timestamp) < this.cacheTTL) {
      return cached.device;
    }
    
    try {
      const doc = await this.devicesDB.get(deviceId);
      
      // Update cache
      this.deviceCache.set(deviceId, {
        device: doc,
        timestamp: now
      });
      
      return doc;
    } catch (error) {
      if (error.status === 404) {
        // Cache negative result to prevent repeated lookups for non-existent devices
        this.deviceCache.set(deviceId, {
          device: null,
          timestamp: now
        });
        return null;
      }
      throw error;
    }
  }

  /**
   * Saves a device to the database with conflict resolution
   * @param {Object} deviceData - The device data to save
   * @param {number} [maxRetries=5] - Maximum number of retry attempts
   * @param {number} [initialDelay=50] - Initial delay between retries in ms
   * @returns {Promise<Object>} The saved device document
   */
  /**
   * Upsert a device (create or update if exists)
   * @param {Object} device - The device data
   * @returns {Promise<Object>} The saved device
   */
  async upsertDevice(device) {
    return this.saveDevice(device);
  }

  /**
   * @deprecated Use upsertDevice instead
   */
  async saveDevice(deviceData, maxRetries = 5, initialDelay = 50) {
    this._checkInitialized();
    
    if (!deviceData?.id) {
      throw new Error('Device ID is required');
    }

    const deviceId = deviceData.id;
    let retries = 0;
    let lastError;
    const now = new Date().toISOString();
    const startTime = Date.now();

    // Helper function to create device document
    const createDeviceDoc = (existing = null) => ({
      _id: deviceId,
      ...(existing ? {
        // Preserve existing fields
        ...existing,
        // Update with new data, but don't overwrite _rev
        ...Object.fromEntries(
          Object.entries(deviceData)
            .filter(([key]) => key !== '_rev' && key !== '_id')
        ),
        // Always update these fields
        updatedAt: now,
        lastSeen: now,
        // Ensure required fields have defaults
        type: deviceData.type || existing?.type || 'unknown',
        name: deviceData.name || existing?.name || `Device ${deviceId.substring(0, 8)}`
      } : {
        // New device
        ...deviceData,
        createdAt: now,
        updatedAt: now,
        lastSeen: now,
        status: 'active',
        type: deviceData.type || 'unknown',
        name: deviceData.name || `Device ${deviceId.substring(0, 8)}`,
        rssi: deviceData.rssi || 0
      })
    });

    while (retries <= maxRetries) {
      try {
        // Get the latest revision of the document
        let existing;
        try {
          existing = await this.devicesDB.get(deviceId).catch(err => {
            if (err.status !== 404) throw err;
            return null;
          });
        } catch (error) {
          console.error(`Error fetching device ${deviceId} (attempt ${retries + 1}/${maxRetries}):`, error.message);
          throw error;
        }

        // Create the device document with proper revision
        const device = createDeviceDoc(existing);
        if (existing) {
          device._rev = existing._rev;
        }

        // Attempt to save
        const response = await this.devicesDB.put(device);
        const savedDevice = { ...device, _rev: response.rev };
        
        // Update cache
        this._updateDeviceCache(deviceId, savedDevice);
        
        // Emit event for real-time updates
        this.emit('device:updated', savedDevice);
        
        return savedDevice;
        
      } catch (error) {
        lastError = error;
        
        // If it's a conflict error and we have retries left
        if ((error.status === 409 || error.name === 'conflict') && retries < maxRetries) {
          retries++;
          
          // Exponential backoff with jitter
          const delay = initialDelay * Math.pow(2, retries - 1) + 
                        (Math.random() * 20 - 10); // ±10ms jitter
          
          // Only log conflicts if debug mode is enabled
          if (process.env.NODE_ENV !== 'test' && process.env.LOG_DB_CONFLICTS === 'true') {
            console.warn(`Conflict detected on device ${deviceId}, retrying in ${delay.toFixed(0)}ms (${retries}/${maxRetries})`);
          }
          
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // For non-conflict errors or if we've exhausted retries
        if (error.status !== 404) { // Don't log 404 errors as they're expected for new devices
          console.error(`Error saving device ${deviceId} (attempt ${retries + 1}/${maxRetries}):`, error.message);
        }
        
        // If we've exhausted retries, throw the last error
        if (retries >= maxRetries) {
          const errorMsg = `Failed to save device ${deviceId} after ${maxRetries} attempts (${Date.now() - startTime}ms): ${error.message}`;
          console.error(errorMsg);
          const err = new Error(errorMsg);
          err.originalError = error;
          err.retries = retries;
          err.deviceId = deviceId;
          throw err;
        }
      }
    }
    
    // This should theoretically never be reached due to the while condition
    const error = lastError || new Error(`Unknown error saving device ${deviceId}`);
    console.error('Unexpected error in saveDevice:', error);
    throw error;
  }
  
  /**
   * Updates the device cache with the latest device data
   * @private
   * @param {string} deviceId - The ID of the device to update
   * @param {Object} deviceData - The latest device data
   */
  _updateDeviceCache(deviceId, deviceData) {
    if (!this.deviceCache) return;
    
    const timestamp = Date.now();
    // Update individual device cache
    this.deviceCache.set(deviceId, {
      device: deviceData,
      timestamp
    });
    
    // Invalidate the all_devices cache
    this.deviceCache.delete('all_devices');
  }

  // === Readings Management ===

  async addReading(deviceId, readingData) {
    this._checkInitialized();
    if (!deviceId) throw new Error('Device ID is required');
    if (!readingData) throw new Error('Reading data is required');
    
    const timestamp = readingData.timestamp || new Date().toISOString();
    const reading = { ...readingData, timestamp };
    
    // Handle bilge pump events
    if (reading.type && (reading.type === 'activated' || reading.type === 'deactivated')) {
      const result = await this.recordPumpEvent(deviceId, reading);
      this.emit('reading:added', { deviceId, reading: result });
      return result;
    }
    
    // Handle generic time series data
    if (reading.metric && reading.value !== undefined) {
      const result = await this.addDataPoint(
        deviceId, 
        reading.metric, 
        reading.value, 
        timestamp
      );
      this.emit('reading:added', { deviceId, reading: result });
      return result;
    }
    
    // Fallback to legacy storage
    const result = await this._saveLegacyReading(deviceId, reading);
    this.emit('reading:added', { deviceId, reading: result });
    return result;
  }

  async getReadings(deviceId, options = {}) {
    this._checkInitialized();
    if (!deviceId) throw new Error('Device ID is required');
    
    // For bilge pumps, get pump statistics
    if (options.type === 'bilge_pump' || options.includePumpStats) {
      const period = options.period || 'day';
      return this.getPumpStatistics(deviceId, period);
    }
    
    // For time series data
    if (options.metric) {
      return this.getDataPoints(
        deviceId,
        options.metric,
        {
          start: options.start,
          end: options.end,
          resolution: options.resolution
        }
      );
    }
    
    // Fallback to legacy storage
    return this._getLegacyReadings(deviceId, options.limit || 100);
  }

  // === Bilge Pump Methods ===

  async recordPumpEvent(deviceId, event) {
    this._checkInitialized();
    const now = new Date();
    const eventData = {
      type: 'pump_event',
      deviceId,
      event: event.type,
      timestamp: event.timestamp || now.toISOString(),
      data: event
    };

    if (event.type === 'deactivated' && this.activePumps?.has(deviceId)) {
      const pumpState = this.activePumps.get(deviceId);
      const duration = now - new Date(pumpState.timestamp);
      eventData.durationMs = duration;
      this.activePumps.delete(deviceId);
    } else if (event.type === 'activated') {
      this.activePumps = this.activePumps || new Map();
      this.activePumps.set(deviceId, {
        timestamp: now.toISOString()
      });
    }

    const db = await this._getReadingsDB(deviceId);
    const response = await db.post(eventData);
    return { ...eventData, _id: response.id, _rev: response.rev };
  }

  async getPumpStatistics(deviceId, period = 'day') {
    this._checkInitialized();
    const { start, end } = this._getTimeRange(period);
    const db = await this._getReadingsDB(deviceId);
    
    const result = await db.find({
      selector: {
        type: 'pump_event',
        timestamp: { $gte: start.toISOString(), $lte: end.toISOString() }
      },
      sort: [{timestamp: 'asc'}]
    });

    const stats = {
      totalActivations: 0,
      totalRuntime: 0,
      averageDuration: 0,
      activationsByHour: Array(24).fill(0),
      events: []
    };

    result.docs.forEach(event => {
      if (event.event === 'activated') {
        stats.totalActivations++;
        const hour = new Date(event.timestamp).getUTCHours();
        stats.activationsByHour[hour]++;
      }
      if (event.durationMs) {
        stats.totalRuntime += event.durationMs;
      }
      
      stats.events.push({
        timestamp: event.timestamp,
        type: event.event,
        durationMs: event.durationMs
      });
    });

    if (stats.totalActivations > 0) {
      stats.averageDuration = stats.totalRuntime / stats.totalActivations;
    }

    return stats;
  }

  // === Time Series Methods ===

  async addDataPoint(deviceId, metric, value, timestamp = new Date().toISOString()) {
    this._checkInitialized();
    const db = await this._getReadingsDB(deviceId);
    const point = {
      type: 'timeseries',
      deviceId,
      metric,
      value,
      timestamp,
      resolution: 'raw'
    };
    const response = await db.post(point);
    return { ...point, _id: response.id, _rev: response.rev };
  }

  async getDataPoints(deviceId, metric, { start, end, resolution = 'raw' } = {}) {
    this._checkInitialized();
    const db = await this._getReadingsDB(deviceId);
    
    const selector = {
      type: 'timeseries',
      metric,
      resolution
    };

    if (start || end) {
      selector.timestamp = {};
      if (start) selector.timestamp.$gte = new Date(start).toISOString();
      if (end) selector.timestamp.$lte = new Date(end).toISOString();
    }

    const result = await db.find({
      selector,
      sort: [{timestamp: 'asc'}]
    });

    return result.docs.map(doc => ({
      t: doc.timestamp,
      v: doc.value
    }));
  }

  // === Alert Storage ===

  async addAlert(alert) {
    const db = await this._getReadingsDB('alerts');
    const doc = {
      _id: `alert_${Date.now()}`,
      type: 'alert',
      ...alert,
      createdAt: new Date().toISOString()
    };
    await db.put(doc);
    return doc;
  }

  async getAlerts({ limit = 100, since } = {}) {
    const db = await this._getReadingsDB('alerts');
    const result = await db.find({
      selector: {
        type: 'alert',
        ...(since ? { createdAt: { $gte: since } } : {})
      },
      sort: [{ createdAt: 'desc' }],
      limit
    });
    return result.docs;
  }

  // === Private Helpers ===

  async _getReadingsDB(deviceId) {
    if (!this.readingsDBs.has(deviceId)) {
      const dbPath = path.join(this.basePath, `readings_${deviceId}.db`);
      const db = new PouchDB(dbPath, { auto_compaction: true });
      
      // Create indexes
      await db.createIndex({
        index: {
          fields: ['type', 'timestamp'],
          name: 'by_type_timestamp'
        }
      });

      await db.createIndex({
        index: {
          fields: ['type', 'metric', 'timestamp'],
          name: 'by_type_metric_timestamp'
        }
      });

      this.readingsDBs.set(deviceId, db);
    }
    return this.readingsDBs.get(deviceId);
  }

  async _ensureDesignDocs() {
    try {
      // Create indexes for devices collection
      await this.devicesDB.createIndex({
        index: {
          fields: ['type'],
          name: 'idx_device_type',
          ddoc: 'idx-device-type'
        }
      }).catch(err => {
        if (err.name !== 'exists') {
          console.error('Error creating device type index:', err);
          throw err;
        }
      });

      await this.devicesDB.createIndex({
        index: {
          fields: ['updatedAt'],
          name: 'idx_device_updated_at',
          ddoc: 'idx-device-updated-at'
        }
      }).catch(err => {
        if (err.name !== 'exists') {
          console.error('Error creating device updatedAt index:', err);
          throw err;
        }
      });

      // Create a design document for time-series data
      const ddoc = {
        _id: '_design/readings',
        views: {
          by_timestamp: {
            map: function (doc) {
              if (doc.timestamp && doc.deviceId) {
                emit([doc.deviceId, new Date(doc.timestamp).getTime()], doc);
              }
            }.toString()
          },
          by_metric: {
            map: function (doc) {
              if (doc.metric && doc.deviceId) {
                emit([doc.deviceId, doc.metric, new Date(doc.timestamp).getTime()], doc);
              }
            }.toString()
          }
        }
      };

      try {
        await this.devicesDB.put(ddoc);
      } catch (err) {
        if (err.status !== 409) { // Ignore conflict (already exists)
          console.error('Error creating design document:', err);
          throw err;
        }
      }

      console.log('Database indexes and design documents initialized');
    } catch (error) {
      console.error('Error initializing database indexes:', error);
      throw error;
    }
  }

  _checkInitialized() {
    if (!this.initialized) {
      throw new Error('StorageService not initialized. Call initialize() first.');
    }
  }
  
  /**
   * Handle device discovery updates efficiently
   * @param {Object} deviceData - The device data to update
   * @param {boolean} [isNew=false] - Whether this is a new device
   */
  async handleDeviceDiscovery(deviceData) {
    if (!deviceData || !deviceData.id) {
      console.warn('Invalid device data in handleDeviceDiscovery');
      return null;
    }

    try {
      // Get existing device to preserve existing data
      const existing = await this.getDevice(deviceData.id, { forceRefresh: false });
      
      // Prepare update with new data
      const update = {
        ...deviceData,
        lastSeen: new Date().toISOString(),
        // Preserve existing type/name if not provided
        type: deviceData.type || (existing?.type || 'unknown'),
        name: deviceData.name || (existing?.name || `Device ${deviceData.id.substring(0, 8)}`),
        // Update RSSI if available
        rssi: deviceData.rssi !== undefined ? deviceData.rssi : (existing?.rssi || 0)
      };

      // If device exists, preserve its creation time and other fields
      if (existing) {
        update.createdAt = existing.createdAt || new Date().toISOString();
        // Copy over any existing fields that aren't being updated
        Object.keys(existing).forEach(key => {
          if (!key.startsWith('_') && !(key in update)) {
            update[key] = existing[key];
          }
        });
      } else {
        update.createdAt = new Date().toISOString();
        update.status = 'active';
        console.log(`New device discovered: ${update.name} (${update.id})`);
      }

      // Save the device
      const savedDevice = await this.saveDevice(update);
      
      // Emit appropriate event
      if (existing) {
        this.emit('device:updated', savedDevice);
      } else {
        this.emit('device:discovered', savedDevice);
      }
      
      return savedDevice;
    } catch (error) {
      console.error('Error handling device discovery:', error);
      this.emit('error', error);
      return null;
    }
  }

  _cleanupCache() {
    const now = Date.now();
    const expired = [];
    
    // Find expired cache entries
    for (const [cacheKey, entry] of this.deviceCache.entries()) {
      // Skip the special 'all_devices' cache key
      if (cacheKey === 'all_devices') continue;
      
      if ((now - entry.timestamp) > this.cacheTTL) {
        expired.push(cacheKey);
      }
    }
    
    // Remove expired entries
    for (const cacheKey of expired) {
      this.deviceCache.delete(cacheKey);
    }
    
    if (expired.length > 0) {
      console.log(`Cleaned up ${expired.length} expired cache entries`);
    }
  }

  _getTimeRange(period = 'day') {
    const now = new Date();
    let start = new Date(now);

    switch (period.toLowerCase()) {
      case 'hour': start.setHours(now.getHours() - 1); break;
      case 'day': start.setDate(now.getDate() - 1); break;
      case 'week': start.setDate(now.getDate() - 7); break;
      case 'month': start.setMonth(now.getMonth() - 1); break;
      case '3months': start.setMonth(now.getMonth() - 3); break;
      default: start = new Date(period); // Custom start date
    }

    return { start, end: now };
  }

  // === Legacy Methods for Backward Compatibility ===

  async _saveLegacyReading(deviceId, reading) {
    if (!reading.timestamp) {
      reading.timestamp = new Date().toISOString();
    }
    const db = await this._getReadingsDB(deviceId);
    await db.post({
      type: 'legacy_reading',
      deviceId,
      data: reading,
      timestamp: reading.timestamp
    });
    return reading;
  }

  async _getLegacyReadings(deviceId, limit = 100) {
    const db = await this._getReadingsDB(deviceId);
    const result = await db.find({
      selector: {
        type: 'legacy_reading',
        deviceId
      },
      sort: [{timestamp: 'desc'}],
      limit
    });
    return result.docs.map(doc => doc.data);
  }
}

// Create and export a singleton instance
const storageService = new StorageService();

export default storageService;