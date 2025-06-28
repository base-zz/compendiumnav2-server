export default class Alert {
  constructor({
    id = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    type,
    deviceId,
    device = null,
    message,
    severity = 'info',  // 'info', 'warning', 'critical'
    data = {},
    timestamp = new Date().toISOString(),
    acknowledged = false,
    acknowledgedAt = null,
    acknowledgedBy = null
  }) {
    this._id = id;
    this.type = type;  // e.g., 'threshold', 'pump_activated', 'pump_runtime_exceeded'
    this.deviceId = deviceId;
    this.device = device;  // Optional device object for quick reference
    this.message = message;
    this.severity = severity;
    this.data = data;  // Additional context data
    this.timestamp = timestamp;
    this.acknowledged = acknowledged;
    this.acknowledgedAt = acknowledgedAt;
    this.acknowledgedBy = acknowledgedBy;
  }

  toJSON() {
    return {
      _id: this._id,
      type: this.type,
      deviceId: this.deviceId,
      device: this.device,
      message: this.message,
      severity: this.severity,
      data: this.data,
      timestamp: this.timestamp,
      acknowledged: this.acknowledged,
      acknowledgedAt: this.acknowledgedAt,
      acknowledgedBy: this.acknowledgedBy
    };
  }

  static fromJSON(json) {
    return new Alert({
      id: json._id,
      type: json.type,
      deviceId: json.deviceId,
      device: json.device,
      message: json.message,
      severity: json.severity,
      data: json.data,
      timestamp: json.timestamp,
      acknowledged: json.acknowledged,
      acknowledgedAt: json.acknowledgedAt,
      acknowledgedBy: json.acknowledgedBy
    });
  }

  // Helper to create a new alert with updated acknowledgment
  acknowledge(userId) {
    return new Alert({
      ...this.toJSON(),
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
      acknowledgedBy: userId
    });
  }
}

// Export as default
