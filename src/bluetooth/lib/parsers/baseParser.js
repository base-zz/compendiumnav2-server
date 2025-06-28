// Base parser class that all device parsers should extend
class DeviceParser {
  static manufacturerId = null;
  
  static parse(data) {
    throw new Error('parse() must be implemented by subclass');
  }

  static matches(manufacturerData) {
    if (!manufacturerData || manufacturerData.length < 2) return false;
    const id = manufacturerData.readUInt16LE(0);
    return id === this.manufacturerId;
  }
}

module.exports = { DeviceParser };
