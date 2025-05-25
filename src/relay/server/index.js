// src/relay/server/index.js

import dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { RelayServer } from './RelayServer.js';
import { startDirectServer } from './DirectServer.js';
import crypto from 'crypto';

let relayServerInstance = null;
let directServerInstance = null;

// Verify a signature using a public key
function verifySignature(message, signature, publicKey) {
  try {
    console.log(`[AUTH] Verifying signature for message: ${message}`);
    const verify = crypto.createVerify('SHA256');
    verify.update(message);
    verify.end();
    const result = verify.verify(publicKey, signature, 'base64');
    console.log(`[AUTH] Signature verification result: ${result ? 'SUCCESS' : 'FAILED'}`);
    return result;
  } catch (error) {
    console.error('[AUTH] Signature verification error:', error);
    return false;
  }
}

export async function startRelayServer(config = {}) {
  relayServerInstance = new RelayServer(config);
  // Initialize the relay server (this will connect to the VPS)
  try {
    await relayServerInstance.initialize();
    console.log('[RELAY] Relay server initialized and started on port', config.port);
  } catch (error) {
    console.error('[RELAY] Failed to initialize relay server:', error.message);
  }
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
