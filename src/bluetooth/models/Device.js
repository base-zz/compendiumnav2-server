export default class Device {
  constructor(data = {}) {
    // Required fields
    this.id = data.id || '';           // Unique device ID (MAC address or generated UUID)
    this.address = data.address || ''; // MAC address
    
    // Core properties
    this.name = data.name || `Device-${this.address}`;
    this.type = data.type || 'unknown';
    this.manufacturer = data.manufacturer || '';
    this.isKnown = data.isKnown !== undefined ? data.isKnown : false;
    
    // Timestamps
    this.firstSeen = data.firstSeen || new Date().toISOString();
    this.lastSeen = data.lastSeen || new Date().toISOString();
    
    // Device state
    this.lastReading = data.lastReading || null;
    this.rssi = data.rssi || null;
    
    // Additional metadata
    this.metadata = data.metadata || {};
    this.customProperties = data.customProperties || {};
  }
  
  /**
   * Update device with new data
   * @param {Object} update - Fields to update
   * @returns {Device} - Updated device instance
   */
  update(update) {
    return new Device({
      ...this,
      ...update,
      lastSeen: new Date().toISOString()
    });
  }
  
  /**
   * Update device with new reading
   * @param {Object} reading - New sensor reading
   * @returns {Device} - Updated device instance
   */
  updateReading(reading) {
    return this.update({
      lastReading: {
        ...reading,
        timestamp: new Date().toISOString()
      },
      rssi: reading.rssi || this.rssi
    });
  }
  
  /**
   * Mark device as known
   * @param {string} name - Optional custom name
   * @returns {Device} - Updated device instance
   */
  markAsKnown(name) {
    return this.update({
      isKnown: true,
      ...(name && { name })
    });
  }
  
  /**
   * Convert device to plain object
   * @returns {Object} - Plain object representation
   */
  toJSON() {
    return {
      id: this.id,
      address: this.address,
      name: this.name,
      type: this.type,
      manufacturer: this.manufacturer,
      isKnown: this.isKnown,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      rssi: this.rssi,
      lastReading: this.lastReading,
      metadata: this.metadata,
      customProperties: this.customProperties
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

// Export as default