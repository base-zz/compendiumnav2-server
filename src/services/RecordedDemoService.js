import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';

console.log('[SERVICE] RecordedDemoService module loaded');
import BaseService from './BaseService.js';

/**
 * RecordedDemoService
 *
 * Plays back a previously-recorded JSONL file line-by-line,
 * emitting the same events that DemoRecorderService captured.
 * Use `--demo <file>` to activate.
 */
export default class RecordedDemoService extends BaseService {
  constructor(options = {}) {
    super('recorded-demo', 'continuous');

    const defaultFile = path.join(process.cwd(), 'data', 'demo-recordings', 'latest.jsonl');
    this.filePath = options.file || defaultFile;
    this.speed = options.speed || 1; // 1 = real-time, 2 = 2×, etc.
    this.lines = [];
    this.index = 0;
    this.startTime = null;
    this.firstTimestamp = null;
    this.loopDelay = options.loopDelay ?? 1000; // milliseconds between loops
    this._currentTimeout = null;
  }

  async start() {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`Demo file not found: ${this.filePath}`);
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    this.lines = raw
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));

    if (this.lines.length === 0) {
      throw new Error('Demo file is empty');
    }

    this.firstTimestamp = this.lines[0].timestamp;
    this.startTime = Date.now();
    this.index = 0;

    this.log(`Loaded ${this.lines.length} demo events from ${this.filePath}`);
    this.scheduleNext();
  }

  scheduleNext() {
    if (this.index >= this.lines.length) {
      this.log('Demo playback complete, restarting loop');
      this.startTime = Date.now() + this.loopDelay;
      this.firstTimestamp = this.lines[0].timestamp;
      this.index = 0;

      this._currentTimeout = setTimeout(() => {
        this.startTime = Date.now();
        this.scheduleNext();
      }, Math.max(0, this.loopDelay));
      return;
    }

    const entry = this.lines[this.index];
    const targetDelta = (entry.timestamp - this.firstTimestamp) / this.speed;
    const elapsed = Date.now() - this.startTime;
    const delay = Math.max(0, targetDelta - elapsed);

    this._currentTimeout = setTimeout(() => {
      this.emit(entry.event, entry.data);
      this.index++;
      this.scheduleNext();
    }, delay);
  }

  async stop() {
    this.log('Stopping demo playback');
    if (this._currentTimeout) {
      clearTimeout(this._currentTimeout);
      this._currentTimeout = null;
    }
  }
}
