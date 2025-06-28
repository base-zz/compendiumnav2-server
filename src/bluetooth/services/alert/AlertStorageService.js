import PouchDB from 'pouchdb';
// Add PouchDB plugins if needed
// import PouchDBFind from 'pouchdb-find';
// PouchDB.plugin(PouchDBFind);

import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import Alert from '../../models/Alert.js';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class AlertStorageService extends EventEmitter {
  constructor(dataPath = null) {
    super();
    this.db = null;
    this.dataPath = dataPath || path.join(os.homedir(), '.boat-monitor', 'alerts');
    this.initialize();
  }

  async initialize() {
    try {
      // Create database directory if it doesn't exist
      await fs.ensureDir(this.dataPath);

      // Initialize PouchDB
      this.db = new PouchDB(path.join(this.dataPath, 'alerts.db'));
      
      // Create necessary indexes
      await this.createIndexes();
      
      console.log('Alert storage initialized');
      return this;
    } catch (error) {
      console.error('Failed to initialize alert storage:', error);
      throw error;
    }
  }

  async createIndexes() {
    try {
      // Check if PouchDB has createIndex method (pouchdb-find plugin)
      if (typeof this.db.createIndex === 'function') {
        // Create indexes for common queries
        await this.db.createIndex({
          index: { fields: ['timestamp'] }
        });
        
        await this.db.createIndex({
          index: { fields: ['deviceId'] }
        });
        
        await this.db.createIndex({
          index: { fields: ['type'] }
        });
      } else {
        console.warn('PouchDB find plugin not available. Some queries may be slower.');
      }
      
      await this.db.createIndex({
        index: { fields: ['severity'] }
      });
      
      await this.db.createIndex({
        index: { fields: ['acknowledged'] }
      });
    } catch (error) {
      console.warn('Could not create indexes:', error);
    }
  }

  async saveAlert(alert) {
    if (!this.db) throw new Error('Database not initialized');
    
    try {
      const doc = {
        _id: alert.id,
        ...alert.toJSON()
      };
      
      // Only include _rev if it exists (for updates)
      if (alert._rev) {
        doc._rev = alert._rev;
      }
      
      const response = await this.db.put(doc);
      // Update revision if it exists in the response
      if (response.rev) {
        alert._rev = response.rev;
      }
      
      // Emit event
      this.emit('alert:updated', alert);
      
      return alert;
    } catch (error) {
      console.error('Error saving alert:', error);
      throw error;
    }
  }

  async getAlert(alertId) {
    try {
      const doc = await this.db.get(alertId);
      return Alert.fromJSON(doc);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async acknowledgeAlert(alertId, userId) {
    try {
      const alert = await this.getAlert(alertId);
      if (!alert) {
        throw new Error('Alert not found');
      }
      
      const updatedAlert = alert.acknowledge(userId);
      return this.saveAlert(updatedAlert);
    } catch (error) {
      console.error('Error acknowledging alert:', error);
      throw error;
    }
  }

  async findAlerts(options = {}) {
    const {
      deviceId = null,
      type = null,
      severity = null,
      acknowledged = null,
      startDate = null,
      endDate = new Date().toISOString(),
      limit = 100,
      skip = 0,
      descending = true
    } = options;

    try {
      let selector = {
        timestamp: { $lte: endDate }
      };

      if (deviceId) selector.deviceId = deviceId;
      if (type) selector.type = type;
      if (severity) selector.severity = severity;
      if (acknowledged !== null) selector.acknowledged = acknowledged;
      if (startDate) selector.timestamp.$gte = startDate;

      const result = await this.db.find({
        selector,
        sort: [{ 'timestamp': descending ? 'desc' : 'asc' }],
        limit,
        skip,
        use_index: ['timestamp']
      });

      return {
        alerts: result.docs.map(doc => Alert.fromJSON(doc)),
        total: result.docs.length,
        hasMore: result.warning ? result.warning.includes('limit') : false
      };
    } catch (error) {
      console.error('Error finding alerts:', error);
      throw error;
    }
  }

  async getRecentAlerts(limit = 50) {
    return this.findAlerts({ limit, descending: true });
  }

  async getUnacknowledgedAlerts() {
    return this.findAlerts({ acknowledged: false });
  }

  async getAlertsByDevice(deviceId, options = {}) {
    return this.findAlerts({ deviceId, ...options });
  }

  async getAlertsByType(type, options = {}) {
    return this.findAlerts({ type, ...options });
  }

  async getAlertsBySeverity(severity, options = {}) {
    return this.findAlerts({ severity, ...options });
  }

  async deleteAlert(id) {
    if (!this.db) throw new Error('Database not initialized');
    
    try {
      const doc = await this.db.get(id);
      await this.db.remove(doc);
      
      // Emit event
      this.emit('alert:deleted', id);
      
      return true;
    } catch (error) {
      if (error.status === 404) return false; // Not found
      console.error('Error deleting alert:', error);
      throw error;
    }
  }

  async deleteOldAlerts(daysToKeep = 30) {
    if (!this.db) throw new Error('Database not initialized');
    
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      
      const result = await this.findAlerts({
        endDate: cutoffDate.toISOString(),
        limit: 1000 // Process in batches
      });
      
      const alertsToDelete = result.alerts || [];
      const deletePromises = alertsToDelete.map(alert => {
        if (alert && alert._id) {
          const doc = { _id: alert._id, _rev: alert._rev };
          return this.db.remove(doc).catch(err => {
            console.error(`Error deleting alert ${alert._id}:`, err);
            return null;
          });
        }
        return null;
      }).filter(Boolean);
      
      await Promise.all(deletePromises);
      return alertsToDelete.length;
    } catch (error) {
      console.error('Error deleting old alerts:', error);
      throw error;
    }
  }

  async getAlertStats(options = {}) {
    const { startDate = null, endDate = new Date().toISOString() } = options;
    
    try {
      const alerts = await this.findAlerts({
        startDate,
        endDate,
        limit: 1000 // Adjust based on expected volume
      });n      
      const stats = {
        total: alerts.alerts.length,
        bySeverity: {},
        byType: {},
        byDevice: {}
      };
      
      alerts.alerts.forEach(alert => {
        // Count by severity
        stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1;
        
        // Count by type
        stats.byType[alert.type] = (stats.byType[alert.type] || 0) + 1;
        
        // Count by device
        if (alert.deviceId) {
          stats.byDevice[alert.deviceId] = (stats.byDevice[alert.deviceId] || 0) + 1;
        }
      });
      
      return stats;
    } catch (error) {
      console.error('Error getting alert stats:', error);
      throw error;
    }
  }
}

// Create and export a singleton instance
let instance = null;

export async function createAlertStorageService(dataPath = null) {
  if (!instance) {
    const service = new AlertStorageService(dataPath);
    instance = await service.initialize();
  }
  return instance;
}

export { AlertStorageService as default };
