import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";
import BaseService from "./BaseService.js";
import { serviceManager } from "./ServiceManager.js";

/**
 * DemoRecorderService
 *
 * Captures selected realtime events (state patches, full updates, device data, etc.)
 * and stores them as newline-delimited JSON for later playback.
 */
export default class DemoRecorderService extends BaseService {
  constructor(options = {}) {
    super("demo-recorder", "continuous");

    const defaultDir = path.join(process.cwd(), "data", "demo-recordings");
    const defaultEvents = [
      "state:patch",
      "state:full-update",
      "victron:update",
      "device:data",
      "device:discovered",
      "device:updated",
    ];

    this.outputDir = options.outputDir || defaultDir;
    this.eventsToRecord = Array.isArray(options.events) && options.events.length > 0
      ? options.events
      : defaultEvents;
    this.filePrefix = options.filePrefix || "demo";

    this._recordStream = null;
    this._eventListener = null;
    this._sequence = 0;
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    await fsPromises.mkdir(this.outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${this.filePrefix}-${timestamp}.jsonl`;
    const filePath = path.join(this.outputDir, fileName);
    this._recordStream = fs.createWriteStream(filePath, { flags: "a" });
    this._listeners = [];

    this.log(`Recording to ${filePath}`);

    // Get the state service to listen to its events directly
    const stateService = serviceManager.getService('state');
    if (!stateService) {
      throw new Error('State service not found - cannot record');
    }

    // Subscribe to each event directly from the state service
    for (const eventName of this.eventsToRecord) {
      const listener = (data) => {
        const entry = {
          seq: ++this._sequence,
          timestamp: Date.now(),
          event: eventName,
          data,
        };
        this._recordStream.write(`${JSON.stringify(entry)}\n`);
      };

      // Listen directly on the state service
      stateService.on(eventName, listener);
      this._listeners.push({ service: stateService, event: eventName, listener });
    }

    await super.start();
    this.log(`Started recording ${this.eventsToRecord.length} event types from state service`);
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    // Remove all event listeners
    if (this._listeners) {
      for (const { service, event, listener } of this._listeners) {
        service.off(event, listener);
      }
      this._listeners = [];
    }

    await new Promise((resolve) => {
      if (!this._recordStream) {
        resolve();
        return;
      }

      this._recordStream.end(() => {
        this.log(`Recording stopped. Wrote ${this._sequence} events`);
        this._recordStream = null;
        resolve();
      });
    });

    await super.stop();
  }
}
