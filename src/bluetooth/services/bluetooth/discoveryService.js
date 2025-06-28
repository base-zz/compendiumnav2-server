import noble from '@abandonware/noble';
import EventEmitter from 'events';
import storageService from '../storage/storageService.js';
import bilgePumpService from '../bilgePumpService.js';
import Device from '../../models/Device.js';
import RuuviParser from '../../lib/parsers/ruuvi.js';

// Add promise-based methods to noble
noble.startScanningAsync = (serviceUUIDs, allowDuplicates) => {
  return new Promise((resolve, reject) => {
    noble.startScanning(serviceUUIDs, allowDuplicates, (error) => {
      if (error) return reject(error);
      resolve();
    });
  });
};

noble.stopScanningAsync = () => {
  return new Promise((resolve) => {
    noble.stopScanning();
    // Small delay to ensure scanning has stopped
    setTimeout(resolve, 100);
  });
};

class DiscoveryService extends EventEmitter {
  constructor() {
    super();
    this.scanning = false;
    this.knownDevices = new Map(); // Map<address, Device>
    this.parser = RuuviParser;
    this.storageInitialized = false;
    this.scanTimer = null;
    this.lastLogTime = 0; // Track last log time to avoid spamming the console
    
    // Batching configuration
    this._batchInterval = 1000; // 1 second batch interval
    this._batchTimeout = null;
    this._batchQueue = new Map(); // Map<deviceId, deviceData>
  }

