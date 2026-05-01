import Database from "better-sqlite3";

/**
 * Master Data API
 *
 * Provides HTTP endpoints for crowdsourced master database updates:
 * - Marinas (upsert, query, nearby search)
 * - Fuel logs (submit price updates)
 * - Sync events (pending events for client sync)
 */

/**
 * Initialize database and create schema if needed
 */
function initializeDatabase(dbPath) {
  const db = new Database(dbPath);

  // Enable foreign keys
  db.pragma("foreign_keys = ON");

  // Drop existing marinas table to recreate with updated schema
  db.exec("DROP TABLE IF EXISTS marinas;");

  // Create marinas table
  db.exec(`
    CREATE TABLE IF NOT EXISTS marinas (
      marina_uid TEXT PRIMARY KEY,
      primary_name TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      website_url TEXT,
      marinas_url TEXT,
      dockwa_url TEXT,
      source_marinas_id TEXT,
      dockwa_destination_id TEXT,
      aliases_json TEXT NOT NULL,
      verification_state TEXT NOT NULL CHECK (verification_state IN ('verified', 'unverified', 'pending_review')),
      missing_from_web_count INTEGER NOT NULL CHECK (missing_from_web_count >= 0),
      fuel_candidate INTEGER NOT NULL CHECK (fuel_candidate IN (0, 1)),
      seed_reason TEXT,
      last_seen_on_web_utc TEXT,
      features_last_checked_at_utc TEXT,
      last_fuel_checked_at_utc TEXT,
      sync_dirty INTEGER NOT NULL CHECK (sync_dirty IN (0, 1)),
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL,
      CHECK (length(marina_uid) = 36),
      CHECK (
        substr(marina_uid, 9, 1) = '-'
        AND substr(marina_uid, 14, 1) = '-'
        AND substr(marina_uid, 19, 1) = '-'
        AND substr(marina_uid, 24, 1) = '-'
      ),
      CHECK (
        marina_uid GLOB '[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*'
      ),
      CHECK (json_valid(aliases_json))
    )
  `);

  // Create indexes for marinas
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_marinas_source_marinas_id
      ON marinas(source_marinas_id)
      WHERE source_marinas_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_marinas_dockwa_destination_id
      ON marinas(dockwa_destination_id)
      WHERE dockwa_destination_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_marinas_geo
      ON marinas(lat, lon);

    CREATE INDEX IF NOT EXISTS idx_marinas_fuel_candidate
      ON marinas(fuel_candidate, sync_dirty);
  `);

  // Create anchorages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS anchorages (
      anchorage_uid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT,
      state TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      source_url TEXT,
      raw_data_json TEXT,
      last_updated TEXT,
      location TEXT,
      mile_marker TEXT,
      lat_lon_text TEXT,
      depth TEXT,
      description TEXT,
      holding_rating REAL,
      wind_protection_rating REAL,
      current_flow_rating REAL,
      wake_protection_rating REAL,
      scenic_beauty_rating REAL,
      ease_of_shopping_rating REAL,
      shore_access_rating REAL,
      pet_friendly_rating REAL,
      cell_service_rating REAL,
      wifi_rating REAL,
      sync_dirty INTEGER NOT NULL CHECK (sync_dirty IN (0, 1)),
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL,
      CHECK (length(anchorage_uid) = 36),
      CHECK (
        substr(anchorage_uid, 9, 1) = '-'
        AND substr(anchorage_uid, 14, 1) = '-'
        AND substr(anchorage_uid, 19, 1) = '-'
        AND substr(anchorage_uid, 24, 1) = '-'
      ),
      CHECK (
        anchorage_uid GLOB '[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*'
      )
    )
  `);

  // Create indexes for anchorages
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_anchorages_geo
      ON anchorages(lat, lon);

    CREATE INDEX IF NOT EXISTS idx_anchorages_sync_dirty
      ON anchorages(sync_dirty);
  `);

  // Create bridges table (simplified without SpatiaLite geometry)
  db.exec(`
    CREATE TABLE IF NOT EXISTS bridges (
      bridge_uid TEXT PRIMARY KEY,
      external_id TEXT,
      name TEXT NOT NULL,
      state TEXT,
      city TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      closed_height_mhw TEXT,
      tier TEXT,
      schedule_type TEXT,
      opening_intervals TEXT,
      blackout_windows TEXT,
      vhf_channel TEXT,
      source_url TEXT UNIQUE,
      raw_data TEXT,
      tier_description TEXT,
      phone TEXT,
      normally_open_closed TEXT,
      has_seasonal_variation INTEGER CHECK (has_seasonal_variation IN (0, 1)),
      current_rule_summary TEXT,
      seasonal_data TEXT,
      constraints TEXT,
      bridge_type TEXT,
      sync_dirty INTEGER NOT NULL CHECK (sync_dirty IN (0, 1)),
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL,
      CHECK (length(bridge_uid) = 36),
      CHECK (
        substr(bridge_uid, 9, 1) = '-'
        AND substr(bridge_uid, 14, 1) = '-'
        AND substr(bridge_uid, 19, 1) = '-'
        AND substr(bridge_uid, 24, 1) = '-'
      ),
      CHECK (
        bridge_uid GLOB '[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*-[0-9a-fA-F]*'
      )
    )
  `);

  // Create indexes for bridges
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bridges_state
      ON bridges(state);

    CREATE INDEX IF NOT EXISTS idx_bridges_city
      ON bridges(city);

    CREATE INDEX IF NOT EXISTS idx_bridges_source_url
      ON bridges(source_url);

    CREATE INDEX IF NOT EXISTS idx_bridges_coords
      ON bridges(latitude, longitude);

    CREATE INDEX IF NOT EXISTS idx_bridges_sync_dirty
      ON bridges(sync_dirty);
  `);

  // Create fuel_logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS fuel_logs (
      fuel_log_id INTEGER PRIMARY KEY,
      marina_uid TEXT NOT NULL,
      fetched_at_utc TEXT NOT NULL,
      outcome_state TEXT NOT NULL CHECK (outcome_state IN ('has_public_price', 'fuel_available_price_hidden', 'fuel_unknown', 'fetch_blocked')),
      reason_tag TEXT NOT NULL,
      blocked_reason TEXT CHECK (
        blocked_reason IS NULL
        OR blocked_reason IN (
          'access_denied_401',
          'access_denied_403',
          'rate_limited_429',
          'cloudflare_challenge',
          'dns_failure',
          'ssl_failure',
          'timeout'
        )
      ),
      diesel_price REAL,
      gasoline_price REAL,
      fuel_dock INTEGER CHECK (fuel_dock IS NULL OR fuel_dock IN (0, 1)),
      last_updated TEXT,
      source_url TEXT,
      source_text TEXT,
      provenance_json TEXT NOT NULL,
      price_source TEXT NOT NULL CHECK (price_source IN ('dockwa_json', 'marinas_web', 'website_text', 'not_published_online', 'none')),
      confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
      extraction_hash TEXT,
      sync_dirty INTEGER NOT NULL CHECK (sync_dirty IN (0, 1)),
      created_at_utc TEXT NOT NULL,
      FOREIGN KEY (marina_uid) REFERENCES marinas(marina_uid) ON DELETE CASCADE,
      CHECK (json_valid(provenance_json)),
      CHECK (
        outcome_state != 'has_public_price'
        OR diesel_price IS NOT NULL
        OR gasoline_price IS NOT NULL
      ),
      CHECK (
        outcome_state != 'fuel_available_price_hidden'
        OR fuel_dock = 1
      ),
      CHECK (
        outcome_state != 'fetch_blocked'
        OR blocked_reason IS NOT NULL
      )
    )
  `);

  // Create indexes for fuel_logs
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fuel_logs_marina_time
      ON fuel_logs(marina_uid, fetched_at_utc);

    CREATE INDEX IF NOT EXISTS idx_fuel_logs_outcome
      ON fuel_logs(outcome_state, reason_tag);
  `);

  // Create sync_events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_events (
      sync_event_id INTEGER PRIMARY KEY,
      marina_uid TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('marina', 'fuel_log')),
      entity_ref TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (
        event_type IN (
          'new_discovery',
          'rebrand_detected',
          'marked_unverified',
          'dockwa_link_added',
          'fuel_price_changed',
          'fetch_blocked'
        )
      ),
      reason_tag TEXT NOT NULL,
      before_hash TEXT,
      after_hash TEXT,
      sync_dirty_before INTEGER NOT NULL CHECK (sync_dirty_before IN (0, 1)),
      sync_dirty_after INTEGER NOT NULL CHECK (sync_dirty_after IN (0, 1)),
      master_status_code INTEGER,
      master_acknowledged INTEGER NOT NULL CHECK (master_acknowledged IN (0, 1)),
      occurred_at_utc TEXT NOT NULL,
      processed_at_utc TEXT,
      FOREIGN KEY (marina_uid) REFERENCES marinas(marina_uid) ON DELETE CASCADE,
      CHECK (
        master_acknowledged = 0
        OR master_status_code = 200
      )
    )
  `);

  // Create index for sync_events
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sync_events_pending
      ON sync_events(master_acknowledged, occurred_at_utc);
  `);

  // Create pricing_logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_logs (
      pricing_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      marina_uid TEXT NOT NULL,
      fetched_at_utc TEXT NOT NULL,
      monthly_base REAL,
      is_per_ft INTEGER CHECK (is_per_ft IS NULL OR is_per_ft IN (0, 1)),
      catamaran_multiplier REAL,
      liveaboard_fee REAL,
      min_air_draft_ft REAL,
      air_draft_source TEXT,
      min_depth_ft REAL,
      depth_source TEXT,
      lift_max_beam_ft REAL,
      lift_max_tons REAL,
      diy_allowed INTEGER CHECK (diy_allowed IS NULL OR diy_allowed IN (0, 1)),
      electricity_metered INTEGER CHECK (electricity_metered IS NULL OR electricity_metered IN (0, 1)),
      water_metered INTEGER CHECK (water_metered IS NULL OR water_metered IN (0, 1)),
      liveaboard_permitted INTEGER CHECK (liveaboard_permitted IS NULL OR liveaboard_permitted IN (0, 1)),
      source_quotes TEXT,
      extraction_hash TEXT,
      sync_dirty INTEGER NOT NULL CHECK (sync_dirty IN (0, 1)),
      created_at_utc TEXT NOT NULL,
      CHECK (json_valid(source_quotes))
    )
  `);

  // Create indexes for pricing_logs
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pricing_logs_marina_time
      ON pricing_logs(marina_uid, fetched_at_utc);

    CREATE INDEX IF NOT EXISTS idx_pricing_logs_sync_dirty
      ON pricing_logs(sync_dirty);
  `);

  // Create vessel_profiles table
  db.exec(`
    CREATE TABLE IF NOT EXISTS vessel_profiles (
      profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      length_ft REAL NOT NULL,
      beam_ft REAL NOT NULL,
      draft_ft REAL NOT NULL,
      air_draft_ft REAL NOT NULL,
      is_multihull INTEGER NOT NULL CHECK (is_multihull IN (0, 1)),
      needs_haulout INTEGER NOT NULL CHECK (needs_haulout IN (0, 1)),
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    )
  `);

  // Create index for vessel_profiles
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vessel_profiles_name
      ON vessel_profiles(name);
  `);

  return db;
}

/**
 * Upsert marina data
 */
export function upsertMarina(db, marinaData) {
  const {
    marina_uid,
    primary_name,
    lat,
    lon,
    website_url,
    marinas_url,
    dockwa_url,
    source_marinas_id,
    dockwa_destination_id,
    aliases_json,
    verification_state = "unverified",
    missing_from_web_count = 0,
    fuel_candidate = 0,
    seed_reason,
    last_seen_on_web_utc,
    features_last_checked_at_utc,
    last_fuel_checked_at_utc,
    sync_dirty = 1,
    created_at_utc,
    updated_at_utc,
  } = marinaData;

  const now = created_at_utc || new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO marinas (
      marina_uid, primary_name, lat, lon, website_url, marinas_url, dockwa_url,
      source_marinas_id, dockwa_destination_id, aliases_json, verification_state,
      missing_from_web_count, fuel_candidate, seed_reason, last_seen_on_web_utc,
      features_last_checked_at_utc, last_fuel_checked_at_utc, sync_dirty,
      created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(marina_uid) DO UPDATE SET
      primary_name = excluded.primary_name,
      lat = excluded.lat,
      lon = excluded.lon,
      website_url = excluded.website_url,
      marinas_url = excluded.marinas_url,
      dockwa_url = excluded.dockwa_url,
      source_marinas_id = excluded.source_marinas_id,
      dockwa_destination_id = excluded.dockwa_destination_id,
      aliases_json = excluded.aliases_json,
      verification_state = excluded.verification_state,
      missing_from_web_count = excluded.missing_from_web_count,
      fuel_candidate = excluded.fuel_candidate,
      seed_reason = excluded.seed_reason,
      last_seen_on_web_utc = excluded.last_seen_on_web_utc,
      features_last_checked_at_utc = excluded.features_last_checked_at_utc,
      last_fuel_checked_at_utc = excluded.last_fuel_checked_at_utc,
      sync_dirty = excluded.sync_dirty,
      updated_at_utc = excluded.updated_at_utc
  `);

  const result = stmt.run(
    marina_uid,
    primary_name,
    lat,
    lon,
    website_url,
    marinas_url,
    dockwa_url,
    source_marinas_id,
    dockwa_destination_id,
    aliases_json || "[]",
    verification_state,
    missing_from_web_count,
    fuel_candidate,
    seed_reason,
    last_seen_on_web_utc,
    features_last_checked_at_utc,
    last_fuel_checked_at_utc,
    sync_dirty,
    now,
    updated_at_utc || now
  );

  return { success: true, changes: result.changes };
}

