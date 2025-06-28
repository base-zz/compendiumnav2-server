/**
 * Lightweight Alert System
 * 
 * Emits events:
 * - 'alert' - When any alert is triggered
 * - 'alert:threshold' - For threshold-based alerts
 * - 'alert:pump' - For bilge pump specific alerts
 */

class AlertSystem extends EventEmitter {
  constructor() {
    super();
    this.thresholds = new Map(); // deviceId -> { metric -> { min, max } }
    this.pumpTimers = new Map(); // deviceId -> timer
  }

  /**
   * Set thresholds for a device
   * @param {string} deviceId - Device identifier
   * @param {Object} thresholds - { metric: { min, max } }
   */
  setThresholds(deviceId, thresholds) {
    this.thresholds.set(deviceId, thresholds);
  }

  /**
   * Check a reading against thresholds
   * @param {Object} params - { deviceId, device, metric, value, timestamp }
   */
  checkThreshold({ deviceId, device, metric, value, timestamp = new Date() }) {
    const deviceThresholds = this.thresholds.get(deviceId);
    if (!deviceThresholds || !deviceThresholds[metric]) return;

    const threshold = deviceThresholds[metric];
    const alertBase = { deviceId, device, metric, value, timestamp };

    if (threshold.min !== undefined && value < threshold.min) {
      this.emit('alert:threshold', {
        ...alertBase,
        type: 'min_threshold',
        threshold: threshold.min,
        message: `${metric} is below minimum threshold (${value} < ${threshold.min})`
      });
    } 
    else if (threshold.max !== undefined && value > threshold.max) {
      this.emit('alert:threshold', {
        ...alertBase,
        type: 'max_threshold',
        threshold: threshold.max,
        message: `${metric} exceeded maximum threshold (${value} > ${threshold.max})`
      });
    }
  }

  /**
   * Handle bilge pump activation
   * @param {Object} params - { deviceId, device, timestamp }
   */
  handlePumpActivated({ deviceId, device, timestamp = new Date() }) {
    // Clear any existing timer
    this.clearPumpTimer(deviceId);
    
    // Set timer for max runtime (5 minutes)
    const timer = setTimeout(() => {
      this.emit('alert:pump', {
        deviceId,
        device,
        type: 'pump_runtime_exceeded',
        message: 'Bilge pump has been running for 5 minutes',
        timestamp: new Date()
      });
    }, 5 * 60 * 1000);

    this.pumpTimers.set(deviceId, timer);
    
    // Emit activation event
    this.emit('alert:pump', {
      deviceId,
      device,
      type: 'pump_activated',
      message: 'Bilge pump activated',
      timestamp
    });
  }

  /**
   * Handle bilge pump deactivation
   * @param {Object} params - { deviceId, device, durationMs, timestamp }
   */
  handlePumpDeactivated({ deviceId, device, durationMs, timestamp = new Date() }) {
    this.clearPumpTimer(deviceId);
    
    this.emit('alert:pump', {
      deviceId,
      device,
      type: 'pump_deactivated',
      message: `Bilge pump ran for ${(durationMs / 1000).toFixed(1)} seconds`,
      durationMs,
      timestamp
    });
  }

  /**
   * Clear pump timer
   * @param {string} deviceId 
   */
  clearPumpTimer(deviceId) {
    const timer = this.pumpTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.pumpTimers.delete(deviceId);
    }
  }
}

import EventEmitter from 'events';

// Create and export singleton instance
const alertSystem = new AlertSystem();
export default alertSystem;
