import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getOrCreateAppUuid } from './uniqueAppId.js';

const PRIVATE_KEY_FILE = path.resolve(process.cwd(), '.private-key');
const PUBLIC_KEY_FILE = path.resolve(process.cwd(), '.public-key');

/**
 * Derives a deterministic key pair from the boat ID
 * This ensures the same boat ID always generates the same key pair
 */
export function deriveKeyPairFromBoatId() {
  const boatId = getOrCreateAppUuid();
  
  // Create a seed from the boatId
  const seed = crypto.createHash('sha256').update(boatId).digest();
  
  // Use the seed to create a deterministic random number generator
  const prng = (size) => {
    let buffer = Buffer.alloc(size);
    let offset = 0;
    
    while (offset < size) {
      const hash = crypto.createHash('sha256')
        .update(seed)
        .update(Buffer.from([offset]))
        .digest();
      
      const copySize = Math.min(hash.length, size - offset);
      hash.copy(buffer, offset, 0, copySize);
      offset += copySize;
    }
    
    return buffer;
  };
  
  // Generate the key pair
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    },
    prng: prng
  });
}

/**
 * Gets existing key pair or creates a new one
 */
export function getOrCreateKeyPair() {
  // Check if keys already exist
  if (fs.existsSync(PRIVATE_KEY_FILE) && fs.existsSync(PUBLIC_KEY_FILE)) {
    return {
      privateKey: fs.readFileSync(PRIVATE_KEY_FILE, 'utf8'),
      publicKey: fs.readFileSync(PUBLIC_KEY_FILE, 'utf8')
    };
  }

  // Generate new key pair
  const { privateKey, publicKey } = deriveKeyPairFromBoatId();

  // Save keys
  fs.writeFileSync(PRIVATE_KEY_FILE, privateKey, 'utf8');
  fs.writeFileSync(PUBLIC_KEY_FILE, publicKey, 'utf8');
  
  // Set restrictive permissions on private key
  fs.chmodSync(PRIVATE_KEY_FILE, 0o600);

  return { privateKey, publicKey };
}

/**
 * Signs a message with the private key
 */
export function signMessage(message, privateKey) {
  const sign = crypto.createSign('SHA256');
  sign.update(message);
  sign.end();
  return sign.sign(privateKey, 'base64');
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
