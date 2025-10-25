/**
 * Test script to add Victron SmartBMV encryption key
 * Run this after your server has discovered the Victron device
 */

import { BluetoothService } from './src/services/BluetoothService.js';

async function addVictronKey() {
  // Initialize Bluetooth service
  const bluetoothService = new BluetoothService();
  await bluetoothService.start();
  
  // Wait a bit for device discovery
  console.log('Waiting for device discovery...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  // Get all discovered devices
  const devices = bluetoothService.getDevices();
  console.log(`Found ${devices.length} devices`);
  
  // Find Victron device (manufacturer ID 737 = 0x02E1)
  const victronDevice = devices.find(d => d.manufacturerId === 737);
  
  if (!victronDevice) {
    console.log('No Victron device found. Make sure your SmartBMV is powered on and in range.');
    process.exit(1);
  }
  
  console.log(`Found Victron device: ${victronDevice.id}`);
  console.log(`Name: ${victronDevice.name || 'Unknown'}`);
  
  // Add encryption key
  const encryptionKey = 'd020496a21cf5db1e5ad2c647d1ec72d'; // Your key
  
  console.log('Adding encryption key to device metadata...');
  await bluetoothService.updateDeviceMetadata(victronDevice.id, {
    encryptionKey: encryptionKey
  });
  
  console.log('✅ Encryption key added!');
  console.log('The device should now start parsing data.');
  console.log('Check your Bluetooth state logs for battery data.');
  
  // Keep running to see data
  console.log('\nWaiting for data... (Press Ctrl+C to exit)');
}

addVictronKey().catch(console.error);
