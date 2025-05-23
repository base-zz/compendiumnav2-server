/**
 * StandardSignalKAdapter
 * 
 * Adapter for standard SignalK server implementations
 */
import { BaseSignalKAdapter } from './BaseSignalKAdapter.js';

export class StandardSignalKAdapter extends BaseSignalKAdapter {
  /**
   * Detect if this adapter can handle the given SignalK server
   * @param {Object} serverInfo - Server information from initial connection
   * @returns {Boolean} - True if this adapter can handle the server
   */
  canHandle(serverInfo) {
    // Standard SignalK servers typically have endpoints with v1 version
    return serverInfo && 
           serverInfo.endpoints && 
           Array.isArray(serverInfo.endpoints) &&
           serverInfo.endpoints.some(endpoint => endpoint.version === 'v1');
  }

  /**
   * Get WebSocket URL from server endpoints
   * @param {Object} endpoints - Server endpoints response
   * @param {String} baseUrl - Base URL of the server
   * @returns {String|null} - WebSocket URL or null if not found
   */
  getWebSocketUrl(endpoints, baseUrl) {
    if (!endpoints || !endpoints.endpoints || !Array.isArray(endpoints.endpoints)) {
      return null;
    }

    const wsEndpoint = endpoints.endpoints.find(endpoint => 
      endpoint.type === 'ws' && endpoint.version === 'v1'
    );

    if (wsEndpoint && wsEndpoint.endpoint) {
      return new URL(wsEndpoint.endpoint, baseUrl).toString();
    }

    return null;
  }

  /**
   * Process a SignalK message
   * @param {Object} message - Parsed SignalK message
   * @returns {Object} - Processed data in standardized format
   */
  processMessage(message) {
    if (!message.updates || !Array.isArray(message.updates)) {
      return { navigationData: {}, hasNavigationData: false, alerts: [] };
    }

    const navigationData = {};
    let hasNavigationData = false;
    const alerts = [];

    for (const update of message.updates) {
      if (!update.values || !Array.isArray(update.values)) {
        continue;
      }

      for (const value of update.values) {
        if (!value.path) {
          continue;
        }

        // Process navigation data
        if (value.path.startsWith('navigation.')) {
          this.processNavigationData(value, navigationData);
          hasNavigationData = true;
        }

        // Process notifications (alerts)
        if (value.path.startsWith('notifications.')) {
          const alert = this.processNotification(value);
          if (alert) {
            alerts.push(alert);
          }
        }
      }
    }

    // Add timestamp to navigation data
    if (hasNavigationData) {
      navigationData.timestamp = new Date().toISOString();
    }

    return {
      navigationData,
      hasNavigationData,
      alerts
    };
  }

  /**
   * Process navigation data from a SignalK value
   * @param {Object} value - SignalK value object
   * @param {Object} navigationData - Object to collect navigation data
   */
  processNavigationData(value, navigationData) {
    const path = value.path;
    const val = value.value;
    
    // Extract the specific navigation data type
    const pathParts = path.split('.');
    const dataType = pathParts[1];
    
    // Collect navigation data based on path
    switch (dataType) {
      case 'position':
        if (!navigationData.position) {
          navigationData.position = {};
        }
        if (val && typeof val === 'object') {
          if (val.latitude !== undefined) navigationData.position.latitude = val.latitude;
          if (val.longitude !== undefined) navigationData.position.longitude = val.longitude;
        }
        break;
        
      case 'speedOverGround':
        navigationData.speed = val;
        break;
        
      case 'courseOverGroundTrue':
        navigationData.course = val;
        break;
        
      case 'headingTrue':
        navigationData.heading = val;
        break;
        
      case 'depth':
        if (!navigationData.depth) {
          navigationData.depth = {};
        }
        // Handle nested paths like navigation.depth.belowTransducer
        if (pathParts.length > 2) {
          const depthType = pathParts[2];
          navigationData.depth[depthType] = val;
        }
        break;
        
      case 'wind':
        if (!navigationData.wind) {
          navigationData.wind = {};
        }
        // Handle nested paths like navigation.wind.speedApparent
        if (pathParts.length > 2) {
          const windType = pathParts[2];
          navigationData.wind[windType] = val;
          console.log(`[SIGNALK-ADAPTER] Processing wind data: ${windType} = ${val}`);
        }
        break;
        
      default:
        // For other navigation data, store it under its type
        navigationData[dataType] = val;
    }
  }

  /**
   * Process notification/alert data from a SignalK value
   * @param {Object} value - SignalK value object
   * @returns {Object} - Standardized alert object
   */
  processNotification(value) {
    const path = value.path;
    const val = value.value;
    
    if (!val) return null;
    
    // Extract the notification type
    const notificationType = path.split('.')[1];
    
    return {
      id: `${notificationType}-${Date.now()}`,
      type: notificationType,
      message: val.message || 'No message',
      severity: val.state || 'normal',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Create a subscription message for this SignalK format
   * @returns {Object} - Subscription message to send to the server
   */
  createSubscriptionMessage() {
    return {
      context: 'vessels.self',
      subscribe: [
        {
          path: 'navigation',
          period: 1000
        },
        {
          path: 'notifications',
          period: 1000
        }
      ]
    };
  }
}
