import EventEmitter from "events";
import debug from 'debug';
import { VPSConnector } from "./services/VPSConnector.js";

const log = debug('cn2:relay');
const logError = debug('cn2:error:relay');

/**
 * A complete, mediator-compliant server that connects to a remote VPS.
 * This class preserves all original logic for VPS connection, client management,
 * and message forwarding, while conforming to the StateMediator's transport interface.
 */
export class RelayServer extends EventEmitter {
  constructor(config = {}) {
    super();
    log('RelayServer constructor called');

    if (!config.vpsUrl) throw new Error("RelayServer: vpsUrl is required");

    this.config = {
      vpsUrl: config.vpsUrl,
      vpsReconnectInterval: config.vpsReconnectInterval || 5000,
      vpsMaxRetries: config.vpsMaxRetries || 10,
    };

    this.clients = new Map();

    this.vpsConnector = new VPSConnector({
      vpsUrl: this.config.vpsUrl,
      reconnectInterval: this.config.vpsReconnectInterval,
      maxRetries: this.config.vpsMaxRetries,
    });

    this._setupConnectionListeners();
  }

  start() {
    return this.initialize();
  }

  async initialize() {
    log('Initializing RelayServer...');
    await this.vpsConnector.connect();
    log('RelayServer initialized.');
  }

  _setupConnectionListeners() {
    this.vpsConnector.on('connected', () => {
      log('RelayServer connected to VPS.');
    });

    this.vpsConnector.on('disconnected', () => {
      logError('RelayServer disconnected from VPS.');
      // Clear clients on disconnect
      this.clients.clear();
      this.emit('client-count:update', 0);
    });

    this.vpsConnector.on('message', (message) => {
      try {
        let data;
        
        // Handle different message types properly
        if (typeof message === 'string') {
          // Parse string messages
          data = JSON.parse(message);
        } else if (typeof message === 'object' && message !== null) {
          // Use object messages directly
          data = message;
        } else {
          // Log and ignore invalid message types
          logError('Received invalid message type from VPS:', typeof message);
          return;
        }
        
        this._handleVpsMessage(data);
      } catch (error) {
        logError('Error parsing message from VPS:', error);
        logError('Message content that caused error:', message);
      }
    });
  }

  _handleVpsMessage(data) {
    const { clientId, type, payload } = data;

    switch (type) {
      case 'client-connect':
        this.addClient(clientId);
        this.emit('client:connected', { clientId, platform: 'relay' });
        break;
      case 'client-disconnect':
        this.removeClient(clientId);
        this.emit('client:disconnected', { clientId });
        break;
      default:
        // Forward other messages to the mediator
        this.emit('message', { clientId, message: JSON.stringify(data) });
        break;
    }
  }

  addClient(clientId) {
    if (!this.clients.has(clientId)) {
      this.clients.set(clientId, { lastActivity: Date.now() });
      log(`Relay client connected: ${clientId}. Total clients: ${this.clients.size}`);
      this.emit('client-count:update', this.clients.size);
    }
  }

  removeClient(clientId) {
    if (this.clients.has(clientId)) {
      this.clients.delete(clientId);
      log(`Relay client disconnected: ${clientId}. Total clients: ${this.clients.size}`);
      this.emit('client-count:update', this.clients.size);
    }
  }

  /**
   * Broadcasts a message to the VPS, which then relays it to all connected clients.
   * @param {object} message The message to broadcast.
   */
  broadcast(message) {
    if (this.vpsConnector.connected) {
      // The VPS handles broadcasting, so we just send the message to it.
      // We wrap it in a standard format for the VPS to process.
      const vpsMessage = {
        type: 'broadcast', // Custom type for the VPS to recognize
        payload: message,
      };
      this.vpsConnector.send(JSON.stringify(vpsMessage));
    }
  }

  getClientCount() {
    return this.clients.size;
  }

  async shutdown() {
    log('Shutting down RelayServer...');
    await this.vpsConnector.shutdown();
    log('RelayServer has been shut down.');
  }
}
