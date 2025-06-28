import { ParserRegistry } from './parsers/index.js';

export class DeviceManager {
  constructor() {
    this.devices = new Map(); // MAC -> Device
    this.parserRegistry = new ParserRegistry();
  }
  
  registerDevice(mac, name, type, config = {}) {
    // Store device configuration
    if (!this.devices.has(mac)) {
      this.devices.set(mac, { mac, name, type, ...config });
    }
    return this.devices.get(mac);
  }
  
  getDevice(mac) {
    return this.devices.get(mac) || null;
  }
  
  registerNewDevice(peripheral) {
    const { address: mac, advertisement } = peripheral;
    const name = advertisement.localName || 'Unknown Device';
    const type = 'generic'; // Default type, can be determined by advertisement data
    
    return this.registerDevice(mac, name, type);
  }
  
  processAdvertisement(peripheral) {
    if (!peripheral || !peripheral.advertisement || !peripheral.advertisement.manufacturerData) {
      return null;
    }
    
    const manufacturerData = peripheral.advertisement.manufacturerData;
    const parser = this.parserRegistry.getParserFor(manufacturerData);
    if (parser) {
      return parser.parse(manufacturerData);
    }
    return null;
  }
}