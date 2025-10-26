import storageService from './storage/storageService.js';

/**
 * Manages Bluetooth devices and their state
 */
export class DeviceManager {
  constructor() {
    this.devices = new Map(); // deviceId -> Device
    this.selectedDevices = new Set(); // Set of selected device IDs
    this.initialized = false;
    
    // Set up periodic cleanup of stale devices
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleDevices();
    }, 60 * 60 * 1000); // Run cleanup every hour
    
    // Track last update time for each device to implement debouncing
    this.lastUpdateTime = new Map(); // deviceId -> timestamp
    this.updateDebounceTime = 5000; // 5 seconds between updates to the same device
  }

  /**
   * Initialize the device manager
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Initialize storage service
      await storageService.initialize();
      
      // Load selected devices from storage (use same key as StateManager)
      const selected = await storageService.getSetting('bluetooth:selectedDevices', []);
      this.selectedDevices = new Set(selected);
      
      // Load device data for selected devices from storage
      for (const deviceId of selected) {
        try {
          const deviceData = await storageService.getDevice(deviceId);
          if (deviceData) {
            // Store in memory with isSelected flag
            this.devices.set(deviceId, {
              ...deviceData,
              isSelected: true
            });
            // Device loaded from storage
          }
        } catch (error) {
          console.error(`[DeviceManager] Failed to load device ${deviceId} from storage:`, error.message);
        }
      }
      
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
    // console.log(`[DeviceManager] Registering device ${id} (${data.name || 'unnamed'})`);
    
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
    // Preserve existing metadata and merge with new data
    // Preserve isSelected flag - it should only be changed via selectDevice/unselectDevice
    const existingIsSelected = device.isSelected;
    device = {
      ...device,
      ...data,
      isSelected: existingIsSelected, // Preserve the existing isSelected state
      metadata: {
        ...(device.metadata || {}),
        ...(data.metadata || {})
      },
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
    
    // Selected device discovered/updated
    // console.log(`[DeviceManager] Device ${id} updated in memory, total devices: ${this.devices.size}`);
    // console.log(`[DeviceManager] Device isSelected: ${device.isSelected}, in selectedDevices set: ${this.selectedDevices.has(id)}`);
    
    // Only persist selected devices to storage with debouncing
    if (this.selectedDevices.has(id)) {
      const now = Date.now();
      const lastUpdate = this.lastUpdateTime.get(id) || 0;
      
      // Only update if enough time has passed since the last update
      if (now - lastUpdate > this.updateDebounceTime) {
        try {
          await storageService.upsertDevice(device);
          this.lastUpdateTime.set(id, now);
        } catch (error) {
          console.error('Failed to persist device:', error);
          // Continue even if persistence fails
        }
      } else {
        // Skip update due to debouncing
        if (process.env.DEBUG_BLUETOOTH) {
          console.log(`Skipping update for device ${id} due to debouncing (last update ${now - lastUpdate}ms ago)`);
        }
      }
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
   * @returns {Promise<Array>} - Array of devices
   */
  async getAllDevices(includeUnselected = false) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    // Get all devices from memory
    const allDevices = Array.from(this.devices.values());
    
    // If we want all devices, return them directly
    if (includeUnselected) {
      return allDevices;
    }
    
    // Otherwise, filter to only selected devices
    return allDevices.filter(device => this.selectedDevices.has(device.id));
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
      
      // Check if device already exists in storage before storing
      try {
        const existingDevice = await storageService.getDevice(deviceId);
        if (!existingDevice) {
          await storageService.upsertDevice(device);
        } else {
          await storageService.upsertDevice(device);
        }
      } catch (error) {
        await storageService.upsertDevice(device);
      }
    }
    
    // Update selected devices list in storage
    const selectedDevicesArray = Array.from(this.selectedDevices);
    await storageService.setSetting('bluetooth:selectedDevices', selectedDevicesArray);
    
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
    const selectedDevicesArray = Array.from(this.selectedDevices);
    await storageService.setSetting('bluetooth:selectedDevices', selectedDevicesArray);
    
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
  
  /**
   * Clean up stale devices from memory (not from storage)
   * Removes devices that haven't been seen in 12 hours
   */
  cleanupStaleDevices() {
    if (!this.initialized) return;
    
    const now = new Date();
    const staleThreshold = 12 * 60 * 60 * 1000; // 12 hours in milliseconds
    
    for (const [id, device] of this.devices.entries()) {
      // Skip selected devices - we always keep these in memory
      if (this.selectedDevices.has(id)) continue;
      
      const lastSeen = new Date(device.lastSeen);
      const timeSinceLastSeen = now.getTime() - lastSeen.getTime();
      
      if (timeSinceLastSeen > staleThreshold) {
        // Remove from memory only, not from storage
        this.devices.delete(id);
        console.log(`Removed stale device ${id} from memory (last seen ${Math.round(timeSinceLastSeen / (60 * 60 * 1000))} hours ago)`);
      }
    }
  }
}

export default DeviceManager;
