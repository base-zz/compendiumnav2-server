// Simple script to print the current state
import { stateManager } from './src/relay/core/state/StateManager.js';

// Wait for state to initialize
setTimeout(() => {
  console.log('\n===== BLUETOOTH STATE =====');
  console.log('Bluetooth devices in state:', Object.keys(stateManager.appState?.bluetooth?.devices || {}).length);
  
  // Print device IDs
  const deviceIds = Object.keys(stateManager.appState?.bluetooth?.devices || {});
  console.log('Device IDs:', deviceIds);
  
  // Print full device details
  console.dir(stateManager.appState?.bluetooth?.devices || {}, { depth: 4, colors: true });
  console.log('\n===== END BLUETOOTH STATE =====');
  process.exit(0);
}, 1000);
