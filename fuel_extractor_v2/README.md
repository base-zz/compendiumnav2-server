# Fuel Extractor v2

This service owns deterministic fuel extraction and fuel outcome logging.

## Ownership
- Read `fuel_seed_queue`
- Write `fuel_logs`
- Write `sync_events` related to fuel refresh
- Never mutate marina identity fields in `marinas`

## Contract boundary
- Input: seed rows from `marina_management`
- Output: canonical fuel outcomes keyed by `marina_uid`

## Modules
- `app/contracts.py`: strict seed input and extractor output validation
- `app/seed_consumer.py`: fetch and status-update queue rows
- `app/sync_event_writer.py`: audit logging for sync events
- `app/fuel_worker.py`: main extraction worker with Dockwa-first logic
- `run_fuel_worker_once.py`: CLI orchestrator for extraction

## HTTP API (via Node.js)
The fuel pipeline is exposed via HTTP endpoints when `MARINA_DB_PATH` is set:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fuel/extract` | POST | Process pending fuel seeds |
| `/api/fuel/pipeline` | POST | Full pipeline (discovery + extraction) |
| `/api/fuel/status` | GET | Check pending seeds, recent logs, sync events |

### Example
```bash
# Process all pending seeds
curl -X POST http://localhost:3000/api/fuel/extract

# Check pipeline status
curl http://localhost:3000/api/fuel/status
```
