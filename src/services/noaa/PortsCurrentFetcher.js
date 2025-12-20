import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

const DEFAULT_PORTS_STATION_FILE = path.resolve(
  process.cwd(),
  "data/noaa-ports-currents.json"
);

const NOAA_API_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

let portsStationCache = null;

async function loadPortsStations(stationFile = DEFAULT_PORTS_STATION_FILE) {
  if (Array.isArray(portsStationCache)) {
    return portsStationCache;
  }

  try {
    const raw = await fs.readFile(stationFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.stations && Array.isArray(parsed.stations)) {
      portsStationCache = parsed.stations
        .filter(
          (station) =>
            typeof station?.lat === "number" &&
            typeof station?.lng === "number" &&
            typeof station?.id === "string"
        )
        .map((station) => ({
          id: station.id,
          name: station.name || station.id,
          latitude: station.lat,
          longitude: station.lng,
          project: station.project || null,
          portscode: station.portscode || null,
        }));
    } else {
      portsStationCache = [];
    }
  } catch (error) {
    console.error("[PORTS] Failed to read PORTS station file:", error);
    portsStationCache = [];
  }
  return portsStationCache;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
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

export async function findNearestPortsStation(latitude, longitude, options = {}) {
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

  const stations = await loadPortsStations(options.stationFile);
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

export async function fetchPortsCurrentData(stationId, options = {}) {
  const { hoursToFetch = 6, units = "english" } = options;

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - hoursToFetch * 60 * 60 * 1000);

  const formatDate = (d) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  const params = new URLSearchParams({
    station: stationId,
    product: "currents",
    begin_date: formatDate(startDate),
    end_date: formatDate(endDate),
    units,
    time_zone: "gmt",
    format: "json",
    application: "CompendiumNav",
  });

  const url = `${NOAA_API_BASE}?${params.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`PORTS currents API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`PORTS currents API error: ${data.error.message}`);
  }

  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("PORTS currents API returned no data");
  }

  const observations = data.data.map((d) => ({
    time: new Date(d.t.replace(" ", "T") + "Z").toISOString(),
    speed: d.s !== null ? parseFloat(d.s) : null,
    direction: d.d !== null ? parseFloat(d.d) : null,
    bin: d.b || null,
  }));

  const latest = observations.length > 0 ? observations[observations.length - 1] : null;

  return {
    stationId,
    observations,
    latest,
    observationCount: observations.length,
  };
}

export function assessInletConditions(options) {
  const {
    currentPrediction,
    portsObservation,
    buoyObservation,
    windSpeed,
    windDirection,
  } = options;

  const conditions = {
    currentStrength: null,
    currentPhase: null,
    waveHeight: null,
    windOpposing: false,
    riskLevel: "unknown",
    riskFactors: [],
    recommendations: [],
  };

  if (currentPrediction) {
    const velocity = currentPrediction.velocity;
    if (velocity !== null) {
      conditions.currentStrength = Math.abs(velocity);
      conditions.currentPhase = velocity < -0.5 ? "ebb" : velocity > 0.5 ? "flood" : "slack";

      if (Math.abs(velocity) > 2) {
        conditions.riskFactors.push("Strong current (>2 kn)");
      }
    }
  }

  if (portsObservation?.latest) {
    const speed = portsObservation.latest.speed;
    if (speed !== null) {
      conditions.currentStrength = speed;
      if (speed > 2) {
        conditions.riskFactors.push(`Real-time current: ${speed.toFixed(1)} kn`);
      }
    }
  }

  if (buoyObservation?.latest) {
    conditions.waveHeight = buoyObservation.latest.waveHeight;
    if (conditions.waveHeight !== null && conditions.waveHeight > 1.5) {
      conditions.riskFactors.push(`Wave height: ${conditions.waveHeight.toFixed(1)} m`);
    }
  }

  if (windSpeed && windDirection && conditions.currentPhase === "ebb") {
    const windFromOcean = windDirection >= 180 && windDirection <= 360;
    if (windFromOcean && windSpeed > 15) {
      conditions.windOpposing = true;
      conditions.riskFactors.push("Wind opposing ebb current");
    }
  }

  const riskScore = conditions.riskFactors.length;
  if (riskScore === 0) {
    conditions.riskLevel = "low";
    conditions.recommendations.push("Conditions appear favorable for inlet crossing");
  } else if (riskScore === 1) {
    conditions.riskLevel = "moderate";
    conditions.recommendations.push("Exercise caution, monitor conditions");
  } else if (riskScore === 2) {
    conditions.riskLevel = "elevated";
    conditions.recommendations.push("Consider waiting for slack water or improved conditions");
  } else {
    conditions.riskLevel = "high";
    conditions.recommendations.push("Avoid inlet crossing if possible");
    conditions.recommendations.push("Wait for slack water and calmer seas");
  }

  if (conditions.currentPhase === "ebb" && conditions.waveHeight && conditions.waveHeight > 1) {
    conditions.recommendations.push("Ebb current with incoming swell creates steep breaking waves");
  }

  if (conditions.currentPhase === "slack") {
    conditions.recommendations.push("Slack water is the safest time to cross inlets");
  }

  return conditions;
}

export function clearPortsStationCache() {
  portsStationCache = null;
}
