import EventEmitter from 'events';
import storageService from './storage/storageService.js';
import alertService from './alertService.js';
import { v4 as uuidv4 } from 'uuid';

class ThresholdService extends EventEmitter {
  constructor() {
    super();
    this.thresholds = new Map(); // deviceId -> { metric -> { min, max } }
    this.activeAlerts = new Map(); // deviceId_metric -> alert
    this.alertCooldown = new Map(); // deviceId_metric -> timestamp
    this.defaultCooldown = 5 * 60 * 1000; // 5 minutes cooldown between alerts for the same threshold
  }

  async initialize() {
    // Load thresholds from storage
    const devices = await storageService.getAllDevices();
    devices.forEach(device => {
      if (device.alertThresholds) {
        this.thresholds.set(device.id, device.alertThresholds);
      }
    });

    // Listen for new readings
    storageService.on('reading:added', this.checkThresholds.bind(this));
    console.log('Threshold service initialized');
  }

  // Set thresholds for a device
  setThresholds(deviceId, thresholds) {
    this.thresholds.set(deviceId, thresholds);
    // Update device in storage
    storageService.getDevice(deviceId).then(device => {
      if (device) {
        device.alertThresholds = thresholds;
        return storageService.saveDevice(device);
      }
    });
  }

  // Check if a reading crosses any thresholds
  async checkThresholds({ deviceId, reading, device = null }) {
    const deviceThresholds = this.thresholds.get(deviceId);
    if (!deviceThresholds || !reading) return;

    const deviceInfo = device ? {
      id: device.id,
      name: device.name,
      type: device.type,
      address: device.address
    } : { id: deviceId };

    // Skip if alert manager is not available
    if (!alertService.alertManager) {
      console.warn('Alert manager not available - threshold checks will be skipped');
      return;
    }

    // Process each metric in the reading
    for (const [metric, value] of Object.entries(reading)) {
      if (typeof value !== 'number') continue;
      
      const thresholds = deviceThresholds[metric];
      if (!thresholds) continue;

      const alertKey = `${deviceId}_${metric}`;
      const isAlertActive = this.activeAlerts.has(alertKey);
      
      // Check max threshold
      if (thresholds.max !== undefined && value > thresholds.max) {
        const alertId = `threshold_${deviceId}_${metric}_max_${Date.now()}`;
        const alertType = 'threshold_exceeded';
        const alertMessage = `${metric} exceeded maximum threshold (${value} > ${thresholds.max})`;
        
        if (this.shouldAlert(alertKey)) {
          // Create alert for threshold exceeded
          await alertService.alertManager.createAlert({
            id: alertId,
            type: alertType,
            deviceId,
            device: deviceInfo,
            message: alertMessage,
            severity: thresholds.severity || 'warning',
            data: {
              metric,
              value,
              threshold: thresholds.max,
              thresholdType: 'max',
              device: deviceInfo,
              timestamp: new Date().toISOString()
            }
          });
          
          this.updateCooldown(alertKey);
          this.emit('threshold:exceeded', { 
            deviceId, 
            device: deviceInfo,
            metric, 
            value, 
            threshold: thresholds.max, 
            type: 'max' 
          });
        }
        
        if (!this.activeAlerts.has(alertKey)) {
          this.activeAlerts.set(alertKey, { type: 'max', threshold: thresholds.max });
        }
      } 
      // Check min threshold
      else if (thresholds.min !== undefined && value < thresholds.min) {
        const alertId = `threshold_${deviceId}_${metric}_min_${Date.now()}`;
        const alertType = 'threshold_exceeded';
        const alertMessage = `${metric} fell below minimum threshold (${value} < ${thresholds.min})`;
        
        if (this.shouldAlert(alertKey)) {
          // Create alert for threshold exceeded
          await alertService.alertManager.createAlert({
            id: alertId,
            type: alertType,
            deviceId,
            device: deviceInfo,
            message: alertMessage,
            severity: thresholds.severity || 'warning',
            data: {
              metric,
              value,
              threshold: thresholds.min,
              thresholdType: 'min',
              device: deviceInfo,
              timestamp: new Date().toISOString()
            }
          });
          
          this.updateCooldown(alertKey);
          this.emit('threshold:exceeded', { 
            deviceId, 
            device: deviceInfo,
            metric, 
            value, 
            threshold: thresholds.min, 
            type: 'min' 
          });
        }
        
        if (!this.activeAlerts.has(alertKey)) {
          this.activeAlerts.set(alertKey, { type: 'min', threshold: thresholds.min });
        }
      } 
      // If within thresholds, check if we need to clear an active alert
      else if (this.activeAlerts.has(alertKey)) {
        const alert = this.activeAlerts.get(alertKey);
        this.activeAlerts.delete(alertKey);
        
        // Create alert for threshold back to normal
        await alertManager.createAlert({
          type: 'threshold_normal',
          deviceId,
          device: deviceInfo,
          message: `${metric} returned to normal range`,
          severity: 'info',
          data: {
            metric,
            value,
            previousThreshold: alert.threshold,
            thresholdType: alert.type,
            device: deviceInfo,
            timestamp: new Date().toISOString(),
            resolvedAt: new Date().toISOString()
          }
        });
        
        this.emit('threshold:normal', {
          deviceId,
          device: deviceInfo,
          metric,
          value,
          previousThreshold: alert.threshold,
          type: alert.type,
          timestamp: new Date().toISOString(),
          resolvedAt: new Date().toISOString()
        });
      }
    }
  }

  shouldAlert(alertKey) {
    const cooldown = this.alertCooldown.get(alertKey);
    if (!cooldown) return true;
    const now = Date.now();
    if (now - cooldown > this.defaultCooldown) {
      this.alertCooldown.delete(alertKey);
      return true;
    }
    return false;
  }

  updateCooldown(alertKey) {
    this.alertCooldown.set(alertKey, Date.now());
  }

  async triggerAlert(alert) {
    const alertDoc = {
      ...alert,
      timestamp: new Date().toISOString(),
      severity: alert.type === 'threshold_normal' ? 'info' : 'warning'
    };

    // Save to storage
    await storageService.addAlert(alertDoc);
    
    // Emit for other services
    this.emit('alert', alertDoc);
    
    // Log to console
    const prefix = alertDoc.severity === 'warning' ? '⚠️ [ALERT]' : 'ℹ️ [INFO]';
  }

  // Get active alerts
  getActiveAlerts() {
    return Array.from(this.activeAlerts.entries()).map(([key, alert]) => ({
      ...alert,
      deviceId: key.split('_')[0],
      metric: key.split('_').slice(1).join('_')
    }));
  }

  // Clean up resources
  async shutdown() {
    this.activeAlerts.clear();
    this.alertCooldown.clear();
  }
}

// Create and export a singleton instance
const thresholdService = new ThresholdService();

// Clean up on process exit
process.on('SIGTERM', () => thresholdService.shutdown());
process.on('SIGINT', () => thresholdService.shutdown());

export default thresholdService;
