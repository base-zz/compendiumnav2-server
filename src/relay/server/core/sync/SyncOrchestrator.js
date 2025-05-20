/**
 * SyncOrchestrator
 * 
 * Manages data synchronization between the Relay Server and VPS Relay Proxy.
 * Implements adaptive throttling based on network conditions, state, and priority.
 */

import EventEmitter from 'events';

export class SyncOrchestrator extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Default throttle intervals (ms)
      defaultThrottleIntervals: {
        navigation: 2000,
        vessel: 5000,
        alerts: 1000,
        default: 5000
      },
      
      // Throttle profiles
      throttleProfiles: {
        NORMAL: {
          multiplier: 1.0,
          priorityBoost: {
            HIGH: 0.2,   // 20% of normal interval
            NORMAL: 1.0,
            LOW: 2.0     // 2x normal interval
          }
        },
        HIGH_SPEED: {
          multiplier: 0.5, // Faster updates (half the interval)
          priorityBoost: {
            HIGH: 0.1,   // 10% of normal interval
            NORMAL: 0.5, // 50% of normal interval
            LOW: 1.0     // Normal interval
          }
        },
        ANCHORED: {
          multiplier: 2.0, // Slower updates (twice the interval)
          priorityBoost: {
            HIGH: 0.5,   // 50% of normal interval
            NORMAL: 2.0, // 2x normal interval
            LOW: 4.0     // 4x normal interval
          }
        },
        POWER_SAVING: {
          multiplier: 3.0, // Very slow updates (3x the interval)
          priorityBoost: {
            HIGH: 1.0,   // Normal interval
            NORMAL: 3.0, // 3x normal interval
            LOW: 6.0     // 6x normal interval
          }
        }
      },
      
      // Network quality adaptation
      networkQualityAdaptation: true,
      poorNetworkMultiplier: 2.0, // Double intervals on poor network
      
      ...config
    };
    
    // Current throttle profile
    this.currentProfile = 'NORMAL';
    
    // Network quality metrics
    this.networkQuality = {
      latency: 0,
      packetLoss: 0,
      lastCheck: Date.now(),
      status: 'GOOD' // GOOD, FAIR, POOR
    };
    
    // Data type statistics
    this.dataStats = new Map();
    
    // Initialize stats for common data types
    ['navigation', 'vessel', 'alerts'].forEach(type => {
      this.dataStats.set(type, {
        sendCount: 0,
        lastSent: 0,
        averageInterval: this.config.defaultThrottleIntervals[type] || this.config.defaultThrottleIntervals.default
      });
    });
    
    // Set up network quality monitoring
    this._setupNetworkMonitoring();
  }
  
  /**
   * Get the throttle interval for a specific data type and priority
   * 
   * @param {string} dataType - Type of data (navigation, vessel, etc.)
   * @param {string} priority - Priority level (HIGH, NORMAL, LOW)
   * @returns {number} - Throttle interval in milliseconds
   */
  getThrottleInterval(dataType, priority = 'NORMAL') {
    // Get base interval for this data type
    const baseInterval = this.config.defaultThrottleIntervals[dataType] || 
                         this.config.defaultThrottleIntervals.default;
    
    // Get current profile settings
    const profile = this.config.throttleProfiles[this.currentProfile];
    
    // Calculate adjusted interval based on profile and priority
    let adjustedInterval = baseInterval * profile.multiplier;
    
    // Apply priority boost
    adjustedInterval *= profile.priorityBoost[priority] || 1.0;
    
    // Apply network quality adjustment if enabled
    if (this.config.networkQualityAdaptation && this.networkQuality.status === 'POOR') {
      adjustedInterval *= this.config.poorNetworkMultiplier;
    }
    
    // Ensure minimum interval of 100ms
    return Math.max(100, Math.round(adjustedInterval));
  }
  
  /**
   * Update the current throttle profile
   * 
   * @param {string} profileName - Name of the profile (NORMAL, HIGH_SPEED, ANCHORED, POWER_SAVING)
   */
  updateThrottleProfile(profileName) {
    if (this.config.throttleProfiles[profileName]) {
      this.currentProfile = profileName;
      // console.log(`[SYNC] Updated throttle profile to: ${profileName}`);
      this.emit('profile-changed', profileName);
    } else {
      console.warn(`[SYNC] Unknown throttle profile: ${profileName}`);
    }
  }
  
  /**
   * Record a successful data send
   * 
   * @param {string} dataType - Type of data that was sent
   */
  recordDataSend(dataType) {
    const now = Date.now();
    
    if (!this.dataStats.has(dataType)) {
      this.dataStats.set(dataType, {
        sendCount: 0,
        lastSent: 0,
        averageInterval: this.config.defaultThrottleIntervals.default
      });
    }
    
    const stats = this.dataStats.get(dataType);
    
    // Update stats
    if (stats.lastSent > 0) {
      const interval = now - stats.lastSent;
      // Exponential moving average for interval
      stats.averageInterval = (stats.averageInterval * 0.8) + (interval * 0.2);
    }
    
    stats.sendCount++;
    stats.lastSent = now;
  }
  
  /**
   * Record network metrics
   * 
   * @param {Object} metrics - Network metrics object
   * @param {number} metrics.latency - Latency in milliseconds
   * @param {number} metrics.packetLoss - Packet loss percentage (0-100)
   */
  updateNetworkMetrics(metrics) {
    this.networkQuality.latency = metrics.latency || this.networkQuality.latency;
    this.networkQuality.packetLoss = metrics.packetLoss || this.networkQuality.packetLoss;
    this.networkQuality.lastCheck = Date.now();
    
    // Update network status
    if (this.networkQuality.packetLoss > 10 || this.networkQuality.latency > 500) {
      this.networkQuality.status = 'POOR';
    } else if (this.networkQuality.packetLoss > 5 || this.networkQuality.latency > 250) {
      this.networkQuality.status = 'FAIR';
    } else {
      this.networkQuality.status = 'GOOD';
    }
    
    this.emit('network-quality-changed', this.networkQuality);
  }
  
  /**
   * Get statistics for all data types
   * 
   * @returns {Object} - Statistics object
   */
  getStats() {
    const stats = {
      profile: this.currentProfile,
      networkQuality: this.networkQuality,
      dataTypes: {}
    };
    
    this.dataStats.forEach((typeStats, type) => {
      stats.dataTypes[type] = { ...typeStats };
    });
    
    return stats;
  }
  
  /**
   * Set up network quality monitoring
   * @private
   */
  _setupNetworkMonitoring() {
    // This would normally ping the VPS and measure response times
    // For now, we'll simulate network quality changes
    setInterval(() => {
      // Simulate random network quality changes
      const latency = Math.floor(Math.random() * 300) + 50; // 50-350ms
      const packetLoss = Math.random() * 8; // 0-8%
      
      this.updateNetworkMetrics({ latency, packetLoss });
    }, 30000); // Check every 30 seconds
  }
}

// Create singleton instance
const syncOrchestrator = new SyncOrchestrator();

export { syncOrchestrator };
