# Anchor Position Smoothing

This document explains the current server-side position flow and the anchor-position smoothing process used to reduce GPS jitter while still allowing real vessel movement to appear in anchor state and breadcrumbs.

## Goals

- Reduce visual GPS jitter while stationary at anchor.
- Keep raw SignalK position data available and unsmoothed.
- Prevent the filtered anchor boat position from freezing when the boat genuinely moves.
- Prevent breadcrumb history from filling with repeated identical points.
- Preserve the existing client-facing state schema.

## State Fields Involved

The current implementation uses the existing state fields below.

- `navigation.position`
  - Raw canonical navigation position from SignalK.
  - This is not aggressively smoothed.

- `position.signalk`
  - Source-specific position written by `PositionService`.
  - Used as a fallback if `navigation.position` is unavailable.

- `position.stability`
  - GPS scatter/stability diagnostics computed by `PositionService`.
  - Used to inform the anchor filter deadband.

- `anchor.filteredBoatPosition`
  - Smoothed boat position used by anchor-derived state.
  - This is where anchor display smoothing happens.

- `anchor.history`
  - Breadcrumb history for the anchor app.
  - Entries use the filtered boat position, but are now gated by time and movement distance.

- `anchor.anchorLocation`
  - Anchor position and distance/bearing calculations derived by the anchor helper.

No new client-facing fields are required by the current implementation.

## High-Level Position Flow

```text
SignalK navigation.position
  -> NewStateService
  -> stateData.navigation.position
  -> StateManager patches
  -> PositionService diagnostics
  -> anchorStateHelpers recomputeAnchorDerivedState
  -> anchor.filteredBoatPosition
  -> anchor distance/bearing/fence/history derived state
  -> client state patches
```

## SignalK Ingestion

SignalK provides position through:

```text
navigation.position
```

`NewStateService` maps that into canonical state as:

```text
navigation.position.latitude.value
navigation.position.longitude.value
navigation.position.timestamp
```

The canonical mapping creates this structure:

```js
{
  latitude: { value: latitude, units: "deg" },
  longitude: { value: longitude, units: "deg" },
  timestamp: currentIsoTimestamp
}
```

`NewStateService` does not smooth valid GPS coordinates. It performs these protections only:

- batches updates before applying them to state
- debounces invalid/null positions
- logs large raw jumps over the diagnostic threshold
- emits patches and periodic full-state updates

Invalid/null positions are debounced so a transient bad GPS sample does not immediately erase the last-known-good position. After several consecutive invalid updates, the null position can be accepted.

## PositionService Diagnostics

When `NewStateService` processes a valid `navigation.position`, it emits a `position:update` event.

`PositionService` listens for this event and writes source-specific position data under:

```text
position.signalk
```

It also calculates jitter/scatter diagnostics under:

```text
position.stability
```

The important stability fields are:

- `radius95Meters`
  - Approximate 95% scatter radius from the running center.

- `filteredRadius95Meters`
  - Approximate 95% scatter radius after removing likely outlier samples.

- `meanRadiusMeters`
  - Mean distance from the running center.

- `stdRadiusMeters`
  - Standard deviation of scatter from the running center.

- `windowSize`
  - Number of samples in the current diagnostic window.

- `teleportThresholdMeters`
  - Diagnostic jump threshold derived from high-percentile step movement.

- `teleportCount`
  - Number of samples excluded by the diagnostic threshold.

`PositionService` does not directly create the anchor filtered position. It provides diagnostics that the anchor helper can use.

## StateManager Anchor Recalculation

`StateManager.applyPatchAndForward()` applies incoming patches to `appState`.

After applying relevant patches, it calls:

```js
_runStateHelpers(patchOps)
```

The anchor helper runs when patches affect any of these areas:

```text
/anchor
/position
/navigation
/aisTargets
```

The helper function is:

```js
recomputeAnchorDerivedState(appState, options)
```

This function lives in:

```text
src/relay/core/state/anchorStateHelpers.js
```

