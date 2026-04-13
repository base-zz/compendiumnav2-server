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
