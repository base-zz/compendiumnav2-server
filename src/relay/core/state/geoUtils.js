export const EARTH_RADIUS_METERS = 6371e3;

export function toRad(value) {
  return (value * Math.PI) / 180;
}

export function toDeg(value) {
  return (value * 180) / Math.PI;
}

export function calculateDistance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
    return null;
  }

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

export function calculateBearing(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
    return null;
  }

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const λ1 = toRad(lon1);
  const λ2 = toRad(lon2);
  const Δλ = λ2 - λ1;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  const bearing = (toDeg(θ) + 360) % 360;

  return Number.isFinite(bearing) ? bearing : null;
}

export function projectPoint(latDeg, lonDeg, bearingDeg, distanceMeters) {
  if (latDeg == null || lonDeg == null || bearingDeg == null || distanceMeters == null) return null;
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || !Number.isFinite(bearingDeg) || !Number.isFinite(distanceMeters)) {
    return null;
  }

  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const bearingRad = toRad(bearingDeg);
  const lat1 = toRad(latDeg);
  const lon1 = toRad(lonDeg);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearingRad)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearingRad) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );

  const next = { latitude: toDeg(lat2), longitude: toDeg(lon2) };
  if (!Number.isFinite(next.latitude) || !Number.isFinite(next.longitude)) return null;
  return next;
}

export function getBoatPosition(state) {
  if (!state || typeof state !== 'object') return null;

  const navPosition = state.navigation?.position;
  const navLat = typeof navPosition?.latitude === 'object'
    ? navPosition.latitude?.value
    : navPosition?.latitude;
  const navLon = typeof navPosition?.longitude === 'object'
    ? navPosition.longitude?.value
    : navPosition?.longitude;

  if (Number.isFinite(navLat) && Number.isFinite(navLon)) {
    return { lat: navLat, lon: navLon };
  }

  const positionRoot =
    state.position && typeof state.position === 'object'
      ? state.position
      : {};
  const boatPositionFromPosition =
    positionRoot.signalk && typeof positionRoot.signalk === 'object'
      ? positionRoot.signalk
      : positionRoot;

  const fallbackBoatLat = typeof boatPositionFromPosition?.latitude === 'object'
    ? boatPositionFromPosition.latitude?.value
    : boatPositionFromPosition?.latitude;
  const fallbackBoatLon = typeof boatPositionFromPosition?.longitude === 'object'
    ? boatPositionFromPosition.longitude?.value
    : boatPositionFromPosition?.longitude;

  if (!Number.isFinite(fallbackBoatLat) || !Number.isFinite(fallbackBoatLon)) {
    return null;
  }

  return { lat: fallbackBoatLat, lon: fallbackBoatLon };
}
