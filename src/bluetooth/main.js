import { DeviceManager } from './lib/deviceManager.js';
import RuuviParser from './lib/parsers/ruuvi.js';
import noble from '@abandonware/noble';

const deviceManager = new DeviceManager();
deviceManager.parserRegistry.registerParser(RuuviParser);

noble.on('discover', peripheral => {
  const reading = deviceManager.processAdvertisement(peripheral);
  if (reading) {
    const device = deviceManager.getDevice(peripheral.address) || 
                 deviceManager.registerNewDevice(peripheral);
    device.updateReading(reading);
    
    console.log(`📡 ${device.name} (${device.type}):`);
    console.log(`   🌡️ ${reading.temperature}  💧 ${reading.humidity}`);
  }
});