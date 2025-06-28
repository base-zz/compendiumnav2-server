import timeSeriesService from './storage/timeSeriesService.js';
import EventEmitter from 'events';
import storageService from './storage/storageService.js';
import alertService from './alertService.js';
import BilgePumpParser from '../lib/parsers/BilgePumpParser.js';

class BilgePumpService extends EventEmitter {
  get alertManager() {
    if (!alertService.alertManager) {
      console.warn('Alert manager not initialized - alerts will not be sent');
      return {
        createAlert: () => {},
        createSystemAlert: () => {}
      };
    }
    return alertService.alertManager;
  }
  constructor() {
    super();
    this.activePumps = new Map(); // Track active pump states
    this.parser = new BilgePumpParser();
    this.longRunningPumpTimers = new Map(); // Track long-running pump timers
    
    // Set default long-running threshold (5 minutes)
    this.longRunningThreshold = process.env.LONG_RUNNING_PUMP_THRESHOLD_MS || (5 * 60 * 1000);
  }

  async initialize() {
    await timeSeriesService.initialize();
  }

  async recordPumpEvent(deviceId, event, device) {
    const now = new Date();
    const eventData = {
      ...event,
      timestamp: now.toISOString()
    };

    // Track pump state
    try {
      if (event.type === 'activated') {
        // Clear any existing timer for this pump
        this.clearLongRunningTimer(deviceId);
        
        // Record activation
        const activationTime = now.toISOString();
        this.activePumps.set(deviceId, { 
          timestamp: activationTime,
          device: device || { id: deviceId }
        });
        
        // Set timer for long-running pump alert
        const timer = setTimeout(() => {
          this.handleLongRunningPump(deviceId, device);
        }, this.longRunningThreshold);
        
        this.longRunningPumpTimers.set(deviceId, timer);
        
        // Emit pump activated event
        this.emit('pump:activated', { 
          deviceId, 
          device: device || { id: deviceId },
          timestamp: activationTime 
        });
        
        // Create alert for pump activation
        await alertManager.createAlert({
          type: 'pump_activated',
          deviceId,
          device: device || { id: deviceId },
          message: 'Bilge pump activated',
          severity: 'info',
          data: { timestamp: activationTime }
        });
        
      } else if (event.type === 'deactivated') {
        const pumpState = this.activePumps.get(deviceId);
        if (pumpState) {
          const duration = new Date(now) - new Date(pumpState.timestamp);
          this.activePumps.delete(deviceId);
          this.clearLongRunningTimer(deviceId);
          
          const result = { 
            ...event, 
            durationMs: duration,
            startTime: pumpState.timestamp,
            endTime: now.toISOString()
          };
          
          // Emit pump deactivated event
          this.emit('pump:deactivated', { 
            ...result, 
            deviceId, 
            device: pumpState.device || { id: deviceId },
            durationMs: duration 
          });
          
          // Create alert for pump deactivation
          await alertManager.createAlert({
            type: 'pump_deactivated',
            deviceId,
            device: pumpState.device || { id: deviceId },
            message: `Bilge pump ran for ${Math.round(duration / 1000)} seconds`,
            severity: 'info',
            data: { 
              durationMs: duration,
              startTime: pumpState.timestamp,
              endTime: now.toISOString()
            }
          });
          
          return result;
        }
      }
    } catch (error) {
      console.error('Error processing pump event:', error);
      throw error;
    }

    // Store the raw event
    await timeSeriesService.addDataPoint(
      deviceId,
      'pump_events',
      eventData,
      event.timestamp || now.toISOString()
    );

    return eventData;
  }

  async getPumpStatistics(deviceId, options = {}) {
    const { start, end } = this._getTimeRange(options.period);
    
    const events = await timeSeriesService.getDataPoints(
      deviceId,
      'pump_events',
      { start: start.toISOString(), end: end.toISOString() }
    );

    const stats = {
      totalActivations: 0,
      totalRuntime: 0,
      averageDuration: 0,
      activationsByHour: Array(24).fill(0),
      events: []
    };

    events.forEach(event => {
      if (event.v.type === 'activated') {
        stats.totalActivations++;
        const hour = new Date(event.t).getHours();
        stats.activationsByHour[hour]++;
      }
      if (event.v.type === 'deactivated' && event.v.durationMs) {
        stats.totalRuntime += event.v.durationMs;
      }
      
      stats.events.push({
        timestamp: event.t,
        type: event.v.type,
        durationMs: event.v.durationMs
      });
    });

    if (stats.totalActivations > 0) {
      stats.averageDuration = stats.totalRuntime / stats.totalActivations;
    }

    return stats;
  }

  _getTimeRange(period = 'day') {
    const now = new Date();
    let start = new Date(now);

    switch (period.toLowerCase()) {
      case 'hour':
        start.setHours(now.getHours() - 1);
        break;
      case 'day':
        start.setDate(now.getDate() - 1);
        break;
      case 'week':
        start.setDate(now.getDate() - 7);
        break;
      case 'month':
        start.setMonth(now.getMonth() - 1);
        break;
      case '3months':
        start.setMonth(now.getMonth() - 3);
        break;
      default:
        start = new Date(period); // Custom start date
    }

    return { start, end: now };
  }

  // Clear the long-running pump timer
  clearLongRunningTimer(deviceId) {
    if (this.longRunningPumpTimers.has(deviceId)) {
      clearTimeout(this.longRunningPumpTimers.get(deviceId));
      this.longRunningPumpTimers.delete(deviceId);
    }
  }
  
  // Handle long-running pump
  async handleLongRunningPump(deviceId, device) {
    try {
      const pumpState = this.activePumps.get(deviceId);
      if (!pumpState) return;
      
      const duration = new Date() - new Date(pumpState.timestamp);
      const minutes = Math.round(duration / 60000);
      
      // Emit long-running pump event
      this.emit('pump:long_running', { 
        deviceId, 
        durationMs: duration,
        state: pumpState
      });
      
      // Create alert for long-running pump
      await this.alertManager.createAlert({
        type: 'pump_long_running',
        deviceId,
        message: `Bilge pump has been running for ${minutes} minutes`,
        level: 'warning',
        timestamp: new Date().toISOString(),
        data: { 
          durationMs: duration,
          state: pumpState
        }
      });
      
      // Schedule the next check (every 5 minutes)
      const timer = setTimeout(
        () => this.handleLongRunningPump(deviceId, device),
        5 * 60 * 1000 // 5 minutes
      );
      this.longRunningPumpTimers.set(deviceId, timer);
    } catch (error) {
      console.error('Error in handleLongRunningPump:', error);
    }
  }
  
  async shutdown() {
    // Clear all timers
    for (const [deviceId] of this.longRunningPumpTimers) {
      this.clearLongRunningTimer(deviceId);
    }
    this.activePumps.clear();
  }
}

// Create and export a singleton instance
const bilgePumpService = new BilgePumpService();

// Clean up on process exit
// Handle process termination
process.on('SIGTERM', () => bilgePumpService.shutdown());
process.on('SIGINT', () => bilgePumpService.shutdown());

export default bilgePumpService;
