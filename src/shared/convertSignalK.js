// Utility to convert SignalK notifications into BASE_ALERT_DATUM format
import { BASE_ALERT_DATUM } from './alertDatum.js';

/**
 * Map SignalK notification state to alert level
 */
function mapStateToLevel(state) {
  switch (state) {
    case 'emergency': return 'emergency';
    case 'alarm': return 'critical';
    case 'warn': return 'warning';
    case 'normal': default: return 'info';
  }
}

/**
 * Convert SignalK notifications object to array of BASE_ALERT_DATUM
 * @param {object} notifications - SignalK notifications object
 * @returns {Array} Array of alert datum objects
 */
export function convertSignalKNotifications(notifications) {
  const alerts = [];
  for (const category in notifications) {
    for (const key in notifications[category]) {
      const notif = notifications[category][key];
      const value = notif.value || {};
      alerts.push({
        ...BASE_ALERT_DATUM,
        id: `${category}-${key}`,
        type: 'signalk',
        category,
        source: notif.$source || '',
        level: mapStateToLevel(value.state),
        label: value.message || key,
        message: value.message || key,
        timestamp: value.timestamp || notif.timestamp || '',
        acknowledged: false,
        muted: false,
        mutedUntil: null,
        mutedBy: '',
        status: 'active',
        trigger: 'SignalK notification',
        ruleId: '',
        data: {
          ...notif.meta,
          method: value.method,
          pgn: notif.pgn
        },
        actions: ['acknowledge', 'mute'],
        phoneNotification: false,
        sticky: false,
        externalId: '',
        deviceTargets: [],
        expiresAt: null
      });
    }
  }
  return alerts;
}
