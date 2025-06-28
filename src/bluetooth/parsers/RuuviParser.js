/**
 * Parser for RuuviTag sensor data
 * Supports RAWv1 (data format 3) and RAWv2 (data format 5)
 */
class RuuviParserClass {
  static manufacturerId = 0x0499;
  
  /**
   * Parse Ruuvi manufacturer data
   * @param {Buffer} data - Raw manufacturer data (including manufacturer ID)
   * @returns {Object|null} Parsed data or null if invalid
   */
  static parse(data) {
    if (!data || data.length < 2) return null;
    
    // Skip manufacturer ID (first 2 bytes)
    const payload = data.slice(2);
    if (payload.length < 1) return null;
    
    const dataFormat = payload[0];
    
    switch (dataFormat) {
      case 3: return this.parseRAWv1(payload);
      case 5: return this.parseRAWv2(payload);
      default:
        console.warn(`Unsupported Ruuvi data format: ${dataFormat}`);
        return null;
    }
  }
  
  /**
   * Parse Ruuvi RAWv1 data (format 3)
   */
  static parseRAWv1(data) {
    if (data.length < 15) return null;
    
    const tempIntegral = data.readInt8(1);
    const tempFraction = data[2];
    const temperature = tempIntegral + (tempFraction / 100);
    
    const humidity = data[3] * 0.5;
    const pressure = data.readUInt16BE(4) + 500;
    const accelerationX = data.readInt16BE(6);
    const accelerationY = data.readInt16BE(8);
    const accelerationZ = data.readInt16BE(10);
    const batteryVoltage = data.readUInt16BE(12) / 1000;

    return {
      format: 'ruuvi/rawv1',
      dataFormat: 3,
      temperature: {
        value: temperature,
        unit: '°C',
        fahrenheit: temperature * 9/5 + 32
      },
      humidity: {
        value: humidity,
        unit: '%',
      },
      pressure: {
        value: pressure,
        unit: 'hPa'
      },
      acceleration: {
        x: { value: accelerationX, unit: 'mg' },
        y: { value: accelerationY, unit: 'mg' },
        z: { value: accelerationZ, unit: 'mg' },
      },
      battery: {
        voltage: { value: batteryVoltage, unit: 'V' },
      },
      raw: data.toString('hex')
    };
  }
  
  /**
   * Parse Ruuvi RAWv2 data (format 5)
   */
  static parseRAWv2(data) {
    if (data.length < 24) return null;
    
    const temperature = data.readInt16BE(1) * 0.005;
    const humidity = data.readUInt16BE(3) * 0.0025;
    const pressure = data.readUInt16BE(5) + 50000;
    
    const accelerationX = data.readInt16BE(7) / 1000;
    const accelerationY = data.readInt16BE(9) / 1000;
    const accelerationZ = data.readInt16BE(11) / 1000;
    
    const powerInfo = data.readUInt16BE(13);
    const batteryVoltage = (powerInfo >> 5) + 1600;
    const txPower = (powerInfo & 0x1F) * 2 - 40;
    
    const movementCounter = data[15];
    const sequenceNumber = data.readUInt16BE(16);
    const macAddress = data.slice(18, 24).toString('hex').toUpperCase();

    return {
      format: 'ruuvi/rawv2',
      dataFormat: 5,
      temperature: {
        value: temperature,
        unit: '°C',
        fahrenheit: temperature * 9/5 + 32
      },
      humidity: {
        value: humidity,
        unit: '%',
      },
      pressure: {
        value: pressure / 100,
        unit: 'hPa'
      },
      acceleration: {
        x: { value: accelerationX, unit: 'g' },
        y: { value: accelerationY, unit: 'g' },
        z: { value: accelerationZ, unit: 'g' },
      },
      battery: {
        voltage: { value: batteryVoltage, unit: 'mV' },
      },
      radio: {
        txPower: { value: txPower, unit: 'dBm' },
      },
      counters: {
        movement: movementCounter,
        sequence: sequenceNumber,
      },
      macAddress: macAddress.match(/.{1,2}/g).join(':'),
      raw: data.toString('hex')
    };
  }
  
  /**
   * Check if this parser can handle the given manufacturer data
   */
  static matches(manufacturerData) {
    return manufacturerData?.length >= 2 && 
           manufacturerData.readUInt16LE(0) === this.manufacturerId;
  }
}

// Export the class first
export { RuuviParserClass as RuuviParser };

/**
 * Create an instance-based parser that delegates to the static methods
 * This matches the expected interface for the ParserRegistry
 */
const RuuviParser = {
  // Expose the manufacturer ID as a property
  manufacturerId: 0x0499, // Use the literal value instead of referencing the class
  
  // Instance methods that delegate to static methods
  parse: (data) => RuuviParserClass.parse(data),
  matches: (data) => RuuviParserClass.matches(data),
  
  // Add name for better logging
  name: 'RuuviParser',
  constructor: { name: 'RuuviParser' }
};

// Export the instance

export default RuuviParser;
