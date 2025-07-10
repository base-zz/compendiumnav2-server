import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import debug from 'debug';

const log = debug('push:token-store');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default storage path (can be overridden in constructor)
const DEFAULT_STORAGE_PATH = path.join(process.cwd(), 'data', 'push-tokens.json');

/**
 * Simple, efficient store for push notification tokens
 * Persists to a JSON file and keeps data in memory for fast access
 */
export class PushTokenStore {
  /**
   * Create a new PushTokenStore
   * @param {string} [storagePath] - Path to the JSON storage file
   */
  constructor(storagePath = DEFAULT_STORAGE_PATH) {
    this.storagePath = storagePath;
    this.tokens = new Map(); // clientId -> { platform, token, deviceId, lastActive, createdAt }
    this.initialized = false;
  }

  /**
   * Initialize the token store
   */
  async init() {
    if (this.initialized) return;
    
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
      
      // Try to load existing tokens
      try {
        const data = await fs.readFile(this.storagePath, 'utf8');
        const tokens = JSON.parse(data);
        
        // Convert array to Map
        tokens.forEach(([clientId, tokenData]) => {
          this.tokens.set(clientId, tokenData);
        });
        
        log(`Loaded ${this.tokens.size} push tokens from storage`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist yet, that's fine
          log('No existing push token storage found, starting fresh');
        } else {
          throw error;
        }
      }
      
      this.initialized = true;
      log('PushTokenStore initialized');
    } catch (error) {
      log('Error initializing PushTokenStore:', error);
      throw error;
    }
  }

  /**
   * Save tokens to disk
   * @private
   */
  async _saveToDisk() {
    try {
      // Convert Map to array for JSON serialization
      const data = JSON.stringify([...this.tokens.entries()], null, 2);
      await fs.writeFile(this.storagePath, data, 'utf8');
    } catch (error) {
      log('Error saving push tokens to disk:', error);
      throw error;
    }
  }

  /**
   * Register or update a push token for a client
   * @param {string} clientId - The client's unique ID
   * @param {string} platform - The platform (ios, android)
   * @param {string} token - The push token
   * @param {string} [deviceId] - Optional device ID
   * @returns {Promise<boolean>} - Success status
   */
  async registerToken(clientId, platform, token, deviceId = null) {
    if (!this.initialized) await this.init();
    
    const now = new Date().toISOString();
    const tokenData = {
      platform,
      token,
      deviceId: deviceId || `device-${crypto.randomUUID()}`,
      lastActive: now,
      createdAt: now,
      updatedAt: now
    };

    this.tokens.set(clientId, tokenData);
    
    try {
      await this._saveToDisk();
      log(`Registered push token for client ${clientId}`);
      return true;
    } catch (error) {
      log('Failed to save push token:', error);
      return false;
    }
  }

  /**
   * Remove a push token
   * @param {string} clientId - The client's unique ID
   * @returns {Promise<boolean>} - Success status
   */
  async unregisterToken(clientId) {
    if (!this.initialized) await this.init();
    
    const deleted = this.tokens.delete(clientId);
    
    if (deleted) {
      try {
        await this._saveToDisk();
        log(`Unregistered push token for client ${clientId}`);
      } catch (error) {
        log('Failed to save after unregistering token:', error);
        return false;
      }
    }
    
    return deleted;
  }

  /**
   * Get a push token by client ID
   * @param {string} clientId - The client's unique ID
   * @returns {Object|null} - The token data or null if not found
   */
  getToken(clientId) {
    if (!this.initialized) return null;
    return this.tokens.get(clientId) || null;
  }

  /**
   * Get all push tokens (for sending to all clients)
   * @returns {Array<{clientId: string, tokenData: Object}>} - Array of client IDs and their token data
   */
  getAllTokens() {
    if (!this.initialized) return [];
    return Array.from(this.tokens.entries()).map(([clientId, tokenData]) => ({
      clientId,
      ...tokenData
    }));
  }

  /**
   * Update the last active timestamp for a client
   * @param {string} clientId - The client's unique ID
   * @returns {Promise<boolean>} - Success status
   */
  async updateLastActive(clientId) {
    if (!this.initialized) await this.init();
    
    const tokenData = this.tokens.get(clientId);
    if (!tokenData) return false;
    
    tokenData.lastActive = new Date().toISOString();
    tokenData.updatedAt = new Date().toISOString();
    
    try {
      await this._saveToDisk();
      return true;
    } catch (error) {
      log('Failed to update last active timestamp:', error);
      return false;
    }
  }

  /**
   * Clean up old/inactive tokens
   * @param {number} [maxAgeDays=30] - Maximum age in days before a token is considered inactive
   * @returns {Promise<number>} - Number of tokens removed
   */
  async cleanupInactiveTokens(maxAgeDays = 30) {
    if (!this.initialized) await this.init();
    
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    
    let removedCount = 0;
    
    for (const [clientId, tokenData] of this.tokens.entries()) {
      const lastActive = new Date(tokenData.lastActive);
      if (lastActive < cutoff) {
        this.tokens.delete(clientId);
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      try {
        await this._saveToDisk();
        log(`Cleaned up ${removedCount} inactive push tokens`);
      } catch (error) {
        log('Failed to save after cleaning up tokens:', error);
      }
    }
    
    return removedCount;
  }
}

// Create a singleton instance
export const pushTokenStore = new PushTokenStore();

// Export for direct use with default settings
export default pushTokenStore;
