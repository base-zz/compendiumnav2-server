/**
 * Boat Info API Endpoint
 * 
 * Provides endpoints for retrieving boat information including
 * the boat's unique ID and vessel details from SignalK
 */

import { getBoatInfo as buildBoatInfo } from '../uniqueAppId.js';
import { requireService } from '../../services/serviceLocator.js';
import Database from 'better-sqlite3';

console.log('[ROUTES] boatInfo routes module loaded');

const PROFILE_ID = 'default';
const STRING_FIELDS = new Set(['boatName', 'boatType', 'mmsi']);
const NUMBER_FIELDS = new Set([
  'loa',
  'beam',
  'draft',
  'safeAnchoringDepth',
  'airDraft',
  'safeAirDraftClearance',
  'bowRollerToWater',
  'topSpeed',
]);

function getBoatProfileDbPath() {
  const dbPath = process.env.BOAT_PROFILE_DB_PATH;
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new Error('BOAT_PROFILE_DB_PATH must be set');
  }
  return dbPath;
}

function openBoatProfileDb() {
  const db = new Database(getBoatProfileDbPath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS boat_profile (
      id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

function sanitizeBoatProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Boat profile payload must be an object');
  }

  const profile = {};

  for (const field of STRING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      const value = input[field];
      if (value === null) {
        profile[field] = null;
      } else if (typeof value === 'string') {
        profile[field] = value;
      } else {
        throw new Error(`${field} must be a string or null`);
      }
    }
  }

  for (const field of NUMBER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      const value = input[field];
      if (value === null) {
        profile[field] = null;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        profile[field] = value;
      } else {
        throw new Error(`${field} must be a finite number or null`);
      }
    }
  }

  return profile;
}

function loadBoatProfile() {
  const db = openBoatProfileDb();
  try {
    const row = db.prepare('SELECT data_json, updated_at FROM boat_profile WHERE id = ?').get(PROFILE_ID);
    if (!row) {
      return null;
    }

    const data = JSON.parse(row.data_json);
    return {
      ...data,
      updatedAt: row.updated_at,
    };
  } finally {
    db.close();
  }
}

function loadBoatProfileForBoatInfo() {
  try {
    return {
      profile: loadBoatProfile(),
      error: null,
    };
  } catch (err) {
    return {
      profile: null,
      error: err.message,
    };
  }
}

