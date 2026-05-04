import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import EventEmitter from 'events';
import { fileURLToPath } from 'url';

console.log('[STORAGE] storageService module loading...');

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class StorageService extends EventEmitter {
  constructor() {
    console.log('[STORAGE] StorageService constructor called');
    super(); // Call parent constructor first
    this.basePath = path.join(process.cwd(), 'data');
    this.settingsDB = null;
    this.initialized = false;
    this.initializing = null;
  }

  async initialize() {
    console.log('[STORAGE] initialize() called');
    if (this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = this._initialize();

    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async _initialize() {
    // Ensure data directory exists
    console.log('[STORAGE] Ensuring basePath exists at', this.basePath);
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }

    this._initializeSettingsDb();
    this.initialized = true;
    console.log('[STORAGE] initialize() completed, storageService is ready');
  }

  async close() {
    if (this.settingsDB && typeof this.settingsDB.close === 'function') {
      this.settingsDB.close();
    }

    this.settingsDB = null;
    this.initialized = false;
    this.initializing = null;
  }

  _initializeSettingsDb() {
    if (this.settingsDB) {
      return;
    }

    const dbPath = path.join(this.basePath, 'settings.db');
    this.settingsDB = new Database(dbPath);
    this.settingsDB.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
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
      const row = this.settingsDB
        .prepare('SELECT value_json FROM app_settings WHERE key = ?')
        .get(key);
      if (!row) {
        return defaultValue;
      }

      const value = JSON.parse(row.value_json);
      return value ?? defaultValue;
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
      this.settingsDB.prepare(`
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value), new Date().toISOString());
      return true;
    } catch (error) {
      console.error('Error saving setting:', error);
      return false;
    }
  }

  // === Device Management ===
  // NOTE: These methods were previously backed by PouchDB (devices.db).
  // Devices auto-discover on restart, so these are currently stubbed.
  // TODO: Replace with SQLite implementation when device persistence is needed.

  async clearAllDevices() {
    return true;
  }

  async getAllDevices({ forceRefresh: _forceRefresh = false } = {}) {
    return [];
  }

  async getDevice(_deviceId, { forceRefresh: _forceRefresh = false } = {}) {
    return null;
  }

  async upsertDevice(device) {
    return device;
  }

  async saveDevice(deviceData, _maxRetries = 5, _initialDelay = 50) {
    return deviceData;
  }

  _checkInitialized() {
    if (!this.initialized) {
      throw new Error('StorageService not initialized. Call initialize() first.');
    }
  }
}

// Create and export a singleton instance
const storageService = new StorageService();

export default storageService;