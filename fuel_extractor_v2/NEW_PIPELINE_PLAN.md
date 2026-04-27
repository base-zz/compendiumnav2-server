# Nexus Marina Management + Fuel Extractor v2 - Strategy Plan

## 0) Why this reset exists
We are resetting because the current flow has too many branches and unclear ownership of responsibilities. This plan defines one deterministic operating model so we stop thrashing and can evaluate progress with clear pass/fail criteria.

This strategy is explicitly split into two services:
1. `marina_management` (identity, discovery, features, source links)
2. `fuel_extractor` (fuel refresh, outcomes, provenance, sync events)

## 1) Hard rules (non-negotiable)
1. No guessed prices.
2. Numeric fuel prices only come from deterministic sources.
3. Every output must include a machine-readable reason state.
4. Every field must have provenance (`source`, `seen_at`).
5. Discovery truth and vessel suitability are separate concerns.
6. `fuel_extractor` never mutates marina identity state.

## 2) Canonical run outcomes
Each marina run must end in exactly one state:
1. `has_public_price`
2. `fuel_available_price_hidden`
3. `fuel_unknown`
4. `fetch_blocked`

Reason tags (examples):
- `price_not_published_publicly`
- `no_dockwa_link`
- `dockwa_blocked`
- `marina_site_blocked`
- `fuel_not_detected`
- `schema_validation_failed`

Blocked reason taxonomy (required for `fetch_blocked`):
- `access_denied_401`
- `access_denied_403`
- `rate_limited_429`
- `cloudflare_challenge`
- `dns_failure`
- `ssl_failure`
- `timeout`

## 2.1) System boundaries (ownership)

### Marina Management owns
- Discovery and reconciliation (`new`, `match`, `rebrand`, `missing`) 
- Identity and lifecycle (`marina_uid`, aliases, verification state)
- Source-link inventory (`marinas_url`, `dockwa_url`, website_url)
- Feature hydration and normalization (amenities/specs)

### Fuel Extractor owns
- Fuel refresh jobs for eligible marinas
- Deterministic price extraction (Dockwa first)
- Fuel evidence outcomes and reason tags
- Fuel provenance and price-change logs

### Shared contract boundary
- Marina Management publishes the seed set.
- Fuel Extractor only processes rows that satisfy the seed eligibility contract.
- Fuel Extractor never mutates marina identity fields.

## 2.2) Seed contract (Marina Management -> Fuel Extractor)

Required fields per seed row:
- `marina_uid` (immutable internal id)
- `name`
- `lat`
- `lon`
- `website_url` (nullable but explicit)
- `marinas_url` (nullable but explicit)
- `dockwa_url` (nullable but explicit)
- `fuel_candidate` (0/1)
- `seed_reason` (e.g., `known_dockwa`, `fuel_amenity_yes`, `stale_fuel`)
- `seeded_at_utc`

Optional fields:
- `source_marinas_id`
- `dockwa_destination_id`
- `last_fuel_checked_at_utc`
- `priority_hint`

Seed eligibility rules:
1. `marina_uid` must exist.
2. At least one source URL field must be present (`dockwa_url`, `marinas_url`, or `website_url`).
3. `fuel_candidate` must be explicitly set (no implicit defaults).

Extractor output contract back to Marina Management:
- `marina_uid`
- `outcome_state`
- `reason_tag`
- `diesel_price`
- `gasoline_price`
- `fuel_dock`
- `last_updated`
- `source_url`
- `source_text`
- `provenance`
- `fetched_at_utc`

## 3) Pipeline modes

### 3.1 Discovery Mode (Where is it?)
Goal: existence + identity reconciliation only.

Steps:
1. Pull local marinas in radius from SpatiaLite (default: 10 miles).
2. Sweep Marinas.com in same area (bounding box query).
3. Reconcile with confidence score:
   - distance score
   - normalized name similarity
   - website host similarity
4. Apply outcomes:
   - Match + same identity -> update `last_seen_on_web`
   - Match + probable rebrand -> update primary name, append alias, queue review
   - No local match -> create skeleton marina
   - No web match -> increment `missing_from_web_count`
5. Mark `unverified` only after misses across separate runs (not one burst).

Guardrails:
- Never auto-merge solely by coordinates in dense marina zones.
- Domain similarity is a strong signal, not a final decision by itself.

### 3.2 Feature Mode (What is it?)
Goal: hydrate slower-changing metadata.

Target set:
- New skeleton marinas
- Marinas with stale features (default: 30 days)
- Rows with prior parse failures

Steps:
1. Scrape Marinas.com detail page.
2. Extract amenities and specs (LOA, beam, depth, slips if present).
3. Normalize data:
   - meters -> feet
   - yes/no -> boolean
4. Parse status per field:
   - `parsed`, `inferred`, `unknown`
5. Attempt Dockwa bridge discovery.

Rules:
- If LOA is 0 or missing, only infer from slip-length when explicit evidence exists.
- No silent fallbacks; record parse status.

### 3.3 Fuel Mode (What does it cost?)
Goal: frequent refresh of volatile fuel data.

Target set:
- Marinas with known Dockwa destination link/id
- Newly bridged marinas

Primary path:
1. Dockwa deterministic payload parse.
2. Validate schema and units.
3. Compare against last value.
4. If changed, mark row dirty for sync.

Fallback path:
- If no Dockwa path, attempt explicit web evidence for fuel availability only (not guessed prices).

Anti-clog policy:
- If `fuel_dock=true` but no online price for 3 consecutive attempts, set:
  - `price_source=not_published_online`
  - `reason_tag=price_not_published_publicly`
  - cooldown before retry (default: 14-30 days)

