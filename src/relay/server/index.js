// src/relay/server/index.js

import dotenv from "dotenv";
dotenv.config({ path: process.env.RELAY_ENV_PATH || ".env.server" });

import { RelayServer } from './RelayServer.js';
import { startDirectServer } from './DirectServer.js';

let relayServerInstance = null;
let directServerInstance = null;

export async function startRelayServer(config = {}) {
  relayServerInstance = new RelayServer(config);
  // If RelayServer has async init, you could await relayServerInstance.initialize();
  console.log('[RELAY] Relay server started on port', config.port);
  return relayServerInstance;
}

export async function startDirectServerWrapper(options = {}) {
  directServerInstance = await startDirectServer(options);
  console.log('[DIRECT] Direct server started');
  return directServerInstance;
}

// Export the original direct server starter for compatibility
export { startDirectServer };

// Optionally export server instances for management
export { relayServerInstance, directServerInstance };
