import BaseService from './BaseService.js';

/**
 * A service that runs continuously once started.
 * Extend this for services that need to maintain an active connection or state.
 */
class ContinuousService extends BaseService {
  /**
   * Create a new continuous service
   * @param {string} name - The name of the service (e.g., 'state')
   */
  constructor(name) {
    super(name, 'continuous');
  }
  
  /**
   * Start the continuous service
   * @override
   */
  async start() {
    if (this.isRunning) {
      return;
    }
    
    await super.start();
  }
  
  /**
   * Stop the continuous service
   * @override
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    await super.stop();
    this.log('Continuous service stopped');
  }
}

export default ContinuousService;
