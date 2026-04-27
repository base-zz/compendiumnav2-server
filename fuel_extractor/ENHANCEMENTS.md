# Fuel Extractor — Enhancements & Future Work

## URL Update Flow for Redirects/403s

### Problem
During extraction, some marina URLs return 403 Forbidden or redirect to new domains (e.g. `keylargomarina.com` → `oceanbreezeinns.com`). The local database becomes stale if these URLs are not updated.

### Proposed Flow
1. **Detect redirect/403** during HTTP fetch  
   - Capture final redirect URL and status code when response != 200

2. **Create update payload**  
   ```json
   {
     "original_url": "https://www.keylargomarina.com/",
     "resolved_url": "https://www.oceanbreezeinns.com/marina-del-mar/marina",
     "status_code": 403,
     "source": "fuel_extractor"
   }
   ```

3. **POST to cloud API** (new endpoint)  
   - Cloud validates and updates master lookup database
   - Optionally runs its own scrape to confirm marina identity

4. **Local fallback (optional)**  
   - If cloud update fails, record locally for retry

### Implementation Notes
- Add helper in `markdown_convert.py` or a new `url_tracker.py` to detect and package redirects/403s
- Add stub cloud client for POSTing updates
- Keep master database current without manual edits
- Support crowdsourced corrections from multiple clients

---

## Ollama LLM Extraction (Planned)

- Integrate local Ollama client for structured fuel data extraction
- Strict JSON schema with source quote requirement
- Enforce "no guesses" — return null if evidence is ambiguous

---

## Node.js FuelService Orchestration (Planned)

- Wrap the Python sidecar via HTTP calls
- Manage job queue, retry logic, and local DB updates
- Emit JSON patches for downstream consumers

---

## Cloud Sync (Planned)

- On successful extraction (confidence > threshold), POST to cloud API
- Include source URL, extracted fields, evidence excerpt, and confidence
- Handle rate limiting and retry backoff

---

## Discovery Improvements

- Better handling of JavaScript-rendered pages (optional Playwright mode)
- PDF prioritization when fuel rates are commonly in PDFs
- Adaptive depth based on site structure

---

## Data Quality Monitoring

- Flag entries where `source_text` date is older than 30 days for manual review
- Periodic re-verification scheduling
- Human-in-the-loop UI flags for low-confidence or ambiguous extractions
