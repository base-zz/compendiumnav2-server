import noble from '@abandonware/noble';

console.log('Initializing Bluetooth...');
console.log('Current state:', noble.state);

noble.on('stateChange', (state) => {
  console.log('Bluetooth state changed to:', state);
  
  if (state === 'poweredOn') {
    console.log('Starting scan...');
    noble.startScanning([], true);
    
    // Stop scanning after 10 seconds
    setTimeout(() => {
      console.log('Stopping scan...');
      noble.stopScanning();
      process.exit(0);
    }, 10000);
  }
});

// Load company identifiers from YAML
import yaml from 'js-yaml';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load company map
const loadCompanyMap = () => {
  try {
    const ymlPath = join(__dirname, 'src', 'bluetooth', 'config', 'btman.yml');
    const fileContents = readFileSync(ymlPath, 'utf8');
    const data = yaml.load(fileContents);
    
    const companyMap = new Map();
    const entries = data.company_identifiers || [];
    
    for (const entry of entries) {
      let id = entry.value;
      if (typeof id === 'string' && id.startsWith('0x')) {
        id = parseInt(id, 16);
      }
      companyMap.set(id, entry.name);
    }
    
    return companyMap;
  } catch (error) {
    console.error('Error loading company map:', error.message);
    return new Map();
  }
};

const companyMap = loadCompanyMap();

noble.on('discover', (peripheral) => {
  console.log('\nFound device:');
  console.log('  Name:', peripheral.advertisement.localName || 'Unknown');
  console.log('  Address:', peripheral.address);
  console.log('  RSSI:', peripheral.rssi);
  
  if (peripheral.advertisement.manufacturerData) {
    try {
      const manufacturerId = peripheral.advertisement.manufacturerData.readUInt16LE(0);
      const companyName = companyMap.get(manufacturerId) || 'Unknown';
      console.log('  Manufacturer ID:', '0x' + manufacturerId.toString(16).toUpperCase(), `(${companyName})`);
      
      // For Ruuvi devices (0x0499), log the raw data
      if (manufacturerId === 0x0499) {
        const hexData = peripheral.advertisement.manufacturerData.toString('hex').toUpperCase();
        console.log('  Ruuvi Data:', hexData);
      }
    } catch (error) {
      console.error('  Error reading manufacturer data:', error.message);
    }
  }
});

// Handle errors
noble.on('error', (error) => {
  console.error('Bluetooth error:', error);
  process.exit(1);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\nStopping...');
  noble.stopScanning();
  process.exit(0);
});
