/**
 * DemoSignalKAdapter
 * 
 * Adapter for demo.signalk.org SignalK server implementation
 */
import { BaseSignalKAdapter } from './BaseSignalKAdapter.js';

export class DemoSignalKAdapter extends BaseSignalKAdapter {
  /**
   * Detect if this adapter can handle the given SignalK server
   * @param {Object} serverInfo - Server information from initial connection
   * @returns {Boolean} - True if this adapter can handle the server
   */
  canHandle(serverInfo) {
    // Check if this is the demo server based on server info
    return serverInfo && 
           serverInfo.server && 
           serverInfo.server.id && 
           serverInfo.server.id.includes('signalk-server');
  }

  /**
   * Get WebSocket URL from server endpoints
   * @param {Object} endpoints - Server endpoints response
   * @param {String} baseUrl - Base URL of the server
   * @returns {String|null} - WebSocket URL or null if not found
   */
  getWebSocketUrl(endpoints, baseUrl) {
    // For demo server, we know the WebSocket URL pattern
    if (baseUrl.includes('demo.signalk.org')) {
      return 'wss://demo.signalk.org/signalk/v1/stream';
    }
    
    // Try to find the WebSocket URL in the endpoints
    if (endpoints && endpoints.v1 && endpoints.v1.stream) {
      return new URL(endpoints.v1.stream, baseUrl).toString();
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
    
    // Demo server specific mappings
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
        // Demo server provides speed in m/s, convert to knots
        navigationData.speed = val * 1.94384;
        break;
        
      case 'courseOverGroundTrue':
        // Demo server provides course in radians, convert to degrees
        navigationData.course = val * (180/Math.PI);
        break;
        
      case 'headingTrue':
        // Demo server provides heading in radians, convert to degrees
        navigationData.heading = val * (180/Math.PI);
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
   * Create a subscription message for demo server format
   * @returns {Object} - Subscription message to send to the server
   */
  createSubscriptionMessage() {
    return {
      context: 'vessels.self',
      subscribe: [
        {
          path: '*',
          period: 1000,
          format: 'delta',
          policy: 'instant',
          minPeriod: 200
        }
      ]
    };
  }
}
