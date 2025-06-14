import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { getOrCreateAppUuid } from './uniqueAppId.js';

const PRIVATE_KEY_FILE = '.private-key';
const PUBLIC_KEY_FILE = '.public-key';

/**
 * Generate or retrieve the key pair for this boat server
 * @returns {Object} The key pair with publicKey and privateKey
 */
export function getOrCreateKeyPair() {
  const existingKeyPair = loadKeyPair();
  if (existingKeyPair) {
    return existingKeyPair;
  }

  // Generate a new key pair if none exists
  return generateAndSaveKeyPair();
}

/**
 * Load the key pair from disk if it exists
 * @returns {Object|null} The key pair or null if not found
 */
function loadKeyPair() {
  try {
    if (fs.existsSync(PRIVATE_KEY_FILE) && fs.existsSync(PUBLIC_KEY_FILE)) {
      const privateKey = fs.readFileSync(PRIVATE_KEY_FILE, 'utf8');
      const publicKey = fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');
      return { privateKey, publicKey };
    }
  } catch (error) {
    console.error('Error loading key pair:', error);
  }
  return null;
}

/**
 * Generate a new key pair and save it to disk
 * @returns {Object} The generated key pair
 */
function generateAndSaveKeyPair() {
  try {
    // Generate a deterministic key pair based on the boat ID
    const boatId = getOrCreateAppUuid();
    const { publicKey, privateKey } = generateKeyPair(boatId);
    
    // Save the keys to disk
    fs.writeFileSync(PRIVATE_KEY_FILE, privateKey);
    fs.writeFileSync(PUBLIC_KEY_FILE, publicKey);
    
    return { privateKey, publicKey };
  } catch (error) {
    console.error('Error generating key pair:', error);
    throw error;
  }
}

/**
 * Generate a key pair deterministically based on the boat ID
 * @param {string} boatId - The unique boat ID
 * @returns {Object} The generated key pair
 */
function generateKeyPair(boatId) {
  try {
    // Use node-forge to generate RSA key pair
    const rsaKeypair = forge.pki.rsa.generateKeyPair({bits: 2048, workers: 2});
    
    // Convert to PEM format
    const privateKey = forge.pki.privateKeyToPem(rsaKeypair.privateKey);
    const publicKey = forge.pki.publicKeyToPem(rsaKeypair.publicKey);
    
    return { privateKey, publicKey };
  } catch (error) {
    console.error('Error generating key pair:', error);
    throw new Error(`Failed to generate key pair: ${error.message}`);
  }
}

/**
 * Sign a message using the private key
 * @param {string} message - The message to sign
 * @param {string} [privateKey] - The private key to use for signing. If not provided, will be retrieved from the key pair.
 * @returns {string} The signature as a base64 string
 */
export function signMessage(message, privateKey) {
  try {
    // If privateKey is not provided, get it from the key pair
    if (!privateKey) {
      const keyPair = getOrCreateKeyPair();
      if (!keyPair || !keyPair.privateKey) {
        throw new Error('No private key available for signing');
      }
      privateKey = keyPair.privateKey;
    }
    
    // Convert PEM to forge private key
    const privateKeyObj = forge.pki.privateKeyFromPem(privateKey);
    
    // Create message digest and sign
    const md = forge.md.sha256.create();
    md.update(message, 'utf8');
    
    // Sign and return base64-encoded signature
    return forge.util.encode64(privateKeyObj.sign(md));
  } catch (error) {
    console.error('Error signing message:', error);
    throw new Error(`Failed to sign message: ${error.message}`);
  }
}

/**
 * Register the public key with the VPS
 * @param {string} vpsUrl - The URL of the VPS (without the ws:// prefix)
 * @returns {Promise<boolean>} True if registration was successful
 */
export async function registerPublicKeyWithVPS(vpsUrl) {
  try {
    const keyPair = getOrCreateKeyPair();
    const boatId = getOrCreateAppUuid();
    
    // Extract hostname from the WebSocket URL and determine protocol
    // Format: ws(s)://hostname:port/path -> http(s)://hostname
    let hostname;
    let protocol;
    
    // Check if it's a secure WebSocket URL (wss://)
    const secureMatch = vpsUrl.match(/^wss:\/\/([^:/]+)/i);
    if (secureMatch) {
      hostname = secureMatch[1];
      protocol = 'https';
    } else {
      // Try to match non-secure WebSocket URL (ws://)
      const insecureMatch = vpsUrl.match(/^ws:\/\/([^:/]+)/i);
      if (insecureMatch) {
        hostname = insecureMatch[1];
        protocol = 'http';
      } else {
        throw new Error(`Invalid WebSocket URL format: ${vpsUrl}`);
      }
    }
    
    const apiBaseUrl = `${protocol}://${hostname}`;
    console.log(`[KEY-PAIR] API base URL: ${apiBaseUrl}`);
    
    const registrationUrl = `${apiBaseUrl}/api/boat/register-key`;
    console.log(`[KEY-PAIR] Registering public key with VPS at ${registrationUrl}`);
    
    // Create a timeout promise
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout after 15 seconds')), 15000);
    });
    
    // Create the fetch promise
    const fetchPromise = fetch(registrationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        boatId,
        publicKey: keyPair.publicKey
      })
    });
    
    // Race the fetch against the timeout
    const response = await Promise.race([fetchPromise, timeout]);
    const data = await response.json();
    
    if (response.ok && data.success) {
      console.log(`[KEY-PAIR] Successfully registered public key with VPS for boat ${boatId}`);
      return true;
    } else {
      console.error(`[KEY-PAIR] Failed to register public key with VPS: ${data.error || 'Unknown error'}`);
      return false;
    }
  } catch (error) {
    console.error('[KEY-PAIR] Error registering public key with VPS:', error);
    console.log('[KEY-PAIR] Continuing with connection despite key registration failure');
    return false;
  }
}

/**
 * Registers the public key with the VPS
 */
export async function registerPublicKey(vpsUrl) {
  const boatId = getOrCreateAppUuid();
  const { publicKey } = getOrCreateKeyPair();
  
  try {
    // Send public key to VPS
    const response = await fetch(`${vpsUrl}/api/boat/register-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        boatId,
        publicKey
      })
    });
    
    const data = await response.json();
    
    if (!data.success) {
      console.error('Failed to register public key:', data.error);
      return { success: false, error: data.error };
    }
    
    console.log('Public key registered successfully');
    return { success: true };
  } catch (error) {
    console.error('Error registering public key:', error);
    return { success: false, error: error.message };
  }
}
