import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class FileStorage {
  constructor(basePath = path.join(process.cwd(), 'data')) {
    this.basePath = basePath;
    this.devicesFile = path.join(basePath, 'devices.json');
    this.readingsDir = path.join(basePath, 'readings');
  }

  async initialize() {
    try {
      await fs.mkdir(this.basePath, { recursive: true });
      await fs.mkdir(this.readingsDir, { recursive: true });
      
      try {
        await fs.access(this.devicesFile);
      } catch {
        await fs.writeFile(this.devicesFile, '[]' + os.EOL);
      }
    } catch (error) {
      throw new Error(`Storage initialization failed: ${error.message}`);
    }
  }

  // Device Management
  async getDevices() {
    try {
      const data = await fs.readFile(this.devicesFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async getDevice(id) {
    const devices = await this.getDevices();
    return devices.find(d => d.id === id) || null;
  }

  async saveDevice(device) {
    const devices = await this.getDevices();
    const index = devices.findIndex(d => d.id === device.id);
    
    if (index >= 0) {
      devices[index] = device;
    } else {
      devices.push(device);
    }

    await this._writeDevices(devices);
    return device;
  }

  async _writeDevices(devices) {
    await fs.writeFile(
      this.devicesFile, 
      JSON.stringify(devices, null, 2) + os.EOL
    );
  }

  // Readings Management
  _getReadingsPath(deviceId) {
    return path.join(this.readingsDir, `${deviceId}.json`);
  }

  async saveReading(deviceId, reading) {
    const filePath = this._getReadingsPath(deviceId);
    let readings = [];
    
    try {
      const data = await fs.readFile(filePath, 'utf8');
      readings = JSON.parse(data);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (!reading.timestamp) {
      reading.timestamp = new Date().toISOString();
    }

    readings.push(reading);

    const MAX_READINGS = 1000;
    if (readings.length > MAX_READINGS) {
      readings = readings.slice(-MAX_READINGS);
    }

    await fs.writeFile(
      filePath,
      JSON.stringify(readings, null, 2) + os.EOL
    );

    return readings.length;
  }

  async getReadings(deviceId, limit = 100) {
    try {
      const filePath = this._getReadingsPath(deviceId);
      const data = await fs.readFile(filePath, 'utf8');
      const readings = JSON.parse(data);
      return readings.slice(-limit);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
}

export default FileStorage;
