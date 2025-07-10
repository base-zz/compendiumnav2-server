import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import debug from 'debug';
import { getOrCreateAppUuid } from './uniqueAppId.js';

const log = debug('key-pair');
const logError = debug('key-pair:error');

// Default key file paths (can be overridden by environment variables)
const DEFAULT_PRIVATE_KEY_FILE = `${process.env.HOME || process.env.USERPROFILE || ''}/.compendium/keys/private-key`;
const DEFAULT_PUBLIC_KEY_FILE = `${process.env.HOME || process.env.USERPROFILE || ''}/.compendium/keys/public-key`;

const PRIVATE_KEY_FILE = process.env.COMPENDIUM_PRIVATE_KEY_FILE || DEFAULT_PRIVATE_KEY_FILE;
const PUBLIC_KEY_FILE = process.env.COMPENDIUM_PUBLIC_KEY_FILE || DEFAULT_PUBLIC_KEY_FILE;

/**
 * Generate or retrieve the key pair for this boat server
 * @returns {Object} The key pair with publicKey and privateKey
 */
export function getOrCreateKeyPair() {
  const existingKeyPair = loadKeyPair();
  if (existingKeyPair) {
    log('Loaded existing key pair from disk');
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
    logError('Error loading key pair:', error);
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
    log('Generating new key pair...');
    const boatId = getOrCreateAppUuid();
    const { publicKey, privateKey } = generateKeyPair(boatId);
    
    // Save the keys to disk
    fs.writeFileSync(PRIVATE_KEY_FILE, privateKey);
    fs.writeFileSync(PUBLIC_KEY_FILE, publicKey);
    log(`Saved new key pair to ${PRIVATE_KEY_FILE} and ${PUBLIC_KEY_FILE}`);
    
    return { privateKey, publicKey };
  } catch (error) {
    logError('Error generating key pair:', error);
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
    log(`Generating deterministic key pair for boat ID: ${boatId}`);
    const rsaKeypair = forge.pki.rsa.generateKeyPair({bits: 2048, workers: 2});
    
    // Convert to PEM format
    const privateKey = forge.pki.privateKeyToPem(rsaKeypair.privateKey);
    const publicKey = forge.pki.publicKeyToPem(rsaKeypair.publicKey);
    
    return { privateKey, publicKey };
  } catch (error) {
    logError('Error generating key pair:', error);
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
      log('Private key not provided, retrieving from key store...');
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
    logError('Error signing message:', error);
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
    log(`API base URL: ${apiBaseUrl}`);
    
    const registrationUrl = `${apiBaseUrl}/api/boat/register-key`;
    log(`Registering public key with VPS at ${registrationUrl}`);
    
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
      log(`Successfully registered public key with VPS for boat ${boatId}`);
      return true;
    } else {
      logError(`Failed to register public key with VPS: ${data.error || 'Unknown error'}`);
      return false;
    }
  } catch (error) {
    logError('Error registering public key with VPS:', error);
    log('Continuing with connection despite key registration failure');
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
      logError('Failed to register public key:', data.error);
      return { success: false, error: data.error };
    }
    
    log('Public key registered successfully');
    return { success: true };
  } catch (error) {
    logError('Error registering public key:', error);
    return { success: false, error: error.message };
  }
}
