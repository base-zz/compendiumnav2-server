import fs from "fs/promises";
import path from "path";

const DEFAULT_TIDE_STATION_FILE = path.resolve(
  process.cwd(),
  "data/noaa-tide-stations.json"
);

const DEFAULT_CURRENT_STATION_FILE = path.resolve(
  process.cwd(),
  "data/noaa-current-stations.json"
);

let tideStationCache = null;
let currentStationCache = null;

async function loadTideStations(stationFile = DEFAULT_TIDE_STATION_FILE) {
  if (Array.isArray(tideStationCache)) {
    return tideStationCache;
  }

  try {
    const raw = await fs.readFile(stationFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.stations && Array.isArray(parsed.stations)) {
      tideStationCache = parsed.stations
        .filter(
          (station) =>
            typeof station?.lat === "number" &&
            typeof station?.lng === "number" &&
            typeof station?.id === "string"
        )
        .map((station) => ({
          id: station.id,
          name: station.name || "Unknown Station",
          latitude: station.lat,
          longitude: station.lng,
          state: station.state || null,
          timezoneOffset: station.timezonecorr ?? null,
          type: station.type || null,
        }));
    } else {
      tideStationCache = [];
    }
  } catch (error) {
    console.error("[NOAA] Failed to read tide station file:", error);
    tideStationCache = [];
  }
  return tideStationCache;
}

async function loadCurrentStations(stationFile = DEFAULT_CURRENT_STATION_FILE) {
  if (Array.isArray(currentStationCache)) {
    return currentStationCache;
  }

  try {
    const raw = await fs.readFile(stationFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.stations && Array.isArray(parsed.stations)) {
      currentStationCache = parsed.stations
        .filter(
          (station) =>
            typeof station?.lat === "number" &&
            typeof station?.lng === "number" &&
            typeof station?.id === "string"
        )
        .map((station) => ({
          id: station.id,
          name: station.name || "Unknown Station",
          latitude: station.lat,
          longitude: station.lng,
          bin: station.currbin ?? null,
          depth: station.depth ?? null,
          depthType: station.depthType || null,
          type: station.type || null,
        }));
    } else {
      currentStationCache = [];
    }
  } catch (error) {
    console.error("[NOAA] Failed to read current station file:", error);
    currentStationCache = [];
  }
  return currentStationCache;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function findNearestInList(latitude, longitude, stations, maxDistanceKm) {
  if (!stations.length) {
    return null;
  }

  let closest = null;
  for (const station of stations) {
    const distanceKm = haversineDistanceKm(
      latitude,
      longitude,
      station.latitude,
      station.longitude
    );
    if (!closest || distanceKm < closest.distanceKm) {
      closest = { ...station, distanceKm };
    }
  }

  if (!closest) {
    return null;
  }

  if (maxDistanceKm !== null && closest.distanceKm > maxDistanceKm) {
    return null;
  }

  return closest;
}

export async function findNearestTideStation(
  latitude,
  longitude,
  options = {}
) {
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }

  const maxDistanceKm =
    typeof options.maxDistanceKm === "number" && Number.isFinite(options.maxDistanceKm)
      ? options.maxDistanceKm
      : null;

  const stations = await loadTideStations(options.stationFile);
  return findNearestInList(latitude, longitude, stations, maxDistanceKm);
}

export async function findNearestCurrentStation(
  latitude,
  longitude,
  options = {}
) {
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }

  const maxDistanceKm =
    typeof options.maxDistanceKm === "number" && Number.isFinite(options.maxDistanceKm)
      ? options.maxDistanceKm
      : null;

  const stations = await loadCurrentStations(options.stationFile);
  return findNearestInList(latitude, longitude, stations, maxDistanceKm);
}

export function clearStationCaches() {
  tideStationCache = null;
  currentStationCache = null;
}
