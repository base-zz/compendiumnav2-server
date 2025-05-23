/**
 * OpenPlotterSignalKAdapter
 * 
 * Adapter for OpenPlotter SignalK server implementation
 */
import { BaseSignalKAdapter } from './BaseSignalKAdapter.js';

export class OpenPlotterSignalKAdapter extends BaseSignalKAdapter {
  /**
   * Detect if this adapter can handle the given SignalK server
   * @param {Object} serverInfo - Server information from initial connection
   * @returns {Boolean} - True if this adapter can handle the server
   */
  canHandle(serverInfo) {
    // OpenPlotter typically has a specific endpoint structure
    return serverInfo && 
           serverInfo.endpoints && 
           serverInfo.endpoints.v1 && 
           serverInfo.endpoints.v1['signalk-ws'];
  }

  /**
   * Get WebSocket URL from server endpoints
   * @param {Object} endpoints - Server endpoints response
   * @param {String} baseUrl - Base URL of the server
   * @returns {String|null} - WebSocket URL or null if not found
   */
  getWebSocketUrl(endpoints) {
    if (endpoints && 
        endpoints.endpoints && 
        endpoints.endpoints.v1 && 
        endpoints.endpoints.v1['signalk-ws']) {
      return endpoints.endpoints.v1['signalk-ws'];
    }
    return null;
  }

  /**
   * Process a SignalK message
   * @param {Object} message - Parsed SignalK message
   * @returns {Object} - SignalK-compliant delta with context and updates array
   */
  processMessage(message) {
    // If the message already has a valid updates array, just return it (pass-through)
    if (message.updates && Array.isArray(message.updates)) {
      return {
        context: message.context || 'vessels.self',
        updates: message.updates
      };
    }

    // Otherwise, convert navigationData/alerts to SignalK delta format
    // We'll build updates array from navigationData and alerts
    const updates = [];
    const values = [];
    let context = message.context || 'vessels.self';

    // Extract navigation data
    if (message.navigationData && typeof message.navigationData === 'object') {
      const nav = message.navigationData;
      if (nav.position && typeof nav.position === 'object') {
        if (nav.position.latitude !== undefined && nav.position.longitude !== undefined) {
          values.push({ path: 'navigation.position', value: { latitude: nav.position.latitude, longitude: nav.position.longitude } });
        }
      }
      if (nav.speed !== undefined) {
        values.push({ path: 'navigation.speedOverGround', value: nav.speed });
      }
      if (nav.course !== undefined) {
        values.push({ path: 'navigation.courseOverGroundTrue', value: nav.course });
      }
      if (nav.heading !== undefined) {
        values.push({ path: 'navigation.headingMagnetic', value: nav.heading });
      }
      if (nav.depth && typeof nav.depth === 'object') {
        for (const [k, v] of Object.entries(nav.depth)) {
          values.push({ path: `navigation.depth.${k}`, value: v });
        }
      }
      if (nav.wind && typeof nav.wind === 'object') {
        for (const [k, v] of Object.entries(nav.wind)) {
          values.push({ path: `navigation.wind.${k}`, value: v });
        }
      }
      if (nav.timestamp) {
        // Optionally add timestamp at update level
      }
    }

    // Extract alerts
    if (Array.isArray(message.alerts)) {
      for (const alert of message.alerts) {
        values.push({ path: `notifications.${alert.type}.${alert.id}`, value: {
          message: alert.message,
          severity: alert.severity,
          timestamp: alert.timestamp
        }});
      }
    }

    // Only add update if we have values
    if (values.length > 0) {
      updates.push({
        source: { label: 'OpenPlotterSignalKAdapter' },
        timestamp: new Date().toISOString(),
        values
      });
    }

    return {
      context,
      updates
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
    
    // OpenPlotter specific mappings
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
        // OpenPlotter may provide speed in m/s, convert to knots
        navigationData.speed = val * 1.94384;
        break;
        
      case 'courseOverGroundTrue':
        // OpenPlotter provides course in radians, convert to degrees
        navigationData.course = val * (180/Math.PI);
        break;
        
      case 'headingMagnetic':
        // OpenPlotter may provide heading in radians, convert to degrees
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
        
      case 'wind':
        if (!navigationData.wind) {
          navigationData.wind = {};
        }
        // Handle nested paths like navigation.wind.speedApparent
        if (pathParts.length > 2) {
          const windType = pathParts[2];
          // OpenPlotter may provide wind speed in m/s, convert to knots if needed
          if (windType.includes('speed')) {
            navigationData.wind[windType] = val * 1.94384; // Convert m/s to knots
          } 
          // OpenPlotter may provide wind angle in radians, convert to degrees if needed
          else if (windType.includes('angle')) {
            navigationData.wind[windType] = val * (180/Math.PI); // Convert radians to degrees
          }
          else {
            navigationData.wind[windType] = val;
          }
          console.log(`[OPENPLOTTER-ADAPTER] Processing wind data: ${windType} = ${navigationData.wind[windType]}`);
        }
        break;
        
      default:
        // For other navigation data, store it under its type
        navigationData[dataType] = val;
    }
  }

  /**
   * Process environment data from OpenPlotter
   * @param {Object} value - SignalK value object
   * @param {Object} navigationData - Object to collect navigation data
   */
  processEnvironmentData(value, navigationData) {
    const path = value.path;
    const val = value.value;
    
    // Extract the specific environment data type
    const pathParts = path.split('.');
    
    // OpenPlotter puts depth data under environment in some versions
    if (path.startsWith('environment.depth.')) {
      if (!navigationData.depth) {
        navigationData.depth = {};
      }
      
      const depthType = pathParts[2];
      navigationData.depth[depthType] = val;
    }
    
    // Wind data may also be under environment
    if (path.startsWith('environment.wind.')) {
      if (!navigationData.wind) {
        navigationData.wind = {};
      }
      
      const windProperty = pathParts[2];
      navigationData.wind[windProperty] = val;
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
    
    // OpenPlotter may have a different alert structure
    return {
      id: `${notificationType}-${Date.now()}`,
      type: notificationType,
      message: val.message || val.description || 'No message',
      severity: val.state || val.severity || 'normal',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Create a subscription message for OpenPlotter format
   * @returns {Object} - Subscription message to send to the server
   */
  createSubscriptionMessage() {
    return {
      context: 'vessels.self',
      subscribe: [
        {
          path: 'navigation',
          period: 1000,
          format: 'delta'
        },
        {
          path: 'environment',
          period: 1000,
          format: 'delta'
        },
        {
          path: 'notifications',
          period: 1000,
          format: 'delta'
        }
      ]
    };
  }
}
