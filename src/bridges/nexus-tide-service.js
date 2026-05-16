import Database from "better-sqlite3";
import pkg from "node-fetch";
const { fetch } = pkg;
import { AbortController } from "abort-controller";

export class NexusTideService {
  constructor(options) {
    console.log(`[NexusTideService] Constructor called with options:`, options);
    if (!options || typeof options !== "object") {
      throw new Error("NexusTideService options are required");
    }

    if (!Object.prototype.hasOwnProperty.call(options, "dbPath") || typeof options.dbPath !== "string" || !options.dbPath.trim()) {
      throw new Error("NexusTideService requires options.dbPath");
    }

    if (!options.spatialitePath || typeof options.spatialitePath !== "string" || !options.spatialitePath.trim()) {
      console.error(`[NexusTideService] spatialitePath check failed:`, {
        type: typeof options.spatialitePath,
        value: options.spatialitePath,
        trimmed: options.spatialitePath?.trim()
      });
      throw new Error("NexusTideService requires options.spatialitePath");
    }

    if (!Object.prototype.hasOwnProperty.call(options, "requestTimeoutMs") || !Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
      throw new Error("NexusTideService requires options.requestTimeoutMs as a positive number");
    }

    this.dbPath = options.dbPath;
    this.spatialitePath = options.spatialitePath;
    this.requestTimeoutMs = options.requestTimeoutMs;

    this.db = new Database(this.dbPath);
    this.db.loadExtension(this.spatialitePath);

    this.headers = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "application/json",
      Referer: "https://tidesandcurrents.noaa.gov/",
      Origin: "https://tidesandcurrents.noaa.gov",
      Connection: "keep-alive",
    };
  }

  async getEnvironmentalData(lat, lon) {
    const tideStations = this.findNearestStations(lat, lon, "Tide", 5);
    const currentStations = this.findNearestStations(lat, lon, "Current", 5);

    let tide = null;
    let current = null;

    const tideQueue = [...tideStations, { id: "8723214", name: "Miami Harbor" }];
    for (const station of tideQueue) {
      tide = await this.fetchTide(station.id, station.name);
      if (tide) {
        break;
      }
    }

    const currentQueue = [...currentStations, { id: "mhrf1", name: "Miami Harbor PORTS" }];
    for (const station of currentQueue) {
      current = await this.fetchCurrent(station.id, station.name);
      if (current) {
        break;
      }
    }

    return {
      timestamp: new Date().toISOString(),
      tide: tide || { status: "unavailable", reason: "NO_VALID_STATION" },
      current: current || { status: "unavailable", reason: "NO_VALID_STATION" },
    };
  }

  async fetchTide(id, name) {
    const now = new Date();
    const beginDate = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0]
      .replace(/-/g, "");

    const urls = [
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${beginDate}&range=48&station=${id}&product=predictions&datum=MLLW&units=english&time_zone=lst_ldt&format=json`,
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${beginDate}&range=48&station=${id}&product=predictions&interval=hilo&datum=MLLW&units=english&time_zone=lst_ldt&format=json`,
    ];

    let mhwMllwOffset = null;

    // Fetch datum offsets for this station
    try {
      const datumUrl = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${id}&product=datums&units=english&format=json`;
      const datumResponse = await this.fetchWithTimeout(datumUrl);
      const datumData = await datumResponse.json();

      if (datumData.datums && Array.isArray(datumData.datums)) {
        const mhw = datumData.datums.find((d) => d.name === "MHW");
        const mllw = datumData.datums.find((d) => d.name === "MLLW");
        if (mhw && mllw) {
          mhwMllwOffset = parseFloat(mhw.value) - parseFloat(mllw.value);
        }
      }
    } catch (_err) {
      // Silently fail if datum offsets can't be fetched
    }

    for (const url of urls) {
      try {
        const response = await this.fetchWithTimeout(url);
        const data = await response.json();

        if (data.error) {
          continue;
        }

        if (data.predictions?.length > 0) {
          const closest = data.predictions.reduce((prev, curr) => {
            const currTime = new Date(curr.t).getTime();
            const prevTime = new Date(prev.t).getTime();
            const nowTime = now.getTime();
            return Math.abs(currTime - nowTime) < Math.abs(prevTime - nowTime) ? curr : prev;
          });

          return {
            height: parseFloat(closest.v),
            height_mhw: mhwMllwOffset !== null ? parseFloat(closest.v) - mhwMllwOffset : null,
            station: name,
            id,
            mhw_mllw_offset: mhwMllwOffset,
          };
        }
      } catch (_error) {
      }
    }

    return null;
  }

  async fetchCurrent(id, name) {
    const now = new Date();
    const beginDate = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0]
      .replace(/-/g, "");

    const urls = [
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${beginDate}&range=24&station=${id}&product=currents&units=english&time_zone=lst_ldt&format=json`,
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${beginDate}&range=48&station=${id}&product=currents_predictions&units=english&time_zone=lst_ldt&format=json`,
    ];

    for (const url of urls) {
      try {
        const response = await this.fetchWithTimeout(url);
        const data = await response.json();

        if (data.error) {
          continue;
        }

        const list = data.data || data.current_predictions?.cp;
        if (list?.length > 0) {
          const closest = list.reduce((prev, curr) => {
            const prevTime = new Date(prev.t || prev.Time).getTime();
            const currTime = new Date(curr.t || curr.Time).getTime();
            const nowTime = now.getTime();
            return Math.abs(currTime - nowTime) < Math.abs(prevTime - nowTime) ? curr : prev;
          });

          const velocity = parseFloat(closest.s || closest.v || closest.Velocity_Major || 0);
          const direction = parseInt(closest.d || (velocity >= 0 ? closest.meanFloodDir : closest.meanEbbDir) || 0, 10);

          return {
            speed: velocity,
            direction,
            station: name,
            id,
          };
        }
      } catch (_error) {
      }
    }

    return null;
  }

  findNearestStations(lat, lon, type, limit) {
    const query = `
      SELECT id, name, station_type
      FROM noaa_stations
      WHERE data_type LIKE ?
      ORDER BY 
        CASE station_type
          WHEN 'H' THEN 1
          WHEN 'P' THEN 2
          WHEN 'S' THEN 3
          ELSE 4
        END,
        ST_Distance(geometry, MakePoint(?, ?, 4326))
      LIMIT ?
    `;

    try {
      return this.db.prepare(query).all(`${type[0]}%`, lon, lat, limit);
    } catch (_error) {
      return [];
    }
  }

  async fetchWithTimeout(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      return await fetch(url, {
        headers: this.headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export default NexusTideService;
