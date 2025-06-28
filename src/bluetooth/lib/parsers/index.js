export class ParserRegistry {
  constructor() {
    this.parsers = new Map(); // manufacturerId -> parser
  }
  
  registerParser(manufacturerId, parser) {
    this.parsers.set(manufacturerId, parser);
  }
  
  getParserFor(manufacturerData) {
    const manufacturerId = manufacturerData.readUInt16LE(0);
    return this.parsers.get(manufacturerId);
  }
}

// Example parser interface
export class DeviceParser {
  static manufacturerId = 0x0499; // Ruuvi
  
  static parse(data) {
    throw new Error('Not implemented');
  }
  
  static matches(data) {
    return data.readUInt16LE(0) === this.manufacturerId;
  }
}