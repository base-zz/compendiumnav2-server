# Marina Management v2

This service owns marina identity, discovery/reconciliation, and publishing eligible fuel seed rows.

## Ownership
- Write `marinas`
- Write `fuel_seed_queue` rows for `fuel_extractor`
- Write `sync_events` for discovery audit
- Never write `fuel_logs`

## Contract boundary
- Producer: `marina_management`
- Consumer: `fuel_extractor`
- Shared key: `marina_uid`

## Modules
- `app/discovery_runner.py`: normalize and run discovery queries
- `app/reconcile_runner.py`: reconcile discovered records with existing marinas
- `app/seed_publish_runner.py`: publish eligible seeds to queue
- `app/geographic_orchestrator.py`: configurable grid-based geographic sweep
- `run_discover_reconcile_seed.py`: CLI orchestrator
- `run_geographic_sweep.py`: CLI for parameterized geographic sweeps

## HTTP API (via Node.js)
The discovery pipeline is exposed via HTTP endpoints when `MARINA_DB_PATH` is set:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fuel/discover` | POST | Geographic sweep for marinas |
| `/api/fuel/pipeline` | POST | Full pipeline (discovery + extraction) |
| `/api/fuel/status` | GET | Check pending seeds, recent logs, sync events |

### Parameters
All discovery endpoints accept:
- `lat` (number, required): Center latitude
- `lon` (number, required): Center longitude
- `sweepRadius` (number, optional): Total sweep radius in miles (default: 50)
- `discoveryRadius` (number, optional): Discovery radius per point in miles (default: 5)
- `gridSpacing` (number, optional): Grid spacing in miles (default: 10)

### Example
```bash
# Discover marinas around a position
curl -X POST http://localhost:3000/api/fuel/discover \
  -H "Content-Type: application/json" \
  -d '{"lat": 37.2425, "lon": -76.5069, "sweepRadius": 25, "discoveryRadius": 5, "gridSpacing": 10}'

# Full pipeline: discover + extract
curl -X POST http://localhost:3000/api/fuel/pipeline \
  -d '{"lat": 37.2425, "lon": -76.5069}'
```
