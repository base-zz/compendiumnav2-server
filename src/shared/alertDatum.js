// Base Alert Datum Structure
// This serves as documentation, a template for new alerts, and a default placeholder.

export const BASE_ALERT_DATUM = {
  id: '', // Unique string identifier
  type: '', // 'signalk', 'user', 'system', 'weather', etc.
  category: '', // 'navigation', 'anchor', etc.
  source: '', // Origin system/module
  level: '', // 'info', 'warning', 'critical', 'emergency', etc.
  label: '', // Short title
  message: '', // Main user-facing message
  timestamp: '', // ISO8601 string
  acknowledged: false,
  muted: false,
  mutedUntil: null, // ISO8601 or null
  mutedBy: '', // Who/what muted this alert
  status: 'active', // 'active', 'resolved', etc.
  trigger: '', // Human-readable trigger
  ruleId: '', // Rule/definition id
  data: {}, // Source/type-specific data
  actions: [], // e.g. ['acknowledge', 'mute']
  phoneNotification: false, // Should trigger phone notification?
  sticky: false, // Persist until handled?
  autoResolvable: false, // Whether this alert can auto-resolve when conditions return to normal
  externalId: '', // External system id
  deviceTargets: [], // Device ids to notify
  expiresAt: null // ISO8601, auto-expiry
};

// For TypeScript, you could also export a type/interface here for stricter typing.
