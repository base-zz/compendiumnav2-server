import noble from '@abandonware/noble';

const normalizeMac = (value) => (value ? value.toLowerCase().replace(/[^0-9a-f]/g, '') : null);

const TARGET_SERVICE_UUID = 'fee5';
const CONNECT_TIMEOUT_MS = 10000;
const SERVICE_DISCOVERY_TIMEOUT_MS = 12000;
const CHARACTERISTIC_READ_TIMEOUT_MS = 5000;

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    targetAddress: null,
    targetId: null,
    targetName: null,
    targetManufacturer: null,
    connect: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case '--address': {
        const next = args[index + 1];
        if (!next) {
          console.error('Missing value for --address');
          process.exit(1);
        }
        options.targetAddress = normalizeMac(next);
        index += 1;
        break;
      }
      case '--id': {
        const next = args[index + 1];
        if (!next) {
          console.error('Missing value for --id');
          process.exit(1);
        }
        options.targetId = next.toLowerCase();
        index += 1;
        break;
      }
      case '--name': {
        const next = args[index + 1];
        if (!next) {
          console.error('Missing value for --name');
          process.exit(1);
        }
        options.targetName = next.toLowerCase();
        index += 1;
        break;
      }
      case '--manufacturer': {
        const next = args[index + 1];
        if (!next) {
          console.error('Missing value for --manufacturer');
          process.exit(1);
        }
        const parsed = parseInt(next.replace(/^0x/i, ''), 16);
        if (Number.isNaN(parsed)) {
          console.error('Invalid manufacturer ID. Use a hex value like 0x0059.');
          process.exit(1);
        }
        options.targetManufacturer = parsed;
        index += 1;
        break;
      }
      case '--connect': {
        options.connect = true;
        break;
      }
      default: {
        console.error(`Unknown argument: ${arg}`);
        console.error('Usage: node test-bluetooth.js [--address <mac>] [--id <nobleId>] [--name <partialName>] [--manufacturer <hex>] [--connect]');
        process.exit(1);
      }
    }
  }

  return options;
};

const options = parseArgs();
const hasTargetFilters = Boolean(
  options.targetAddress ||
    options.targetId ||
    options.targetName ||
    options.targetManufacturer !== null
);
const shouldPersistScan = hasTargetFilters || options.connect;
const SCAN_DURATION_MS = 10000;
let scanTimeout = null;
let shuttingDown = false;

console.log('Initializing Bluetooth...');
console.log('Current state:', noble.state);

