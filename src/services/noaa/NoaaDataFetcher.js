import fetch from "node-fetch";

const NOAA_API_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

export async function fetchNoaaTidePredictions(stationId, options = {}) {
  const {
    rangeHours = 72,
    datum = "MLLW",
    units = "english",
    interval = "hilo",
  } = options;

  // Use explicit begin_date and end_date to ensure forward-looking predictions
  // Start from 6 hours ago (to have some past context) and extend rangeHours into the future
  const now = new Date();
  const beginDate = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const endDate = new Date(now.getTime() + rangeHours * 60 * 60 * 1000);

  const formatDate = (d) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

  const params = new URLSearchParams({
    station: stationId,
    product: "predictions",
    datum,
    time_zone: "gmt",
    units,
    interval,
    begin_date: formatDate(beginDate),
    end_date: formatDate(endDate),
    format: "json",
    application: "CompendiumNav",
  });

  const url = `${NOAA_API_BASE}?${params.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NOAA tide API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`NOAA tide API error: ${data.error.message}`);
  }

  if (!data.predictions || !Array.isArray(data.predictions)) {
    throw new Error("NOAA tide API returned no predictions");
  }

  return data.predictions.map((p) => ({
    time: parseNoaaTime(p.t),
    height: parseFloat(p.v),
    type: p.type || null,
  }));
}

export async function fetchNoaaCurrentPredictions(stationId, options = {}) {
  const {
    rangeHours = 72,
    units = "english",
    timeZone = "lst_ldt",
    interval = "max_slack",
    bin = null,
  } = options;

  const params = new URLSearchParams({
    station: stationId,
    product: "currents_predictions",
    time_zone: timeZone,
    units,
    interval,
    range: String(rangeHours),
    format: "json",
    application: "CompendiumNav",
  });

  if (bin !== null) {
    params.set("bin", String(bin));
  }

  const url = `${NOAA_API_BASE}?${params.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NOAA currents API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`NOAA currents API error: ${data.error.message}`);
  }

  if (!data.current_predictions && !data.predictions) {
    throw new Error("NOAA currents API returned no predictions");
  }

  const predictions = data.current_predictions || data.predictions || [];

  return predictions.map((p) => ({
    time: parseNoaaTime(p.Time || p.t),
    velocity: p.Velocity_Major !== undefined ? parseFloat(p.Velocity_Major) : (p.v !== undefined ? parseFloat(p.v) : null),
    type: p.Type || p.type || null,
    meanFloodDir: p.meanFloodDir !== undefined ? parseFloat(p.meanFloodDir) : null,
    meanEbbDir: p.meanEbbDir !== undefined ? parseFloat(p.meanEbbDir) : null,
  }));
}

function parseNoaaTime(timeStr) {
  if (!timeStr) return null;
  // NOAA returns times in format "YYYY-MM-DD HH:MM" in GMT when time_zone=gmt
  const cleaned = timeStr.replace(" ", "T") + "Z";
  return new Date(cleaned).toISOString();
}

/**
 * Build imputed current data from Open-Meteo ocean current data
 * Converts hourly velocity/direction into prediction format for comparison with NOAA
 * @param {Object} openMeteoHourly - Open-Meteo hourly data with time and values
 * @returns {Array} Array of current predictions in NOAA-compatible format
 */
export function buildImputedCurrentData(openMeteoHourly) {
  if (!openMeteoHourly?.time || !openMeteoHourly?.values) {
    return null;
  }

  const times = openMeteoHourly.time;
  const velocities = openMeteoHourly.values.oceanCurrentVelocity || [];
  const directions = openMeteoHourly.values.oceanCurrentDirection || [];

  if (!times.length || !velocities.length) {
    return null;
  }

  const predictions = [];

  for (let i = 0; i < times.length; i++) {
    const velocity = velocities[i];
    const direction = directions[i];

    if (velocity === null || velocity === undefined || direction === null || direction === undefined) {
      continue;
    }

    // Infer type from velocity magnitude (Open-Meteo uses signed velocity)
    // Positive = one direction, negative = opposite
    let type = "slack";
    const absVelocity = Math.abs(velocity);
    if (absVelocity > 0.2) {
      // Direction interpretation: arbitrary - we'll use the actual direction
      // For consistency with NOAA, we call it "flood" when moving in recorded direction
      type = "flood";
    }

    predictions.push({
      time: times[i],
      velocity: absVelocity,
      direction: direction,
      type: type,
      meanFloodDir: direction,
      meanEbbDir: (direction + 180) % 360,
      source: "openmeteo"
    });
  }

  return predictions;
}

