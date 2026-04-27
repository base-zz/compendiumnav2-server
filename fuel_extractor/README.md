# Nexus Fuel Extractor Sidecar (Python)

This sidecar implements phase-1 of the autonomous fuel extraction engine:

- Discovery of fuel-relevant candidate links from a base marina URL.
- Conversion of selected HTML/PDF content into clean markdown.
- Strict no-guess response shape (all extraction fields remain `null` until explicit evidence extraction is added).

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8097
```

## Endpoints

- `GET /health`
- `POST /v1/fuel/extract`

## Request Example

```json
{
  "job_id": "job-123",
  "fuel_source_id": 1,
  "name": "Example Marina",
  "website_url": "https://example.com",
  "phone": null,
  "lat": 26.1,
  "lon": -80.2,
  "max_discovery_depth": 2,
  "max_pages": 8,
  "prefer_pdfs": true,
  "timeout_seconds": 45,
  "skip_if_verified_within_hours": 24
}
```

## No-Guess Contract

This service intentionally avoids inference and guessing:

- If there is no explicit evidence extraction stage, price fields remain `null`.
- Discovery/conversion success does not imply price extraction success.
- The current response includes `evidence.markdown_excerpt` for downstream verified extraction.
