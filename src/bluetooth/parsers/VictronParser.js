import crypto from 'crypto';

/**
 * VictronParser - Handles encrypted Victron BLE advertisements
 * Supports SmartBMV, SmartShunt, SmartSolar, and other Victron devices
 */
class VictronParser {
  constructor(config) {
    this.config = config;
    this.manufacturerId = config.manufacturerId || 0x02E1; // Victron manufacturer ID
    this.name = config.name || 'Victron Device';
    this.encryptionKey = config.encryptionKey; // Per-device encryption key (hex string)
  }

  /**
   * Parse and decrypt Victron manufacturer data
   * @param {Buffer} data - Raw manufacturer data (including manufacturer ID)
   * @param {Object} options - Parse options (e.g., { encryptionKey: 'hex_string' })
   * @returns {Object|null} Parsed data or null if invalid
   */
  parse(data, options = {}) {
    if (!data || data.length < 2) return null;

    // Verify manufacturer ID
    const manufacturerId = data.readUInt16LE(0);
    if (manufacturerId !== this.manufacturerId) return null;

    // Skip manufacturer ID (first 2 bytes)
    const payload = data.slice(2);
    
    if (payload.length < 3) {
      return null;
    }

    // Extract record type (first byte after manufacturer ID)
    const recordType = payload[0];
    
    // Use runtime encryption key if provided, otherwise use config key
    const encryptionKey = options.encryptionKey || this.encryptionKey;
    
    // Check if data is encrypted (most Victron devices encrypt)
    if (!encryptionKey) {
      return null;
    }

    try {
      // Temporarily set the key for decryption
      const originalKey = this.encryptionKey;
      this.encryptionKey = encryptionKey;
      
      // Decrypt the payload
      const decryptedData = this._decrypt(payload);
      
      // Restore original key
      this.encryptionKey = originalKey;
      
      // Parse based on record type
      return this._parseDecryptedData(recordType, decryptedData);
    } catch (error) {
      // Silently fail - encryption key mismatch or invalid data
      return null;
    }
  }

  /**
   * Decrypt Victron data using AES-CTR
   * Matches the official Python victron-ble library implementation
   * @private
   */
  _decrypt(payload) {
    // Victron BLE advertisement format:
    // Bytes 0-1: Prefix (manufacturer ID, little-endian)
    // Bytes 2-3: Model ID (little-endian)
    // Byte 4: Record/readout type
    // Bytes 5-6: IV/counter (little-endian)
    // Bytes 7+: Encrypted data (first byte is key check)
    
    if (payload.length < 8) {
      throw new Error('Payload too short');
    }

    // Parse container
    const prefix = payload.readUInt16LE(0);
    const modelId = payload.readUInt16LE(2);
    const recordType = payload[4];
    const iv = payload.readUInt16LE(5);
    const encryptedData = payload.slice(7);

    // Convert encryption key from hex string to buffer
    const keyBuffer = Buffer.from(this.encryptionKey, 'hex');
    
    // First byte of encrypted data must match first byte of key
    if (encryptedData[0] !== keyBuffer[0]) {
      throw new Error('Advertisement key mismatch - first byte check failed');
    }

    // Create counter for AES-CTR (little-endian, 128-bit)
    // The IV is used as the initial counter value
    const counter = Buffer.alloc(16);
    counter.writeUInt16LE(iv, 0);
    
    // Create decipher using AES-128-CTR
    const decipher = crypto.createDecipheriv('aes-128-ctr', keyBuffer, counter);
    decipher.setAutoPadding(false);
    
    // Decrypt (skip first byte which was the key check)
    const dataToDecrypt = encryptedData.slice(1);
    const decrypted = Buffer.concat([
      decipher.update(dataToDecrypt),
      decipher.final()
    ]);
    
    return decrypted;
  }

  /**
   * Parse decrypted data based on record type
   * @private
   */
  _parseDecryptedData(recordType, data) {
    // Record types for different Victron devices
    // 0x01: Solar Charger
    // 0x02: Battery Monitor (SmartBMV/SmartShunt)
    // 0x03: Inverter
    // 0x04: DC/DC Converter
    // 0x05: Smart Lithium
    // 0x06: Inverter RS
    // 0x07: GX Device
    // 0x08: AC Charger
    // 0x09: Smart Battery Protect
    // 0x0A: Lynx Smart BMS
    // 0x0B: Multi RS
    // 0x0C: VE.Bus
    // 0x0D: DC Energy Meter

    switch (recordType) {
      case 0x10: // BMV-712 and newer battery monitors use 0x10
      case 0x02: // Older battery monitors use 0x02
        return this._parseBatteryMonitor(data);
      case 0x01:
        return this._parseSolarCharger(data);
      case 0x03:
        return this._parseInverter(data);
      case 0x04:
        return this._parseDCDCConverter(data);
      case 0x05:
        return this._parseSmartLithium(data);
      default:
        return {
          deviceType: 'unknown',
          recordType: recordType,
          raw: data.toString('hex')
        };
    }
  }

