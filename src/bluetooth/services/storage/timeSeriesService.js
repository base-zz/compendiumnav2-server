import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TimeSeriesService {
  constructor(basePath = path.join(process.cwd(), 'data', 'timeseries')) {
    this.basePath = basePath;
    this.retentionPolicies = {
      raw: 30 * 24 * 60 * 60 * 1000,       // 30 days in ms
      hourly: 90 * 24 * 60 * 60 * 1000,    // 90 days in ms
      daily: 365 * 24 * 60 * 60 * 1000,    // 1 year in ms
      monthly: 5 * 365 * 24 * 60 * 60 * 1000 // 5 years in ms
    };
  }

  async initialize() {
    await fs.mkdir(this.basePath, { recursive: true });
    await this._ensureDirectories(['raw', 'hourly', 'daily', 'monthly']);
  }

  async _ensureDirectories(dirs) {
    await Promise.all(
      dirs.map(dir => 
        fs.mkdir(path.join(this.basePath, dir), { recursive: true })
      )
    );
  }

  _getFilePath(deviceId, metric, resolution, timestamp = null) {
    const date = timestamp ? new Date(timestamp) : new Date();
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    
    return path.join(
      this.basePath,
      resolution,
      `${deviceId}`,
      `${year}-${month}`,
      `${year}-${month}-${day}.json`
    );
  }

  async addDataPoint(deviceId, metric, value, timestamp = new Date().toISOString()) {
    const point = {
      t: timestamp,
      v: value
    };

    // Save raw data point
    await this._appendToFile(
      this._getFilePath(deviceId, metric, 'raw'),
      point
    );

    // TODO: Queue for aggregation
    return point;
  }

  async _appendToFile(filePath, data) {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      
      let existing = [];
      try {
        const content = await fs.readFile(filePath, 'utf8');
        existing = JSON.parse(content);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      existing.push(data);
      await fs.writeFile(filePath, JSON.stringify(existing, null, 2) + os.EOL);
      
    } catch (error) {
      console.error(`Error writing to ${filePath}:`, error);
      throw error;
    }
  }

  async getDataPoints(deviceId, metric, { start, end, resolution = 'raw' }) {
    // TODO: Implement efficient time-range based querying
    // This is a simplified version that reads all data and filters in memory
    const filePath = this._getFilePath(deviceId, metric, resolution, start);
    
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const points = JSON.parse(content);
      
      return points.filter(point => {
        const pointTime = new Date(point.t).getTime();
        return (!start || pointTime >= new Date(start).getTime()) &&
               (!end || pointTime <= new Date(end).getTime());
      });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  // TODO: Implement cleanup job for expired data
  async cleanup() {
    // Implementation for cleaning up old data based on retention policies
  }
}

// Create and export a singleton instance
const timeSeriesService = new TimeSeriesService();

export default timeSeriesService;