noble.on('stateChange', (state) => {
  console.log('Bluetooth state changed to:', state);

  if (state === 'poweredOn') {
    console.log('Starting scan...');
    noble.startScanning([], true, (error) => {
      if (error) {
        console.error('Failed to start scan:', error.message);
      }
    });

    if (!shouldPersistScan) {
      scanTimeout = setTimeout(() => {
        console.log('Stopping scan...');
        noble.stopScanning();
        process.exit(0);
      }, SCAN_DURATION_MS);
    }
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
    const ymlPath = join(__dirname, 'src', 'bluetooth', 'config', 'company-identifiers.yaml');
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

const matchesTarget = (peripheral) => {
  if (!hasTargetFilters) {
    return true;
  }

  if (options.targetAddress) {
    const address = normalizeMac(peripheral.address);
    if (!address || address !== options.targetAddress) {
      return false;
    }
  }

  if (options.targetId) {
    const id = peripheral.id?.toLowerCase?.();
    if (!id || id !== options.targetId) {
      return false;
    }
  }

  if (options.targetName) {
    const name = peripheral.advertisement.localName?.toLowerCase?.() || '';
    if (!name.includes(options.targetName)) {
      return false;
    }
  }

  if (options.targetManufacturer !== null) {
    const data = peripheral.advertisement.manufacturerData;
    if (!data || data.length < 2) {
      return false;
    }
    const manufacturerId = data.readUInt16LE(0);
    if (manufacturerId !== options.targetManufacturer) {
      return false;
    }
  }

  return true;
};

const asciiPreview = (buffer) => {
  if (!buffer) {
    return null;
  }

  const printable = buffer.toString('ascii');
  if (/^[\x20-\x7E\r\n\t]+$/.test(printable)) {
    return printable.trim();
  }

  return null;
};

const formatNumericDetails = (buffer) => {
  if (!buffer || buffer.length === 0) {
    return [];
  }

  const lines = [];

  if (buffer.length === 1) {
    lines.push(`      uint8: ${buffer.readUInt8(0)}`);
    lines.push(`      int8: ${buffer.readInt8(0)}`);
  }

  if (buffer.length >= 2) {
    lines.push(`      uint16LE: ${buffer.readUInt16LE(0)}`);
    lines.push(`      int16LE: ${buffer.readInt16LE(0)}`);
  }

  if (buffer.length >= 4) {
    lines.push(`      uint32LE: ${buffer.readUInt32LE(0)}`);
    lines.push(`      int32LE: ${buffer.readInt32LE(0)}`);

    try {
      const floatValue = buffer.readFloatLE(0);
      if (Number.isFinite(floatValue)) {
        lines.push(`      floatLE: ${floatValue}`);
      }
    } catch (error) {
      // Ignore float conversion errors for non-IEEE754 patterns
    }
  }

  return lines;
};

const logPeripheral = (peripheral, { isTarget }) => {
  const header = isTarget ? '\n*** Target device matched ***' : '\nFound device:';
  console.log(header);
  console.log('  Name:', peripheral.advertisement.localName || 'Unknown');
  console.log('  ID:', peripheral.id || 'Unknown');
  console.log('  Address:', peripheral.address || 'Unknown');
  console.log('  RSSI:', peripheral.rssi);

  const advertisedServices = peripheral.advertisement.serviceUuids || [];
  if (advertisedServices.length > 0) {
    console.log('  Service UUIDs:', advertisedServices.map((uuid) => `0x${uuid.toUpperCase()}`));
  }

  if (peripheral.advertisement.manufacturerData) {
    try {
      const manufacturerId = peripheral.advertisement.manufacturerData.readUInt16LE(0);
      const companyName = companyMap.get(manufacturerId) || 'Unknown';
      const hexData = peripheral.advertisement.manufacturerData.toString('hex').toUpperCase();
      console.log('  Manufacturer ID:', `0x${manufacturerId.toString(16).toUpperCase()}`, `(${companyName})`);
      console.log('  Manufacturer data:', hexData);

      const preview = asciiPreview(peripheral.advertisement.manufacturerData);
      if (preview) {
        console.log('  Manufacturer ASCII:', preview);
      }

      if (manufacturerId === 0x0499) {
        console.log('  Ruuvi Data:', hexData);
      }
    } catch (error) {
      console.error('  Error reading manufacturer data:', error.message);
    }
  }

  const serviceData = peripheral.advertisement.serviceData || [];
  if (serviceData.length > 0) {
    console.log('  Service Data:');
    for (const { uuid, data } of serviceData) {
      const hex = data?.toString('hex').toUpperCase() || '';
      const preview = asciiPreview(data);
      console.log(`    UUID 0x${uuid?.toUpperCase?.() || uuid}: ${hex}${preview ? ` (${preview})` : ''}`);
    }
  }
};

const inspectedPeripherals = new Set();

const resumeScanning = () => {
  if (shuttingDown) {
    return;
  }

  try {
    noble.startScanning([], true);
  } catch (error) {
    console.error('Failed to resume scan:', error.message);
  }
};

const attachDisconnectHandlers = (peripheral) => {
  if (inspectedPeripherals.has(peripheral.id)) {
    return;
  }

  inspectedPeripherals.add(peripheral.id);

  peripheral.on('connect', () => {
    console.log(`Connected to ${peripheral.address || peripheral.id}`);
  });

  peripheral.on('disconnect', () => {
    console.log(`Disconnected from ${peripheral.address || peripheral.id}`);
    if (options.connect && !shuttingDown) {
      console.log('Resuming scan after disconnect...');
      resumeScanning();
    }
  });
};

const readCharacteristic = (characteristic) => {
  return new Promise((resolve) => {
    let timeout = setTimeout(() => {
      console.warn(`    Read timeout for characteristic ${characteristic.uuid}`);
      resolve();
    }, CHARACTERISTIC_READ_TIMEOUT_MS);

    characteristic.read((readError, data) => {
      clearTimeout(timeout);
      if (readError) {
        console.error(`    Failed to read characteristic ${characteristic.uuid}:`, readError.message);
        resolve();
        return;
      }

      const hex = data.toString('hex').toUpperCase();
      const preview = asciiPreview(data);
      console.log(`    Characteristic ${characteristic.uuid}: ${hex}${preview ? ` (${preview})` : ''}`);

      const detailLines = formatNumericDetails(data);
      for (const line of detailLines) {
        console.log(line);
      }
      resolve();
    });
  });
};

const inspectServices = async (peripheral) => {
  console.log('Discovering services for target device...');

  const discoveryPromise = new Promise((resolve) => {
    peripheral.discoverServices([], (serviceError, services) => {
      if (serviceError) {
        console.error('Failed to discover services:', serviceError.message);
        resolve({ services: [], error: serviceError });
        return;
      }
      resolve({ services });
    });
  });

  let discoveryTimeout = setTimeout(() => {
    console.error('Service discovery timed out.');
    discoveryTimeout = null;
  }, SERVICE_DISCOVERY_TIMEOUT_MS);

  const { services } = await discoveryPromise;
  if (discoveryTimeout) {
    clearTimeout(discoveryTimeout);
  }

  if (!services || services.length === 0) {
    peripheral.disconnect();
    return;
  }

  const targetService = services.find((svc) => svc.uuid?.toLowerCase?.() === TARGET_SERVICE_UUID);

  if (!targetService) {
    console.warn('0xFEE5 service not found on device.');
    peripheral.disconnect();
    return;
  }

  console.log('Found 0xFEE5 service. Reading readable characteristics...');

  const characteristicsPromise = new Promise((resolve) => {
    targetService.discoverCharacteristics([], (charError, characteristics) => {
      if (charError) {
        console.error('Failed to discover characteristics:', charError.message);
        resolve([]);
        return;
      }
      resolve(characteristics || []);
    });
  });

  const characteristics = await characteristicsPromise;
  if (!characteristics.length) {
    console.warn('No characteristics found on 0xFEE5 service.');
    peripheral.disconnect();
    return;
  }

  for (const characteristic of characteristics) {
    if (characteristic.properties.includes('read')) {
      await readCharacteristic(characteristic);
    } else {
      console.log(`    Skipping characteristic ${characteristic.uuid} (properties: ${characteristic.properties.join(', ')})`);
    }
  }

  peripheral.disconnect();
};

const connectToTarget = (peripheral) => {
  attachDisconnectHandlers(peripheral);

  let connectTimeout = setTimeout(() => {
    console.error('Connection timed out.');
    peripheral.removeAllListeners('connect');
    peripheral.disconnect();
  }, CONNECT_TIMEOUT_MS);

  console.log('Scan stopped. Connecting to target device...');
  peripheral.connect(async (connectError) => {
    clearTimeout(connectTimeout);
    if (connectError) {
      console.error('Failed to connect:', connectError.message);
      peripheral.disconnect();
      return;
    }

    await inspectServices(peripheral);
  });
};

noble.on('discover', (peripheral) => {
  const isTarget = matchesTarget(peripheral);
  if (!isTarget) {
    if (!hasTargetFilters) {
      logPeripheral(peripheral, { isTarget: false });
    }
    return;
  }

  logPeripheral(peripheral, { isTarget: true });

  if (!shouldPersistScan && scanTimeout) {
    clearTimeout(scanTimeout);
    scanTimeout = null;
  }

  if (options.connect) {
    attachDisconnectHandlers(peripheral);

    noble.once('scanStop', () => {
      connectToTarget(peripheral);
    });

    console.log('Target matched. Stopping scan to connect...');
    noble.stopScanning();
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
