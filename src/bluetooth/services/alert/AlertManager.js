import EventEmitter from 'events';
import Alert from '../../models/Alert.js';

/**
 * AlertManager handles the creation and management of alerts in the system.
 * It listens for various events and creates appropriate alerts.
 */
class AlertManager extends EventEmitter {
  /**
   * Create a new AlertManager instance
   * @param {Object} alertStorageService - The storage service for alerts
   * @param {Object} [options] - Configuration options
   * @param {boolean} [options.autoInitialize=true] - Whether to automatically set up event listeners
   */
  constructor(alertStorageService, options = {}) {
    if (!alertStorageService) {
      throw new Error('AlertStorageService is required');
    }
    
    super();
    this.storage = alertStorageService;
    this.initialized = false;
    
    const { autoInitialize = true } = options;
    if (autoInitialize) {
      this.initialize();
    }
  }
  
  /**
   * Initialize the alert manager
   * @returns {AlertManager} The current instance for chaining
   */
  initialize() {
    if (this.initialized) return this;
    
    this.setupEventListeners();
    this.initialized = true;
    
    // Emit an event when initialized
    this.emit('initialized');
    
    return this;
  }

  /**
   * Set up event listeners for various alert types
   * @private
   */
  setupEventListeners() {
    if (this.listenersSetup) return;
    
    // Mark that we've set up the listeners
    this.listenersSetup = true;
    // Listen for threshold alerts
    this.on('alert:threshold', this.handleThresholdAlert.bind(this));
    
    // Listen for pump events
    this.on('pump:activated', this.handlePumpActivated.bind(this));
    this.on('pump:deactivated', this.handlePumpDeactivated.bind(this));
    this.on('pump:long_running', this.handlePumpLongRunning.bind(this));
    
    // System events
    this.on('system:startup', this.handleSystemStartup.bind(this));
    this.on('system:shutdown', this.handleSystemShutdown.bind(this));
    
    // Error events
    this.on('error', this.handleError.bind(this));
  }
  
  /**
   * Handle threshold alert event
   * @param {Object} data - Alert data
   * @private
   */
  async handleThresholdAlert(data) {
    const { deviceId, device = null, metric, value, threshold, type } = data;
    const message = type === 'max' 
      ? `${metric} exceeded maximum threshold (${value} > ${threshold})`
      : `${metric} fell below minimum threshold (${value} < ${threshold})`;
    
    await this.createAlert({
      type: 'threshold',
      deviceId,
      device,
      message,
      severity: 'warning',
      data: { metric, value, threshold, thresholdType: type }
    });
  }

  /**
   * Handle pump activated event
   * @param {Object} data - Event data
   * @private
   */
  async handlePumpActivated(data) {
    const { deviceId, device = null, timestamp = new Date().toISOString() } = data;
    
    await this.createAlert({
      type: 'pump_activated',
      deviceId,
      device,
      message: 'Bilge pump activated',
      severity: 'info',
      data: { timestamp }
    });
  }
  
  /**
   * Handle pump deactivated event
   * @param {Object} data - Event data
   * @private
   */
  async handlePumpDeactivated(data) {
    const { deviceId, device = null, duration, timestamp = new Date().toISOString() } = data;
    
    await this.createAlert({
      type: 'pump_deactivated',
      deviceId,
      device,
      message: `Bilge pump deactivated after ${duration}ms`,
      severity: 'info',
      data: { duration, timestamp }
    });
  }
  
  /**
   * Handle long-running pump event
   * @param {Object} data - Event data
   * @private
   */
  async handlePumpLongRunning(data) {
    const { deviceId, device = null, duration, timestamp = new Date().toISOString() } = data;
    
    await this.createAlert({
      type: 'pump_long_running',
      deviceId,
      device,
      message: `Bilge pump running for ${duration}ms (possible issue)`,
      severity: 'warning',
      data: { duration, timestamp }
    });
  }

  /**
   * Handle device connected event
   * @param {Object} data - Event data
   * @private
   */
  async handleDeviceConnected(data) {
    const { deviceId, device = null, timestamp = new Date().toISOString() } = data;
    
    await this.createAlert({
      type: 'device_connected',
      deviceId,
      device,
      message: 'Device connected',
      severity: 'info',
      data: { timestamp }
    });
  }

  /**
   * Handle device disconnected event
   * @param {Object} data - Event data
   * @private
   */
  async handleDeviceDisconnected(data) {
    const { deviceId, device = null, reason = 'unknown', timestamp = new Date().toISOString() } = data;
    
    await this.createAlert({
      type: 'device_disconnected',
      deviceId,
      device,
      message: `Device disconnected (${reason})`,
      severity: 'warning',
      data: { reason, timestamp }
    });
  }

  /**
   * Handle system startup event
   * @private
   */
  async handleSystemStartup() {
    await this.createAlert({
      type: 'system_startup',
      message: 'System started',
      severity: 'info',
      data: { timestamp: new Date().toISOString() }
    });
  }
  
