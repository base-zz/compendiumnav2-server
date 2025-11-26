import ContinuousService from './ContinuousService.js';
import ModbusRTU from 'modbus-serial';
import storageService from '../bluetooth/services/storage/storageService.js';
import { scanVictronDevices } from './victron/discoveryHelpers.js';

const UNIT_IDS_SETTING_KEY = 'victronModbusUnitIds';
const DEVICES_SETTING_KEY = 'victronModbusDevices';
const DEFAULT_UNIT_SCAN_RANGE = { start: 0, end: 247 };

/**
 * VictronModbusService
 * 
 * Connects to Victron Cerbo GX via Modbus TCP to read data from connected devices
 * (MultiPlus, Solar Chargers, Battery Monitors, etc.)
 */
export class VictronModbusService extends ContinuousService {
  constructor(options = {}) {
    super('victron-modbus');
    
    this.host = options.host || '192.168.50.158';
    this.port = options.port || 502;
    this.pollInterval = options.pollInterval || 5000; // Poll every 5 seconds
    this.unitId = options.unitId || 100; // Default Victron unit ID
    
    this.client = new ModbusRTU();
    this.connected = false;
    this.pollTimer = null;
    this.hasLoggedFirstData = false;
    this._bmvFailureCount = 0;
    this._bmvRescanInProgress = false;
    this._lastBMVRescan = 0;
    this._bmvRescanCooldownMs = 5 * 60 * 1000; // 5 minutes
    this._maxBMVFailuresBeforeRescan = 3;
    this._missingDeviceLogCooldownMs = 5 * 60 * 1000;
    this._deviceLogState = new Map();
    this.deviceDefinitions = [];
    this._solarUnitIds = new Set();
    this._multiplusUnitIds = new Set();

    this.log(`VictronModbusService initialized for ${this.host}:${this.port}`);
  }

  _shouldLogMissingDevice(key, message) {
    const now = Date.now();
    const last = this._deviceLogState.get(key);

    if (!last || last.message !== message || now - last.timestamp >= this._missingDeviceLogCooldownMs) {
      this._deviceLogState.set(key, { message, timestamp: now });
      return true;
    }

    return false;
  }
  
  async start() {
    await super.start();
    
    try {
      await this._connect();
      
      const savedDevices = await this._loadSavedDevices();
      if (Array.isArray(savedDevices) && savedDevices.length > 0) {
        console.log(`[VictronModbus] Loaded ${savedDevices.length} saved device definitions.`);
        this._applyDiscoveredDevices(savedDevices);
      } else {
        // Check if we have saved Unit IDs (legacy format)
        const savedUnitIds = await this._loadSavedUnitIds();
        
        if (savedUnitIds && savedUnitIds.length > 0) {
          console.log('[VictronModbus] Using legacy saved Unit IDs:', savedUnitIds);
          this._applyLegacyUnitIds(savedUnitIds);
        } else {
          // First try to discover BMV specifically to speed up boot
          this.bmvUnitId = await this.discoverBMV();
          
          if (this.bmvUnitId) {
            console.log(`[VictronModbus] Discovered BMV at Unit ID ${this.bmvUnitId}`);
            this.discoveredDevices = [{ unitId: this.bmvUnitId }];
          }
          
          // Run full discovery to map all devices
          console.log('[VictronModbus] Starting enhanced general device discovery...');
          await this._discoverDevices();
        }
      }
      
      this._startPolling();
      this.log('VictronModbusService started successfully');
    } catch (error) {
      this.log(`Failed to start VictronModbusService: ${error.message}`, 'error');
      throw error;
    }
  }
  
  async _loadSavedUnitIds() {
    try {
      const saved = await storageService.getSetting(UNIT_IDS_SETTING_KEY);
      return saved;
    } catch (error) {
      console.log('[VictronModbus] No saved Unit IDs found');
      return null;
    }
  }
  
  async _saveSavedUnitIds(devices) {
    try {
      await storageService.setSetting(UNIT_IDS_SETTING_KEY, devices);
    } catch (error) {
      console.error('[VictronModbus] Failed to save Unit IDs:', error.message);
    }
  }
  
  async _loadSavedDevices() {
    try {
      const saved = await storageService.getSetting(DEVICES_SETTING_KEY);
      return saved;
    } catch (error) {
      console.log('[VictronModbus] No saved device definitions found');
      return null;
    }
  }
  