  /**
   * Initialize the discovery service
   */
  async initialize() {
    try {
      await storageService.initialize();
      await this._loadKnownDevices();
      this._setupEventHandlers();
      this.storageInitialized = true;
      this.emit('ready');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Set up noble event handlers
   */
  _setupEventHandlers() {
    noble.on('stateChange', this._handleStateChange.bind(this));
    noble.on('discover', this._handleDiscover.bind(this));
    noble.on('scanStart', () => {
      console.log('🔍 BLE scan started');
      this.emit('scanStart');
    });
    noble.on('scanStop', () => {
      console.log('⏹️ BLE scan stopped');
      this.emit('scanStop');
    });
  }

  /**
   * Handle BLE adapter state changes
   * @param {string} state - The new state of the BLE adapter
   */
  _handleStateChange(state) {
    console.log(`BLE adapter state changed to: ${state}`);
    
    switch (state) {
      case 'poweredOn':
        console.log('✅ Bluetooth adapter is powered on and ready');
        this.emit('stateChange', 'poweredOn');
        break;
        
      case 'poweredOff':
        console.error('❌ Bluetooth is powered off. Please turn on Bluetooth in System Preferences.');
        this.emit('stateChange', 'poweredOff');
        break;
        
      case 'unauthorized':
        console.error('❌ App is not authorized to use Bluetooth. Please check System Preferences > Security & Privacy > Privacy > Bluetooth.');
        this.emit('stateChange', 'unauthorized');
        break;
        
      case 'unsupported':
        console.error('❌ Bluetooth Low Energy is not supported on this device');
        this.emit('stateChange', 'unsupported');
        break;
        
      case 'resetting':
        console.log('🔄 Bluetooth adapter is resetting...');
        this.emit('stateChange', 'resetting');
        break;
        
      case 'unknown':
      default:
        console.error(`❌ Bluetooth state is ${state}. This might indicate an issue with the Bluetooth adapter.`);
        console.log('💡 Try these troubleshooting steps:');
        console.log('1. Turn Bluetooth off and on in System Preferences');
        console.log('2. Run: sudo pkill bluetoothd');
        console.log('3. Restart your computer');
        this.emit('stateChange', state);
    }
  }

  /**
   * Start scanning for BLE devices
   * @param {number} [timeout=0] - Time in milliseconds to scan for (0 = no timeout)
   * @returns {Promise<void>}
   */
  /**
   * Start scanning for BLE devices
   * @param {number} [timeout=0] - Time in milliseconds to scan for (0 = no timeout)
   * @returns {Promise<boolean>} - True if scanning started successfully
   */
  async startScanning(timeout = 0) {
    if (this.scanning) {
      console.log('⚠️  Already scanning for BLE devices');
      return false;
    }

    // Clear any existing scan timer
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }

    // Check if Bluetooth is powered on
    if (noble.state !== 'poweredOn') {
      console.log(`Bluetooth is not ready (state: ${noble.state}). Waiting for poweredOn state...`);
      
      try {
        await new Promise((resolve, reject) => {
          const stateTimeout = setTimeout(() => {
            noble.removeListener('stateChange', onStateChange);
            reject(new Error(`Timed out waiting for Bluetooth to be ready. Current state: ${noble.state}`));
          }, 10000); // 10 second timeout
          
          const onStateChange = (state) => {
            if (state === 'poweredOn') {
              clearTimeout(stateTimeout);
              noble.removeListener('stateChange', onStateChange);
              resolve();
            }
          };
          
          noble.on('stateChange', onStateChange);
        });
      } catch (error) {
        console.error('Error waiting for Bluetooth to be ready:', error);
        throw error;
      }
    }
    
    console.log('Starting BLE scan...');
    this.scanning = true;
    this.emit('scanStart');
    
    try {
      // Start scanning with duplicate reporting enabled
      await noble.startScanningAsync([], true);
      
      // Set scan timeout if specified
      if (timeout > 0) {
        console.log(`Will stop scanning after ${timeout}ms`);
        this.scanTimer = setTimeout(async () => {
          console.log('Scan duration reached, stopping...');
          await this.stopScanning();
        }, timeout);
      } else {
        console.log('Scanning indefinitely (press Ctrl+C to stop)');
      }
      
      return true;
    } catch (error) {
      this.scanning = false;
      console.error('Error starting BLE scan:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop scanning for BLE devices
   * @returns {Promise<boolean>} - True if scanning was stopped, false if not scanning
   */
  async stopScanning() {
    if (!this.scanning) {
      console.log('⚠️  Not currently scanning');
      return false;
    }
    
    console.log('Stopping BLE scan...');
    
    // Clear any existing scan timer
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    
    try {
      await noble.stopScanningAsync();
      
      // Process any remaining batched updates
      if (this._batchTimeout) {
        clearTimeout(this._batchTimeout);
        await this._processBatch();
      }
      
      this.emit('scanStop');
      return true;
    } catch (error) {
      console.error('Error stopping scan:', error);
      return false;
    }
  }

  /**
   * Load known devices from storage
   */
  async _loadKnownDevices() {
    try {
      const devices = await storageService.getAllDevices();
      devices.forEach(deviceData => {
        const device = new Device(deviceData);
        this.knownDevices.set(device.address, device);
      });
      this.emit('devicesLoaded', Array.from(this.knownDevices.values()));
    } catch (error) {
      this.emit('error', new Error(`Failed to load known devices: ${error.message}`));
      throw error;
    }
  }

  /**
   * Check if a device is known
   * @param {string} address - Device MAC address
   * @returns {boolean} - True if device is known
   */
  isKnownDevice(address) {
    return this.knownDevices.has(address) && this.knownDevices.get(address).isKnown;
  }

  /**
   * Get all discovered devices
   * @param {Object} filter - Optional filter criteria
   * @returns {Array<Device>} - Array of devices
   */
  getDevices(filter = {}) {
    const devices = Array.from(this.knownDevices.values());
    if (Object.keys(filter).length === 0) {
      return devices;
    }
    return devices.filter(device => device.matches(filter));
  }

  /**
   * Get a device by address
   * @param {string} address - Device MAC address
   * @returns {Device|undefined} - Device if found
   */
  getDevice(address) {
    return this.knownDevices.get(address);
  }

  /**
   * Process batched device updates
   */
  async _processBatch() {
    if (this._batchQueue.size === 0) {
      this._batchTimeout = null;
      return;
    }

    // Create a copy of the current batch and clear the queue
    const batchToProcess = new Map(this._batchQueue);
    this._batchQueue.clear();
    
    // Process each device in the batch
    for (const [deviceId, device] of batchToProcess.entries()) {
      try {
        const isNewDevice = !this.knownDevices.has(deviceId);
        
        if (isNewDevice) {
          console.log(`✨ New device discovered: ${device.name || 'Unnamed'} (${deviceId})`);
          this.emit('newDevice', device);
        }
        
        // Update the known devices map
        this.knownDevices.set(deviceId, device);
        
        // Save the device to storage (don't await to avoid blocking the event loop)
        this._saveDevice(device).catch(error => {
          console.error('Error saving device:', error);
        });
        
      } catch (error) {
        console.error(`Error processing device ${deviceId}:`, error);
        this.emit('error', new Error(`Failed to process device ${deviceId}: ${error.message}`));
      }
    }
    
    // Emit batch processed event
    this.emit('batchProcessed', Array.from(batchToProcess.values()));
  }
  
  /**
   * Handle discovery of a BLE peripheral
   * @param {Object} peripheral - Noble peripheral object
   */
  async _handleDiscover(peripheral) {
    try {
      // Debug log for raw peripheral data
      if (peripheral.advertisement && peripheral.advertisement.manufacturerData) {
        const manufacturerId = peripheral.advertisement.manufacturerData.readUInt16LE(0);
        if (manufacturerId === 0x0499) {
          console.log('\n🔍 Found potential Ruuvi tag:', {
            id: peripheral.id,
            address: peripheral.address,
            manufacturerData: peripheral.advertisement.manufacturerData.toString('hex'),
            localName: peripheral.advertisement.localName,
            serviceUuids: peripheral.advertisement.serviceUuids
          });
        }
      }

      const device = this._parseDevice(peripheral);
      
      if (!device || !device.id) {
        console.log('⚠️  Skipping invalid device:', peripheral.id, peripheral.address);
        return; // Skip invalid devices
      }
      
      // Track last seen time for each device to avoid console spam
      const now = Date.now();
      const isNewDevice = !this.knownDevices.has(device.id);
      const knownDevice = this.knownDevices.get(device.id);
      
      // Only log significant changes (new device, type change, or >5dBm RSSI change)
      const rssiChanged = knownDevice ? Math.abs(knownDevice.rssi - device.rssi) > 5 : true;
      const typeChanged = knownDevice && knownDevice.type !== device.type;
      const shouldLog = isNewDevice || rssiChanged || typeChanged;
      
      // Add to batch queue
      this._batchQueue.set(device.id, device);
      
      // Schedule batch processing if not already scheduled
      if (!this._batchTimeout) {
        this._batchTimeout = setTimeout(() => {
          this._processBatch().catch(error => {
            console.error('Error processing batch:', error);
          });
        }, this._batchInterval);
      }
      
      // Only log if there's something interesting to report
      if (shouldLog) {
        const logLines = [];
        
        if (isNewDevice) {
          logLines.push(`\n✨ NEW DEVICE DISCOVERED!`);
        } else if (rssiChanged) {
          logLines.push(`\n📶 SIGNAL STRENGTH UPDATE`);
        } else if (typeChanged) {
          logLines.push(`\n🔄 DEVICE TYPE UPDATED`);
        }
        
        // Only show device details if we're logging something
        if (logLines.length > 0) {
          const deviceInfo = [
            `📱 ${device.name || 'Unnamed Device'}`,
            device.type && device.type !== 'unknown' ? `• Type: ${device.type}` : '',
            device.manufacturer ? `• Manufacturer: ${device.manufacturer}` : '',
            `• RSSI: ${device.rssi} dBm`,
            device.address ? `• Address: ${device.address}` : `• ID: ${device.id.substring(0, 8)}...`,
            `• Last Seen: ${new Date().toISOString()}`
          ].filter(Boolean).join('\n  ');
          
          logLines.push(deviceInfo);
          
          // Show manufacturer data for unknown devices to help with debugging
          if (device.type === 'unknown' && peripheral.advertisement.manufacturerData) {
            logLines.push(`  🔍 Manufacturer Data: ${peripheral.advertisement.manufacturerData.toString('hex')}`);
          }
          
          console.log(logLines.join('\n'));
        }
      }
      
      // Emit device updated event
      this.emit('deviceUpdated', device);
      
    } catch (error) {
      console.error('Error handling discovered device:', error);
      this.emit('error', new Error(`Failed to handle discovered device: ${error.message}`));
    }
  }
  
  /**
   * Parse a BLE peripheral into a Device object
   * @param {Object} peripheral - Noble peripheral object
   * @returns {Device} - Parsed device
   */
  _parseDevice(peripheral) {
    const { id, address, rssi, advertisement } = peripheral;
    const { localName, manufacturerData, serviceUuids } = advertisement || {};
    
    // Try to get MAC address if available (some platforms don't expose it)
    let deviceAddress = address || id;
    
    // Clean up the address if it's in UUID format
    if (deviceAddress && deviceAddress.includes('-')) {
      deviceAddress = deviceAddress.replace(/-/g, '').toLowerCase();
    }
    
    // Try to determine device type based on advertisement data
    let type = 'unknown';
    let manufacturer = '';
    let name = localName || `Device-${id || address}`;
    
    // Check for manufacturer data
    if (manufacturerData && manufacturerData.length >= 2) {
      const manufacturerId = manufacturerData.readUInt16LE(0);
      
      // Common manufacturer IDs (https://www.bluetooth.com/specifications/assigned-numbers/company-identifiers/)
      const MANUFACTURERS = {
        0x004C: 'Apple',
        0x0075: 'Samsung',
        0x011B: 'Sony',
        0x00E0: 'Google',
        0x0499: 'Ruuvi',
        0x0059: 'Nordic Semiconductor',
        0x0006: 'Microsoft',
        0x000F: 'Texas Instruments'
      };
      
      manufacturer = MANUFACTURERS[manufacturerId] || `Unknown (0x${manufacturerId.toString(16).toUpperCase()})`;
      
      // Handle Ruuvi tags
      if (manufacturerId === 0x0499) {
        type = 'ruuvi';
        name = localName || 'Ruuvi Tag';
        
        // Try to parse Ruuvi data
        try {
          // First try the direct parse method
          let sensorData = this.parser.parse(manufacturerData);
          
          // If that fails, try the manufacturer data specific method
          if (!sensorData) {
            sensorData = this.parser.parseRuuviManufacturerData(manufacturerData);
          }
          
          if (sensorData) {
            // Add MAC address to the name if available
            const displayName = sensorData.macAddress 
              ? `${name} (${sensorData.macAddress})` 
              : name;
              
            return new Device({
              id: id || address,
              address: address || id,
              name: displayName,
              type: 'ruuvi',
              manufacturer: 'Ruuvi',
              rssi,
              lastSeen: new Date().toISOString(),
              lastReading: {
                ...sensorData,
                timestamp: new Date().toISOString()
              },
              advertisement: {
                localName,
                serviceUuids,
                manufacturerData: manufacturerData.toString('hex'),
                rawData: Array.from(manufacturerData).map(b => b.toString(16).padStart(2, '0')).join(':')
              },
              connectable: peripheral.connectable || false
            });
          }
        } catch (e) {
          console.error('Error parsing Ruuvi data:', e);
          // Fall through to create a basic device with raw data
          return new Device({
            id: id || address,
            address: address || id,
            name: 'Ruuvi Tag (Unparsed)',
            type: 'ruuvi',
            manufacturer: 'Ruuvi',
            rssi,
            lastSeen: new Date().toISOString(),
            advertisement: {
              localName,
              serviceUuids,
              manufacturerData: manufacturerData.toString('hex'),
              rawData: Array.from(manufacturerData).map(b => b.toString(16).padStart(2, '0')).join(':')
            },
            connectable: peripheral.connectable || false
          });
        }
      } else if (manufacturerId === 0x004C) {
        type = 'apple';
      } else if (serviceUuids && serviceUuids.length > 0) {
        // Try to determine type from service UUIDs
        const serviceUuid = serviceUuids[0].toLowerCase();
        
        // Common service UUIDs (partial matches)
        if (serviceUuid.includes('fe95')) {
          type = 'xiaomi';
        } else if (serviceUuid.includes('fe9f')) {
          type = 'google';
        }
      }
    }
    
    // Create a basic device object with cleaned up data
    const deviceData = {
      id: id || deviceAddress,
      address: deviceAddress,
      name: name,
      type: type,
      manufacturer: manufacturer,
      rssi: rssi,
      lastSeen: new Date().toISOString(),
      advertisement: {
        localName: localName,
        serviceUuids: serviceUuids || [],
        manufacturerData: manufacturerData?.toString('hex'),
        txPowerLevel: advertisement?.txPowerLevel
      },
      connectable: peripheral.connectable || false
    };
    
    return new Device(deviceData);
  }

  /**
   * Save device to storage
   * @param {Device} device - Device instance to save
   * @returns {Promise<Device>} - The saved device
   */
  async _saveDevice(device) {
    if (!this.storageInitialized) {
      console.warn('Storage not initialized, skipping device save');
      return device;
    }

    if (!device || !device.id) {
      console.warn('Cannot save device: Missing ID', device);
      return device;
    }

    try {
      // Ensure device has required fields
      const deviceToSave = {
        id: device.id,
        address: device.address || device.id,
        name: device.name || `Device-${device.id.substring(0, 8)}`,
        type: device.type || 'unknown',
        rssi: device.rssi || null,
        lastSeen: device.lastSeen || new Date().toISOString(),
        ...(device.advertisement ? { advertisement: device.advertisement } : {})
      };

      // Try to get existing device to handle updates
      let existingDevice;
      try {
        existingDevice = await storageService.getDevice(device.id);
      } catch (error) {
        // Ignore not found errors
        if (error.status !== 404) {
          console.warn(`Error checking for existing device ${device.id}:`, error.message);
        }
      }

      // If device exists, merge with existing data
      if (existingDevice) {
        deviceToSave._rev = existingDevice._rev; // Include _rev for updates
        deviceToSave.createdAt = existingDevice.createdAt || new Date().toISOString();
        deviceToSave.updatedAt = new Date().toISOString();
      } else {
        deviceToSave.createdAt = new Date().toISOString();
        deviceToSave.updatedAt = deviceToSave.createdAt;
      }

      // Save the device
      await storageService.saveDevice(deviceToSave);
      
      // Save reading if available
      if (device.lastReading) {
        try {
          const reading = {
            ...device.lastReading,
            deviceId: device.id,
            timestamp: device.lastReading.timestamp || new Date().toISOString()
          };
          
          await storageService.addReading(device.id, reading);
          
          // Handle bilge pump events if this is a pump reading
          if (reading.type === 'activated' || reading.type === 'deactivated') {
            try {
              await bilgePumpService.recordPumpEvent(device.id, reading, deviceToSave);
            } catch (pumpError) {
              console.warn(`Error recording pump event for device ${device.id}:`, pumpError.message);
            }
          }
        } catch (readingError) {
          console.warn(`Error saving reading for device ${device.id}:`, readingError.message);
        }
      }
      
      return deviceToSave;
    } catch (error) {
      if (error.status === 409) {
        // Document conflict - this is normal during rapid updates
        console.debug(`Document conflict while saving device ${device.id}, will retry on next update`);
      } else {
        console.error(`Failed to save device ${device.id}:`, error.message);
      }
      // Don't throw here to prevent blocking the discovery process
      return device;
    }
  }
}

// Create and export a singleton instance
const discoveryService = new DiscoveryService();

export default discoveryService;
