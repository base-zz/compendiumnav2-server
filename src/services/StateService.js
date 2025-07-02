import ContinuousService from './ContinuousService.js';
import { stateData } from '../state/StateData.js';

export class StateService extends ContinuousService {
  constructor(initialState, options = {}) {
    super('state'); 
    // Destructure options with defaults
    const { mockData, updateIntervalMs } = {
      mockData: false,
      updateIntervalMs: 5000,
      ...options,
    };

    // Initialize instance properties
    this.state = initialState || {};
    this.clients = new Set();
    this.useMockData = mockData;
    this.updateIntervalMs = updateIntervalMs;
    this.updateInterval = null;

    // Bind the handler once to allow for proper removal on stop
    this._stateUpdateHandler = (path, value) => {
      const update = { [path]: value };
      this.emit('state:update', update);
      
      if (path.startsWith('navigation.')) {
        this.emit('navigation:update', update);
      }
    };
  }

  async _startService() {
    this.log('Starting State Service...');
    this.setupStateUpdateEmitter();

    if (this.useMockData) {
      this.log(`Starting mock data updates every ${this.updateIntervalMs}ms`);
      this.updateInterval = setInterval(() => {
        // This is a placeholder for mock data generation logic
        this.log('Updating with mock data...', 'debug');
      }, this.updateIntervalMs);
    }
    
    this.log('State Service started');
  }

  async _stopService() {
    this.log('Stopping State Service');
    
    // Cleanup: remove the event listener to prevent memory leaks
    if (this._stateUpdateHandler) {
      stateData.off('update', this._stateUpdateHandler);
      this.log('Stopped listening to state data updates');
    }

    // Cleanup: stop the mock data interval
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      this.log('Stopped mock data updates');
    }

    // Disconnect all WebSocket clients
    this.log(`Disconnecting ${this.clients.size} clients.`);
    this.clients.forEach(client => {
      client.close(1000, 'Server is shutting down');
    });
    this.clients.clear();

    this.log('State Service stopped');
  }

  setupStateUpdateEmitter() {
    this.log('Setting up state update emitter.');
    stateData.on('update', this._stateUpdateHandler);
  }

  getState() {
    return stateData.state || {};
  }

  updateState(updates) {
    if (stateData.batchUpdate) {
      stateData.batchUpdate(updates);
    } else {
      Object.assign(stateData.state || (stateData.state = {}), updates);
      this.emit('state:update', updates);
    }
  }

  subscribe(ws) {
    this.clients.add(ws);
    this.log(`Client subscribed. Total clients: ${this.clients.size}`);
    ws.on('close', () => this.unsubscribe(ws));
    return () => this.unsubscribe(ws);
  }

  unsubscribe(ws) {
    this.clients.delete(ws);
    this.log(`Client unsubscribed. Total clients: ${this.clients.size}`);
  }

  broadcast(message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    this.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(data);
      }
    });
  }
}
