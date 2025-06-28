import EventEmitter from 'events';
import storageService from './storage/storageService.js';

class AlertService extends EventEmitter {
  constructor() {
    super();
    this.pumpTimers = new Map();
  }

  start() {
    // Listen for pump events
    storageService.on('pump:activated', this.onPumpActivated.bind(this));
    storageService.on('pump:deactivated', this.onPumpDeactivated.bind(this));
    console.log('Alert service started');
  }

  onPumpActivated({ deviceId, device }) {
    // Clear any existing timer for this pump
    this.clearPumpTimer(deviceId);
    
    // Set a timer for 5 minutes
    const timer = setTimeout(() => {
      this.triggerAlert({
        deviceId,
        deviceName: device?.name || deviceId,
        message: `Bilge pump has been running for 5 minutes`,
        type: 'pump_runtime_exceeded',
        timestamp: new Date().toISOString()
      });
    }, 5 * 60 * 1000);

    this.pumpTimers.set(deviceId, timer);
    
    // Immediate notification
    this.emit('alert', {
      deviceId,
      deviceName: device?.name || deviceId,
      message: 'Bilge pump activated',
      type: 'pump_activated',
      timestamp: new Date().toISOString()
    });
  }

  onPumpDeactivated({ deviceId, device, durationMs }) {
    this.clearPumpTimer(deviceId);
    
    this.emit('alert', {
      deviceId,
      deviceName: device?.name || deviceId,
      message: `Bilge pump ran for ${(durationMs / 1000).toFixed(1)} seconds`,
      type: 'pump_deactivated',
      timestamp: new Date().toISOString()
    });
  }

  clearPumpTimer(deviceId) {
    const timer = this.pumpTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.pumpTimers.delete(deviceId);
    }
  }

  triggerAlert(alert) {
    // Save to storage
    storageService.addAlert(alert);
    
    // Emit for other services (e.g., web interface, notifications)
    this.emit('alert', alert);
    
    // Log to console
    console.log(`[ALERT] ${new Date(alert.timestamp).toISOString()} - ${alert.deviceName}: ${alert.message}`);
  }
}

// Create and export singleton instance
const alertService = new AlertService();

export default alertService;
