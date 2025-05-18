// Debug script to show real data from StateService
import { stateService } from './StateService.js';
import { stateData } from './StateData.js';

console.log('Starting StateService data debug...');

// Log the current state data
console.log('Current state data:');
console.log(JSON.stringify(stateData, null, 2));

// Listen for state updates
stateService.on('state-updated', (data) => {
  console.log('State update received:');
  console.log(JSON.stringify(data, null, 2));
});

// Keep the process running
process.on('SIGINT', () => {
  console.log('Shutting down...');
  process.exit(0);
});
