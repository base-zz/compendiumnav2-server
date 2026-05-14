import BaseService from "./BaseService.js";
import crypto from "crypto";
import { getStateManager } from "../relay/core/state/StateManager.js";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

/**
 * VPS Master Database Sync Service
 *
 * This service periodically syncs local database changes to the VPS master database for crowdsourcing.
 * It enables all boat servers to contribute marina and fuel data to a central master database.
 *
 * **How it works:**
 * 1. Monitors local database for records marked with `sync_dirty = 1` (dirty records need syncing)
 * 2. Every 5 minutes (configurable), batches up to 10 dirty records of each type
 * 3. Sends signed HTTP POST requests to VPS master API endpoints
 * 4. Uses boat's private key for signature-based authentication (same as WebSocket auth)
 * 5. On successful sync, clears `sync_dirty = 0` to mark record as synced
 *
 * **Synced entities:**
 * - Marinas (new discoveries and updates from geographic sweeps)
 * - Fuel logs (price data from fuel extraction)
 *
 * **Authentication:**
 * Uses RSA signature-based auth with headers:
 * - x-boat-id: boat identifier
 * - x-timestamp: request timestamp
 * - x-signature: RSA signature of message
 *
 * **Rate limiting:**
 * Batches updates to avoid spamming VPS API
 * Configurable sync interval and batch size
 *
 * **Environment variables:**
 * - MASTER_SYNC_ENABLED: Set to "true" to enable service
 * - MARINA_DB_PATH: Path to local SQLite database
 * - VPS_HOST: VPS server URL (e.g., https://compendiumnav.com)
 */
export class MasterSyncService extends BaseService {
  constructor(options) {
    super("master-sync", "continuous");

    if (!options || typeof options !== "object") {
      throw new Error("[MasterSyncService] options is required");
    }

    this.dbPath = options.dbPath;
    this.vpsHost = options.vpsHost || process.env.VPS_HOST;
    if (this.vpsHost && !this.vpsHost.startsWith('http')) {
      this.vpsHost = `https://${this.vpsHost}`;
    }
    this.boatId = options.boatId;
    this.privateKey = options.privateKey;
    this.syncIntervalMs = options.syncIntervalMs || 5 * 60 * 1000; // 5 minutes default
    this.batchSize = options.batchSize || 10;

    if (!this.dbPath) {
      throw new Error("[MasterSyncService] dbPath is required");
    }
    if (!this.vpsHost) {
      throw new Error("[MasterSyncService] vpsHost is required");
    }
    if (!this.boatId) {
      throw new Error("[MasterSyncService] boatId is required");
    }
    if (!this.privateKey) {
      throw new Error("[MasterSyncService] privateKey is required");
    }

    this._stateManager = getStateManager();
    this._syncInterval = null;
  }

  async start() {
    await super.start();

    this._syncInterval = setInterval(() => {
      this._syncToMaster().catch((err) => {
        console.error("[MasterSyncService] Sync failed:", err);
      });
    }, this.syncIntervalMs);

    this.log(`Started - syncing every ${this.syncIntervalMs}ms to ${this.vpsHost}`);

    // Initial sync
    this._syncToMaster().catch((err) => {
      console.error("[MasterSyncService] Initial sync failed:", err);
    });
  }

  async stop() {
    if (!this.isRunning) return;

    if (this._syncInterval) {
      clearInterval(this._syncInterval);
      this._syncInterval = null;
    }

    await super.stop();
    this.log("Stopped");
  }

  /**
   * Sign a request body with the boat's private key
   */
  _signRequest(body) {
    const timestamp = Date.now();
    const bodyHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const message = `${this.boatId}:${timestamp}:${bodyHash}`;
    const signature = crypto.sign("SHA256", Buffer.from(message), this.privateKey).toString("base64");
    return { timestamp, _bodyHash: bodyHash, signature };
  }

