class ManufacturerRegistry {
  constructor() {
    this.manufacturers = new Map(); // ID -> {name, parser}
  }
  
  loadFromConfig(path) {
    // Load from YAML and register known manufacturers
  }
  
  register(id, name, parserModule) {
    this.manufacturers.set(id, {name, parserModule});
  }
  
  getParser(manufacturerId) {
    return this.manufacturers.get(manufacturerId)?.parserModule;
  }
}