/**
 * Submit fuel log entry
 */
export function submitFuelLog(db, fuelLogData) {
  const {
    marina_uid,
    fetched_at_utc,
    outcome_state,
    reason_tag,
    blocked_reason,
    diesel_price,
    gasoline_price,
    fuel_dock,
    last_updated,
    source_url,
    source_text,
    provenance_json,
    price_source,
    confidence,
    extraction_hash,
    created_at_utc,
  } = fuelLogData;

  const now = created_at_utc || new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO fuel_logs (
      marina_uid, fetched_at_utc, outcome_state, reason_tag, blocked_reason,
      diesel_price, gasoline_price, fuel_dock, last_updated, source_url,
      source_text, provenance_json, price_source, confidence, extraction_hash,
      created_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    marina_uid,
    fetched_at_utc || now,
    outcome_state,
    reason_tag,
    blocked_reason,
    diesel_price,
    gasoline_price,
    fuel_dock,
    last_updated,
    source_url,
    source_text,
    provenance_json || "{}",
    price_source,
    confidence,
    extraction_hash,
    now
  );

  return { success: true, fuel_log_id: result.lastInsertRowid };
}

/**
 * Find marinas nearby a location
 */
export function findNearbyMarinas(db, lat, lon, radiusMiles = 10, limit = 50) {
  // Simple bounding box query (for production, use proper geospatial query)
  const latDelta = radiusMiles / 69.0;
  const lonDelta = radiusMiles / (69.0 * Math.cos(lat * Math.PI / 180));

  const stmt = db.prepare(`
    SELECT * FROM marinas
    WHERE lat BETWEEN ? AND ?
      AND lon BETWEEN ? AND ?
    ORDER BY fuel_candidate DESC, primary_name ASC
    LIMIT ?
  `);

  const marinas = stmt.all(
    lat - latDelta,
    lat + latDelta,
    lon - lonDelta,
    lon + lonDelta,
    limit
  );

  return { success: true, marinas };
}

