#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

import discoveryService from './services/bluetooth/discoveryService.js';
import storageService from './services/storage/storageService.js';
import bilgePumpService from './services/bilgePumpService.js';
import thresholdService from './services/thresholdService.js';
import { initializeAlertSystem } from './services/alert/index.js';

// Initialize alert storage and manager
let alertManager;

// Set up cleanup on process exit
const cleanup = async () => {
  console.log('Shutting down...');
  if (alertManager) {
    await alertManager.createSystemAlert('shutdown', 'System is shutting down', 'info');
  }
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Set up cleanup on process exit
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await alertManager.createSystemAlert('shutdown', 'System is shutting down', 'info');
  process.exit(0);
});

// Main function
async function main() {
  // Initialize alert system only if not already initialized
  if (!alertManager) {
    try {
      const { alertManager: manager } = await initializeAlertSystem();
      alertManager = manager;
      console.log('Alert system initialized successfully');
    } catch (error) {
      console.error('Failed to initialize alert system:', error);
      process.exit(1);
    }
  }

  const command = process.argv[2];
  const arg = process.argv[3];

  // Set up event handlers - only set these up once
  if (!discoveryService.listeners('ready').length) {
    discoveryService
      .on('ready', () => {
        console.log('✅ Discovery service ready');
      })
      .on('error', (error) => {
        console.error('❌ Discovery service error:', error.message);
        process.exit(1);
      });
  }

  try {
    // Initialize services
    await storageService.initialize();
    await bilgePumpService.initialize();
    await thresholdService.initialize();
    await discoveryService.initialize();
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }

  // Log all alerts
  alertManager.on('alert:created', (alert) => {
    const prefix = 
      alert.severity === 'critical' ? '🚨' :
      alert.severity === 'warning' ? '⚠️' : 'ℹ️';
      
    console.log(`${prefix} [${new Date(alert.timestamp).toISOString()}] ${alert.device?.name || alert.deviceId || 'System'}: ${alert.message}`);
  });

  // Log system startup
  await alertManager.createSystemAlert('startup', 'System started', 'info');
  
  // Set up daily cleanup of old alerts (older than 30 days)
  const cleanupInterval = setInterval(
    () => alertManager.deleteOldAlerts(30),
    24 * 60 * 60 * 1000 // 24 hours
  );
  
  // Clean up on exit
  process.on('exit', () => clearInterval(cleanupInterval));
}