export function interpolateHourlyTides(hiloData, hoursToGenerate = 72, options = {}) {
  if (!hiloData || hiloData.length < 2) {
    return [];
  }

  const sorted = [...hiloData].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  // Start from 6 hours before now (for past context) and extend hoursToGenerate into the future
  const now = new Date();
  const pastHours = options.pastHours !== undefined ? options.pastHours : 6;
  const startTime = new Date(now.getTime() - pastHours * 60 * 60 * 1000);
  startTime.setMinutes(0, 0, 0);

  const hourlyData = [];
  const totalHours = pastHours + hoursToGenerate;

  for (let h = 0; h < totalHours; h++) {
    const targetTime = new Date(startTime.getTime() + h * 60 * 60 * 1000);

    let before = null;
    let after = null;

    for (let i = 0; i < sorted.length - 1; i++) {
      const t1 = new Date(sorted[i].time);
      const t2 = new Date(sorted[i + 1].time);

      if (targetTime >= t1 && targetTime <= t2) {
        before = sorted[i];
        after = sorted[i + 1];
        break;
      }
    }

    if (!before || !after) {
      if (targetTime < new Date(sorted[0].time)) {
        before = sorted[0];
        after = sorted[1];
      } else if (targetTime > new Date(sorted[sorted.length - 1].time)) {
        before = sorted[sorted.length - 2];
        after = sorted[sorted.length - 1];
      } else {
        continue;
      }
    }

    const t1 = new Date(before.time).getTime();
    const t2 = new Date(after.time).getTime();
    const tTarget = targetTime.getTime();

    const fraction = (tTarget - t1) / (t2 - t1);

    const h1 = before.height;
    const h2 = after.height;
    const interpolatedHeight = h1 + (h2 - h1) * (1 - Math.cos(fraction * Math.PI)) / 2;

    hourlyData.push({
      time: targetTime.toISOString(),
      height: Math.round(interpolatedHeight * 1000) / 1000,
    });
  }

  return hourlyData;
}

export function buildTidePayload(options) {
  const {
    hiloData,
    hourlyData,
    currentData,
    imputedCurrentData,
    tideStation,
    currentStation,
    buoyStation,
    ndbcData,
    waveComparison,
    nwsForecast,
    marineHazards,
    sunMoonData,
    portsStation,
    portsData,
    inletConditions,
    units,
    openMeteoData,
  } = options;

  const now = new Date();
  const nowIso = now.toISOString();

  const nextHigh = hiloData?.find((p) => p.type === "H" && new Date(p.time) > now) || null;
  const nextLow = hiloData?.find((p) => p.type === "L" && new Date(p.time) > now) || null;

  const currentHeight = hourlyData?.length
    ? findClosestToNow(hourlyData, now)?.height ?? null
    : null;

  const currentCurrent = currentData?.length
    ? findClosestToNow(currentData, now)
    : null;

  const hourlyTimes = hourlyData?.map((h) => h.time) || [];
  const hourlyHeights = hourlyData?.map((h) => h.height) || [];

  const dailySummary = buildDailySummary(hiloData || []);

  const displayUnits = {
    waveHeight: units === "metric" ? "m" : "ft",
    currentVelocity: units === "metric" ? "km/h" : "kn",
    temperature: units === "metric" ? "°C" : "°F",
    seaLevelHeight: units === "metric" ? "m" : "ft",
  };

  const payload = {
    type: "tide:update",
    timestamp: nowIso,
    units: displayUnits,
    current: {
      time: nowIso,
      values: {
        seaLevelHeightMsl: currentHeight,
        waveHeight: openMeteoData?.current?.values?.waveHeight ?? null,
        waveDirection: openMeteoData?.current?.values?.waveDirection ?? null,
        wavePeriod: openMeteoData?.current?.values?.wavePeriod ?? null,
        seaSurfaceTemperature: openMeteoData?.current?.values?.seaSurfaceTemperature ?? null,
        oceanCurrentVelocity: currentCurrent?.velocity ?? openMeteoData?.current?.values?.oceanCurrentVelocity ?? null,
        oceanCurrentDirection: currentCurrent?.meanFloodDir ?? openMeteoData?.current?.values?.oceanCurrentDirection ?? null,
      },
    },
    hourly: {
      time: hourlyTimes,
      values: {
        seaLevelHeightMsl: hourlyHeights,
        waveHeight: openMeteoData?.hourly?.values?.waveHeight || [],
        waveDirection: openMeteoData?.hourly?.values?.waveDirection || [],
        wavePeriod: openMeteoData?.hourly?.values?.wavePeriod || [],
        windWavePeakPeriod: openMeteoData?.hourly?.values?.windWavePeakPeriod || [],
        windWaveHeight: openMeteoData?.hourly?.values?.windWaveHeight || [],
        windWaveDirection: openMeteoData?.hourly?.values?.windWaveDirection || [],
        windWavePeriod: openMeteoData?.hourly?.values?.windWavePeriod || [],
        swellWaveHeight: openMeteoData?.hourly?.values?.swellWaveHeight || [],
        swellWaveDirection: openMeteoData?.hourly?.values?.swellWaveDirection || [],
        swellWavePeriod: openMeteoData?.hourly?.values?.swellWavePeriod || [],
        swellWavePeakPeriod: openMeteoData?.hourly?.values?.swellWavePeakPeriod || [],
        seaSurfaceTemperature: openMeteoData?.hourly?.values?.seaSurfaceTemperature || [],
        oceanCurrentVelocity: openMeteoData?.hourly?.values?.oceanCurrentVelocity || [],
        oceanCurrentDirection: openMeteoData?.hourly?.values?.oceanCurrentDirection || [],
      },
    },
    daily: {
      time: dailySummary.dates,
      values: {
        highTimes: dailySummary.highTimes,
        highHeights: dailySummary.highHeights,
        lowTimes: dailySummary.lowTimes,
        lowHeights: dailySummary.lowHeights,
        waveHeightMax: openMeteoData?.daily?.values?.waveHeightMax || [],
        waveDirectionDominant: openMeteoData?.daily?.values?.waveDirectionDominant || [],
        wavePeriodMax: openMeteoData?.daily?.values?.wavePeriodMax || [],
        windWaveHeightMax: openMeteoData?.daily?.values?.windWaveHeightMax || [],
        windWaveDirectionDominant: openMeteoData?.daily?.values?.windWaveDirectionDominant || [],
      },
    },
    tideEvents: {
      nextHigh: nextHigh ? { time: nextHigh.time, height: nextHigh.height } : null,
      nextLow: nextLow ? { time: nextLow.time, height: nextLow.height } : null,
      predictions: hiloData || [],
    },
    currentEvents: currentData
      ? {
          predictions: currentData,
        }
      : null,
    imputedCurrent: imputedCurrentData
      ? {
          predictions: imputedCurrentData,
          source: "openmeteo",
        }
      : null,
    buoyObservations: ndbcData
      ? {
          stationId: ndbcData.stationId,
          latest: ndbcData.latest,
          observations: ndbcData.observations,
          observationCount: ndbcData.observationCount,
        }
      : null,
    waveComparison: waveComparison || null,
    weather: nwsForecast
      ? {
          forecast: nwsForecast.forecast,
          hourlyForecast: nwsForecast.hourlyForecast,
          alerts: nwsForecast.alerts,
          marineHazards: marineHazards || [],
        }
      : null,
    sunMoon: sunMoonData || null,
    portsCurrents: portsData
      ? {
          stationId: portsData.stationId,
          latest: portsData.latest,
          observations: portsData.observations,
          observationCount: portsData.observationCount,
        }
      : null,
    inletConditions: inletConditions || null,
    metadata: {
      source: "NOAA Tide Predictions + NDBC Buoy + NWS Forecast + PORTS",
      tideStation: tideStation
        ? {
            id: tideStation.id,
            name: tideStation.name,
            latitude: tideStation.latitude,
            longitude: tideStation.longitude,
            distanceKm: tideStation.distanceKm,
          }
        : null,
      currentStation: currentStation
        ? {
            id: currentStation.id,
            name: currentStation.name,
            latitude: currentStation.latitude,
            longitude: currentStation.longitude,
            distanceKm: currentStation.distanceKm,
          }
        : null,
      buoyStation: buoyStation
        ? {
            id: buoyStation.id,
            name: buoyStation.name,
            latitude: buoyStation.latitude,
            longitude: buoyStation.longitude,
            distanceKm: buoyStation.distanceKm,
          }
        : null,
      portsStation: portsStation
        ? {
            id: portsStation.id,
            name: portsStation.name,
            latitude: portsStation.latitude,
            longitude: portsStation.longitude,
            distanceKm: portsStation.distanceKm,
            project: portsStation.project,
          }
        : null,
      datum: "MLLW",
      last_updated: nowIso,
      units: displayUnits,
    },
  };

  return payload;
}

