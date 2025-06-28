import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import Device from './models/Device';

// Get the directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DeviceStorage {
  constructor(path) {
    this.path = path;
    this.devices = new Map();
    this.load();
  }
  
  async load() {
    try {
      await fs.access(this.path);
      const data = JSON.parse(await fs.readFile(this.path, 'utf8'));
      for (const deviceData of data) {
        this.devices.set(deviceData.mac, new Device(deviceData));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Error loading device storage:', err);
      }
    }
  }
  
  async save() {
    try {
      const data = [...this.devices.values()].map(d => d.toJSON());
      await fs.writeFile(this.path, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Error saving device storage:', err);
      throw err;
    }
  }
}

export default DeviceStorage;