// Set up event handlers - only set these up once
if (!discoveryService.listeners('scanStart').length) {
  discoveryService
    .on('scanStart', () => console.log('🔍 Scanning for devices...'))
    .on('scanStop', () => console.log('⏹️  Scan stopped'))
    .on('newDevice', (device) => {
      console.log(`\n✨ New device discovered!`);
      logDevice(device);
    })
    .on('deviceDiscovered', (device) => {
      if (device.isKnown) {
        console.log(`\n📡 Updated known device: ${device.name}`);
        console.log(`   RSSI: ${device.rssi}dBm`);
        if (device.lastReading) {
          console.log(`   Temp: ${device.lastReading.temperature}°C`);
          console.log(`   Hum:  ${device.lastReading.humidity}%`);
        }
      }
    });
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  try {
    await discoveryService.stopScanning();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Start scanning for devices
async function startScanning(duration = 30000) {
  return new Promise(async (resolve, reject) => {
    console.log(`Starting scan for ${duration / 1000} seconds...`);
    
    let scanTimeout;
    let cleanupComplete = false;
    
    // Cleanup function
    const cleanup = async (exit = false) => {
      if (cleanupComplete) return;
      
      try {
        // Clear the timeout first to prevent it from firing
        if (scanTimeout) {
          clearTimeout(scanTimeout);
          scanTimeout = null;
        }
        
        // Remove any existing SIGINT listeners to prevent multiple cleanups
        process.removeListener('SIGINT', handleInterrupt);
        
        // Check if we need to stop scanning
        if (discoveryService && typeof discoveryService.stopScanning === 'function') {
          try {
            await discoveryService.stopScanning();
            console.log('\n✅ Scan stopped successfully');
          } catch (stopError) {
            console.warn('⚠️  Warning: Error while stopping scan:', stopError.message);
          }
        }
        
        cleanupComplete = true;
        
        if (exit) {
          process.exit(0);
        }
      } catch (error) {
        console.error('❌ Error during cleanup:', error.message);
        if (exit) process.exit(1);
        throw error;
      }
    };
    
    // Handle scan timeout
    const onTimeout = async () => {
      try {
        console.log('\n⏱️  Scan duration reached. Stopping scan...');
        await cleanup();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    
    // Set the timeout
    scanTimeout = setTimeout(onTimeout, duration);
    
    // Handle manual interruption (Ctrl+C)
    const handleInterrupt = async () => {
      console.log('\n🛑 Scan interrupted by user');
      try {
        await cleanup(true);
      } catch (error) {
        process.exit(1);
      }
    };
    
    // Handle process termination
    process.on('SIGINT', handleInterrupt);
    
    try {
      // Start the scan
      await discoveryService.startScanning(duration);
      console.log('🔍 Scanning for BLE devices... (Press Ctrl+C to stop)');
    } catch (error) {
      console.error('❌ Error starting BLE scan:', error.message);
      await cleanup();
      reject(error);
    }
  });
}

// List all known devices
async function listDevices() {
  try {
    console.log('\n📋 Fetching devices...');
    
    // Get devices from discovery service (in-memory)
    const discoveredDevices = discoveryService.getDevices() || [];
    
    // Get devices from storage (persisted)
    let storedDevices = [];
    try {
      const result = await storageService.devicesDB.allDocs({
        include_docs: true,
        attachments: true
      });
      storedDevices = result.rows.map(row => row.doc);
    } catch (error) {
      console.warn('⚠️  Could not fetch devices from storage:', error.message);
    }
    
    // Combine and deduplicate devices
    const allDevices = [...discoveredDevices];
    const deviceIds = new Set(discoveredDevices.map(d => d.id));
    
    storedDevices.forEach(device => {
      if (!deviceIds.has(device._id || device.id)) {
        allDevices.push(device);
        deviceIds.add(device._id || device.id);
      }
    });
    
    console.log('\n📋 Discovered Devices:');
    console.log('='.repeat(80));
    
    if (allDevices.length === 0) {
      console.log('No devices found');
      return;
    }
    
    allDevices.forEach((device, index) => {
      const deviceId = device._id || device.id;
      const deviceName = device.name || `Device-${deviceId.substring(0, 8)}`;
      const deviceType = device.type || 'unknown';
      const lastSeen = device.lastSeen ? new Date(device.lastSeen) : new Date(0);
      const isOnline = discoveredDevices.some(d => (d._id || d.id) === deviceId);
      
      console.log(`\n${index + 1}. ${deviceName} (${deviceId})`);
      console.log(`   Type: ${deviceType}`);
      console.log(`   Status: ${isOnline ? '🟢 Online' : '⚪ Offline'}`);
      console.log(`   Last seen: ${lastSeen.toLocaleString()}`);
      
      if (device.rssi !== undefined) {
        console.log(`   Signal: ${device.rssi} dBm`);
      }
      
      if (device.lastReading) {
        console.log('   Last reading:');
        if (device.lastReading.temperature !== undefined) {
          console.log(`     Temperature: ${device.lastReading.temperature}°C`);
        }
        if (device.lastReading.humidity !== undefined) {
          console.log(`     Humidity: ${device.lastReading.humidity}%`);
        }
        if (device.lastReading.batteryVoltage !== undefined) {
          console.log(`     Battery: ${device.lastReading.batteryVoltage}V`);
        }
      }
    });
    
    console.log('\n🔄 Use `node index.js scan` to discover more devices');
  } catch (error) {
    console.error('❌ Error listing devices:', error.message);
    throw error;
  }
}

// Log device details
function logDevice(device) {
  console.log(`Name: ${device.name}`);
  console.log(`Address: ${device.address}`);
  console.log(`Type: ${device.type}`);
  console.log(`RSSI: ${device.rssi}dBm`);
  if (device.lastReading) {
    console.log('Last Reading:');
    Object.entries(device.lastReading).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
  }
}

// Show help
function showHelp() {
  console.log(`
Bluetooth Device Manager

Usage:
  node app.js <command> [options]

Commands:
  scan [duration]  Scan for devices (default: 30s)
  list             List all discovered devices
  help             Show this help

Examples:
  node app.js scan           # Scan for 30 seconds
  node app.js scan 60        # Scan for 60 seconds
  node app.js list           # List all devices
`);
  process.exit(0);
}

// Export all the functions and services
export {
  discoveryService,
  main as initialize,
  startScanning,
  listDevices,
  logDevice,
  showHelp,
  cleanup
};

// Export the main function as default for easier imports
export default main;

// Run the application if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  if (!command || command === 'help') {
    showHelp();
  } else {
    main().catch(error => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
  }
}
