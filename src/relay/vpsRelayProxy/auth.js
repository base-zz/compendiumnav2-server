import crypto from "crypto";
import jwt from "jsonwebtoken";

const TOKEN_SECRET = process.env.TOKEN_SECRET;

/**
 * Hash a password using SHA-256
 */
export function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

/**
 * Generate a JWT token
 */
export function generateToken(payload) {
  return jwt.sign(payload, TOKEN_SECRET, { expiresIn: "60d" });
}

/**
 * Verify a JWT token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, TOKEN_SECRET);
  } catch {
    return null;
  }
}

/**
 * Verify a signature using a public key
 */
export function verifySignature(message, signature, publicKey) {
  try {
    const verify = crypto.createVerify("SHA256");
    verify.update(message);
    verify.end();
    return verify.verify(publicKey, signature, "base64");
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

/**
 * Generate a reset token for password reset
 */
export function generateResetToken(username) {
  return jwt.sign({ username }, TOKEN_SECRET, { expiresIn: "1h" });
}