/**
 * Get pending sync events
 */
export function getPendingSyncEvents(db, limit = 100) {
  const stmt = db.prepare(`
    SELECT * FROM sync_events
    WHERE master_acknowledged = 0
    ORDER BY occurred_at_utc ASC
    LIMIT ?
  `);

  const events = stmt.all(limit);

  return { success: true, events };
}

/**
 * Acknowledge sync events
 */
export function acknowledgeSyncEvents(db, eventIds) {
  const stmt = db.prepare(`
    UPDATE sync_events
    SET master_acknowledged = 1,
        master_status_code = 200,
        processed_at_utc = ?
    WHERE sync_event_id = ?
  `);

  const now = new Date().toISOString();
  let acknowledged = 0;

  for (const eventId of eventIds) {
    const result = stmt.run(now, eventId);
    acknowledged += result.changes;
  }

  return { success: true, acknowledged };
}

/**
 * Submit pricing log entry
 */
export function submitPricingLog(db, pricingLogData) {
  const {
    marina_uid,
    fetched_at_utc,
    monthly_base,
    is_per_ft,
    catamaran_multiplier,
    liveaboard_fee,
    min_air_draft_ft,
    air_draft_source,
    min_depth_ft,
    depth_source,
    lift_max_beam_ft,
    lift_max_tons,
    diy_allowed,
    electricity_metered,
    water_metered,
    liveaboard_permitted,
    source_quotes,
    extraction_hash,
    created_at_utc,
  } = pricingLogData;

  const now = created_at_utc || new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO pricing_logs (
      marina_uid, fetched_at_utc, monthly_base, is_per_ft, catamaran_multiplier,
      liveaboard_fee, min_air_draft_ft, air_draft_source, min_depth_ft, depth_source,
      lift_max_beam_ft, lift_max_tons, diy_allowed, electricity_metered, water_metered,
      liveaboard_permitted, source_quotes, extraction_hash, sync_dirty, created_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  const result = stmt.run(
    marina_uid,
    fetched_at_utc || now,
    monthly_base,
    is_per_ft,
    catamaran_multiplier,
    liveaboard_fee,
    min_air_draft_ft,
    air_draft_source,
    min_depth_ft,
    depth_source,
    lift_max_beam_ft,
    lift_max_tons,
    diy_allowed,
    electricity_metered,
    water_metered,
    liveaboard_permitted,
    source_quotes ? JSON.stringify(source_quotes) : null,
    extraction_hash,
    now
  );

  return { success: true, pricing_log_id: result.lastInsertRowid };
}

/**
 * Get pricing logs for a marina
 */
export function getPricingLogs(db, marina_uid, limit = 10) {
  const stmt = db.prepare(`
    SELECT * FROM pricing_logs
    WHERE marina_uid = ?
    ORDER BY fetched_at_utc DESC
    LIMIT ?
  `);

  const logs = stmt.all(marina_uid, limit);

  // Parse source_quotes JSON
  return {
    success: true,
    logs: logs.map(log => ({
      ...log,
      source_quotes: log.source_quotes ? JSON.parse(log.source_quotes) : [],
    })),
  };
}

/**
 * Create vessel profile
 */
export function createVesselProfile(db, profileData) {
  const {
    name,
    length_ft,
    beam_ft,
    draft_ft,
    air_draft_ft,
    is_multihull = 0,
    needs_haulout = 0,
    created_at_utc,
  } = profileData;

  const now = created_at_utc || new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO vessel_profiles (
      name, length_ft, beam_ft, draft_ft, air_draft_ft, is_multihull,
      needs_haulout, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    name,
    length_ft,
    beam_ft,
    draft_ft,
    air_draft_ft,
    is_multihull,
    needs_haulout,
    now,
    now
  );

  return { success: true, profile_id: result.lastInsertRowid };
}

/**
 * Get vessel profiles
 */
export function getVesselProfiles(db) {
  const stmt = db.prepare(`
    SELECT * FROM vessel_profiles
    ORDER BY name ASC
  `);

  const profiles = stmt.all();

  return { success: true, profiles };
}

/**
 * Update vessel profile
 */
export function updateVesselProfile(db, profile_id, profileData) {
  const {
    name,
    length_ft,
    beam_ft,
    draft_ft,
    air_draft_ft,
    is_multihull,
    needs_haulout,
  } = profileData;

  const stmt = db.prepare(`
    UPDATE vessel_profiles
    SET name = ?, length_ft = ?, beam_ft = ?, draft_ft = ?, air_draft_ft = ?,
        is_multihull = ?, needs_haulout = ?, updated_at_utc = ?
    WHERE profile_id = ?
  `);

  const now = new Date().toISOString();
  const result = stmt.run(
    name,
    length_ft,
    beam_ft,
    draft_ft,
    air_draft_ft,
    is_multihull,
    needs_haulout,
    now,
    profile_id
  );

  return { success: true, changes: result.changes };
}

/**
 * Delete vessel profile
 */
export function deleteVesselProfile(db, profile_id) {
  const stmt = db.prepare(`
    DELETE FROM vessel_profiles
    WHERE profile_id = ?
  `);

  const result = stmt.run(profile_id);

  return { success: true, changes: result.changes };
}

/**
 * Register master data routes on Express app
 */
export function registerMasterDataRoutes(app, options = {}) {
  const dbPath = options.dbPath || process.env.MASTER_DB_PATH;
  const requireBoatSignature = options.requireBoatSignature;

  if (!dbPath) {
    console.warn("[MasterData] No dbPath provided, master data routes disabled");
    return;
  }

  if (!requireBoatSignature) {
    console.warn("[MasterData] No requireBoatSignature function provided, write endpoints disabled");
  }

  // Initialize database
  const db = initializeDatabase(dbPath);
  console.log(`[MasterData] Database initialized at ${dbPath}`);

  /**
   * POST /api/master/marinas
   * Upsert marina data (requires boat signature)
   */
  app.post("/api/master/marinas", async (req, res) => {
    if (!requireBoatSignature) {
      return res.status(503).json({ success: false, error: "Authentication not configured" });
    }

    try {
      const auth = await requireBoatSignature(req, res);
      if (!auth) return;

      const result = upsertMarina(db, req.body);
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Marina upsert failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/master/fuel-logs
   * Submit fuel log entry (requires boat signature)
   */
  app.post("/api/master/fuel-logs", async (req, res) => {
    if (!requireBoatSignature) {
      return res.status(503).json({ success: false, error: "Authentication not configured" });
    }

    try {
      const auth = await requireBoatSignature(req, res);
      if (!auth) return;

      const result = submitFuelLog(db, req.body);
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Fuel log submission failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/master/nearby
   * Find marinas nearby a location
   * Query: lat, lon, radiusMiles (default 10), limit (default 50)
   */
  app.get("/api/master/nearby", (req, res) => {
    try {
      const { lat, lon, radiusMiles, limit } = req.query;

      if (!lat || !lon) {
        return res.status(400).json({ error: "lat and lon are required" });
      }

      const result = findNearbyMarinas(
        db,
        parseFloat(lat),
        parseFloat(lon),
        radiusMiles ? parseFloat(radiusMiles) : 10,
        limit ? parseInt(limit) : 50
      );
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Nearby search failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/master/sync-events
   * Get pending sync events
   * Query: limit (default 100)
   */
  app.get("/api/master/sync-events", (req, res) => {
    try {
      const { limit } = req.query;
      const result = getPendingSyncEvents(db, limit ? parseInt(limit) : 100);
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Sync events query failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/master/sync-events/acknowledge
   * Acknowledge sync events (requires boat signature)
   */
  app.post("/api/master/sync-events/acknowledge", async (req, res) => {
    if (!requireBoatSignature) {
      return res.status(503).json({ success: false, error: "Authentication not configured" });
    }

    try {
      const auth = await requireBoatSignature(req, res);
      if (!auth) return;

      const { eventIds } = req.body;
      if (!Array.isArray(eventIds)) {
        return res.status(400).json({ error: "eventIds must be an array" });
      }

      const result = acknowledgeSyncEvents(db, eventIds);
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Sync event acknowledgement failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/master/pricing-logs
   * Submit pricing log entry (requires boat signature)
   */
  app.post("/api/master/pricing-logs", async (req, res) => {
    if (!requireBoatSignature) {
      return res.status(503).json({ success: false, error: "Authentication not configured" });
    }

    try {
      const auth = await requireBoatSignature(req, res);
      if (!auth) return;

      const result = submitPricingLog(db, req.body);
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Pricing log submission failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/master/pricing-logs
   * Get pricing logs for a marina
   * Query: marina_uid, limit (default 10)
   */
  app.get("/api/master/pricing-logs", (req, res) => {
    try {
      const { marina_uid, limit } = req.query;

      if (!marina_uid) {
        return res.status(400).json({ error: "marina_uid is required" });
      }

      const result = getPricingLogs(db, marina_uid, limit ? parseInt(limit) : 10);
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Pricing logs query failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/master/vessel-profiles
   * Create vessel profile (requires boat signature)
   */
  app.post("/api/master/vessel-profiles", async (req, res) => {
    if (!requireBoatSignature) {
      return res.status(503).json({ success: false, error: "Authentication not configured" });
    }

    try {
      const auth = await requireBoatSignature(req, res);
      if (!auth) return;

      const result = createVesselProfile(db, req.body);
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Vessel profile creation failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * GET /api/master/vessel-profiles
   * Get all vessel profiles
   */
  app.get("/api/master/vessel-profiles", (req, res) => {
    try {
      const result = getVesselProfiles(db);
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Vessel profiles query failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * PUT /api/master/vessel-profiles/:id
   * Update vessel profile (requires boat signature)
   */
  app.put("/api/master/vessel-profiles/:id", async (req, res) => {
    if (!requireBoatSignature) {
      return res.status(503).json({ success: false, error: "Authentication not configured" });
    }

    try {
      const auth = await requireBoatSignature(req, res);
      if (!auth) return;

      const profile_id = parseInt(req.params.id);
      const result = updateVesselProfile(db, profile_id, req.body);
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Vessel profile update failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * DELETE /api/master/vessel-profiles/:id
   * Delete vessel profile (requires boat signature)
   */
  app.delete("/api/master/vessel-profiles/:id", async (req, res) => {
    if (!requireBoatSignature) {
      return res.status(503).json({ success: false, error: "Authentication not configured" });
    }

    try {
      const auth = await requireBoatSignature(req, res);
      if (!auth) return;

      const profile_id = parseInt(req.params.id);
      const result = deleteVesselProfile(db, profile_id);
      res.json(result);
    } catch (error) {
      console.error("[MasterData] Vessel profile deletion failed:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log("[MasterData] Routes registered:");
  console.log("  POST /api/master/marinas");
  console.log("  POST /api/master/fuel-logs");
  console.log("  GET  /api/master/nearby");
  console.log("  GET  /api/master/sync-events");
  console.log("  POST /api/master/sync-events/acknowledge");
  console.log("  POST /api/master/pricing-logs");
  console.log("  GET  /api/master/pricing-logs");
  console.log("  POST /api/master/vessel-profiles");
  console.log("  GET  /api/master/vessel-profiles");
  console.log("  PUT  /api/master/vessel-profiles/:id");
  console.log("  DELETE /api/master/vessel-profiles/:id");
}
