'use strict';
// @ts-nocheck


import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { BASE_ALERT_DATUM } from '../../../shared/alertDatum.js';
import debug from 'debug';
import { pushTokenStore } from './PushTokenStore.js';

// Type definitions for JSDoc
/**
 * @typedef {'info'|'warning'|'error'|'critical'} AlertLevel
 * @typedef {'active'|'acknowledged'|'resolved'|'expired'} AlertStatus
 * @typedef {Object} Alert
 * @property {string} id - Unique identifier for the alert
 * @property {string} type - Type of the alert
 * @property {string} [category] - Category of the alert
 * @property {string} [source] - Source of the alert
 * @property {AlertLevel} level - Severity level of the alert
 * @property {string} label - Display label for the alert
 * @property {string} message - Detailed message for the alert
 * @property {string} timestamp - ISO timestamp of when the alert was created
 * @property {boolean} [acknowledged] - Whether the alert has been acknowledged
 * @property {AlertStatus} status - Current status of the alert
 * @property {boolean} [autoResolvable] - Whether the alert can be auto-resolved
 * @property {boolean} [autoExpire] - Whether the alert should auto-expire
 * @property {number} [expiresIn] - Time in milliseconds until the alert expires
 * @property {string} [trigger] - Trigger that caused the alert
 * @property {Object} [data] - Additional data associated with the alert
 * @property {boolean} [silent] - Whether the alert should be silent
 * @property {string} [expiresAt] - ISO timestamp when the alert expires
 * @property {string} [resolvedAt] - ISO timestamp when the alert was resolved
 * @property {string} [resolvedBy] - Who resolved the alert
 * @property {string} [resolutionMessage] - Resolution message
 */

/**
 * @typedef {Object} ResolutionData
 * @property {string} [message] - Optional resolution message
 * @property {Object} [data] - Additional resolution data
 * @property {string|number} [distance] - Distance value for resolution
 * @property {string} [units] - Units for the distance value
 * @property {string|number} [warningRadius] - Warning radius for proximity alerts
 */

/**
 * @typedef {Object} AppState
 * @property {Object} alerts - Alerts state
 * @property {Alert[]} alerts.active - Active alerts
 * @property {Alert[]} alerts.acknowledged - Acknowledged alerts
 * @property {Alert[]} alerts.resolved - Resolved alerts
 */

/**
 * @typedef {Object} StateManager
 * @property {AppState} appState - Application state
 * @property {Function} emit - Emit an event
 * @property {Function} on - Add an event listener
 * @property {Function} off - Remove an event listener
 * @property {Function} getState - Get current state
 * @property {Function} updateState - Update state
 */

// Constants
const log = debug('alert-service');
const PUSH_NOTIFICATION_TIMEOUT = 5000; // 5 seconds

/**
 * Alert Service
 * 
 * Responsible for creating, managing, and resolving alerts
 * Acts as a dedicated service for alert operations, keeping the StateManager focused on state management
 */

// Push notification platforms
const PLATFORMS = {
  IOS: 'ios',
  ANDROID: 'android'
};

// Push notification providers
const PROVIDERS = {
  FCM: 'fcm',
  APNS: 'apns',
  EXPO: 'expo'
};

export class AlertService {
  constructor(stateManager) {
    this.stateManager = stateManager;
    
    // Push notification configuration
    this.pushConfig = {
      // Provider-specific configuration
      [PROVIDERS.FCM]: {
        url: process.env.FCM_URL || 'https://fcm.googleapis.com/fcm/send',
        apiKey: process.env.FCM_SERVER_KEY,
        enabled: !!process.env.FCM_SERVER_KEY
      },
      [PROVIDERS.APNS]: {
        keyId: process.env.APNS_KEY_ID,
        teamId: process.env.APNS_TEAM_ID,
        keyFile: process.env.APNS_KEY_FILE,
        topic: process.env.APNS_TOPIC, // Your app's bundle ID
        production: process.env.NODE_ENV === 'production',
        enabled: !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_KEY_FILE)
      },
      [PROVIDERS.EXPO]: {
        url: process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push/send',
        accessToken: process.env.EXPO_ACCESS_TOKEN,
        enabled: !!process.env.EXPO_ACCESS_TOKEN
      }
    };

    // Initialize push token store
    this.pushTokenStore = pushTokenStore;
    
    // Track which clients are active (have an active WebSocket connection)
    this.activeClients = new Set();
    
    // APN Provider instance (lazy-loaded)
    this._apnProvider = null;
    this._apnProduction = false;
    
