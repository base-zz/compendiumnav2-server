# Seed Contract Examples (v2)

This file provides concrete payload examples for the boundary between Marina Management and Fuel Extractor.

Service ownership:
- Producer: `marina_management`
- Consumer: `fuel_extractor`
- Return path: `fuel_extractor` -> `marina_management`

## 1) Valid seed row (published by marina_management, ready for fuel_extractor)

```json
{
  "marina_uid": "8d3f8b8c-5b17-4f9d-9f7a-1f6f1f7782aa",
  "name": "Port LaBelle Marina",
  "lat": 26.7606,
  "lon": -81.4376,
  "website_url": "https://www.portlabellemarina.com",
  "marinas_url": "https://marinas.com/marinas/d9cj3j-port-labelle-marina",
  "dockwa_url": "https://dockwa.com/explore/destination/d9cj3j-port-labelle-marina",
  "fuel_candidate": 1,
  "seed_reason": "known_dockwa",
  "seeded_at_utc": "2026-04-27T23:51:00Z",
  "source_marinas_id": "d9cj3j",
  "dockwa_destination_id": "d9cj3j",
  "last_fuel_checked_at_utc": "2026-04-26T20:10:00Z",
  "priority_hint": "high"
}
```

Why valid:
- `marina_uid` present
- `fuel_candidate` explicitly set
- at least one source URL provided (here all three are present)

## 2) Invalid seed row (must be rejected by fuel_extractor)

```json
{
  "marina_uid": "a8b1c2d3-e4f5-4789-9abc-112233445566",
  "name": "Example Marina",
  "lat": 25.774,
  "lon": -80.19,
  "website_url": null,
  "marinas_url": null,
  "dockwa_url": null,
  "seed_reason": "stale_fuel",
  "seeded_at_utc": "2026-04-27T23:55:00Z"
}
```

Why invalid:
- no source URL exists (`dockwa_url`, `marinas_url`, `website_url` all null)
- `fuel_candidate` is missing

## 3) Extractor output example (returned to marina_management): has public price

```json
{
  "marina_uid": "8d3f8b8c-5b17-4f9d-9f7a-1f6f1f7782aa",
  "outcome_state": "has_public_price",
  "reason_tag": "dockwa_price_observed",
  "diesel_price": 5.33,
  "gasoline_price": 5.76,
  "fuel_dock": true,
  "last_updated": "03/26/2026 at 5:34PM",
  "source_url": "https://dockwa.com/explore/destination/d9cj3j-port-labelle-marina",
  "source_text": "Premium Gas: $5.76/gal; Diesel: $5.33/gal",
  "provenance": {
    "diesel_price": { "source": "dockwa_json", "seen_at": "2026-04-27T23:58:20Z" },
    "gasoline_price": { "source": "dockwa_json", "seen_at": "2026-04-27T23:58:20Z" },
    "fuel_dock": { "source": "dockwa_json", "seen_at": "2026-04-27T23:58:20Z" }
  },
  "fetched_at_utc": "2026-04-27T23:58:20Z"
}
```

## 4) Extractor output example (returned to marina_management): fuel available, price hidden

```json
{
  "marina_uid": "4f8db13b-238c-45dd-a8bd-aec83e1a9f18",
  "outcome_state": "fuel_available_price_hidden",
  "reason_tag": "price_not_published_publicly",
  "diesel_price": null,
  "gasoline_price": null,
  "fuel_dock": true,
  "last_updated": null,
  "source_url": "https://marinas.com/marinas/example-marina",
  "source_text": "Fuel Dock: Yes",
  "provenance": {
    "fuel_dock": { "source": "marinas_web", "seen_at": "2026-04-27T23:59:42Z" }
  },
  "fetched_at_utc": "2026-04-27T23:59:42Z"
}
```

## 5) Extractor output example (returned to marina_management): fetch blocked

```json
{
  "marina_uid": "7cd47a94-2102-4e6a-b5a6-6e7b11cd5ba0",
  "outcome_state": "fetch_blocked",
  "reason_tag": "marina_site_blocked",
  "diesel_price": null,
  "gasoline_price": null,
  "fuel_dock": null,
  "last_updated": null,
  "source_url": "https://examplemarina.com/fuel",
  "source_text": null,
  "provenance": {},
  "fetched_at_utc": "2026-04-28T00:05:11Z",
  "blocked_reason": "access_denied_403"
}
```