## Anchor Position Input Selection

The anchor helper first reads the raw boat position from:

```text
appState.navigation.position.latitude.value
appState.navigation.position.longitude.value
```

If that is not available, it falls back to source-specific position state:

```text
appState.position.signalk
```

The selected raw position is then compared against the previous filtered boat position:

```text
anchor.filteredBoatPosition.position.latitude.value
anchor.filteredBoatPosition.position.longitude.value
```

## Current Filter Parameters

The current tuned filter parameters are:

```text
DEFAULT_DEADBAND_METERS = 3
STATIONARY_DEADBAND_FLOOR_METERS = 6
MAX_DEADBAND_METERS = 12
ACCURACY_DEADBAND_MULTIPLIER = 0.75
DEFAULT_FILTER_ALPHA = 0.35
STATIONARY_FILTER_ALPHA = 0.25
UNDERWAY_FILTER_ALPHA = 0.6
STATIONARY_SOG_THRESHOLD_KNOTS = 0.2
UNDERWAY_SOG_THRESHOLD_KNOTS = 2
MOVEMENT_PERSIST_MS = 5000
JUMP_REJECTION_METERS = 40
```

## Deadband Calculation

The deadband determines how much movement is ignored as GPS jitter.

If `position.stability.filteredRadius95Meters` is available, it is preferred. If not, the filter falls back to `position.stability.radius95Meters`.

The deadband calculation is:

```text
deadband = max(DEFAULT_DEADBAND_METERS, accuracyMeters * ACCURACY_DEADBAND_MULTIPLIER)
deadband = min(deadband, MAX_DEADBAND_METERS)
```

This means the deadband can expand when GPS scatter is high, but it cannot grow beyond `12m`.

This cap is important because rejected or quarantined GPS jumps must not inflate the deadband enough to freeze real movement.

## Speed-Based Filter Behavior

The filter uses speed over ground to choose how responsive smoothing should be.

If SOG is below `0.2 knots`, the boat is treated as stationary:

```text
deadband floor = 6m
alpha = 0.25
```

If SOG is above `2 knots`, the boat is treated as underway:

```text
alpha = 0.6
```

Otherwise, the default alpha is used:

```text
alpha = 0.35
```

Alpha controls how far the filtered position moves toward the raw position when movement is accepted:

```text
filtered = previousFiltered + ((raw - previousFiltered) * alpha)
```

Higher alpha follows raw movement more quickly. Lower alpha is smoother but lags more.

## Normal Movement Handling

For every valid raw position update, the helper calculates:

```text
delta = distance(previousFilteredPosition, rawPosition)
```

Then it applies this logic:

1. If there is no previous filtered position, initialize filtered position from raw position.
2. If `delta` is inside the deadband, hold the previous filtered position.
3. If `delta` is outside the deadband but within the jump threshold, apply alpha smoothing after movement persistence allows it.
4. If `delta` is larger than the jump threshold, dampen toward the raw point instead of freezing forever.

## Large Jump Handling

The previous behavior rejected jumps over `40m` by holding the previous filtered position forever.

That could cause filter lock:

```text
filtered position becomes stale
real movement accumulates
raw position becomes more than 40m from stale filtered point
filter treats real movement as a jump
filtered position remains frozen
```

The current behavior no longer hard-freezes these jumps. If the raw point is more than `40m` from the filtered point, the filter moves partially toward it using stationary alpha:

```text
filtered = previousFiltered + ((raw - previousFiltered) * STATIONARY_FILTER_ALPHA)
```

This still dampens suspicious movement but avoids permanent lock.

## Movement Persistence

The filter still includes a movement persistence gate:

```text
MOVEMENT_PERSIST_MS = 5000
```

For non-jump movement outside the deadband, the helper checks whether enough time has elapsed before applying alpha smoothing.

This is intended to avoid accepting short-lived jitter spikes immediately.

A future improvement would store explicit movement candidates with `firstSeenAt` and `lastSeenAt`, but the current implementation keeps the existing state shape unchanged.

