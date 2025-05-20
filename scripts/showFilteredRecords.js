import { StateServiceDemo } from '../src/state/StateServiceDemo.js';

async function main() {
  try {
    console.log('Creating StateServiceDemo instance...');
    const stateService = new StateServiceDemo();
    
    console.log('Fetching first 100 filtered records...');
    await stateService.showFirst100FilteredRecords();
    
    console.log('\nDone!');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
