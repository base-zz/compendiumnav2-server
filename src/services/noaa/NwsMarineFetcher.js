import fetch from "node-fetch";

const NWS_API_BASE = "https://api.weather.gov";

export async function fetchNwsMarineForecast(latitude, longitude) {
  const pointsUrl = `${NWS_API_BASE}/points/${latitude},${longitude}`;

  const pointsResponse = await fetch(pointsUrl, {
    headers: {
      "User-Agent": "CompendiumNav Marine App",
      Accept: "application/geo+json",
    },
  });

  if (!pointsResponse.ok) {
    throw new Error(`NWS points API error: ${pointsResponse.status}`);
  }

  const pointsData = await pointsResponse.json();
  const forecastUrl = pointsData?.properties?.forecast;
  const forecastHourlyUrl = pointsData?.properties?.forecastHourly;
  const forecastGridDataUrl = pointsData?.properties?.forecastGridData;
  const forecastZone = pointsData?.properties?.forecastZone;

  if (!forecastUrl) {
    throw new Error("NWS did not return a forecast URL for this location");
  }

  const [forecastResponse, hourlyResponse] = await Promise.all([
    fetch(forecastUrl, {
      headers: { "User-Agent": "CompendiumNav Marine App", Accept: "application/geo+json" },
    }),
    fetch(forecastHourlyUrl, {
      headers: { "User-Agent": "CompendiumNav Marine App", Accept: "application/geo+json" },
    }),
  ]);

  if (!forecastResponse.ok) {
    throw new Error(`NWS forecast API error: ${forecastResponse.status}`);
  }

  const forecastData = await forecastResponse.json();
  const hourlyData = hourlyResponse.ok ? await hourlyResponse.json() : null;

  const alerts = await fetchNwsAlerts(latitude, longitude);

  const periods = forecastData?.properties?.periods || [];
  const hourlyPeriods = hourlyData?.properties?.periods || [];

  return {
    location: {
      latitude,
      longitude,
      gridId: pointsData?.properties?.gridId,
      forecastOffice: pointsData?.properties?.cwa,
    },
    forecast: periods.map((p) => ({
      name: p.name,
      startTime: p.startTime,
      endTime: p.endTime,
      isDaytime: p.isDaytime,
      temperature: p.temperature,
      temperatureUnit: p.temperatureUnit,
      windSpeed: p.windSpeed,
      windDirection: p.windDirection,
      shortForecast: p.shortForecast,
      detailedForecast: p.detailedForecast,
      probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value ?? null,
    })),
    hourlyForecast: hourlyPeriods.slice(0, 24).map((p) => ({
      startTime: p.startTime,
      temperature: p.temperature,
      temperatureUnit: p.temperatureUnit,
      windSpeed: p.windSpeed,
      windDirection: p.windDirection,
      shortForecast: p.shortForecast,
      probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value ?? null,
    })),
    alerts,
    metadata: {
      source: "NOAA National Weather Service",
      forecastOffice: pointsData?.properties?.cwa,
      generatedAt: forecastData?.properties?.generatedAt,
    },
  };
}

async function fetchNwsAlerts(latitude, longitude) {
  const alertsUrl = `${NWS_API_BASE}/alerts/active?point=${latitude},${longitude}`;

  try {
    const response = await fetch(alertsUrl, {
      headers: {
        "User-Agent": "CompendiumNav Marine App",
        Accept: "application/geo+json",
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const features = data?.features || [];

    return features.map((f) => ({
      id: f.properties?.id,
      event: f.properties?.event,
      headline: f.properties?.headline,
      severity: f.properties?.severity,
      urgency: f.properties?.urgency,
      certainty: f.properties?.certainty,
      onset: f.properties?.onset,
      expires: f.properties?.expires,
      description: f.properties?.description,
      instruction: f.properties?.instruction,
      senderName: f.properties?.senderName,
    }));
  } catch (err) {
    console.error("[NWS] Failed to fetch alerts:", err);
    return [];
  }
}

export function extractMarineHazards(alerts) {
  const marineKeywords = [
    "small craft",
    "gale",
    "storm warning",
    "hurricane",
    "tropical",
    "marine",
    "coastal flood",
    "high surf",
    "rip current",
    "waterspout",
    "dense fog",
  ];

  return alerts.filter((alert) => {
    const eventLower = (alert.event || "").toLowerCase();
    const headlineLower = (alert.headline || "").toLowerCase();
    return marineKeywords.some(
      (kw) => eventLower.includes(kw) || headlineLower.includes(kw)
    );
  });
}

export function parseWindSpeed(windSpeedStr) {
  if (!windSpeedStr) return null;

  const match = windSpeedStr.match(/(\d+)\s*to\s*(\d+)|(\d+)/i);
  if (match) {
    if (match[1] && match[2]) {
      return {
        min: parseInt(match[1]),
        max: parseInt(match[2]),
        avg: (parseInt(match[1]) + parseInt(match[2])) / 2,
      };
    } else if (match[3]) {
      const val = parseInt(match[3]);
      return { min: val, max: val, avg: val };
    }
  }
  return null;
}