function findClosestToNow(dataArray, now) {
  if (!dataArray || !dataArray.length) return null;

  let closest = dataArray[0];
  let closestDiff = Math.abs(new Date(closest.time).getTime() - now.getTime());

  for (const item of dataArray) {
    const diff = Math.abs(new Date(item.time).getTime() - now.getTime());
    if (diff < closestDiff) {
      closest = item;
      closestDiff = diff;
    }
  }

  return closest;
}

function buildDailySummary(hiloData) {
  const byDate = {};

  for (const p of hiloData) {
    const date = p.time.split("T")[0];
    if (!byDate[date]) {
      byDate[date] = { highs: [], lows: [] };
    }
    if (p.type === "H") {
      byDate[date].highs.push(p);
    } else if (p.type === "L") {
      byDate[date].lows.push(p);
    }
  }

  const dates = Object.keys(byDate).sort();
  const highTimes = [];
  const highHeights = [];
  const lowTimes = [];
  const lowHeights = [];

  for (const date of dates) {
    const day = byDate[date];

    const hTimes = day.highs.map((h) => {
      const d = new Date(h.time);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    });
    const hHeights = day.highs.map((h) => h.height);

    const lTimes = day.lows.map((l) => {
      const d = new Date(l.time);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    });
    const lHeights = day.lows.map((l) => l.height);

    highTimes.push(hTimes);
    highHeights.push(hHeights);
    lowTimes.push(lTimes);
    lowHeights.push(lHeights);
  }

  return { dates, highTimes, highHeights, lowTimes, lowHeights };
}
