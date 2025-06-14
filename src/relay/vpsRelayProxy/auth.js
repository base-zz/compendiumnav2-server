import forge from 'node-forge';
import jwt from 'jsonwebtoken';
import crypto from 'crypto'; // Keep for other crypto operations if needed

const TOKEN_SECRET = process.env.TOKEN_SECRET;

// ===================================================================
// TOKEN-BASED AUTHENTICATION
// These functions are used for the web API and admin interface
// ===================================================================

/**
 * Hash a password using SHA-256
 * Used for user registration and login
 */
export function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

/**
 * Generate a JWT token
 * Used for user login and API authentication
 */
export function generateToken(payload) {
  return jwt.sign(payload, TOKEN_SECRET, { expiresIn: "60d" });
}

/**
 * Verify a JWT token
 * Used for API authentication
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, TOKEN_SECRET);
  } catch {
    return null;
  }
}

/**
 * Generate a reset token for password reset
 * Used for password reset functionality
 */
export function generateResetToken(username) {
  return jwt.sign({ username }, TOKEN_SECRET, { expiresIn: "1h" });
}

// ===================================================================
// KEY-BASED AUTHENTICATION
// These functions are used for WebSocket connections and client authentication
// ===================================================================

/**
 * Verify a signature using a public key
 */
export function verifySignature(message, signature, publicKey) {
  try {
    // Convert PEM to forge public key
    const publicKeyObj = forge.pki.publicKeyFromPem(publicKey);
    
    // Create message digest
    const md = forge.md.sha256.create();
    md.update(message, 'utf8');
    
    // Verify the signature
    return publicKeyObj.verify(
      md.digest().bytes(),
      forge.util.decode64(signature)
    );
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Verify a client signature using the client's public key
 * @param {string} clientId - Unique identifier for the client
 * @param {string} boatId - ID of the boat the client is associated with
 * @param {string} timestamp - Timestamp of the message
 * @param {string} signature - Signature to verify (base64 encoded)
 * @param {string} publicKey - Client's public key in PEM format
 * @returns {boolean} - Whether the signature is valid
 */
export function verifyClientSignature(clientId, boatId, timestamp, signature, publicKey) {
  try {
    // The message format is "clientId:boatId:timestamp"
    const message = `${clientId}:${boatId}:${timestamp}`;
    
    // Convert PEM to forge public key
    const publicKeyObj = forge.pki.publicKeyFromPem(publicKey);
    
    // Create message digest
    const md = forge.md.sha256.create();
    md.update(message, 'utf8');
    
    // Verify the signature
    const isValid = publicKeyObj.verify(
      md.digest().bytes(),
      forge.util.decode64(signature)
    );
    
    if (!isValid) {
      console.warn(`[AUTH] Invalid signature for client ${clientId} and boat ${boatId}`);
    } else {
      console.log(`[AUTH-DETAILED] Valid signature for client ${clientId} and boat ${boatId}`);
    }
    
    return isValid;
  } catch (error) {
    console.error(`[AUTH] Client signature verification error:`, error);
    return false;
  }
}