function saveBoatProfile(profile) {
  const sanitized = sanitizeBoatProfile(profile);
  const updatedAt = new Date().toISOString();
  const db = openBoatProfileDb();
  try {
    db.prepare(`
      INSERT INTO boat_profile (id, data_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(PROFILE_ID, JSON.stringify(sanitized), updatedAt);

    return {
      ...sanitized,
      updatedAt,
    };
  } finally {
    db.close();
  }
}

function mergeBoatProfile(boatInfo, profile) {
  if (!profile || typeof profile !== 'object') {
    return boatInfo;
  }

  const merged = {
    ...boatInfo,
    profile,
  };

  if (typeof profile.boatName === 'string' && profile.boatName.trim() !== '') {
    merged.name = profile.boatName;
    merged.boatName = profile.boatName;
  }

  if (typeof profile.mmsi === 'string' && profile.mmsi.trim() !== '') {
    merged.mmsi = profile.mmsi;
  }

  if (typeof profile.boatType === 'string' && profile.boatType.trim() !== '') {
    merged.boatType = profile.boatType;
  }

  merged.dimensions = {
    ...(boatInfo.dimensions || {}),
  };

  if (Number.isFinite(profile.loa)) {
    merged.dimensions.length = profile.loa;
    merged.loa = profile.loa;
  }

  if (Number.isFinite(profile.beam)) {
    merged.dimensions.beam = profile.beam;
    merged.beam = profile.beam;
  }

  if (Number.isFinite(profile.draft)) {
    merged.dimensions.draft = profile.draft;
    merged.draft = profile.draft;
  }

  for (const field of ['safeAnchoringDepth', 'airDraft', 'safeAirDraftClearance', 'bowRollerToWater', 'topSpeed']) {
    if (Number.isFinite(profile[field])) {
      merged[field] = profile[field];
    }
  }

  return merged;
}

// Re-export getBoatInfo with stateService pre-bound
export function getBoatInfo() {
  const profileResult = loadBoatProfileForBoatInfo();
  try {
    const state = requireService('state');
    const boatInfo = mergeBoatProfile(buildBoatInfo(state), profileResult.profile);
    if (profileResult.error) {
      boatInfo.profilePersistence = { configured: false, error: profileResult.error };
    }
    return boatInfo;
  } catch (_error) {
    const boatInfo = mergeBoatProfile(buildBoatInfo(), profileResult.profile);
    if (profileResult.error) {
      boatInfo.profilePersistence = { configured: false, error: profileResult.error };
    }
    return boatInfo;
  }
}

/**
 * Registers boat info routes with the Express app
 * @param {Object} app - Express application instance
 */
export function registerBoatInfoRoutes(app) {
  /**
   * @openapi
   * /api/boat-info:
   *   get:
   *     tags: [Boat]
   *     summary: Get boat information
   *     description: Returns the boat's unique ID and vessel information
   *     responses:
   *       200:
   *         description: Boat information
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/BoatInfo'
   *       500:
   *         description: Server error
   */
  app.get('/api/boat-info', (req, res) => {
    try {
      const state = requireService('state');
      const profileResult = loadBoatProfileForBoatInfo();
      const boatInfo = mergeBoatProfile(buildBoatInfo(state), profileResult.profile);
      if (profileResult.error) {
        boatInfo.profilePersistence = { configured: false, error: profileResult.error };
      }
      res.json(boatInfo);
    } catch (error) {
      console.error('Error getting boat info:', error);
      res.status(500).json({ 
        error: 'Failed to get boat information',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  app.get('/api/boat-profile', (req, res) => {
    try {
      const profile = loadBoatProfile();
      res.json({ success: true, profile });
    } catch (error) {
      console.error('Error getting boat profile:', error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  app.put('/api/boat-profile', (req, res) => {
    try {
      const profile = saveBoatProfile(req.body);
      let boatInfo;
      try {
        const state = requireService('state');
        boatInfo = mergeBoatProfile(buildBoatInfo(state), profile);
      } catch (_stateError) {
        boatInfo = mergeBoatProfile(buildBoatInfo(), profile);
      }

      res.json({ success: true, profile, boatInfo });
    } catch (error) {
      console.error('Error saving boat profile:', error);
      res.status(400).json({
        success: false,
        error: error.message,
      });
    }
  });
}

/**
 * @openapi
 * components:
 *   schemas:
 *     BoatInfo:
 *       type: object
 *       properties:
 *         boatId:
 *           type: string
 *           description: Unique identifier for the boat
 *         name:
 *           type: string
 *           description: Vessel name
 *         mmsi:
 *           type: string
 *           nullable: true
 *           description: Maritime Mobile Service Identity number
 *         callsign:
 *           type: string
 *           nullable: true
 *           description: Vessel radio callsign
 *         dimensions:
 *           type: object
 *           properties:
 *             length:
 *               type: number
 *               nullable: true
 *             beam:
 *               type: number
 *               nullable: true
 *             draft:
 *               type: number
 *               nullable: true
 *         position:
 *           type: object
 *           nullable: true
 *           description: Current position information if available
 *         lastUpdated:
 *           type: string
 *           format: date-time
 *           description: ISO timestamp of when the information was last updated
 *         status:
 *           type: string
 *           enum: [online, offline]
 *           description: Current status of the boat's connection to SignalK
 *         signalK:
 *           type: object
 *           properties:
 *             connected:
 *               type: boolean
 *               description: Whether the boat is connected to SignalK
 *             error:
 *               type: string
 *               nullable: true
 *               description: Error message if connection to SignalK failed
 *             lastUpdate:
 *               type: string
 *               format: date-time
 *               nullable: true
 *               description: Timestamp of the last update from SignalK
 */