## 4) Queue priority and cadence
1. Fuel Mode (highest priority, frequent: 12-24h)
2. Discovery Mode (medium: movement trigger, e.g. every 10 miles)
3. Feature Mode (low: background on new/stale rows)

Resource controls:
- domain-level rate limits
- exponential backoff by error class
- max concurrency cap (Pi-safe)

## 5) Identity model
Use immutable `marina_uid` internally.
Mutable fields (`name`, urls, aliases) can change without replacing identity.

Phase-1 identity constraints:
- `marina_uid` must be UUIDv4.
- `marina_uid` is never derived from coordinates.
- `marina_uid` is never reused or reassigned.

Required identity fields:
- `marina_uid` (internal primary key)
- `source_marinas_id` (nullable)
- `dockwa_destination_id` (nullable)
- `aliases` (history list)

## 6) Vessel constraints (clarified)
Vessel constraints are not global. They are profile-based.

Model:
- `vessel_profiles` table
- `vessel_constraints` table keyed by `vessel_profile_id`
- suitability is computed as a separate view/layer

Result:
- Discovery remains objective truth.
- Prioritization and route suitability become vessel-specific.

## 7) Sync + audit model
Dirty rows sync to Master API idempotently.

Sync safety rule:
- `sync_dirty` is cleared only after a per-`marina_uid` success acknowledgement (`200 OK`) from Master API.

Audit event types:
- `new_discovery`
- `rebrand_detected`
- `marked_unverified`
- `dockwa_link_added`
- `fuel_price_changed`
- `fetch_blocked`

Each event stores:
- timestamp
- actor/mode
- before/after payload hash
- reason tag

## 8) Initial seed mode (cold start)
Before movement-triggered discovery starts:
1. Pull baseline corridor/region from Master API.
2. Populate local DB with initial marinas.
3. Run discovery reconciliation against this baseline.

This avoids noisy day-1 false positives.

Duplicate skeleton protection:
- During skeleton creation, run dedupe check against recent candidates in the same run window.
- Require name+distance threshold checks before creating a new skeleton in dense marina regions.
- If confidence is ambiguous, queue for review instead of auto-insert.

## 9) Implementation phases (to avoid flailing)

### Phase 1 - Schema + contracts
Deliverables:
1. `marinas` table v2
2. `fuel_logs` table v2
3. `sync_events` table v2
4. canonical outcome + reason-tag enums

Exit criteria:
- migrations apply cleanly
- enum validation tests pass

### Phase 2 - Deterministic fuel core
Deliverables:
1. Dockwa deterministic fetcher/parser
2. schema validation for payloads
3. price-change detector + dirty-flag logic

Exit criteria:
- known Dockwa marinas return deterministic output
- no numeric prices from LLM

### Phase 3 - Discovery + reconciliation
Deliverables:
1. Marinas.com bbox sweep
2. confidence-based matcher
3. skeleton creation + rebrand queue

Exit criteria:
- reproducible reconciliation on sample regions
- no duplicate inserts on repeated runs

### Phase 4 - Feature hydration
Deliverables:
1. amenities/spec extraction
2. unit normalization + parse status
3. Dockwa bridge capture

Exit criteria:
- parse status coverage for core fields
- deterministic field provenance recorded

### Phase 5 - Scheduler + sync
Deliverables:
1. priority queue runner
2. retry/backoff per error class
3. idempotent sync to Master

Exit criteria:
- stable repeated runs on Pi constraints
- sync event log complete

## 10) Definition of done for v2 baseline
v2 baseline is done when:
1. 10-marina random run produces zero guessed prices.
2. Every marina has one canonical outcome.
3. Every null/blocked result has a reason tag.
4. Field provenance exists for fuel + fuel_dock.
5. Repeat run does not create duplicate marina records.
6. **HTTP API exposes pipeline to external controllers.**
7. **Dockwa-first extraction for marinas with Dockwa links.**
8. **Sync events logged for audit trail.**

## 11) HTTP API Integration
The pipeline is exposed via Node.js Express endpoints when `MARINA_DB_PATH` is configured:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fuel/discover` | POST | Geographic sweep for marinas (parameterized radius/grid) |
| `/api/fuel/extract` | POST | Process pending fuel seeds |
| `/api/fuel/pipeline` | POST | Full flow: discover → reconcile → seed → extract |
| `/api/fuel/status` | GET | Pending seeds, recent logs, sync events |

### Trigger flow from any client:
```bash
# From boat position, sweep 25nm radius with 5nm discovery radius
curl -X POST http://localhost:3000/api/fuel/pipeline \
  -d '{"lat": 37.24, "lon": -76.50, "sweepRadius": 25, "discoveryRadius": 5}'
```

## 12) End-to-end execution sequence
1. Client calls `/api/fuel/pipeline` with position + radius parameters.
2. `marina_management` runs geographic sweep (configurable radius/grid).
3. Discovered marinas reconciled into `marinas` table with sync events.
4. Eligible marinas published to `fuel_seed_queue`.
5. `fuel_extractor` processes seeds (Dockwa-first, then marinas.com).
6. Outcomes written to `fuel_logs` with provenance.
7. Sync events logged for `fuel_price_changed` / `fetch_blocked`.
8. Client polls `/api/fuel/status` for completion.

Operational notes:
- If a marina has no eligible source URL, it is retained in Marina Management and excluded from Fuel Extractor until a new source is discovered.
- Geographic sweep parameters are fully configurable per API call.
- Seeds are read from DB by `fuel_extractor`; no need to pass marina IDs explicitly.