## Filtered Position Output

The output is written to:

```text
anchor.filteredBoatPosition
```

The shape remains:

```js
{
  position: {
    latitude: {
      value: filteredLatitude,
      units: "deg"
    },
    longitude: {
      value: filteredLongitude,
      units: "deg"
    }
  },
  time: filteredPositionTime
}
```

The helper emits a granular patch at:

```text
/anchor/filteredBoatPosition
```

when the filtered position changes.

## Anchor Derived State

The filtered boat position is used to recompute anchor-derived values, including:

- distance from anchor
- bearing to anchor
- distance from drop point
- inferred anchor movement
- fence distances
- AIS proximity status
- breadcrumb history

## Breadcrumb Creation

Breadcrumbs are stored in:

```text
anchor.history
```

Each entry has this shape:

```js
{
  position: {
    latitude: filteredLatitude,
    longitude: filteredLongitude
  },
  time: timestampMs
}
```

Breadcrumb creation now requires both conditions:

```text
at least 30 seconds since the last breadcrumb
at least 3 meters from the last breadcrumb
```

The parameters are:

```text
MIN_BREADCRUMB_INTERVAL_MS = 30000
MIN_BREADCRUMB_DISTANCE_METERS = 3
```

This prevents the system from appending repeated breadcrumbs at the same point when the filtered position has not meaningfully moved.

The maximum history remains:

```text
MAX_HISTORY_ENTRIES = 1000
```

At 30-second intervals, this stores about 8.33 hours of breadcrumbs.

## Client Compatibility

The current implementation does not require client changes.

The same state paths are used:

```text
navigation.position
position.signalk
position.stability
anchor.filteredBoatPosition
anchor.history
anchor.anchorLocation
```

The client will observe changed behavior, not changed schema:

- `anchor.filteredBoatPosition` should move more responsively.
- `anchor.history` should no longer accumulate repeated identical points.
- anchor distance and bearing values should better track slow real movement.
- suspicious jumps should be dampened instead of permanently freezing the anchor display position.

## Current Limitations

The current implementation is intentionally minimal and preserves the state schema.

Known limitations:

- Jump quarantine is not yet a shared position-filter concept.
- `PositionService` stability calculations are independent from anchor filtering.
- Movement persistence is based on existing filtered-position timing rather than an explicit candidate object.
- Safety calculations and display smoothing still share the same filtered anchor boat position in several anchor-derived calculations.

## Preferred Future Improvements

A more complete implementation would add an internal filter model that classifies samples as:

```text
accepted
candidate
quarantined
```

Quarantined samples should not feed `filteredRadius95Meters`, because that would artificially inflate the deadband.

A future filter state could include:

```js
{
  status: "holding" | "tracking" | "candidate" | "quarantined",
  deadbandMeters,
  alpha,
  deltaFromFilteredMeters,
  candidate: {
    latitude,
    longitude,
    firstSeenAt,
    lastSeenAt,
    distanceFromFilteredMeters
  },
  lastDecision: {
    reason,
    timestamp
  }
}
```

That future state should be additive and optional for the client.

The long-term preferred model is to separate:

- raw GPS position
- display-filtered position
- breadcrumb position
- safety/alert evaluation position

This would let the UI remain stable while safety logic remains responsive to sustained real movement.

## Testing Guidance

After deploying to the Pi, verify these behaviors:

1. Raw position continues to update:

```text
navigation.position.latitude.value
navigation.position.longitude.value
```

2. Filtered anchor position moves when raw position persistently moves:

```text
anchor.filteredBoatPosition.position.latitude.value
anchor.filteredBoatPosition.position.longitude.value
```

3. Breadcrumbs do not repeat the exact same point every 30 seconds:

```text
anchor.history
```

4. Anchor distances and bearings continue to update:

```text
anchor.anchorLocation.distancesFromCurrent.value
anchor.anchorLocation.bearing.value
```

5. Large GPS jumps are dampened rather than permanently freezing the filtered boat position.
