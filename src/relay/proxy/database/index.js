import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { join } from "path";

// --- LOWDB SETUP ---
const dbFile = join(process.cwd(), "db.json");
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, {
  users: [],
  boats: [],
  user_boats: [],
  boat_keys: [],
});

/**
 * Initialize the database
 */
export async function initDatabase() {
  await db.read();
  
  // Ensure all collections exist
  if (!db.data.users) db.data.users = [];
  if (!db.data.boats) db.data.boats = [];
  if (!db.data.user_boats) db.data.user_boats = [];
  if (!db.data.boat_keys) db.data.boat_keys = [];
  
  await db.write();
  console.log("[DB] Database initialized");
}

/**
 * Get the database instance
 */
export function getDb() {
  return db;
}

/**
 * Find a user by username
 */
export async function findUserByUsername(username) {
  await db.read();
  return db.data.users.find(u => u.username === username);
}

/**
 * Find a user by email
 */
export async function findUserByEmail(email) {
  await db.read();
  return db.data.users.find(u => u.email === email);
}

/**
 * Create a new user
 */
export async function createUser(user) {
  await db.read();
  db.data.users.push(user);
  await db.write();
  return user;
}

/**
 * Find a boat by ID
 */
export async function findBoatById(boatId) {
  await db.read();
  return db.data.boats.find(b => b.boatId === boatId);
}

/**
 * Create a new boat
 */
export async function createBoat(boat) {
  await db.read();
  db.data.boats.push(boat);
  await db.write();
  return boat;
}

/**
 * Associate a user with a boat
 */
export async function associateUserWithBoat(username, boatId) {
  await db.read();
  if (!db.data.user_boats.find(ub => ub.username === username && ub.boatId === boatId)) {
    db.data.user_boats.push({ username, boatId });
    await db.write();
  }
}

/**
 * Get boats for a user
 */
export async function getBoatsForUser(username) {
  await db.read();
  const boatIds = db.data.user_boats
    .filter(ub => ub.username === username)
    .map(ub => ub.boatId);
  return db.data.boats.filter(b => boatIds.includes(b.boatId));
}

/**
 * Register or update a boat's public key
 */
export async function registerBoatKey(boatId, publicKey) {
  await db.read();
  
  // Ensure boat_keys exists
  if (!db.data.boat_keys) {
    db.data.boat_keys = [];
  }
  
  // Update or create key entry
  const existingKeyIndex = db.data.boat_keys.findIndex(k => k.boatId === boatId);
  if (existingKeyIndex >= 0) {
    db.data.boat_keys[existingKeyIndex].publicKey = publicKey;
    db.data.boat_keys[existingKeyIndex].updatedAt = new Date().toISOString();
  } else {
    db.data.boat_keys.push({
      boatId,
      publicKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  
  await db.write();
  return true;
}

/**
 * Get a boat's public key
 */
export async function getBoatPublicKey(boatId) {
  await db.read();
  const keyEntry = db.data.boat_keys.find(k => k.boatId === boatId);
  return keyEntry ? keyEntry.publicKey : null;
}
