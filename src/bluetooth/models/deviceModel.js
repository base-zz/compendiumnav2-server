export default class DeviceModel {
  /**
   * Create a new device model
   * @param {Object} data - Device data
   */
  constructor(data = {}) {
    this.id = data.id || '';
    this.name = data.name || '';
    this.type = data.type || 'unknown';
    this.address = data.address || '';
    this.firstSeen = data.firstSeen || new Date().toISOString();
    this.lastSeen = data.lastSeen || new Date().toISOString();
    this.isKnown = data.isKnown !== undefined ? data.isKnown : true;
    this.metadata = data.metadata || {};
  }

  /**
   * Update device with new data
   * @param {Object} update - Fields to update
   * @returns {DeviceModel} - Updated device
   */
  update(update) {
    return new DeviceModel({
      ...this,
      ...update,
      lastSeen: new Date().toISOString()
    });
  }

  /**
   * Convert device to plain object
   * @returns {Object} - Plain object representation
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      address: this.address,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      isKnown: this.isKnown,
      metadata: this.metadata
    };
  }

  /**
   * Check if device matches filter criteria
   * @param {Object} filter - Filter criteria
   * @returns {boolean} - True if device matches all criteria
   */
  matches(filter) {
    return Object.entries(filter).every(([key, value]) => {
      return this[key] === value;
    });
  }
}

module.exports = DeviceModel;
