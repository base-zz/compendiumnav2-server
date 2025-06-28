export default class DiscoveryService {
  constructor() {
    this.unknownDevices = new Map(); // MAC -> { firstSeen, lastSeen, rawData }
  }
  
  logUnknown(peripheral) {
    // Store unknown devices for later analysis
    // Can implement automatic parser suggestions
  }
}