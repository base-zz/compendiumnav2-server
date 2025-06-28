import { EventEmitter } from 'events';
import { getAlertStorage } from './index.js';

class AlertService extends EventEmitter {
  constructor() {
    super();
    this.activeAlerts = new Map();
  }

  /**
   * Initialize the alert service
   */
  async initialize() {
    try {
      // Initialize alert storage
      this.alertStorage = await getAlertStorage();
      
      // Load any persisted alert rules
      this.rules = await this.loadAlertRules();
      
      console.log('Alert service initialized');
    } catch (error) {
      console.error('Failed to initialize alert service:', error);
      throw error;
    }
  }

  /**
   * Handle pump activated event
   * @param {Object} event - Pump event data
   */
  async handlePumpActivated(event) {
    try {
      const { deviceId, timestamp } = event;
      // Get device from storage if needed
      let deviceName = deviceId;
      if (this.alertStorage) {
        try {
          const device = await this.alertStorage.getDevice(deviceId);
          deviceName = device?.name || deviceId;
        } catch (error) {
          console.warn(`Failed to get device ${deviceId}:`, error);
        }
      }
      
      // Create a new alert if this pump runs too long
      const alertId = `pump_${deviceId}_${Date.now()}`;
      const timeout = setTimeout(() => {
        this.triggerAlert({
          id: alertId,
          type: 'pump_runtime_exceeded',
          deviceId,
          deviceName,
          message: `Bilge pump ${deviceName} has been running for too long`,
          timestamp: new Date().toISOString(),
          severity: 'warning',
          data: { event }
        });
      }, 5 * 60 * 1000); // 5 minutes timeout

      this.activeAlerts.set(alertId, { timeout, deviceId });
      
      // Emit immediate notification
      this.triggerAlert({
        id: `pump_${deviceId}_start_${Date.now()}`,
        type: 'pump_activated',
        deviceId,
        deviceName,
        message: `Bilge pump ${deviceName} activated`,
        timestamp: new Date().toISOString(),
        severity: 'info',
        data: { event }
      });
    } catch (error) {
      console.error('Error handling pump activated event:', error);
      this.emit('error', error);
    }
  }

  /**
   * Handle pump deactivated event
   * @param {Object} event - Pump event data
   */
  async handlePumpDeactivated(event) {
    try {
      const { deviceId, timestamp } = event;
      // Get device from storage if needed
      let deviceName = deviceId;
      if (this.alertStorage) {
        try {
          const device = await this.alertStorage.getDevice(deviceId);
          deviceName = device?.name || deviceId;
        } catch (error) {
          console.warn(`Failed to get device ${deviceId}:`, error);
        }
      }
      
      // Clear any running timeout for this pump
      for (const [alertId, alert] of this.activeAlerts.entries()) {
        if (alert.deviceId === deviceId) {
          clearTimeout(alert.timeout);
          this.activeAlerts.delete(alertId);
        }
      }
      
      // Emit notification
      this.triggerAlert({
        id: `pump_${deviceId}_stop_${Date.now()}`,
        type: 'pump_deactivated',
        deviceId,
        deviceName,
        message: `Bilge pump ${deviceName} deactivated`,
        timestamp: new Date().toISOString(),
        severity: 'info',
        data: { event }
      });
    } catch (error) {
      console.error('Error handling pump deactivated event:', error);
      this.emit('error', error);
    }
  }

  /**
   * Trigger a new alert
   * @param {Object} alert - Alert data
   */
  async triggerAlert(alert) {
    if (!this.alertStorage) {
      throw new Error('Alert storage not initialized');
    }
    
    try {
      // Save the alert
      await this.alertStorage.saveAlert(alert);
      
      // Emit the alert
      this.emit('alert', alert);
      
      // TODO: Send notifications (email, SMS, push, etc.)
      console.log(`ALERT: ${alert.message}`);
    } catch (error) {
      console.error('Failed to save alert:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Load alert rules from storage
   */
  async loadAlertRules() {
    if (!this.alertStorage) {
      console.warn('Alert storage not initialized, returning empty rules');
      return [];
    }
    
    try {
      // Get all alerts of type 'rule'
      const result = await this.alertStorage.findAlerts({ type: 'rule' });
      return result.alerts || [];
    } catch (error) {
      console.error('Failed to load alert rules:', error);
      this.emit('error', error);
      return [];
    }
  }

  /**
   * Get active alerts
   */
  getActiveAlerts() {
    return Array.from(this.activeAlerts.values());
  }
}

// Create and export a singleton instance
const alertService = new AlertService();
export default alertService;
