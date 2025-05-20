/**
 * Alert Service
 * 
 * Responsible for creating, managing, and resolving alerts
 * Acts as a dedicated service for alert operations, keeping the StateManager focused on state management
 */

import crypto from 'crypto';
import { BASE_ALERT_DATUM } from '../../../shared/alertDatum.js';

export class AlertService {
  constructor(stateManager) {
    this.stateManager = stateManager;
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
   */
  createAlert(alertData) {
    if (!alertData || !alertData.trigger) {
      console.warn('[AlertService] Invalid alert data provided');
      return null;
    }
    
    this._ensureAlertsStructure();
    
    // Create the alert using the BASE_ALERT_DATUM as foundation
    const alert = {
      ...structuredClone(BASE_ALERT_DATUM),
      id: crypto.randomUUID(),
      type: alertData.type || 'system',
      category: alertData.category || 'anchor',
      source: alertData.source || 'anchor_monitor',
      level: alertData.level || 'warning',
      label: alertData.label || 'Alert',
      message: alertData.message || 'Alert triggered',
      timestamp: new Date().toISOString(),
      acknowledged: false,
      status: 'active',
      trigger: alertData.trigger,
      data: alertData.data || {},
      actions: alertData.actions || ['acknowledge', 'mute'],
      phoneNotification: alertData.phoneNotification !== undefined ? alertData.phoneNotification : true,
      sticky: alertData.sticky !== undefined ? alertData.sticky : true,
      autoResolvable: alertData.autoResolvable !== undefined ? alertData.autoResolvable : true
    };
    
    // Add the alert to active alerts
    this.stateManager.appState.alerts.active.push(alert);
    console.log(`[AlertService] Created new alert: ${alert.label}`);
    
    return alert;
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
   * @param {Object} resolutionData - Data about the resolution
   * @private
   */
  _createResolutionNotification(triggerType, resolutionData) {
    // Find a resolved alert to base the notification on
    const baseAlert = this.stateManager.appState.alerts.resolved.find(
      alert => alert.trigger === triggerType
    );
    
    if (!baseAlert) return;
    
    const resolutionAlert = {
      id: crypto.randomUUID(),
      type: 'system',
      category: baseAlert.category,
      source: baseAlert.source,
      level: 'info',
      label: 'Condition Resolved',
      timestamp: new Date().toISOString(),
      acknowledged: false,
      status: 'active',
      autoResolvable: true,
      autoExpire: true,
      expiresIn: 60000, // 1 minute
      trigger: `${triggerType}_resolved`,
      data: resolutionData,
    };
    
    // Create appropriate message based on trigger type
    let message = 'An alert condition has been resolved.';
    switch (triggerType) {
      case 'critical_range':
        message = `Boat has returned within critical range. Distance to anchor: ${resolutionData.distance} ${resolutionData.units}.`;
        break;
      case 'anchor_dragging':
        message = `Anchor is no longer dragging. Distance to anchor: ${resolutionData.distance} ${resolutionData.units}.`;
        break;
      case 'ais_proximity':
        message = `No vessels detected within warning radius of ${resolutionData.warningRadius} ${resolutionData.units}.`;
        break;
      default:
        message = `${triggerType} condition has been resolved.`;
    }
    
    resolutionAlert.message = message;
    
    // Add to active alerts
    this.stateManager.appState.alerts.active.push(resolutionAlert);
  }
  
  /**
   * Process rule actions related to alerts
   * @param {Array} actions - Actions from the rule engine
   * @returns {boolean} - Whether any state changes were made
   */
  processAlertActions(actions) {
    if (!actions || !actions.length) return false;
    
    let stateChanged = false;
    
    actions.forEach(action => {
      if (action.type === 'CREATE_ALERT' && action.alertData) {
        // Get alert data if it's a function
        const alertData = typeof action.alertData === 'function'
          ? action.alertData(this.stateManager.appState)
          : action.alertData;
        
        if (alertData) {
          this.createAlert(alertData);
          stateChanged = true;
        }
      } else if (action.type === 'RESOLVE_ALERTS' && action.trigger) {
        // Get resolution data if it's a function
        const resolutionData = typeof action.resolutionData === 'function' 
          ? action.resolutionData(this.stateManager.appState)
          : action.resolutionData || {};
        
        // Resolve alerts with this trigger
        const resolvedAlerts = this.resolveAlertsByTrigger(action.trigger, resolutionData);
        if (resolvedAlerts.length > 0) {
          stateChanged = true;
        }
      }
    });
    
    return stateChanged;
  }
}
