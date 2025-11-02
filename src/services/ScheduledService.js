import BaseService from './BaseService.js';

/**
 * A service that runs on a schedule.
 * Extend this for services that need to perform periodic tasks.
 */
class ScheduledService extends BaseService {
  /**
   * Create a new scheduled service
   * @param {string} name - The name of the service (e.g., 'weather', 'tidal')
   * @param {Object} [options] - Configuration options
   * @param {number} [options.interval=3600000] - Interval between runs in milliseconds
   * @param {boolean} [options.immediate=true] - Whether to run immediately on start
   * @param {boolean} [options.runOnInit=false] - Whether to run when the service starts
   * @param {number} [options.scanDuration] - Duration of each scan in ms (for scanning services)
   * @param {string} [options.ymlPath] - Path to YAML configuration file (for services that use YAML configs)
   */
  constructor(name, options = {}) {
    super(name, 'scheduled');
    
    this.options = {
      interval: 3600000, // 1 hour default
      immediate: true,
      runOnInit: false,
      ...options
    };
    
    this._timeout = null;
    this._isRunningTask = false;
    this.runCount = 0;
    this.lastRun = null;
    this.nextRun = null;
    this.lastError = null;
    
    this.log(`Initialized with interval: ${this.options.interval}ms`);
  }
  
  /**
   * Start the scheduled service
   * @override
   */
  async start() {
    if (this.isRunning) {
      this.log('Scheduled service is already running');
      return;
    }
    
    try {
      this.log('Starting scheduled service');
      await super.start();

      // Schedule the next run but don't run immediately
      this._scheduleNextRun(false);
      this.log('Scheduled service started successfully');
      
      // If immediate is true, run the first task after the service is fully started
      if (this.options.immediate) {
        this.log('Running initial task immediately');
        await this._executeTask();
      } else if (this.options.runOnInit) {
        this.log('Running onInit task');
        await this._executeTask();
      }
      
    } catch (error) {
      this.logError('Error starting scheduled service:', error);
      this.emit(`service:${this.name}:error`, { 
        error: error.message,
        code: error.code,
        timestamp: new Date()
      });
      throw error;
    }
  }
  
  /**
   * Stop the scheduled service
   * @override
   */
  async stop() {
    if (!this.isRunning) {
      this.log('Scheduled service is not running');
      return;
    }
    
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
    
    await super.stop();
    this.log('Scheduled service stopped');
  }
  
  /**
   * Schedule the next run of the service
   * @private
   * @param {boolean} immediate - Whether to run immediately
   */
  _scheduleNextRun(immediate = false) {
    if (!this.isRunning) return;
    
    if (this._timeout) {
      clearTimeout(this._timeout);
    }
    
    const now = Date.now();
    const nextRunTime = immediate ? now : now + this.options.interval;
    const delay = Math.max(0, nextRunTime - now);
    
    this.nextRun = new Date(now + delay);
    
    this._timeout = setTimeout(() => {
      this._executeTask();
    }, delay);
    
    this.log(`Next run scheduled in ${Math.round(delay / 1000)} seconds`);
  }
  
  /**
   * Execute the scheduled task
   * @private
   * @emits {string} service:{name}:task:start - When a task starts
   * @emits {string} service:{name}:task:complete - When a task completes successfully
   * @emits {Error} service:{name}:task:error - When a task fails
   * @returns {Promise<*>} The result of the task
   */
  async _executeTask() {
    if (this._isRunningTask) {
      this.log('Task is already running, skipping this execution');
      return;
    }
    
    const taskId = Date.now();
    this._isRunningTask = true;
    this.lastRun = new Date();
    this.lastError = null;
    
    try {
      this.log(`Starting task #${taskId}`);
      this.emit(`service:${this.name}:task:start`, { 
        taskId, 
        timestamp: this.lastRun 
      });
      
      // Execute the task
      const startTime = process.hrtime();
      const result = await this.run.call(this);
      const [seconds, nanoseconds] = process.hrtime(startTime);
      const duration = Math.round((seconds * 1000) + (nanoseconds / 1000000));
      
      this.runCount++;
      this.lastUpdated = new Date();
      
      this.log(`Task #${taskId} completed in ${duration}ms`);
      this.emit(`service:${this.name}:task:complete`, { 
        taskId, 
        duration,
        timestamp: this.lastUpdated,
        result
      });
      
      return result;
    } catch (error) {
      this.lastError = error;
      this.logError(`Task #${taskId} failed:`, error);
      
      const errorData = {
        taskId,
        error: error.message,
        code: error.code,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        timestamp: new Date()
      };
      
      this.emit(`service:${this.name}:task:error`, errorData);
      throw error;
    } finally {
      this._isRunningTask = false;
      
      // Schedule the next run
      if (this.isRunning) {
        this._scheduleNextRun(false);
      }
    }
  }
  
  /**
   * The task to be executed on each run.
   * Must be implemented by subclasses.
   * @abstract
   * @returns {Promise<*>} The result of the task
   */
  async run() {
    throw new Error('Subclasses must implement the run method');
  }
  
  /**
   * Get the status of the scheduled service
   * @override
   * @returns {Object} Service status
   */
  getStatus() {
    return {
      ...super.getStatus(),
      runCount: this.runCount,
      lastRun: this.lastRun,
      nextRun: this.nextRun,
      isRunningTask: this._isRunningTask,
      interval: this.options.interval
    };
  }
}

export default ScheduledService;
