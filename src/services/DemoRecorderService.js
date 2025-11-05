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
  /**
   * @param {Object} [options]
   * @param {string} [options.outputDir] Directory to store recordings
   * @param {string[]} [options.events] Event names to capture via ServiceManager event bus
   * @param {string} [options.filePrefix] Prefix for generated recording files
   */
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

    this._eventListener = (payload) => {
      if (!payload || !payload.event || !this.eventsToRecord.includes(payload.event)) {
        return;
      }

      const entry = {
        seq: ++this._sequence,
        timestamp: new Date().toISOString(),
        service: payload.service,
        event: payload.event,
        data: payload.args && payload.args.length === 1 ? payload.args[0] : payload.args,
      };

      this._recordStream.write(`${JSON.stringify(entry)}\n`);
    };

    serviceManager.on("*", this._eventListener);

    await super.start();
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    if (this._eventListener) {
      serviceManager.off("*", this._eventListener);
      this._eventListener = null;
    }

    await new Promise((resolve) => {
      if (!this._recordStream) {
        resolve();
        return;
      }

      this._recordStream.end(() => {
        this._recordStream = null;
        resolve();
      });
    });

    await super.stop();
  }
}
