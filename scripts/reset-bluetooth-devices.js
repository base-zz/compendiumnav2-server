import storageService from '../src/bluetooth/services/storage/storageService.js';

/**
 * Script to reset all Bluetooth device data
 */
async function resetBluetoothDevices() {
  console.log('Initializing storage service...');
  await storageService.initialize();
  
  console.log('Clearing all devices from database...');
  const result = await storageService.clearAllDevices();
  
  if (result) {
    console.log('Successfully cleared all devices from database');
    
    // Also clear selected devices setting
    await storageService.setSetting('selectedDevices', []);
    console.log('Reset selected devices list');
    
    console.log('Bluetooth device data has been reset successfully');
  } else {
    console.error('Failed to clear devices');
  }
  
  process.exit(0);
}

resetBluetoothDevices().catch(error => {
  console.error('Error resetting Bluetooth devices:', error);
  process.exit(1);
});