  /**
   * Send signed HTTP request to VPS
   */
  async _sendToVps(endpoint, data) {
    const { timestamp, signature } = this._signRequest(data);

    const response = await fetch(`${this.vpsHost}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-boat-id": this.boatId,
        "x-timestamp": String(timestamp),
        "x-signature": signature,
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`VPS request failed: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  /**
   * Get dirty records from local database
   */
  _getDirtyRecords(db, table, limit) {
    const stmt = db.prepare(`
      SELECT * FROM ${table}
      WHERE sync_dirty = 1
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  /**
   * Clear sync_dirty flag for specific records
   */
  _clearSyncDirty(db, table, ids) {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    // Marinas table uses marina_uid (singular), not marinas_uid
    const uidColumn = table === 'marinas' ? 'marina_uid' : `${table}_uid`;
    const stmt = db.prepare(`
      UPDATE ${table}
      SET sync_dirty = 0
      WHERE ${uidColumn} IN (${placeholders})
    `);
    const result = stmt.run(...ids);
    return result.changes;
  }

  /**
   * Sync dirty marinas to VPS
   */
  async _syncMarinas(db) {
    // Check if marinas table exists
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='marinas'").get();
    if (!tableCheck) {
      this.log('Marinas table does not exist in local database, skipping marina sync');
      return { synced: 0 };
    }

    const dirtyMarinas = this._getDirtyRecords(db, "marinas", this.batchSize);
    if (dirtyMarinas.length === 0) return { synced: 0 };

    const results = [];
    for (const marina of dirtyMarinas) {
      try {
        const result = await this._sendToVps("/api/master/marinas", marina);
        results.push({ success: true, marina_uid: marina.marina_uid, result });
      } catch (error) {
        console.error(`[MasterSyncService] Failed to sync marina ${marina.marina_uid}:`, error);
        results.push({ success: false, marina_uid: marina.marina_uid, error: error.message });
      }
    }

    // Clear sync_dirty for successful syncs
    const successfulIds = results.filter((r) => r.success).map((r) => r.marina_uid);
    if (successfulIds.length > 0) {
      this._clearSyncDirty(db, "marinas", successfulIds);
    }

    return { synced: successfulIds.length, total: dirtyMarinas.length, results };
  }

  /**
   * Sync dirty fuel logs to VPS
   */
  async _syncFuelLogs(db) {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fuel_logs'").get();
    if (!tableCheck) {
      this.log('fuel_logs table does not exist in local database, skipping fuel log sync');
      return { synced: 0 };
    }

    const dirtyLogs = this._getDirtyRecords(db, "fuel_logs", this.batchSize);
    if (dirtyLogs.length === 0) return { synced: 0 };

    const results = [];
    for (const log of dirtyLogs) {
      try {
        const result = await this._sendToVps("/api/master/fuel-logs", log);
        results.push({ success: true, fuel_log_id: log.fuel_log_id, result });
      } catch (error) {
        console.error(`[MasterSyncService] Failed to sync fuel log ${log.fuel_log_id}:`, error);
        results.push({ success: false, fuel_log_id: log.fuel_log_id, error: error.message });
      }
    }

    // Clear sync_dirty for successful syncs
    const successfulIds = results.filter((r) => r.success).map((r) => r.fuel_log_id);
    if (successfulIds.length > 0) {
      const stmt = db.prepare(`
        UPDATE fuel_logs
        SET sync_dirty = 0
        WHERE fuel_log_id IN (${successfulIds.map(() => "?").join(",")})
      `);
      stmt.run(...successfulIds);
    }

    return { synced: successfulIds.length, total: dirtyLogs.length, results };
  }

  /**
   * Sync dirty pricing logs to VPS
   */
  async _syncPricingLogs(db) {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pricing_logs'").get();
    if (!tableCheck) {
      this.log('pricing_logs table does not exist in local database, skipping pricing log sync');
      return { synced: 0 };
    }

    const dirtyLogs = this._getDirtyRecords(db, "pricing_logs", this.batchSize);
    if (dirtyLogs.length === 0) return { synced: 0 };

    const results = [];
    for (const log of dirtyLogs) {
      try {
        const result = await this._sendToVps("/api/master/pricing-logs", log);
        results.push({ success: true, pricing_log_id: log.pricing_log_id, result });
      } catch (error) {
        console.error(`[MasterSyncService] Failed to sync pricing log ${log.pricing_log_id}:`, error);
        results.push({ success: false, pricing_log_id: log.pricing_log_id, error: error.message });
      }
    }

    // Clear sync_dirty for successful syncs
    const successfulIds = results.filter((r) => r.success).map((r) => r.pricing_log_id);
    if (successfulIds.length > 0) {
      const stmt = db.prepare(`
        UPDATE pricing_logs
        SET sync_dirty = 0
        WHERE pricing_log_id IN (${successfulIds.map(() => "?").join(",")})
      `);
      stmt.run(...successfulIds);
    }

    return { synced: successfulIds.length, total: dirtyLogs.length, results };
  }

  /**
   * Main sync loop
   */
  async _syncToMaster() {
    const Database = await import("better-sqlite3");
    
    // Ensure database directory exists
    const dbDir = path.dirname(this.dbPath);
    try {
      await fs.mkdir(dbDir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new Error(`[MasterSyncService] Failed to create database directory: ${err.message}`);
      }
    }
    
    const db = new Database.default(this.dbPath);

    try {
      const marinaResult = await this._syncMarinas(db);
      const fuelLogResult = await this._syncFuelLogs(db);
      const pricingLogResult = await this._syncPricingLogs(db);

      const totalSynced = marinaResult.synced + fuelLogResult.synced + pricingLogResult.synced;
      if (totalSynced > 0) {
        this.log(`Synced ${marinaResult.synced} marinas, ${fuelLogResult.synced} fuel logs, ${pricingLogResult.synced} pricing logs to VPS`);
      }

      return { marinas: marinaResult, fuelLogs: fuelLogResult, pricingLogs: pricingLogResult };
    } finally {
      db.close();
    }
  }
}
