import noble from '@abandonware/noble';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIMEOUT = 10000;
const YML_PATH = path.join(__dirname, 'btman.yml');

let companyMap = {};

async function loadCompanyMap() {
  try {
    const fileContent = await fs.readFile(YML_PATH, 'utf8');
    const ymlData = yaml.load(fileContent);
    
    for (const entry of ymlData.company_identifiers || []) {
      try {
        let id = entry.value;
        
        if (typeof id === 'string' && id.startsWith('0x')) {
          id = parseInt(id, 16);
        } else if (typeof id !== 'number') {
          console.warn(`⚠️ Unknown company ID format: ${id}`);
          continue;
        }
        
        companyMap[id] = entry.name;
      } catch (err) {
        console.warn(`⚠️ Error processing company ID entry:`, entry, err);
        continue;
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to load btman.yml:', err.message);
  }
}

// Load company map when the module is imported
await loadCompanyMap();

function parseRuuviManufacturerData(data) {
  if (!data || data.length < 2) return null;
  
  const companyId = data.readUInt16LE(0);
  if (companyId !== 0x0499) return null; // Not Ruuvi
  
  const payload = data.slice(2); // Skip company ID
  if (payload.length < 1) return null;
  
  const dataFormat = payload[0];
  
  switch (dataFormat) {
    case 3: return parseRuuviRAWv1(payload);
    case 5: return parseRuuviRAWv2(payload);
    default:
      console.log(`⚠️ Unsupported Ruuvi data format: ${dataFormat}`);
      return null;
  }
}

function parseRuuviRAWv1(data) {
  if (data.length < 15) return null;
  
  const tempIntegral = data.readInt8(1);
  const tempFraction = data[2];
  const temperature = tempIntegral + (tempFraction / 100);
  
  const humidity = data[3] * 0.5;
  const pressure = data.readUInt16BE(4) + 500;
  const accelerationX = data.readInt16BE(6);
  const accelerationY = data.readInt16BE(8);
  const accelerationZ = data.readInt16BE(10);
  const batteryVoltage = data.readUInt16BE(12);

  return {
    dataFormat: 3,
    temperature: temperature.toFixed(2) + ' °C',
    fahrenheit: (temperature * 9/5 + 32).toFixed(2) + ' °F',
    humidity: humidity.toFixed(1) + '%',
    pressure: pressure.toFixed(0) + ' hPa',
    acceleration: { 
      x: accelerationX,
      y: accelerationY, 
      z: accelerationZ 
    },
    batteryVoltage: batteryVoltage + ' mV'
  };
}

function parseRuuviRAWv2(data) {
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
    dataFormat: 5,
    temperature: temperature.toFixed(2) + ' °C',
    fahrenheit: (temperature * 9/5 + 32).toFixed(2) + ' °F',
    humidity: humidity.toFixed(2) + '%',
    pressure: (pressure / 100).toFixed(2) + ' hPa',
    acceleration: { 
      x: accelerationX.toFixed(3) + ' g',
      y: accelerationY.toFixed(3) + ' g', 
      z: accelerationZ.toFixed(3) + ' g' 
    },
    batteryVoltage: batteryVoltage + ' mV',
    txPower: txPower + ' dBm',
    movementCounter: movementCounter,
    sequenceNumber: sequenceNumber,
    macAddress: macAddress.match(/.{1,2}/g).join(':')
  };
}

// Begin BLE scan
console.log("🔍 Starting BLE scan...");
noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    try {
      await noble.startScanningAsync([], true);
      console.log('✅ Scanning started...');
      setTimeout(() => {
        noble.stopScanning();
        console.log('⏹️ Scanning stopped after timeout.');
      }, TIMEOUT);
    } catch (err) {
      console.error('❌ Scan failed:', err);
    }
  } else {
    noble.stopScanning();
  }
});

noble.on('discover', (peripheral) => {
  const adv = peripheral.advertisement;
  const manufacturerData = adv.manufacturerData;
  const id = peripheral.id;
  const address = peripheral.address;
  const rssi = peripheral.rssi;
  const localName = adv.localName || 'Unnamed';

  console.log(`\n📡 Discovered device: ${address} (${id}), RSSI: ${rssi}`);
  
  if (!manufacturerData || manufacturerData.length < 2) {
    console.log(`  Manufacturer Data: None`);
    return;
  }

  const companyId = manufacturerData.readUInt16LE(0);
  const companyName = companyMap[companyId] || `Unknown (0x${companyId.toString(16)})`;

  console.log(`  Manufacturer Data: ${manufacturerData.toString('hex')}`);
  console.log(`  Company ID: 0x${companyId.toString(16)}`);
  console.log(`  Company Name: ${companyName}`);

  if (companyId === 0x0499) {
    const parsed = parseRuuviManufacturerData(manufacturerData);
    if (parsed) {
      console.log(`\n📦 Parsed Ruuvi Data (Format ${parsed.dataFormat}) from ${localName}:`);
      console.log(`    🌡️ Temperature: ${parsed.temperature} (${parsed.fahrenheit})`);
      console.log(`    💧 Humidity: ${parsed.humidity}`);
      console.log(`    📈 Pressure: ${parsed.pressure}`);
      
      if (parsed.acceleration) {
        console.log(`    🧭 Acceleration: X=${parsed.acceleration.x}, Y=${parsed.acceleration.y}, Z=${parsed.acceleration.z}`);
      }
      
      console.log(`    🔋 Battery: ${parsed.batteryVoltage}`);
      
      if (parsed.txPower) {
        console.log(`    📶 TX Power: ${parsed.txPower}`);
      }
      
      if (parsed.macAddress) {
        console.log(`    📍 MAC Address: ${parsed.macAddress}`);
      }
    } else {
      console.log(`  ⚠️ Could not parse Ruuvi data.`);
    }
  }
});

export { parseRuuviManufacturerData };