  async _saveDiscoveredDevices(devices) {
    try {
      await storageService.setSetting(DEVICES_SETTING_KEY, devices);
    } catch (error) {
      console.error('[VictronModbus] Failed to save device definitions:', error.message);
    }
  }
  
  _applyLegacyUnitIds(entries) {
    if (!Array.isArray(entries)) {
      this.deviceDefinitions = [];
      this.discoveredDevices = [];
      this._solarUnitIds = new Set();
      this._multiplusUnitIds = new Set();
      return;
    }
    this.deviceDefinitions = [];
    this._solarUnitIds = new Set();
    this._multiplusUnitIds = new Set();
    const uniqueUnitIds = new Set();
    const normalized = [];
    for (const entry of entries) {
      let unitId = null;
      if (typeof entry === 'number') {
        unitId = entry;
      } else if (entry && typeof entry.unitId === 'number') {
        unitId = entry.unitId;
      }
      if (typeof unitId === 'number' && !uniqueUnitIds.has(unitId)) {
        uniqueUnitIds.add(unitId);
        normalized.push({ unitId });
      }
    }
    this.discoveredDevices = normalized;
  }
  
  _applyDiscoveredDevices(devices = []) {
    if (!Array.isArray(devices)) {
      this.deviceDefinitions = [];
      return [];
    }
    this.deviceDefinitions = devices;
    const unitIdSet = new Set();
    const solarIds = new Set();
    const multiplusIds = new Set();
    let batteryUnitId = this.bmvUnitId;

    for (const device of devices) {
      if (!device || !Array.isArray(device.sources)) {
        continue;
      }
      for (const source of device.sources) {
        if (!source || typeof source.unitId !== 'number') {
          continue;
        }
        unitIdSet.add(source.unitId);
        if (device.type === 'solar_charger') {
          solarIds.add(source.unitId);
        } else if (device.type === 'multiplus') {
          multiplusIds.add(source.unitId);
        } else if (device.type === 'battery_monitor' && (batteryUnitId === undefined || batteryUnitId === null)) {
          batteryUnitId = source.unitId;
        }
      }
    }

    if (batteryUnitId !== undefined && batteryUnitId !== null) {
      this.bmvUnitId = batteryUnitId;
    }

    this._solarUnitIds = solarIds;
    this._multiplusUnitIds = multiplusIds;
    const legacyList = Array.from(unitIdSet).map(unitId => ({ unitId }));
    this.discoveredDevices = legacyList;
    return Array.from(unitIdSet);
  }
  
  async discoverAndPersistDevices(options = {}) {
    const {
      range = DEFAULT_UNIT_SCAN_RANGE,
      retries = 1,
      delay = 10,
      verbose = false
    } = options;

    console.log('[VictronModbus] Running enhanced device discovery...');
    try {
      const discoveryResult = await scanVictronDevices({
        client: this.client,
        range,
        retries,
        delay,
        verbose,
        defaultUnitId: this.unitId,
        logger: {
          info: (...args) => console.log('[VictronModbus]', ...args),
          warn: (...args) => console.warn('[VictronModbus]', ...args)
        }
      });

      const unitIds = this._applyDiscoveredDevices(discoveryResult.devices);
      await this._saveDiscoveredDevices(discoveryResult.devices);
      await this._saveSavedUnitIds(this.discoveredDevices);
      console.log(`[VictronModbus] Discovery complete. Found ${discoveryResult.devices.length} device types across ${unitIds.length} unit IDs.`);
      return discoveryResult;
    } catch (error) {
      console.error(`[VictronModbus] Enhanced discovery failed: ${error.message}`);
      throw error;
    }
  }

  async _discoverDevices(options = {}) {
    return this.discoverAndPersistDevices(options);
  }
  
  async stop() {
    this._stopPolling();
    await this._disconnect();
    await super.stop();
    this.log('VictronModbusService stopped');
  }
  
  async _connect() {
    try {
      console.log(`[VictronModbus] Attempting to connect to ${this.host}:${this.port}...`);
      await this.client.connectTCP(this.host, { port: this.port });
      this.client.setID(this.unitId);
      this.client.setTimeout(5000);
      this.connected = true;
      console.log(`[VictronModbus] Connected to Cerbo GX at ${this.host}:${this.port}`);
      this.log(`Connected to Cerbo GX at ${this.host}:${this.port}`);
    } catch (error) {
      this.connected = false;
      console.error(`[VictronModbus] Failed to connect: ${error.message}`);
      throw new Error(`Failed to connect to Cerbo GX: ${error.message}`);
    }
  }
  