  /**
   * Handle system shutdown event
   * @private
   */
  async handleSystemShutdown() {
    await this.createAlert({
      type: 'system_shutdown',
      message: 'System shutting down',
      severity: 'info',
      data: { timestamp: new Date().toISOString() }
    });
  }
  
  /**
   * Handle error event
   * @param {Error} error - The error that occurred
   * @private
   */
  async handleError(error) {
    console.error('AlertManager error:', error);
    
    await this.createAlert({
      type: 'system_error',
      message: error.message,
      severity: 'error',
      data: {
        name: error.name,
        stack: error.stack,
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Create a new alert
   * @param {Object} options - Alert options
   * @returns {Promise<Object>} The created alert
   */
  async createAlert(options) {
    try {
      const alert = new Alert({
        ...options,
        timestamp: options.timestamp || new Date().toISOString(),
        acknowledged: options.acknowledged || false
      });
      
      const savedAlert = await this.storage.saveAlert(alert);
      
      // Emit a generic alert event
      this.emit('alert:created', savedAlert);
      
      // Emit a specific event based on alert type
      this.emit(`alert:${savedAlert.type}`, savedAlert);
      
      return savedAlert;
    } catch (error) {
      console.error('Error creating alert:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Acknowledge an alert
   * @param {string} alertId - ID of the alert to acknowledge
   * @param {string} userId - ID of the user acknowledging the alert
   * @returns {Promise<Object>} The updated alert
   */
  async acknowledgeAlert(alertId, userId) {
    try {
      const alert = await this.storage.acknowledgeAlert(alertId, userId);
      this.emit('alert:acknowledged', alert);
      return alert;
    } catch (error) {
      console.error('Error acknowledging alert:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get alerts with optional filters
   * @param {Object} [filters] - Filters to apply
   * @param {number} [limit=100] - Maximum number of alerts to return
   * @param {number} [skip=0] - Number of alerts to skip
   * @returns {Promise<Array>} Array of alerts
   */
  async getAlerts(filters = {}, limit = 100, skip = 0) {
    try {
      return await this.storage.findAlerts(filters, limit, skip);
    } catch (error) {
      console.error('Error getting alerts:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get recent alerts
   * @param {number} [limit=50] - Maximum number of recent alerts to return
   * @returns {Promise<Array>} Array of recent alerts
   */
  async getRecentAlerts(limit = 50) {
    try {
      return await this.storage.getRecentAlerts(limit);
    } catch (error) {
      console.error('Error getting recent alerts:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get unacknowledged alerts
   * @returns {Promise<Array>} Array of unacknowledged alerts
   */
  async getUnacknowledgedAlerts() {
    try {
      return await this.storage.getUnacknowledgedAlerts();
    } catch (error) {
      console.error('Error getting unacknowledged alerts:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get alert statistics
   * @param {Object} [options] - Options for statistics
   * @returns {Promise<Object>} Alert statistics
   */
  async getAlertStats(options = {}) {
    try {
      return await this.storage.getAlertStats(options);
    } catch (error) {
      console.error('Error getting alert stats:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Delete old alerts
   * @param {number} [daysToKeep=30] - Number of days of alerts to keep
   * @returns {Promise<Object>} Deletion result
   */
  async deleteOldAlerts(daysToKeep = 30) {
    try {
      return await this.storage.deleteOldAlerts(daysToKeep);
    } catch (error) {
      console.error('Error deleting old alerts:', error);
      this.emit('error', error);
      throw error;
    }
  }

  // Helper methods for specific alert types
  async createThresholdAlert(deviceId, device, metric, value, threshold, type) {
    return this.emit('alert:threshold', {
      deviceId,
      device,
      metric,
      value,
      threshold,
      type
    });
  }

  async createDeviceAlert(deviceId, device, type, message, severity = 'info', data = {}) {
    return this.createAlert({
      type: `device_${type}`,
      deviceId,
      device,
      message,
      severity,
      data
    });
  }

  async createSystemAlert(type, message, severity = 'info', data = {}) {
    return this.createAlert({
      type: `system_${type}`,
      message,
      severity,
      data
    });
  }
}

// Create a singleton instance
let instance = null;

/**
 * Create or get the AlertManager singleton instance
 * @param {Object} alertStorageService - The storage service for alerts
 * @param {Object} options - Configuration options
 * @returns {AlertManager} The AlertManager instance
 */
export function createAlertManager(alertStorageService, options) {
  if (!instance) {
    instance = new AlertManager(alertStorageService, options);
  } else if (alertStorageService && instance.storage !== alertStorageService) {
    // If storage service changes, update it
    instance.storage = alertStorageService;
  }
  return instance;
}

/**
 * Get the singleton instance (for backward compatibility)
 * @returns {AlertManager}
 */
export function getInstance() {
  if (!instance) {
    throw new Error('AlertManager has not been initialized. Call createAlertManager() first.');
  }
  return instance;
}

export { AlertManager as default };
