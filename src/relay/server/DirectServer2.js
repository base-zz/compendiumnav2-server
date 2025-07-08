import { WebSocket as WS, WebSocketServer } from 'ws';
import EventEmitter from 'events';
import debug from 'debug';

const log = debug('cn2:direct');
const logError = debug('cn2:error:direct');
const logTrace = debug('cn2:trace:direct');

/**
 * A complete, mediator-compliant WebSocket server for local clients.
 * This class preserves all original logic including heartbeats and graceful shutdowns,
 * while conforming to the StateMediator's transport interface.
 */
export class DirectServer extends EventEmitter {
  start() {
    // The server is already started in the constructor, so this is a no-op.
    return Promise.resolve();
  }

  constructor(config) {
    super();

    if (!config || !config.port || !config.host) {
      throw new Error('DirectServer requires a config object with port and host.');
    }

    this.wss = new WebSocketServer({ port: config.port, host: config.host });
    this.clients = new Map();
    this.clientIdCounter = 0;

    this.wss.on('connection', this._handleConnection.bind(this));

    // Heartbeat mechanism to remove dead clients
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          log('Terminating dead client connection.');
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping(() => {});
      });
    }, 30000);

    log(`Direct server listening on ws://${config.host}:${config.port}`);
  }

  _handleConnection(ws) {
    const clientId = `direct-${++this.clientIdCounter}`;
    ws.isAlive = true;
    this.clients.set(clientId, ws);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    log(`New direct client connected: ${clientId}`);
    this.emit('client:connected', { clientId, platform: 'direct' });

    ws.on('message', (message) => {
      if (!ws.isAlive) return;
      try {
        const messageStr = message.toString();
        logTrace(`Received message from ${clientId}:`, messageStr);
        this.emit('message', { clientId, message: messageStr });
      } catch (error) {
        logError(`Error emitting message from ${clientId}:`, error);
      }
    });

    ws.on('close', () => {
      this.clients.delete(clientId);
      log(`Direct client disconnected: ${clientId}`);
      this.emit('client:disconnected', { clientId });
    });

    ws.on('error', (error) => {
      logError(`Error with direct client ${clientId}:`, error);
      this.clients.delete(clientId);
      this.emit('client:disconnected', { clientId });
    });
  }

  /**
   * Broadcasts a message to all connected, living clients.
   * @param {object} message The message to broadcast.
   */
  broadcast(message) {
    const serializedMessage = JSON.stringify(message);
    this.clients.forEach((clientWs) => {
      if (clientWs.isAlive && clientWs.readyState === WS.OPEN) {
        clientWs.send(serializedMessage);
      }
    });
  }

  /**
   * Sends a message to a single specific client.
   * @param {string} clientId The ID of the client to send the message to.
   * @param {object} message The message to send.
   */
  send(clientId, message) {
    const clientWs = this.clients.get(clientId);
    if (clientWs && clientWs.isAlive && clientWs.readyState === WS.OPEN) {
      clientWs.send(JSON.stringify(message));
    }
  }

  getClientCount() {
    return this.clients.size;
  }

  shutdown() {
    return new Promise((resolve) => {
      log('Shutting down direct server...');
      clearInterval(this.heartbeatInterval);
      this.wss.close(() => {
        log('Direct server has been shut down.');
        resolve();
      });
    });
  }
}