  async _disconnect() {
    if (this.client.isOpen) {
      this.client.close(() => {
        this.connected = false;
        this.log('Disconnected from Cerbo GX');
      });
    }
  }
  
  _startPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    
    // Initial poll
    this._pollData();
    
    // Set up interval polling
    this.pollTimer = setInterval(() => {
      this._pollData();
    }, this.pollInterval);
    
    this.log(`Started polling every ${this.pollInterval}ms`);
  }
  
  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.log('Stopped polling');
    }
  }
  
  async _pollData() {
    if (!this.connected) {
      this.log('Not connected, skipping poll', 'warn');
      return;
    }
    
    try {
      // Try reading common system registers that should always be available
      // Register 840 = DC System Battery Voltage (should work on most Cerbo GX setups)
      // Register 842 = DC System Battery Current
      // Register 841 = DC System Battery Power
      
      const data = {};
      
      const addUnitIdsFromDefinitions = (targetSet, type) => {
        if (!Array.isArray(this.deviceDefinitions)) {
          return;
        }
        for (const device of this.deviceDefinitions) {
          if (!device || device.type !== type || !Array.isArray(device.sources)) {
            continue;
          }
          for (const source of device.sources) {
            if (source && typeof source.unitId === 'number') {
              targetSet.add(source.unitId);
            }
          }
        }
      };

      // Try BMV-712 on different unit IDs
      // BMV-712 registers: 259=Voltage, 261=Current, 258=Power, 266=SOC
      const bmvUnitIdCandidates = new Set();
      if (this.bmvUnitId !== undefined && this.bmvUnitId !== null) {
        bmvUnitIdCandidates.add(this.bmvUnitId);
      }
      addUnitIdsFromDefinitions(bmvUnitIdCandidates, 'battery_monitor');
      if (Array.isArray(this.discoveredDevices)) {
        for (const device of this.discoveredDevices) {
          if (device === undefined || device === null) {
            continue;
          }
          if (typeof device === 'number') {
            bmvUnitIdCandidates.add(device);
            continue;
          }
          if (typeof device.unitId === 'number') {
            bmvUnitIdCandidates.add(device.unitId);
          }
        }
      }
      const bmvUnitIds = Array.from(bmvUnitIdCandidates);
      let bmvFound = false;
      
      if (bmvUnitIds.length === 0) {
        if (this._shouldLogMissingDevice('bmv:no-candidates', 'No candidate BMV unit IDs available, scheduling background rescan')) {
          console.log('[VictronModbus] No candidate BMV unit IDs available, scheduling background rescan');
        }
        this._scheduleBMVRescan();
      }

      for (const unitId of bmvUnitIds) {
        if (bmvFound) break;
        
        try {
          this.client.setID(unitId);
          
          const batteryVoltage = await this.client.readInputRegisters(259, 1); // uint16, scale 100
          const batteryCurrent = await this.client.readInputRegisters(261, 1); // int16, scale 10
          const batteryPower = await this.client.readInputRegisters(258, 1);   // int16, scale 1
          const batterySOC = await this.client.readInputRegisters(266, 1);     // uint16, scale 10
          
          data.battery = {
            unitId: unitId,
            voltage: batteryVoltage.data,
            current: batteryCurrent.data,
            power: batteryPower.data,
            soc: batterySOC.data
          };
          this.log(`Found BMV-712 at Unit ID ${unitId}`);
          this.log('Raw BMV-712 values:', {
            voltage: batteryVoltage.data[0],
            current: batteryCurrent.data[0],
            power: batteryPower.data[0],
            soc: batterySOC.data[0]
          });
          this._bmvFailureCount = 0;
          this.bmvUnitId = unitId;
          this._mergeDiscoveredUnitId(unitId);
          bmvFound = true;
        } catch (e) {
          // Try next unit ID
        }
      }
      
      if (!bmvFound) {
        if (this._shouldLogMissingDevice('bmv:not-found', 'BMV-712 not found on any unit ID')) {
          console.log('[VictronModbus] BMV-712 not found on any unit ID');
        }
        const systemBattery = await this._readSystemBatteryRegisters();
        if (systemBattery) {
          data.battery = systemBattery;
          if (this._shouldLogMissingDevice('bmv:fallback', 'Using system-level battery registers as fallback')) {
            console.log('[VictronModbus] Using system-level battery registers as fallback');
            console.log('[VictronModbus] System battery SOC array length:', systemBattery.soc?.length || 0);
          }
        } else {
          if (this._shouldLogMissingDevice('bmv:no-fallback', 'No system-level battery data available as fallback')) {
            console.log('[VictronModbus] No system-level battery data available as fallback');
          }
        }
        this._handleBMVFailure();
      }
      
      this.client.setID(this.unitId);
      
      // Try different Unit IDs for MultiPlus (VE.Bus)
      // Common Unit IDs: 227, 246, 100
      const multiplusUnitIdCandidates = new Set(this._multiplusUnitIds || []);
      addUnitIdsFromDefinitions(multiplusUnitIdCandidates, 'multiplus');
      [100, 227, 246, 225, 228].forEach(id => multiplusUnitIdCandidates.add(id));
      let multiplusFound = false;
      
      for (const unitId of multiplusUnitIdCandidates) {
        if (multiplusFound) break;
        
        try {
          this.client.setID(unitId);
          
          // Try reading VE.Bus state register (31) as a test
          const vebusState = await this.client.readHoldingRegisters(31, 1);
          
          // If we got here, this Unit ID works! Read all the registers
          const acInputL1Voltage = await this.client.readHoldingRegisters(3, 1);
          const acInputL1Current = await this.client.readHoldingRegisters(6, 1);
          const acInputL1Power = await this.client.readHoldingRegisters(12, 1);
          const acOutputL1Voltage = await this.client.readHoldingRegisters(15, 1);
          const acOutputL1Current = await this.client.readHoldingRegisters(18, 1);
          const acOutputL1Power = await this.client.readHoldingRegisters(23, 1);
          
          data.multiplus = {
            unitId: unitId,
            state: vebusState.data,
            acInput: {
              voltage: acInputL1Voltage.data,
              current: acInputL1Current.data,
              power: acInputL1Power.data
            },
            acOutput: {
              voltage: acOutputL1Voltage.data,
              current: acOutputL1Current.data,
              power: acOutputL1Power.data
            }
          };
          
          // console.log(`[VictronModbus] Successfully read MultiPlus data from Unit ID ${unitId}`);
          // console.log('[VictronModbus] Raw MultiPlus values:', {
          //   state: vebusState.data[0],
          //   acInV: acInputL1Voltage.data[0],
          //   acInA: acInputL1Current.data[0],
          //   acInW: acInputL1Power.data[0],
          //   acOutV: acOutputL1Voltage.data[0],
          //   acOutA: acOutputL1Current.data[0],
          //   acOutW: acOutputL1Power.data[0]
          // });
          
          multiplusFound = true;
          
          // Reset to default Unit ID
          this.client.setID(this.unitId);
        } catch (e) {
          // This Unit ID didn't work, try next one
          if (unitId === Array.from(multiplusUnitIdCandidates).pop()) {
            const message = e?.message || 'Unknown Modbus error';
            if (this._shouldLogMissingDevice('multiplus:not-found', message)) {
              console.log('[VictronModbus] MultiPlus not found on any Unit ID:', message);
            }
          }
        }
      }
      
      // Make sure we're back to default Unit ID
      this.client.setID(this.unitId);
      
      // Try different Unit IDs for Solar Charger
      // Use discovered devices first, then try common ranges
      const solarUnitIdCandidates = new Set(this._solarUnitIds || []);
      addUnitIdsFromDefinitions(solarUnitIdCandidates, 'solar_charger');
      if (Array.isArray(this.discoveredDevices)) {
        for (const device of this.discoveredDevices) {
          if (device === undefined || device === null) {
            continue;
          }
          if (typeof device === 'number') {
            solarUnitIdCandidates.add(device);
            continue;
          }
          if (typeof device.unitId === 'number') {
            solarUnitIdCandidates.add(device.unitId);
          }
        }
      }
      solarUnitIdCandidates.add(100);
      for (let i = 20; i < 51; i += 1) {
        solarUnitIdCandidates.add(i);
      }
      let solarFound = false;
      
      const solarUnitIds = Array.from(solarUnitIdCandidates);
      for (const unitId of solarUnitIds) {
        if (solarFound) break;
        
        try {
          this.client.setID(unitId);
          
          // Try reading solar charger voltage (register 771) as a test
          const solarVoltage = await this.client.readHoldingRegisters(771, 1);
          
          // If we got here, this Unit ID works! Read all the registers
          const solarCurrent = await this.client.readHoldingRegisters(772, 1);
          const solarPower = await this.client.readHoldingRegisters(789, 1);
          const chargerState = await this.client.readHoldingRegisters(775, 1);
          const yieldToday = await this.client.readHoldingRegisters(784, 1);
          
          data.solar = {
            unitId: unitId,
            voltage: solarVoltage.data,
            current: solarCurrent.data,
            power: solarPower.data,
            state: chargerState.data,
            yieldToday: yieldToday.data
          };
          
          // console.log(`[VictronModbus] Successfully read Solar Charger data from Unit ID ${unitId}`);
          // console.log('[VictronModbus] Raw Solar values:', {
          //   voltage: solarVoltage.data[0],
          //   current: solarCurrent.data[0],
          //   power: solarPower.data[0],
          //   state: chargerState.data[0],
          //   yieldToday: yieldToday.data[0]
          // });
          
          solarFound = true;
          
          // Reset to default Unit ID
          this.client.setID(this.unitId);
        } catch (e) {
          // This Unit ID didn't work, try next one
          if (unitId === solarUnitIds[solarUnitIds.length - 1]) {
            const message = e?.message || 'Unknown Modbus error';
            if (this._shouldLogMissingDevice('solar:not-found', message)) {
              console.log('[VictronModbus] Solar charger not found on any Unit ID:', message);
            }
          }
        }
      }
      
      // Make sure we're back to default Unit ID
      this.client.setID(this.unitId);
      
      // Parse and convert to state updates
      const parsedData = this._parseModbusData(data);
      const stateUpdate = this._convertToStateUpdate(parsedData);
      
      // Validate that we have battery data before emitting
      // This prevents overwriting good battery data with empty/missing data
      if (!stateUpdate.vessel?.systems?.electrical?.battery1) {
        console.log('[VictronModbus] Skipping update - no battery data available');
        return;
      }
      
      // Emit victron:update event with the parsed data
      // StateManager will handle converting this to patches
      this.emit('victron:update', stateUpdate);
      
      // Log first successful read
      // if (!this.hasLoggedFirstData) {
      //   console.log('[VictronModbus] First Modbus data received:', JSON.stringify(parsedData, null, 2));
      //   console.log('[VictronModbus] State update:', JSON.stringify(stateUpdate, null, 2));
      //   this.log('First Modbus data received:', parsedData);
      //   this.hasLoggedFirstData = true;
      // }
      
    } catch (error) {
      console.error(`[VictronModbus] Error polling Modbus data: ${error.message}`);
      console.error(`[VictronModbus] Error stack:`, error.stack);
      this.log(`Error polling Modbus data: ${error.message}`, 'error');
      
      // Try to reconnect if connection was lost
      if (!this.client.isOpen) {
        this.connected = false;
        console.log('[VictronModbus] Connection lost, attempting to reconnect...');
        this.log('Connection lost, attempting to reconnect...', 'warn');
        try {
          await this._connect();
        } catch (reconnectError) {
          console.error(`[VictronModbus] Reconnection failed: ${reconnectError.message}`);
          this.log(`Reconnection failed: ${reconnectError.message}`, 'error');
        }
      }
    }
  }
  
  async discoverBMV() {
    console.log('[VictronModbus] Starting comprehensive Unit ID scan...');
    
    // Scan a wider range - Victron uses 0-247
    const unitIdsToScan = [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 
      100, // System device
      223, 225, 226, 227, 228, 229, 230, // Common USB devices
    ];
    
    let foundDevices = [];
    
    for (const unitId of unitIdsToScan) {
      try {
        console.log(`[VictronModbus] Scanning Unit ID ${unitId}...`);
        this.client.setID(unitId);
        
        // Try to read battery voltage (register 259)
        const result = await this.client.readInputRegisters(259, 1);
        
        if (result && result.data && result.data.length > 0) {
          const voltage = result.data[0] / 100;
          console.log(`[VictronModbus] Unit ID ${unitId} responded: ${voltage}V`);
          
          // More lenient validation
          if (voltage > 5 && voltage < 100) { // Wider range
            foundDevices.push({ unitId, voltage });
            
            // Try to read SOC to confirm it's a battery monitor
            const socResult = await this.client.readInputRegisters(266, 1);
            if (socResult && socResult.data && socResult.data.length > 0) {
              const soc = socResult.data[0] / 10;
              console.log(`[VictronModbus] CONFIRMED BATTERY at Unit ID ${unitId}: ${voltage}V, ${soc}% SOC`);
              const confirmedUnitId = unitId;
              this.client.setID(this.unitId);
              return confirmedUnitId; // Return first confirmed battery
            }
          }
        }
      } catch (error) {
        // Log only if it's an interesting error
        if (!error.message.includes('timeout') && !error.message.includes('not available')) {
          console.log(`[VictronModbus] Unit ID ${unitId} error: ${error.message}`);
        }
      }
    }
    
    // Report found devices
    if (foundDevices.length > 0) {
      console.log('[VictronModbus] Found responding devices:',
        foundDevices.map(d => `ID ${d.unitId} (${d.voltage}V)`).join(', '));
    } else {
      console.log('[VictronModbus] No devices responded to battery voltage read');
    }
    
    this.client.setID(this.unitId);
    return null;
  }
  
  async _readSystemBatteryRegisters() {
    try {
      this.client.setID(this.unitId);
      const voltage = await this.client.readHoldingRegisters(840, 1);
      const power = await this.client.readHoldingRegisters(841, 1);
      const current = await this.client.readHoldingRegisters(842, 1);
      let soc = null;
      try {
        soc = await this.client.readHoldingRegisters(266, 1);
      } catch (error) {
        console.log(`[VictronModbus] System battery SOC read failed: ${error.message}`);
      }
      if (voltage?.data?.length && power?.data?.length && current?.data?.length) {
        return {
          unitId: this.unitId,
          voltage: voltage.data,
          current: current.data,
          power: power.data,
          soc: soc?.data || []
        };
      }
    } catch (error) {
      console.log(`[VictronModbus] System battery register read failed: ${error.message}`);
    } finally {
      this.client.setID(this.unitId);
    }
    return null;
  }

  _mergeDiscoveredUnitId(unitId) {
    if (!Array.isArray(this.discoveredDevices)) {
      this.discoveredDevices = [];
    }
    const alreadyTracked = this.discoveredDevices.some(device => {
      if (typeof device === 'number') {
        return device === unitId;
      }
      if (device && typeof device.unitId === 'number') {
        return device.unitId === unitId;
      }
      return false;
    });
    if (!alreadyTracked) {
      this.discoveredDevices.push({ unitId });
    }
    this._saveSavedUnitIds(this.discoveredDevices).catch(error => {
      console.log(`[VictronModbus] Failed to persist Unit ID ${unitId}: ${error.message}`);
    });
  }

  _handleBMVFailure() {
    this._bmvFailureCount += 1;
    if (this._bmvFailureCount >= this._maxBMVFailuresBeforeRescan) {
      this._scheduleBMVRescan();
    }
  }

  _scheduleBMVRescan() {
    if (this._bmvRescanInProgress) {
      return;
    }
    const now = Date.now();
    if (now - this._lastBMVRescan < this._bmvRescanCooldownMs) {
      return;
    }
    this._bmvRescanInProgress = true;
    this._lastBMVRescan = now;
    (async () => {
      try {
        const unitId = await this._scanAllBMVUnitIds();
        if (typeof unitId === 'number') {
          console.log(`[VictronModbus] Background rescan found BMV at Unit ID ${unitId}`);
          this.bmvUnitId = unitId;
          this._mergeDiscoveredUnitId(unitId);
          this._bmvFailureCount = 0;
        } else {
          console.log('[VictronModbus] Background rescan did not find BMV');
        }
      } catch (error) {
        console.log(`[VictronModbus] Background rescan error: ${error.message}`);
      } finally {
        this._bmvRescanInProgress = false;
      }
    })();
  }

  async _scanAllBMVUnitIds() {
    const scanRange = Array.from({ length: 248 }, (_, i) => i);
    for (const unitId of scanRange) {
      try {
        this.client.setID(unitId);
        const voltageResult = await this.client.readInputRegisters(259, 1);
        if (voltageResult?.data?.length) {
          const voltage = voltageResult.data[0] / 100;
          if (voltage > 5 && voltage < 100) {
            const socResult = await this.client.readInputRegisters(266, 1);
            if (socResult?.data?.length) {
              console.log(`[VictronModbus] Rescan candidate Unit ID ${unitId}: ${voltage}V, SOC ${socResult.data[0] / 10}%`);
              this.client.setID(this.unitId);
              return unitId;
            }
          }
        }
      } catch (error) {
        if (!error.message.includes('timeout') && !error.message.includes('not available')) {
          console.log(`[VictronModbus] Rescan Unit ID ${unitId} error: ${error.message}`);
        }
      }
    }
    this.client.setID(this.unitId);
    return null;
  }

  _parseModbusData(rawData) {
    // Parse Victron Modbus registers into meaningful data
    // Victron uses scaling factors: voltage=0.01V, current=0.1A, power=1W
    
    // Log raw AC input power to debug scaling
    if (rawData.multiplus?.acInput?.power) {
      this.log('Raw AC Input Power register value:', rawData.multiplus.acInput.power[0]);
    }
    
    const parsed = {
      timestamp: new Date().toISOString()
    };
    
    // Battery Monitor data (BMV-712 registers with correct scale factors)
    if (rawData.battery) {
      // Register 259: Voltage (uint16, scale 100) - divide by 100
      const voltage = rawData.battery.voltage[0] / 100;
      
      // Register 261: Current (int16, scale 10) - divide by 10, signed
      const current = this._toSignedInt16(rawData.battery.current[0]) / 10;
      
      // Register 258: Power (int16, scale 1) - no division, signed
      const power = this._toSignedInt16(rawData.battery.power[0]);
      
      // Register 266: SOC (uint16, scale 10) - divide by 10
      const rawSoc = rawData.battery.soc[0];
      const soc = rawSoc / 10;
      
      // Validate SOC value - reject if it's clearly invalid
      // Valid SOC should be between 0 and 100, and raw value should not be 0xFFFF (invalid/missing)
      // Also check for undefined/NaN which can occur when soc array is empty
      if (rawSoc === undefined || rawSoc === null || isNaN(soc) || 
          rawSoc === 0xFFFF || soc < 0 || soc > 100) {
        console.log(`[VictronModbus] Invalid SOC value detected: raw=${rawSoc}, parsed=${soc}% - skipping battery data`);
        return parsed;
      }
      
      this.log('Decoded BMV-712 data:', {
        voltage,
        current,
        power,
        soc,
        rawSoc
      });
      
      parsed.battery = {
        voltage: voltage,
        current: current,
        power: power,
        soc: soc
      };
    }
    
    // MultiPlus data (VE.Bus)
    if (rawData.multiplus) {
      parsed.multiplus = {
        unitId: rawData.multiplus.unitId,
        state: rawData.multiplus.state[0] || null, // VE.Bus state (0=Off, 1=Low Power, 2=Fault, 3=Bulk, 4=Absorption, 5=Float, etc.)
        acInput: {
          voltage: rawData.multiplus.acInput.voltage[0] ? rawData.multiplus.acInput.voltage[0] / 10 : null, // 0.1V scale
          current: rawData.multiplus.acInput.current[0] ? this._toSignedInt16(rawData.multiplus.acInput.current[0]) / 10 : null, // 0.1A scale
          power: rawData.multiplus.acInput.power[0] ? this._toSignedInt16(rawData.multiplus.acInput.power[0]) * 10 : null, // 0.1W scale, multiply by 10 to get watts
        },
        acOutput: {
          voltage: rawData.multiplus.acOutput.voltage[0] ? rawData.multiplus.acOutput.voltage[0] / 10 : null, // 0.1V scale
          current: rawData.multiplus.acOutput.current[0] ? this._toSignedInt16(rawData.multiplus.acOutput.current[0]) / 10 : null, // 0.1A scale
          power: rawData.multiplus.acOutput.power[0] ? this._toSignedInt16(rawData.multiplus.acOutput.power[0]) * 10 : null, // 0.1W scale, multiply by 10 to get watts
        }
      };
    }
    
    // Solar Charger data
    if (rawData.solar) {
      parsed.solar = {
        unitId: rawData.solar.unitId,
        voltage: rawData.solar.voltage[0] ? rawData.solar.voltage[0] / 100 : null, // 0.01V scale
        current: rawData.solar.current[0] ? rawData.solar.current[0] / 10 : null, // 0.1A scale
        power: rawData.solar.power[0] ? rawData.solar.power[0] / 10 : null, // 0.1W scale, divide by 10 to get watts
        state: rawData.solar.state[0] || null, // Charger state (0=Off, 2=Fault, 3=Bulk, 4=Absorption, 5=Float)
        yieldToday: rawData.solar.yieldToday[0] ? rawData.solar.yieldToday[0] / 100 : null // 0.01 kWh scale
      };
    }
    
    return parsed;
  }
  
  // Convert parsed Modbus data to canonical state structure
  _convertToStateUpdate(parsedData) {
    const stateUpdate = {
      vessel: {
        systems: {
          electrical: {}
        }
      }
    };
    
    // Map battery data to battery1
    if (parsedData.battery) {
      stateUpdate.vessel.systems.electrical.battery1 = {
        voltage: { value: parsedData.battery.voltage },
        current: { value: parsedData.battery.current },
        capacity: { value: parsedData.battery.soc },
        power: { value: parsedData.battery.power }
      };
    }
    
    // Map MultiPlus data
    if (parsedData.multiplus) {
      const state = parsedData.multiplus.state;
      
      // MultiPlus AC Input -> Shore Power 1
      if (parsedData.multiplus.acInput) {
        stateUpdate.vessel.systems.electrical.inputs = stateUpdate.vessel.systems.electrical.inputs || {};
        stateUpdate.vessel.systems.electrical.inputs.shore1 = {
          voltage: { value: parsedData.multiplus.acInput.voltage },
          current: { value: parsedData.multiplus.acInput.current },
          power: { value: parsedData.multiplus.acInput.power },
          connected: { value: parsedData.multiplus.acInput.voltage > 0 }
        };
      }
      
      // MultiPlus as Charger (when on shore power and charging)
      // State 3=Bulk, 4=Absorption, 5=Float are charging states
      if (state >= 3 && state <= 5 && parsedData.multiplus.acInput && parsedData.multiplus.acInput.voltage > 0) {
        stateUpdate.vessel.systems.electrical.chargers = stateUpdate.vessel.systems.electrical.chargers || {};
        stateUpdate.vessel.systems.electrical.chargers.charger1 = {
          inputVoltage: { value: parsedData.multiplus.acInput.voltage },
          outputVoltage: { value: parsedData.battery?.voltage || null },
          outputCurrent: { value: parsedData.battery?.current || null },
          outputPower: { value: parsedData.battery?.power || null },
          state: { value: this._getChargerStateLabel(state) }
        };
      }
      
      // MultiPlus as Inverter (when inverting - AC output active but no AC input)
      if (parsedData.multiplus.acOutput && parsedData.multiplus.acOutput.power > 0) {
        stateUpdate.vessel.systems.electrical.inverters = stateUpdate.vessel.systems.electrical.inverters || {};
        stateUpdate.vessel.systems.electrical.inverters.inverter1 = {
          inputVoltage: { value: parsedData.battery?.voltage || null },
          outputVoltage: { value: parsedData.multiplus.acOutput.voltage },
          outputCurrent: { value: parsedData.multiplus.acOutput.current },
          outputPower: { value: parsedData.multiplus.acOutput.power },
          state: { value: this._getInverterStateLabel(state) }
        };
      }
    }
    
    // Map Solar data to solar1
    if (parsedData.solar) {
      stateUpdate.vessel.systems.electrical.inputs = stateUpdate.vessel.systems.electrical.inputs || {};
      stateUpdate.vessel.systems.electrical.inputs.solar1 = {
        voltage: { value: parsedData.solar.voltage },
        current: { value: parsedData.solar.current },
        power: { value: parsedData.solar.power },
        state: { value: this._getSolarStateLabel(parsedData.solar.state) },
        yieldToday: { value: parsedData.solar.yieldToday }
      };
    }
    
    return stateUpdate;
  }
  
  // Helper to get charger state label
  _getChargerStateLabel(state) {
    const states = {
      0: 'Off',
      1: 'Low Power',
      2: 'Fault',
      3: 'Bulk',
      4: 'Absorption',
      5: 'Float',
      6: 'Storage',
      7: 'Equalize',
      8: 'Passthru',
      9: 'Inverting',
      10: 'Power Assist',
      11: 'Power Supply'
    };
    return states[state] || `Unknown (${state})`;
  }
  
  // Helper to get inverter state label
  _getInverterStateLabel(state) {
    const states = {
      0: 'Off',
      1: 'Low Power',
      2: 'Fault',
      9: 'Inverting',
      10: 'Power Assist'
    };
    return states[state] || `Unknown (${state})`;
  }
  
  // Helper to get solar charger state label
  _getSolarStateLabel(state) {
    const states = {
      0: 'Off',
      2: 'Fault',
      3: 'Bulk',
      4: 'Absorption',
      5: 'Float'
    };
    return states[state] || `Unknown (${state})`;
  }
  
  // Helper to convert unsigned 16-bit to signed 16-bit
  _toSignedInt16(value) {
    return value > 32767 ? value - 65536 : value;
  }
  
  // Helper to decode 32-bit IEEE 754 float from two 16-bit registers
  _decode32BitFloat(registers) {
    if (!registers || registers.length < 2) return null;
    
    // Victron stores floats as big-endian (high word first)
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt16BE(registers[0], 0);
    buffer.writeUInt16BE(registers[1], 2);
    return buffer.readFloatBE(0);
  }
}
