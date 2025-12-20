import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

const DEFAULT_BUOY_STATION_FILE = path.resolve(
  process.cwd(),
  "data/ndbc-buoy-stations.json"
);

const NDBC_REALTIME_BASE = "https://www.ndbc.noaa.gov/data/realtime2";

let buoyStationCache = null;

async function loadBuoyStations(stationFile = DEFAULT_BUOY_STATION_FILE) {
  if (Array.isArray(buoyStationCache)) {
    return buoyStationCache;
  }

  try {
    const raw = await fs.readFile(stationFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.stations && Array.isArray(parsed.stations)) {
      buoyStationCache = parsed.stations
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
          owner: station.owner || null,
          type: station.type || null,
        }));
    } else {
      buoyStationCache = [];
    }
  } catch (error) {
    console.error("[NDBC] Failed to read buoy station file:", error);
    buoyStationCache = [];
  }
  return buoyStationCache;
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

export async function findNearestBuoyStation(latitude, longitude, options = {}) {
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

  const stations = await loadBuoyStations(options.stationFile);
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

export async function fetchNdbcBuoyData(stationId, options = {}) {
  const { hoursToFetch = 24 } = options;

  const url = `${NDBC_REALTIME_BASE}/${stationId}.txt`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NDBC buoy API error: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.split("\n").filter((line) => line.trim() && !line.startsWith("#"));

  if (lines.length === 0) {
    throw new Error("NDBC buoy returned no data");
  }

  const observations = [];
  const now = new Date();
  const cutoffTime = new Date(now.getTime() - hoursToFetch * 60 * 60 * 1000);

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 14) continue;

    const [year, month, day, hour, minute, wdir, wspd, gst, wvht, dpd, apd, mwd, pres, atmp, wtmp] = parts;

    const obsTime = new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour),
      parseInt(minute)
    );

    if (obsTime < cutoffTime) continue;

    observations.push({
      time: obsTime.toISOString(),
      windDirection: wdir !== "MM" ? parseFloat(wdir) : null,
      windSpeed: wspd !== "MM" ? parseFloat(wspd) : null,
      windGust: gst !== "MM" ? parseFloat(gst) : null,
      waveHeight: wvht !== "MM" ? parseFloat(wvht) : null,
      dominantWavePeriod: dpd !== "MM" ? parseFloat(dpd) : null,
      averageWavePeriod: apd !== "MM" ? parseFloat(apd) : null,
      meanWaveDirection: mwd !== "MM" ? parseFloat(mwd) : null,
      pressure: pres !== "MM" ? parseFloat(pres) : null,
      airTemperature: atmp !== "MM" ? parseFloat(atmp) : null,
      waterTemperature: wtmp !== "MM" ? parseFloat(wtmp) : null,
    });
  }

  observations.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const latest = observations.length > 0 ? observations[observations.length - 1] : null;

  return {
    stationId,
    observations,
    latest,
    observationCount: observations.length,
  };
}

export function buildWaveComparison(ndbcData, openMeteoData) {
  if (!ndbcData?.latest || !openMeteoData?.current?.values) {
    return null;
  }

  const ndbcWaveHeight = ndbcData.latest.waveHeight;
  const openMeteoWaveHeight = openMeteoData.current.values.waveHeight;

  if (ndbcWaveHeight === null || openMeteoWaveHeight === null) {
    return null;
  }

  const difference = openMeteoWaveHeight - ndbcWaveHeight;
  const percentDifference = ndbcWaveHeight !== 0 
    ? ((difference / ndbcWaveHeight) * 100) 
    : null;

  return {
    ndbc: {
      waveHeight: ndbcWaveHeight,
      wavePeriod: ndbcData.latest.dominantWavePeriod,
      waveDirection: ndbcData.latest.meanWaveDirection,
      waterTemperature: ndbcData.latest.waterTemperature,
      observationTime: ndbcData.latest.time,
      source: "NDBC Buoy (Observed)",
    },
    openMeteo: {
      waveHeight: openMeteoWaveHeight,
      wavePeriod: openMeteoData.current.values.wavePeriod,
      waveDirection: openMeteoData.current.values.waveDirection,
      waterTemperature: openMeteoData.current.values.seaSurfaceTemperature,
      source: "Open-Meteo (Modeled)",
    },
    comparison: {
      waveHeightDifference: Math.round(difference * 1000) / 1000,
      waveHeightPercentDifference: percentDifference !== null 
        ? Math.round(percentDifference * 10) / 10 
        : null,
      openMeteoHigher: difference > 0,
      correlationNote: Math.abs(difference) < 0.3 
        ? "Good correlation (within 0.3m)" 
        : Math.abs(difference) < 0.6 
          ? "Moderate correlation (within 0.6m)" 
          : "Poor correlation (>0.6m difference)",
    },
  };
}

export function clearBuoyStationCache() {
  buoyStationCache = null;
}
