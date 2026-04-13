import fs from "fs";

export async function parseGPXRoute(gpxFilePath) {
  if (!fs.existsSync(gpxFilePath)) {
    throw new Error(`GPX file not found: ${gpxFilePath}`);
  }

  const gpxData = fs.readFileSync(gpxFilePath, "utf8");
  const points = extractPoints(gpxData);

  if (points.length === 0) {
    throw new Error("No route points found in GPX file");
  }

  return points;
}

function extractPoints(gpxData) {
  const points = [];
  const pointRegex = /<(rtept|trkpt|wpt)\b([^>]*)>([\s\S]*?)<\/\1>|<(rtept|trkpt|wpt)\b([^>]*)\/>/gi;
  let match = pointRegex.exec(gpxData);

  while (match) {
    const attrsRaw = match[2] || match[5] || "";
    const body = match[3] || "";
    const point = parsePoint(attrsRaw, body);

    if (point) {
      points.push(point);
    }

    match = pointRegex.exec(gpxData);
  }

  return points;
}

function parsePoint(attrsRaw, body) {
  const latMatch = attrsRaw.match(/\blat\s*=\s*"([^"]+)"/i);
  const lonMatch = attrsRaw.match(/\blon\s*=\s*"([^"]+)"/i);

  if (!latMatch || !lonMatch) {
    return null;
  }

  const lat = parseFloat(latMatch[1]);
  const lon = parseFloat(lonMatch[1]);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const elevationMatch = body.match(/<ele>([^<]+)<\/ele>/i);
  const timeMatch = body.match(/<time>([^<]+)<\/time>/i);
  const nameMatch = body.match(/<name>([^<]+)<\/name>/i);

  return {
    lat,
    lon,
    elevation: elevationMatch ? parseFloat(elevationMatch[1]) : undefined,
    time: timeMatch ? timeMatch[1] : undefined,
    name: nameMatch ? nameMatch[1] : undefined,
  };
}

export function calculateDistanceNM(lat1, lon1, lat2, lon2) {
  const radiusNm = 3440.065;
  const toRad = (degrees) => (degrees * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radiusNm * c;
}

export function calculateRouteDistances(points) {
  const result = [];
  let cumulativeDistance = 0;

  for (let i = 0; i < points.length; i += 1) {
    if (i > 0) {
      const prev = points[i - 1];
      const current = points[i];
      const segmentDistance = calculateDistanceNM(
        prev.lat,
        prev.lon,
        current.lat,
        current.lon,
      );
      cumulativeDistance += segmentDistance;
    }

    result.push({
      ...points[i],
      distanceFromStart: cumulativeDistance,
    });
  }

  return result;
}

export function findClosestRoutePoint(routePoints, lat, lon) {
  let minDistance = Infinity;
  let closestIndex = -1;
  let closestDistanceFromStart = 0;

  for (let i = 0; i < routePoints.length; i += 1) {
    const point = routePoints[i];
    const distance = calculateDistanceNM(point.lat, point.lon, lat, lon);

    if (distance < minDistance) {
      minDistance = distance;
      closestIndex = i;
      closestDistanceFromStart = point.distanceFromStart;
    }
  }

  return {
    distanceNM: minDistance,
    distanceFromStart: closestDistanceFromStart,
    pointIndex: closestIndex,
  };
}
