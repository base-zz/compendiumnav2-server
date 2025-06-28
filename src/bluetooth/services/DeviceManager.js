import storageService from './storage/storageService.js';

/**
 * Manages Bluetooth devices and their state
 */
export class DeviceManager {
  constructor() {
    this.devices = new Map(); // deviceId -> Device
    this.selectedDevices = new Set(); // Set of selected device IDs
    this.initialized = false;
  }

  /**
   * Initialize the device manager
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Initialize storage service
      await storageService.initialize();
      
      // Load selected devices from storage
      const selected = await storageService.getSetting('selectedDevices', []);
      this.selectedDevices = new Set(selected);
      
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize DeviceManager:', error);
      throw error;
    }
  }
  
  /**
   * Register or update a device
   * @param {string} id - Device ID (MAC address or unique identifier)
   * @param {Object} data - Device data
   * @returns {Promise<Object>} The updated/created device
   */
  async registerDevice(id, data) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const now = new Date().toISOString();
    let device = this.getDevice(id);
    
    if (!device) {
      // New device
      device = {
        id,
        firstSeen: now,
        lastSeen: now,
        lastUpdated: now,
        rssiHistory: [],
        lastRssi: null,
        advertisement: {},
        sensorData: {},
        isSelected: this.selectedDevices.has(id),
        metadata: {
          alias: null,
          notes: '',
          isFavorite: false
        }
      };
    }
    
    // Update device properties
    device = {
      ...device,
      ...data,
      lastSeen: now,
      lastUpdated: now
    };
    
    // Update RSSI history (keep last 10 readings)
    if (data.rssi !== undefined) {
      device.lastRssi = data.rssi;
      device.rssiHistory = [
        ...(device.rssiHistory || []).slice(-9),
        { timestamp: now, rssi: data.rssi }
      ];
    }
    
    // Store advertisement data if available
    if (data.advertisement) {
      device.advertisement = {
        ...(device.advertisement || {}),
        ...data.advertisement,
        lastUpdated: now
      };
    }
    
    // Store sensor data if available
    if (data.sensorData) {
      device.sensorData = {
        ...(device.sensorData || {}),
        ...data.sensorData,
        lastUpdated: now
      };
    }
    
    // Update in memory
    this.devices.set(id, device);
    
    // Persist to storage
    try {
      await storageService.upsertDevice(device);
    } catch (error) {
      console.error('Failed to persist device:', error);
      // Continue even if persistence fails
    }
    
    return device;
  }
  
  /**
   * Get a device by ID
   * @param {string} id - Device ID
   * @returns {Object|null} The device or null if not found
   */
  getDevice(id) {
    return this.devices.get(id) || null;
  }
  
  /**
   * Get all devices
   * @param {boolean} includeUnselected - Whether to include unselected devices
   * @returns {Promise<Array>} Array of devices
   */
  async getAllDevices(includeUnselected = true) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    try {
      // Get devices from storage
      const devices = await storageService.getAllDevices();
      
      // Update in-memory cache
      for (const device of devices) {
        this.devices.set(device.id, device);
      }
      
      // Filter based on selection if needed
      return includeUnselected 
        ? devices 
        : devices.filter(device => this.selectedDevices.has(device.id));
    } catch (error) {
      console.error('Failed to get devices:', error);
      // Fallback to in-memory devices
      return Array.from(this.devices.values());
    }
  }
  
  /**
   * Remove a device
   * @param {string} id - Device ID
   * @returns {boolean} True if device was removed, false if not found
   */
  removeDevice(id) {
    return this.devices.delete(id);
  }
  
  /**
   * Get devices by type
   * @param {string} type - Device type
   * @param {boolean} selectedOnly - Whether to include only selected devices
   * @returns {Promise<Array>} Array of matching devices
   */
  async getDevicesByType(type, selectedOnly = false) {
    const devices = await this.getAllDevices();
    return devices.filter(device => 
      device.type === type && 
      (!selectedOnly || this.selectedDevices.has(device.id))
    );
  }
  
  /**
   * Select a device
   * @param {string} deviceId - ID of the device to select
   * @returns {Promise<boolean>} True if device was selected, false if already selected
   */
  async selectDevice(deviceId) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    if (this.selectedDevices.has(deviceId)) {
      return false;
    }
    
    this.selectedDevices.add(deviceId);
    
    // Update device in storage
    const device = this.getDevice(deviceId);
    if (device) {
      device.isSelected = true;
      await storageService.upsertDevice(device);
    }
    
    // Update selected devices list in storage
    await storageService.setSetting('selectedDevices', Array.from(this.selectedDevices));
    
    return true;
  }
  
  /**
   * Unselect a device
   * @param {string} deviceId - ID of the device to unselect
   * @returns {Promise<boolean>} True if device was unselected, false if not found
   */
  async unselectDevice(deviceId) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    if (!this.selectedDevices.has(deviceId)) {
      return false;
    }
    
    this.selectedDevices.delete(deviceId);
    
    // Update device in storage
    const device = this.getDevice(deviceId);
    if (device) {
      device.isSelected = false;
      await storageService.upsertDevice(device);
    }
    
    // Update selected devices list in storage
    await storageService.setSetting('selectedDevices', Array.from(this.selectedDevices));
    
    return true;
  }
  
  /**
   * Check if a device is selected
   * @param {string} deviceId - ID of the device to check
   * @returns {boolean} True if the device is selected
   */
  isDeviceSelected(deviceId) {
    return this.selectedDevices.has(deviceId);
  }
  
  /**
   * Get all selected devices
   * @returns {Promise<Array>} Array of selected devices
   */
  async getSelectedDevices() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const devices = await this.getAllDevices();
    return devices.filter(device => this.selectedDevices.has(device.id));
  }
  
  /**
   * Update device metadata
   * @param {string} deviceId - ID of the device to update
   * @param {Object} metadata - Metadata to update
   * @returns {Promise<Object>} Updated device or null if not found
   */
  async updateDeviceMetadata(deviceId, metadata) {
    const device = this.getDevice(deviceId);
    if (!device) {
      return null;
    }
    
    // Update metadata
    device.metadata = {
      ...(device.metadata || {}),
      ...metadata,
      lastUpdated: new Date().toISOString()
    };
    
    // Persist changes
    await storageService.upsertDevice(device);
    
    return device;
  }
  
  /**
   * Clear all devices from memory (does not affect storage)
   */
  clearMemory() {
    this.devices.clear();
  }
  
  /**
   * Clear all devices from storage
   */
  async clearStorage() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    try {
      await storageService.clearAllDevices();
      this.devices.clear();
      this.selectedDevices.clear();
    } catch (error) {
      console.error('Failed to clear device storage:', error);
      throw error;
    }
  }
}

export default DeviceManager;
