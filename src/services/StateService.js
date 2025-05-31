import ContinuousService from './ContinuousService.js';
import { stateData } from '../state/StateData.js';

export class StateService extends ContinuousService {
  constructor() {
    super('state');
    this.clients = new Set();
  }

  async start() {
    await super.start();
    console.log('[StateService] Starting state service...');
    
    // Set up any WebSocket server or other continuous operations
    this.setupStateUpdateEmitter();
    
    console.log('[StateService] State service started');
  }

  setupStateUpdateEmitter() {
    // Listen for state changes and emit events
    // Note: This assumes stateData is an EventEmitter that emits 'update' events
    // You may need to adapt this based on your actual state management implementation
    stateData.on('update', (path, value) => {
      const update = { [path]: value };
      this.emit('state:update', update);
      
      // Also emit specific events for certain paths
      if (path.startsWith('navigation.')) {
        this.emit('navigation:update', update);
      }
      // Add more specific event types as needed
    });
  }

  // Get current state
  getState() {
    // Adapt this based on your state management implementation
    return stateData.state || {};
  }

  // Update state
  updateState(updates) {
    // Adapt this based on your state management implementation
    if (stateData.batchUpdate) {
      stateData.batchUpdate(updates);
    } else {
      // Fallback implementation
      Object.assign(stateData.state || (stateData.state = {}), updates);
      this.emit('state:update', updates);
    }
  }

  // Subscribe to state changes (for WebSocket clients)
  subscribe(ws) {
    this.clients.add(ws);
    ws.on('close', () => this.unsubscribe(ws));
    return () => this.unsubscribe(ws);
  }

  unsubscribe(ws) {
    this.clients.delete(ws);
  }

  // Broadcast to all connected clients
  broadcast(message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    this.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(data);
      }
    });
  }
}
