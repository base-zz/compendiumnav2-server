/**
 * State Management System
 * 
 * This module exports the unified state management components
 * for the CompendiumnNav2 application.
 */

// Load environment variables from .env file (Node only; skip if running in browser)
if (typeof process !== 'undefined' && process.env) {
  // Dynamically import dotenv only in Node
  const dotenvModule = await import('dotenv');
  dotenvModule.config({ path: new URL('./.env', import.meta.url).pathname });
}

import { stateData, StateData } from './StateData.js';
import { stateService, StateService } from './StateService.js';

if (typeof process !== 'undefined' && process.env) {
  dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
}

export { stateData, StateData, stateService, StateService };

export async function initialize(config = {}) {
  await stateService.initialize(config);
  return { stateData, stateService };
}