  /**
   * Parse Battery Monitor (SmartBMV/SmartShunt) data
   * Uses bit-packed format as per Victron BLE specification
   * Implements the same bit-reading logic as the official Python library
   * @private
   */
  _parseBatteryMonitor(data) {
    if (data.length < 8) return null;

    // Bit reader implementation matching Python victron-ble library
    let bitIndex = 0;
    
    const readBit = () => {
      const byteIndex = bitIndex >> 3;  // Divide by 8
      const bitPosition = bitIndex & 7;  // Modulo 8
      if (byteIndex >= data.length) return 0;
      const bit = (data[byteIndex] >> bitPosition) & 1;
      bitIndex++;
      return bit;
    };
    
    const readUnsignedInt = (numBits) => {
      let value = 0;
      for (let position = 0; position < numBits; position++) {
        value |= (readBit() << position);
      }
      return value;
    };
    
    const readSignedInt = (numBits) => {
      const value = readUnsignedInt(numBits);
      // Convert to signed if the sign bit is set
      if (value & (1 << (numBits - 1))) {
        return value - (1 << numBits);
      }
      return value;
    };

    // Parse bit-packed fields according to Victron spec
    const remainingMins = readUnsignedInt(16); // 16 bits
    const voltage = readSignedInt(16); // 16 bits signed
    const alarm = readUnsignedInt(16); // 16 bits
    const aux = readUnsignedInt(16); // 16 bits
    const auxMode = readUnsignedInt(2); // 2 bits
    const current = readSignedInt(22); // 22 bits signed
    const consumedAh = readUnsignedInt(20); // 20 bits
    const soc = readUnsignedInt(10); // 10 bits

    const result = {
      deviceType: 'battery_monitor',
      voltage: {
        value: voltage !== 0x7FFF ? voltage / 100 : null,
        unit: 'V'
      },
      current: {
        value: current !== 0x3FFFFF ? current / 1000 : null,
        unit: 'A'
      },
      alarm: alarm,
      raw: data.toString('hex')
    };

    // Add power calculation
    if (result.voltage.value !== null && result.current.value !== null) {
      result.power = {
        value: result.voltage.value * result.current.value,
        unit: 'W'
      };
    }

    // Remaining time
    if (remainingMins !== 0xFFFF) {
      result.timeRemaining = {
        value: remainingMins,
        unit: 'minutes'
      };
    }

    // State of charge
    if (soc !== 0x3FF) {
      result.stateOfCharge = {
        value: soc / 10,
        unit: '%'
      };
    }

    // Consumed Ah
    if (consumedAh !== 0xFFFFF) {
      result.consumedAh = {
        value: -consumedAh / 10,
        unit: 'Ah'
      };
    }

    // Auxiliary input based on mode
    // 0 = Starter voltage, 1 = Midpoint voltage, 2 = Temperature, 3 = Disabled
    if (auxMode === 0 && aux !== 0xFFFF) {
      // Starter voltage (signed)
      const auxSigned = aux >= 0x8000 ? aux - 0x10000 : aux;
      result.starterVoltage = {
        value: auxSigned / 100,
        unit: 'V'
      };
    } else if (auxMode === 1 && aux !== 0xFFFF) {
      // Midpoint voltage
      result.midpointVoltage = {
        value: aux / 100,
        unit: 'V'
      };
    } else if (auxMode === 2 && aux !== 0xFFFF) {
      // Temperature in Kelvin, convert to Celsius
      result.temperature = {
        value: (aux / 100) - 273.15,
        unit: '°C'
      };
    }

    return result;
  }

  /**
   * Parse Solar Charger data
   * @private
   */
  _parseSolarCharger(data) {
    if (data.length < 6) return null;

    const chargeState = data[0];
    const batteryVoltage = data.readUInt16LE(1) * 0.01;
    const batteryCurrent = data.readInt16LE(3) * 0.1;
    
    let result = {
      deviceType: 'solar_charger',
      chargeState: chargeState,
      batteryVoltage: {
        value: batteryVoltage,
        unit: 'V'
      },
      batteryCurrent: {
        value: batteryCurrent,
        unit: 'A'
      },
      power: {
        value: batteryVoltage * batteryCurrent,
        unit: 'W'
      },
      raw: data.toString('hex')
    };

    if (data.length >= 8) {
      const yieldToday = data.readUInt16LE(6) * 10; // Wh
      result.yieldToday = {
        value: yieldToday,
        unit: 'Wh'
      };
    }

    if (data.length >= 10) {
      const solarPower = data.readUInt16LE(8); // W
      result.solarPower = {
        value: solarPower,
        unit: 'W'
      };
    }

    return result;
  }

  /**
   * Parse Inverter data
   * @private
   */
  _parseInverter(data) {
    if (data.length < 6) return null;

    return {
      deviceType: 'inverter',
      // Add inverter-specific parsing
      raw: data.toString('hex')
    };
  }

  /**
   * Parse DC/DC Converter data
   * @private
   */
  _parseDCDCConverter(data) {
    if (data.length < 6) return null;

    return {
      deviceType: 'dcdc_converter',
      // Add DC/DC converter-specific parsing
      raw: data.toString('hex')
    };
  }

  /**
   * Parse Smart Lithium battery data
   * @private
   */
  _parseSmartLithium(data) {
    if (data.length < 6) return null;

    return {
      deviceType: 'smart_lithium',
      // Add Smart Lithium-specific parsing
      raw: data.toString('hex')
    };
  }

  /**
   * Check if this parser can handle the given manufacturer data
   */
  matches(manufacturerData) {
    return manufacturerData?.length >= 2 && 
           manufacturerData.readUInt16LE(0) === this.manufacturerId;
  }
}

export default VictronParser;
