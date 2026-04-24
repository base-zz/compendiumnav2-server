import Database from "better-sqlite3";
import {
  parseGPXRoute,
  calculateRouteDistances,
  findClosestRoutePoint,
} from "./gpx-route-parser.js";

function requireConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Route query config is required");
  }

  if (!Object.prototype.hasOwnProperty.call(config, "dbPath") || typeof config.dbPath !== "string" || !config.dbPath.trim()) {
    throw new Error("Route query config requires dbPath");
  }

  if (!Object.prototype.hasOwnProperty.call(config, "maxDistanceNM") || !Number.isFinite(config.maxDistanceNM) || config.maxDistanceNM <= 0) {
    throw new Error("Route query config requires maxDistanceNM as a positive number");
  }

  return config;
}

export async function queryBridgesAlongRoute(gpxFilePath, config) {
  if (typeof gpxFilePath !== "string" || !gpxFilePath.trim()) {
    throw new Error("gpxFilePath is required");
  }

  const { dbPath, maxDistanceNM } = requireConfig(config);

  const routePoints = await parseGPXRoute(gpxFilePath);
  const routeWithDistances = calculateRouteDistances(routePoints);
  const db = new Database(dbPath);

  try {
    const stmt = db.prepare(`
      SELECT 
        b.id,
        b.external_id,
        b.name,
        b.state,
        b.city,
        b.latitude,
        b.longitude,
        b.closed_height_mhw,
        b.tier,
        b.schedule_type,
        b.vhf_channel,
        b.raw_data
      FROM bridges b
      WHERE b.latitude IS NOT NULL AND b.longitude IS NOT NULL
    `);

    const bridges = stmt.all();
    const results = [];

    for (const bridge of bridges) {
      const closest = findClosestRoutePoint(
        routeWithDistances,
        bridge.latitude,
        bridge.longitude,
      );

      if (closest.distanceNM <= maxDistanceNM) {
        results.push({
          ...bridge,
          distanceFromRoute: closest.distanceNM,
          distanceAlongRoute: closest.distanceFromStart,
          closestRoutePointIndex: closest.pointIndex,
        });
      }
    }

    results.sort((a, b) => a.distanceAlongRoute - b.distanceAlongRoute);
    return results;
  } finally {
    db.close();
  }
}

export async function queryAnchoragesAlongRoute(gpxFilePath, config) {
  if (typeof gpxFilePath !== "string" || !gpxFilePath.trim()) {
    throw new Error("gpxFilePath is required");
  }

  const { dbPath, maxDistanceNM } = requireConfig(config);

  const routePoints = await parseGPXRoute(gpxFilePath);
  const routeWithDistances = calculateRouteDistances(routePoints);
  const db = new Database(dbPath);

  try {
    const stmt = db.prepare(`
      SELECT
        a.id,
        a.name,
        a.city,
        a.state,
        a.lat,
        a.lon,
        a.source_url,
        a.raw_data_json,
        a.last_updated,
        a.location,
        a.mile_marker,
        a.lat_lon_text,
        a.depth,
        a.description,
        a.holding_rating,
        a.wind_protection_rating,
        a.current_flow_rating,
        a.wake_protection_rating,
        a.scenic_beauty_rating,
        a.ease_of_shopping_rating,
        a.shore_access_rating,
        a.pet_friendly_rating,
        a.cell_service_rating,
        a.wifi_rating
      FROM anchorages a
      WHERE a.lat IS NOT NULL AND a.lon IS NOT NULL
    `);

    const anchorages = stmt.all();
    const results = [];

    for (const anchorage of anchorages) {
      const closest = findClosestRoutePoint(
        routeWithDistances,
        anchorage.lat,
        anchorage.lon,
      );

      if (closest.distanceNM <= maxDistanceNM) {
        results.push({
          ...anchorage,
          distanceFromRoute: closest.distanceNM,
          distanceAlongRoute: closest.distanceFromStart,
          closestRoutePointIndex: closest.pointIndex,
        });
      }
    }

    results.sort((a, b) => a.distanceAlongRoute - b.distanceAlongRoute);
    return results;
  } finally {
    db.close();
  }
}

export async function queryMarinasAlongRoute(gpxFilePath, config) {
  if (typeof gpxFilePath !== "string" || !gpxFilePath.trim()) {
    throw new Error("gpxFilePath is required");
  }

  const { dbPath, maxDistanceNM } = requireConfig(config);

  const routePoints = await parseGPXRoute(gpxFilePath);
  const routeWithDistances = calculateRouteDistances(routePoints);
  const db = new Database(dbPath);

  try {
    const stmt = db.prepare(`
      SELECT 
        m.id,
        m.name,
        m.city,
        m.state,
        m.lat,
        m.lon,
        m.vhf_channel,
        m.phone,
        m.fuel_diesel,
        m.fuel_gas,
        m.fuel_price_diesel,
        m.fuel_price_gas,
        m.amenities,
        m.services,
        m.raw_data_json
      FROM marinas m
      WHERE m.lat IS NOT NULL AND m.lon IS NOT NULL
    `);

    const marinas = stmt.all();
    const results = [];

    for (const marina of marinas) {
      const closest = findClosestRoutePoint(routeWithDistances, marina.lat, marina.lon);

      if (closest.distanceNM <= maxDistanceNM) {
        results.push({
          ...marina,
          distanceFromRoute: closest.distanceNM,
          distanceAlongRoute: closest.distanceFromStart,
          closestRoutePointIndex: closest.pointIndex,
        });
      }
    }

    results.sort((a, b) => a.distanceFromRoute - b.distanceFromRoute);
    return results;
  } finally {
    db.close();
  }
}
