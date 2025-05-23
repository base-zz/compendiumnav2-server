/**
 * BaseSignalKAdapter
 * 
 * Base class for SignalK format adapters that standardize data from different SignalK implementations.
 */
export class BaseSignalKAdapter {
  constructor(config = {}) {
    const isNodeEnv = typeof process !== 'undefined' && process.env;
    this.config = {
      debug: isNodeEnv ? process.env.DEBUG === 'true' : false,
      ...config
    };
  }

  /**
   * Detect if this adapter can handle the given SignalK server
   * @param {Object} serverInfo - Server information from initial connection
   * @returns {Boolean} - True if this adapter can handle the server
   */
  canHandle(serverInfo) {
    return false; // Base implementation always returns false
  }

  /**
   * Get WebSocket URL from server endpoints
   * @param {Object} endpoints - Server endpoints response
   * @param {String} baseUrl - Base URL of the server
   * @returns {String|null} - WebSocket URL or null if not found
   */
  getWebSocketUrl(endpoints, baseUrl) {
    return null; // Implement in subclasses
  }

  /**
   * Process a SignalK message
   * @param {Object} message - Parsed SignalK message
   * @returns {Object} - Processed data in standardized format
   */
  processMessage(message) {
    return {}; // Implement in subclasses
  }

  /**
   * Process navigation data from a SignalK value
   * @param {Object} value - SignalK value object
   * @param {Object} navigationData - Object to collect navigation data
   */
  processNavigationData(value, navigationData) {
    // Implement in subclasses
  }

  /**
   * Process notification/alert data from a SignalK value
   * @param {Object} value - SignalK value object
   * @returns {Object} - Standardized alert object
   */
  processNotification(value) {
    return null; // Implement in subclasses
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
          path: '*',
          period: 1000
        }
      ]
    };
  }

  /**
   * Debug logging
   * @param {String} message - Message to log
   */
  debug(message) {
    if (this.config.debug) {
      console.log(`[SignalKAdapter] ${message}`);
    }
  }
}
