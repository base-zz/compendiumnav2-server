PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- Owned by marina_management
CREATE TABLE IF NOT EXISTS marinas (
    marina_uid TEXT PRIMARY KEY,
    primary_name TEXT NOT NULL,
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
);

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

-- Published by marina_management, consumed by fuel_extractor
CREATE TABLE IF NOT EXISTS fuel_seed_queue (
    seed_id INTEGER PRIMARY KEY,
    marina_uid TEXT NOT NULL,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    website_url TEXT,
    marinas_url TEXT,
    dockwa_url TEXT,
    fuel_candidate INTEGER NOT NULL CHECK (fuel_candidate IN (0, 1)),
    seed_reason TEXT NOT NULL,
    seeded_at_utc TEXT NOT NULL,
    source_marinas_id TEXT,
    dockwa_destination_id TEXT,
    last_fuel_checked_at_utc TEXT,
    priority_hint TEXT,
    queue_status TEXT NOT NULL CHECK (queue_status IN ('pending', 'processing', 'done', 'failed')),
    FOREIGN KEY (marina_uid) REFERENCES marinas(marina_uid) ON DELETE CASCADE,
    CHECK (
        dockwa_url IS NOT NULL
        OR marinas_url IS NOT NULL
        OR website_url IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_fuel_seed_queue_status
    ON fuel_seed_queue(queue_status, seeded_at_utc);

-- Owned by fuel_extractor
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
);

CREATE INDEX IF NOT EXISTS idx_fuel_logs_marina_time
    ON fuel_logs(marina_uid, fetched_at_utc);

CREATE INDEX IF NOT EXISTS idx_fuel_logs_outcome
    ON fuel_logs(outcome_state, reason_tag);

-- Sync/audit bridge between marina_management and fuel_extractor
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
);

CREATE INDEX IF NOT EXISTS idx_sync_events_pending
    ON sync_events(master_acknowledged, occurred_at_utc);

COMMIT;