    // Initialize token store
    this.pushTokenStore.init().catch(error => {
      log('Failed to initialize push token store:', error);
    });
    
    // Clean up old tokens once a week
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
    this.tokenCleanupInterval = setInterval(
      () => this.pushTokenStore.cleanupInactiveTokens(30), // 30 days
      ONE_WEEK
    );
    
    log('AlertService initialized with push notification support');
  }
  
  /**
   * Initialize the alerts structure in the state if it doesn't exist
   * @private
   */
  /**
   * Register a push token for a client
   * @param {string} clientId - The client's unique ID
   * @param {string} platform - The platform (ios, android)
   * @param {string} token - The push token
   * @param {string} [deviceId] - Optional device ID
   * @returns {Promise<boolean>} - Success status
   */
  /**
   * Send a test notification to verify push functionality
   * @private
   * @param {string} clientId - The client's unique ID
   * @param {string} platform - The platform (ios, android)
   * @returns {Promise<void>}
   */
  /**
   * Send a test notification to the client
   * @param {string} clientId - The client ID to send the test notification to
   * @param {string} platform - The platform (ios/android)
   * @returns {Promise<{success: boolean, error?: string, provider?: string}>} - The result of the send operation
   */
  async _sendTestNotification(clientId, platform) {
    if (!clientId || !platform) {
      const errorMsg = `Missing clientId or platform. clientId: ${clientId}, platform: ${platform}`;
      console.log(`[TEST NOTIFICATION] ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
    
    try {
      console.log(`[TEST NOTIFICATION] Creating test notification for client ${clientId} (${platform})`);
      
      const testAlert = {
        type: 'test',
        level: 'info',
        title: '✅ Registration Verified',
        message: `Successfully registered for ${platform} push notifications`,
        timestamp: new Date().toISOString()
      };
      
      console.log('[TEST NOTIFICATION] Sending test notification:', JSON.stringify(testAlert, null, 2));
      
      const result = await this._sendPushToClient(clientId, testAlert);
      
      if (result && result.success) {
        const successMsg = `Successfully sent test notification to ${clientId}`;
        console.log(`[TEST NOTIFICATION] ${successMsg}`);
        log(successMsg);
        return { success: true, provider: result.provider };
      } else {
        const errorMsg = result?.error || 'Unknown error';
        console.error(`[TEST NOTIFICATION] Failed to send test notification to ${clientId}:`, errorMsg);
        log(`Failed to send test notification to ${clientId}:`, errorMsg);
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      const errorMsg = error.message || 'Unknown error';
      console.error('[TEST NOTIFICATION] Error sending test notification:', error);
      log('Error sending test notification:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Register a push token for a client
   * @param {string} clientId - The client's unique ID
   * @param {string} platform - The platform (ios, android)
   * @param {string} token - The push token
   * @param {string} [deviceId] - Optional device ID
   * @returns {Promise<boolean>} - Success status
   */
  async registerPushToken(clientId, platform, token, deviceId = null) {
    console.log(`[REGISTER] Starting token registration for client ${clientId} (${platform})`);
    
    if (!clientId || !platform || !token) {
      const errorMsg = `Invalid push token registration: missing required fields. clientId: ${clientId}, platform: ${platform}, token: ${token ? 'provided' : 'missing'}`;
      console.error(`[REGISTER] ${errorMsg}`);
      log(errorMsg);
      return false;
    }

    try {
      // Normalize platform
      platform = platform.toLowerCase();
      console.log(`[REGISTER] Normalized platform: ${platform}`);
      
      console.log(`[REGISTER] Storing token for client ${clientId}...`);
      
      // Store the token using the PushTokenStore
      const success = await this.pushTokenStore.registerToken(
        clientId, 
        platform, 
        token, 
        deviceId
      );
      
      if (success) {
        const successMsg = `Registered push token for client ${clientId} on ${platform}`;
        console.log(`[REGISTER] ${successMsg}`);
        log(successMsg);
        
        // Send test notification
        console.log(`[REGISTER] Sending test notification to ${clientId}...`);
        const testResult = await this._sendTestNotification(clientId, platform);
        
        if (testResult && testResult.success) {
          console.log(`[REGISTER] Successfully sent test notification to ${clientId}`);
        } else {
          console.error(`[REGISTER] Failed to send test notification to ${clientId}:`, testResult?.error || 'Unknown error');
        }
        
        return true;
      } else {
        const errorMsg = `Failed to register push token for client ${clientId}`;
        console.error(`[REGISTER] ${errorMsg}`);
        log(errorMsg);
        return false;
      }
    } catch (error) {
      const errorMsg = `Error registering push token for client ${clientId}: ${error.message}`;
      console.error(`[REGISTER] ${errorMsg}`, error);
      log(errorMsg);
      return false;
    }
  }

  /**
   * Unregister a push token
   * @param {string} clientId - The client's unique ID
   * @returns {Promise<boolean>} - Success status
   */
  async unregisterPushToken(clientId) {
    if (!clientId) return false;
    
    try {
      const success = await this.pushTokenStore.unregisterToken(clientId);
      if (success) {
        log(`Unregistered push token for client ${clientId}`);
      } else {
        log(`No push token found for client ${clientId} to unregister`);
      }
      return success;
    } catch (error) {
      log('Error unregistering push token:', error);
      return false;
    }
  }

  /**
   * Mark a client as active (has an active WebSocket connection)
   * @param {string} clientId - The client's unique ID
   * @returns {Promise<void>}
   */
  async setClientActive(clientId) {
    if (!clientId) return;
    
    this.activeClients.add(clientId);
    
    // Update last active time in the token store
    try {
      await this.pushTokenStore.updateLastActive(clientId);
    } catch (error) {
      log('Error updating last active time for client:', clientId, error);
    }
  }

  /**
   * Mark a client as inactive (WebSocket connection closed)
   * @param {string} clientId - The client's unique ID
   */
  setClientInactive(clientId) {
    this.activeClients.delete(clientId);
  }

  /**
   * Send a push notification to a specific client
   * @private
   * @param {string} clientId - The client ID
   * @param {Object} notification - The notification to send
   * @returns {Promise<Object>} - The result of the send operation
   */
  async _sendPushToClient(clientId, notification) {
    console.log(`[PUSH] Attempting to send push to client ${clientId}`);
    
    try {
      // Get the client's push token
      console.log(`[PUSH] Fetching token for client ${clientId}`);
      const tokenData = await this.pushTokenStore.getToken(clientId);
      
      if (!tokenData) {
        const errorMsg = `No push token found for client ${clientId}`;
        console.error(`[PUSH] ${errorMsg}`);
        log(errorMsg);
        return { success: false, error: 'No push token found' };
      }

      console.log(`[PUSH] Found token for client ${clientId}:`, {
        platform: tokenData.platform,
        token: tokenData.token ? `${tokenData.token.substring(0, 10)}...` : 'undefined',
        deviceId: tokenData.deviceId
      });

      // Determine the provider based on the platform
      const platform = tokenData.platform;
      const isIos = platform === PLATFORMS.IOS;
      let result;
      let provider;

      // Send the notification
      if (isIos && this.pushConfig[PROVIDERS.APNS]?.enabled) {
        console.log('[PUSH] Sending via APNS (iOS)');
        provider = 'APNS';
        result = await this._sendApnsNotification(tokenData.token, notification);
      } else if (this.pushConfig[PROVIDERS.FCM]?.enabled) {
        console.log(`[PUSH] Sending via FCM (${isIos ? 'iOS' : 'Android'})`);
        provider = 'FCM';
        result = await this._sendFcmNotification(tokenData.token, notification, isIos);
      } else if (this.pushConfig[PROVIDERS.EXPO]?.enabled) {
        console.log('[PUSH] Sending via Expo');
        provider = 'Expo';
        result = await this._sendExpoNotification(tokenData.token, notification);
      } else {
        const errorMsg = 'No push provider configured or enabled';
        console.error(`[PUSH] ${errorMsg}`, {
          apnsEnabled: this.pushConfig[PROVIDERS.APNS]?.enabled,
          fcmEnabled: this.pushConfig[PROVIDERS.FCM]?.enabled,
          expoEnabled: this.pushConfig[PROVIDERS.EXPO]?.enabled
        });
        return { success: false, error: errorMsg };
      }
      
      console.log(`[PUSH] Successfully sent via ${provider} to ${clientId} (${platform})`);
      log(`Push notification sent to ${clientId} (${platform})`);
      return { success: true, provider, ...result };
      
    } catch (error) {
      const errorMsg = `Error sending push to ${clientId}: ${error.message}`;
      console.error(`[PUSH] ${errorMsg}`, error);
      log(errorMsg);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send a push notification via FCM
   * @private
   * @param {string} token - The FCM token
   * @param {Object} notification - The notification data
   * @param {boolean} [isIos=false] - Whether the target is iOS
   * @returns {Promise<Object>} - The result of the send operation
   */
  /**
   * Handle an invalid push token by removing it from the store
   * @private
   * @param {string} token - The invalid token to remove
   * @returns {Promise<boolean>} - Whether the token was removed
   */
  /**
   * Normalize an alert into a push notification format
   * @private
   * @param {Object} alert - The alert to normalize
   * @returns {Object} - The normalized notification
   */
  _normalizeNotification(alert) {
    // Default notification structure
    const notification = {
      title: alert.label || 'New Alert',
      body: alert.message || 'You have a new alert',
      data: {
        ...alert.data,
        alertId: alert.id,
        alertType: alert.type || 'alert',
        timestamp: alert.timestamp || new Date().toISOString()
      }
    };

    // Add sound configuration if specified
    if (alert.sound !== undefined) {
      notification.sound = alert.sound;
    }

    // Add badge count if specified
    if (alert.badge !== undefined) {
      notification.badge = alert.badge;
    }

    // Add priority if specified
    if (alert.priority) {
      notification.priority = alert.priority;
    }

    return notification;
  }

  /**
   * Handle an invalid push token by removing it from the store
   * @private
   * @param {string} token - The invalid token to remove
   * @returns {Promise<boolean>} - Whether the token was removed
   */
  /**
   * Handle an invalid push token by removing it from the store
   * @private
   * @param {string} token - The invalid token to remove
   * @returns {Promise<boolean>} - Whether the token was removed
   */
  async _handleInvalidToken(token) {
    if (!token) return false;
    
    log(`Removing invalid token: ${token.substring(0, 8)}...`);
    
    try {
      // Get all token records and find the one matching our token
      const tokenRecords = await this.pushTokenStore.getAllTokens();
      
      for (const record of tokenRecords) {
        // Check both possible token locations in the record
        const tokenMatch = record.tokenData?.token === token || 
                         (record.tokenData && record.tokenData === token);
        
        if (tokenMatch) {
          await this.pushTokenStore.unregisterToken(record.clientId);
          log(`Removed invalid token for client: ${record.clientId}`);
          return true;
        }
      }
      
      log(`No client found with token: ${token.substring(0, 8)}...`);
      return false;
    } catch (error) {
      log(`Error handling invalid token: ${error.message}`);
      return false;
    }
  }

  /**
   * Send a push notification via FCM
   * @private
   * @param {string} token - The FCM token
   * @param {Object} notification - The notification data
   * @param {boolean} [isIos=false] - Whether the target is iOS
   * @returns {Promise<Object>} - The result of the send operation
   */
  async _sendFcmNotification(token, notification, isIos = false) {
    const { url, apiKey } = this.pushConfig[PROVIDERS.FCM];
    
    if (!apiKey) {
      log('FCM server key is not configured');
      throw new Error('FCM server key is not configured');
    }

    // Base message structure
    const message = {
      to: token,
      // Notification object for display (can be shown by the OS when app is in background)
      notification: {
        title: notification.title,
        body: notification.body,
        sound: 'default',
        click_action: 'FLUTTER_NOTIFICATION_CLICK' // Important for Android to handle taps
      },
      // Data object for handling in the app
      data: {
        ...notification.data,
        // Ensure we have required fields for routing
        type: notification.data?.type || 'alert',
        alertId: notification.data?.alertId || 'unknown',
        alertType: notification.data?.alertType || 'general',
        // Add timestamp if not present
        timestamp: notification.data?.timestamp || new Date().toISOString()
      },
      // Android-specific settings
      android: {
        priority: 'high',
        ttl: 3600, // 1 hour
        notification: {
          // Channel ID (must match your Android app's notification channel)
          channel_id: 'alerts_high_priority',
          // Notification icon (must be a resource in your Android app)
          icon: 'notification_icon',
          // Color for the notification icon (ARGB format)
          color: '#FF0000',
          // Sound (default or custom sound from app resources)
          sound: 'default',
          // Tag for grouping notifications
          tag: 'alert_notification',
          // Action buttons (Android-specific)
          actions: [
            {
              title: 'View',
              action: 'VIEW_ALERT'
            },
            {
              title: 'Dismiss',
              action: 'DISMISS_ALERT'
            }
          ]
        }
      },
      // APNS (iOS) specific settings
      apns: isIos ? {
        payload: {
          aps: {
            alert: {
              title: notification.title,
              body: notification.body
            },
            sound: 'default',
            badge: 1,
            'mutable-content': 1,
            'content-available': 1
          }
        },
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
          'apns-topic': this.pushConfig[PROVIDERS.APNS]?.topic || 'com.your.app'
        }
      } : undefined
    };

    // Add message ID for tracking
    const messageId = `msg_${Date.now()}`;
    message.data.messageId = messageId;

    log(`Sending FCM message to ${isIos ? 'iOS' : 'Android'} device (${messageId})`);
    
    try {
      const response = await axios.post(url, message, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `key=${apiKey}`
        },
        timeout: PUSH_NOTIFICATION_TIMEOUT
      });

      log(`FCM message sent successfully (${messageId}):`, response.data);
      
      return { 
        provider: PROVIDERS.FCM, 
        status: response.status, 
        data: response.data,
        messageId,
        success: true
      };
      
    } catch (error) {
      const errorMessage = error.response?.data || error.message;
      log(`Failed to send FCM message (${messageId}):`, errorMessage);
      
      // Handle specific FCM errors
      if (error.response?.data?.results?.[0]?.error) {
        const fcmError = error.response.data.results[0].error;
        
        // Handle specific FCM errors
        if (fcmError === 'NotRegistered' || fcmError === 'InvalidRegistration') {
          log(`FCM token is invalid or unregistered: ${token}`);
          // You might want to remove the token from your database
          await this._handleInvalidToken(token);
        }
      }
      
      throw new Error(`FCM send failed: ${errorMessage}`);
    }
  }

  /**
   * Send a push notification via APNS (Apple Push Notification Service)
   * @private
   * @param {string} token - The device token to send the notification to
   * @param {Object} notification - The notification data
   * @returns {Promise<Object>} - Result of the send operation
   */
  async _sendApnsNotification(token, notification) {
    const { keyFile, keyId, teamId, topic, production } = this.pushConfig[PROVIDERS.APNS];
    
    if (!keyFile || !keyId || !teamId || !topic) {
      const error = new Error('APNS configuration is incomplete. Missing required parameters.');
      log('APNS configuration error:', error.message);
      throw error;
    }

    try {
      // Lazy load the APN module to avoid loading it if not used
      const apn = require('@parse/node-apn');
      
      // Create a new provider if it doesn't exist or if the environment has changed
      if (!this._apnProvider || this._apnProduction !== production) {
        this._apnProvider = new apn.Provider({
          token: {
            key: keyFile,
            keyId: keyId,
            teamId: teamId
          },
          production: production
        });
        this._apnProduction = production;
      }

      // Create a new notification
      const apnNotification = new apn.Notification();
      
      // Set the expiration time (1 hour from now)
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      
      // Set the topic (usually the bundle ID of your app)
      apnNotification.topic = topic;
      
      // Set the notification content
      apnNotification.alert = {
        title: notification.title,
        body: notification.body
      };
      
      // Set the badge count if provided
      if (notification.badge !== undefined) {
        apnNotification.badge = notification.badge;
      }
      
      // Set the sound
      apnNotification.sound = notification.sound || 'default';
      
      // Set any custom data
      if (notification.data) {
        apnNotification.payload = notification.data;
      }
      
      // Set the expiration
      apnNotification.expiry = expiry;
      
      // Set the priority
      apnNotification.priority = 10; // 10 means high priority (send immediately)
      
      // Send the notification
      log(`Sending APNS notification to token: ${token}`);
      const result = await this._apnProvider.send(apnNotification, token);
      
      // Log the result
      if (result.failed && result.failed.length > 0) {
        const error = result.failed[0].error;
        log('APNS notification failed to send:', error);
        throw new Error(`APNS send failed: ${error}`);
      }
      
      log('APNS notification sent successfully:', result.sent);
      return { 
        provider: PROVIDERS.APNS, 
        status: 'sent', 
        sent: result.sent,
        failed: result.failed
      };
      
    } catch (error) {
      log('Error sending APNS notification:', error);
      
      // Check for common APNS errors and provide more context
      if (error.statusCode) {
        let errorMessage = `APNS error (${error.statusCode}): `;
        
        switch (error.statusCode) {
          case 400:
            errorMessage += 'Bad request - The request contained an invalid token or other bad syntax.';
            break;
          case 403:
            errorMessage += 'There was an error with the certificate or with the provider authentication token.';
            break;
          case 405:
            errorMessage += 'The request used a bad method. Only POST requests are supported.';
            break;
          case 410:
            errorMessage += 'The device token is no longer active for the topic.';
            break;
          case 413:
            errorMessage += 'The notification payload was too large.';
            break;
          case 429:
            errorMessage += 'The server received too many requests for the same device token.';
            break;
          case 500:
            errorMessage += 'Internal server error.';
            break;
          case 503:
            errorMessage += 'The server is shutting down and unavailable.';
            break;
          default:
            errorMessage += error.message || 'Unknown error';
        }
        
        throw new Error(errorMessage);
      }
      
      // Re-throw the original error if we couldn't handle it specifically
      throw error;
    }
  }

  /**
   * Send a push notification via Expo's push service
   * @private
   */
  async _sendExpoNotification(token, notification) {
    const { url, accessToken } = this.pushConfig[PROVIDERS.EXPO];
    
    const message = {
      to: token,
      title: notification.title,
      body: notification.body,
      data: notification.data || {},
      sound: 'default',
      priority: 'high'
    };

    const headers = {
      'Content-Type': 'application/json'
    };

    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const response = await axios.post(url, message, {
      headers,
      timeout: PUSH_NOTIFICATION_TIMEOUT
    });

    return { provider: PROVIDERS.EXPO, status: response.status, data: response.data };
  }

  /**
   * Initialize the alerts structure in the state if it doesn't exist
   * @private
   */
  _ensureAlertsStructure() {
    const state = this.stateManager.appState;
    
    if (!state.alerts) {
      state.alerts = { active: [], resolved: [] };
    }
    
    if (!state.alerts.active) {
      state.alerts.active = [];
    }
    
    if (!state.alerts.resolved) {
      state.alerts.resolved = [];
    }
  }
  
  /**
   * Create a new alert and add it to the state
   * @param {Object} alertData - Data for the new alert
   * @returns {Object} - The created alert
   * @throws {Error} If stateManager is not available or alertData is invalid
   * @example
   * const alert = alertService.createAlert({
   *   type: 'proximity',
   *   level: 'warning',
   *   message: 'Vessel approaching',
   *   data: { distance: 100, units: 'meters' }
   * });
   */
  createAlert(alertData) {
    if (!this.stateManager) {
      throw new Error('State manager not available');
    }
    
    if (!alertData || typeof alertData !== 'object') {
      throw new Error('Invalid alert data');
    }
    
    this._ensureAlertsStructure();
    
    const newAlert = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      status: 'active',
      acknowledged: false,
      ...alertData
    };
    
    // Use stateManager's updateState if available, otherwise modify directly
    if (typeof this.stateManager.updateState === 'function') {
      this.stateManager.updateState(state => ({
        ...state,
        alerts: {
          ...state.alerts,
          active: [...state.alerts.active, newAlert]
        }
      }));
    } else {
      this.stateManager.appState.alerts.active.push(newAlert);
    }
    
    this.stateManager.emit('alerts:updated', { type: 'alert:created', alert: newAlert });
    
    return newAlert;
  }
  
  /**
   * Send push notifications for an alert to all registered clients
   * @private
   * @param {Object} alert - The alert to send notifications for
   * @returns {Promise<Array>} - Results of the push notification sends
   */
  async _sendPushNotification(alert) {
    if (!alert?.id) {
      log('Cannot send notification for invalid alert');
      return [];
    }

    let tokens = [];
    try {
      const result = await this.pushTokenStore.getAllTokens();
      tokens = Array.isArray(result) ? result : [];
      
      if (tokens.length === 0) {
        log('No push tokens registered, skipping notifications');
        return [];
      }
    } catch (error) {
      log('Error retrieving push tokens:', error);
      return [];
    }
    
    // Prepare the notification payload
    const notification = this._normalizeNotification(alert);
    const results = [];
    
    for (const { clientId } of tokens) {
      // Skip if client is currently connected (they'll get the alert via WebSocket)
      if (this.activeClients.has(clientId)) {
        log(`Skipping push for active client ${clientId}`);
        continue;
      }

      try {
        const result = await this._sendPushToClient(clientId, notification);
        results.push({ clientId, success: result.success });
      } catch (error) {
        log(`Error sending push to client ${clientId}:`, error);
        results.push({ clientId, success: false, error: error.message });
      }
    }

    log(`Sent push notifications for alert ${alert.id}. Results:`, results);
    return results;
  }
  
  /**
   * Resolve alerts by trigger type
   * @param {string} triggerType - The trigger type to resolve
   * @param {Object} resolutionData - Additional data about the resolution
   * @returns {Array} - The resolved alerts
   */
  resolveAlertsByTrigger(triggerType, resolutionData = {}) {
    this._ensureAlertsStructure();
    
    // Find active alerts with this trigger that are auto-resolvable and not acknowledged
    const alertsToResolve = this.stateManager.appState.alerts.active.filter(
      alert => alert.trigger === triggerType && 
               alert.autoResolvable === true && 
               !alert.acknowledged
    );
    
    if (alertsToResolve.length === 0) return [];
    
    console.log(`[AlertService] Auto-resolving ${alertsToResolve.length} alerts with trigger: ${triggerType}`);
    
    // Process each alert to resolve
    alertsToResolve.forEach(alert => {
      // Update alert status
      alert.status = 'resolved';
      alert.resolvedAt = new Date().toISOString();
      alert.resolutionData = {
        ...resolutionData,
        autoResolved: true
      };
      
      // Move from active to resolved
      const index = this.stateManager.appState.alerts.active.findIndex(a => a.id === alert.id);
      if (index !== -1) {
        this.stateManager.appState.alerts.active.splice(index, 1);
        this.stateManager.appState.alerts.resolved.push(alert);
      }
    });
    
    // Create a resolution notification if any alerts were resolved
    if (alertsToResolve.length > 0) {
      this._createResolutionNotification(triggerType, resolutionData);
    }
    
    return alertsToResolve;
  }
  
  /**
   * Create a notification for resolved alerts
   * @param {string} triggerType - The trigger type that was resolved
   * @param {Object} [resolutionData] - Data about the resolution
   * @property {string} [message] - Resolution message
   * @property {string} [distance] - Distance value if applicable
   * @property {string} [units] - Units for distance (e.g., 'meters')
   * @property {string} [warningRadius] - Warning radius if applicable
   * @returns {void}
   * @private
   */
  _createResolutionNotification(triggerType, resolutionData = {}) {
    // Ensure we have a valid state manager and alerts
    if (!this.stateManager?.appState?.alerts?.active) {
      log('State manager or alerts not properly initialized');
      return;
    }

    // Ensure we have a valid trigger type
    if (!triggerType || typeof triggerType !== 'string') {
      log('No valid trigger type provided for resolution notification');
      return;
    }

    try {
      // Ensure we have a valid state manager with required properties
      if (!this.stateManager?.appState?.alerts) {
        console.error('Invalid state manager or app state');
        return;
      }

      // Find a resolved alert to base the notification on
      const baseAlert = this.stateManager.appState.alerts.resolved?.find(
        (alert) => alert.trigger === triggerType
      ) || {
        id: 'system-generated',
        type: 'system',
        category: 'system',
        source: 'alert-service',
        level: 'info',
        label: 'System Alert',
        message: 'A system alert has been resolved',
        timestamp: new Date().toISOString(),
        acknowledged: false,
        status: 'resolved',
        trigger: triggerType
      };
      
      // Create appropriate message based on trigger type
      let message = 'An alert condition has been resolved.';
      const data = resolutionData || {};
      const units = data.units || 'meters';
      const distance = data.distance || 'N/A';
      const warningRadius = data.warningRadius || 'N/A';
      
      // Build message based on trigger type
      if (triggerType === 'critical_range') {
        message = `Boat has returned within critical range. Distance to anchor: ${distance} ${units}.`;
      } else if (triggerType === 'anchor_dragging') {
        message = `Anchor is no longer dragging. Distance to anchor: ${distance} ${units}.`;
      } else if (triggerType === 'ais_proximity') {
        // Find the alert that was resolved
        const resolvedAlert = this.stateManager?.appState?.alerts?.active?.find(
          (alert) => alert.trigger === triggerType
        );

        if (!resolvedAlert) {
          log(`No active alert found for trigger type: ${triggerType}`);
          return;
        }

        // Check if we should create a resolution alert
        const isSilent = resolvedAlert.silent === true || false;
        if (!isSilent) {
          const resolutionAlert = {
            id: `resolution-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: 'alert',
            category: 'system',
            source: 'AlertService',
            level: 'info',
            label: `${resolvedAlert.label || 'Alert'} Resolved`,
            message: (resolutionData && resolutionData.message) || `${resolvedAlert.label || 'Alert'} has been resolved`,
            timestamp: new Date().toISOString(),
            acknowledged: false,
            status: 'active',
            trigger: 'resolution',
            data: {
              ...(resolutionData || {}),
              resolvedAlertId: resolvedAlert.id,
              resolvedAlertType: resolvedAlert.type,
              resolvedAt: new Date().toISOString()
            },
            silent: false // Explicitly set silent flag
          };

          // Add the resolution alert to the active alerts
          if (this.stateManager?.appState?.alerts?.active) {
            this.stateManager.appState.alerts.active.push(resolutionAlert);
            this.stateManager.emit('stateChange', this.stateManager.appState);
          }
        } else {
          console.error('Invalid active alerts array');
        }
      } else {
        message = triggerType + ' condition has been resolved.';
      }

      // Create resolution alert
      const resolutionAlert = {
        id: crypto.randomUUID(),
        type: 'system',
        category: baseAlert.category || 'system',
        source: baseAlert.source || 'alert-service',
        level: 'info',
        label: 'Condition Resolved',
        message: message,
        timestamp: new Date().toISOString(),
        acknowledged: false,
        status: 'active',
        autoResolvable: true,
        autoExpire: true,
        expiresIn: 60000, // 1 minute
        trigger: `${triggerType}_resolved`,
        data: {
          ...data,
          autoResolved: true
        },
        silent: false,
        // Add missing required properties from Alert type
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'system',
        resolutionMessage: message
      };
      
      // Ensure we have a valid active alerts array
      if (Array.isArray(this.stateManager.appState.alerts.active)) {
        this.stateManager.appState.alerts.active.push(resolutionAlert);
      } else {
        console.error('Invalid active alerts array');
      }
    } catch (error) {
      console.error('Error in _createResolutionNotification:', error);
    }
  }
  
  /**
   * Process rule actions related to alerts
   * @param {Array<Object>} [actions] - Actions from the rule engine
   * @returns {boolean} - Whether any state changes were made
   * @throws {Error} If stateManager is not available
   * @example
   * const actions = [
   *   {
   *     type: 'CREATE_ALERT',
   *     alertData: { type: 'proximity', level: 'warning', message: 'Vessel approaching' }
   *   },
   *   {
   *     type: 'RESOLVE_ALERTS',
   *     trigger: 'proximity_alert',
   *     resolutionData: { message: 'Vessel has moved away' }
   *   }
   * ];
   * const changed = alertService.processAlertActions(actions);
   */
  processAlertActions(actions) {
    if (!this.stateManager) {
      throw new Error('State manager not available');
    }
    
    if (!actions || !actions.length) return false;
    
    let stateChanged = false;
    
    try {
      actions.forEach(action => {
        if (!action || typeof action !== 'object') return;
        
        try {
          if (action.type === 'CREATE_ALERT' && (action.alertData || action.data)) {
            // Get alert data if it's a function
            const alertData = (action.alertData || action.data);
            const resolvedAlertData = typeof alertData === 'function'
              ? alertData(this.stateManager.getState ? this.stateManager.getState() : this.stateManager.appState)
              : alertData;
            
            if (alertData) {
              this.createAlert(resolvedAlertData);
              stateChanged = true;
            }
          } else if (action.type === 'RESOLVE_ALERTS' && action.trigger) {
            // Get resolution data if it's a function
            const resolutionData = typeof action.resolutionData === 'function' 
              ? action.resolutionData(this.stateManager.getState ? this.stateManager.getState() : this.stateManager.appState)
              : action.resolutionData || {};
            
            // Resolve alerts with this trigger
            const resolvedAlerts = this.resolveAlertsByTrigger(action.trigger, resolutionData);
            if (resolvedAlerts.length > 0) {
              stateChanged = true;
            }
          }
        } catch (error) {
          log(`Error processing action ${action.type}:`, error);
          // Continue with next action
        }
      });
    } catch (error) {
      log('Unexpected error in processAlertActions:', error);
      throw error; // Re-throw to allow caller to handle
    }
    
    return stateChanged;
  }
  
  /**
   * Clean up resources when the service is no longer needed
   * @returns {void}
   * @example
   * // Example of proper cleanup
   * const alertService = new AlertService(stateManager);
   * // ... use the service ...
   * alertService.destroy(); // Clean up when done
   */
  destroy() {
    // Clear interval for token cleanup
    if (this.tokenCleanupInterval) {
      clearInterval(this.tokenCleanupInterval);
      this.tokenCleanupInterval = null;
    }
    
    // Clean up APN provider if it exists
    if (this._apnProvider) {
      this._apnProvider.shutdown().catch(err => {
        log('Error shutting down APN provider:', err);
      });
      this._apnProvider = null;
    }
    
    // Clear active clients
    this.activeClients.clear();
    
    // Clear any event listeners if they were added
    if (this.stateManager) {
      this.stateManager.removeAllListeners?.('alerts:updated');
    }
    
    log('AlertService destroyed');
  }
}

export default AlertService;