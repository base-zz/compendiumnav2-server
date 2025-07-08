import EventEmitter from 'events';
import debug from 'debug';

const log = debug('cn2:state-mediator');
const logError = debug('cn2:state-mediator:error');

/**
 * @class StateMediator
 * @extends EventEmitter
 * @description
 * Acts as an intermediary between the StateManager and various server implementations (e.g., DirectServer, RelayServer).
 * It decouples the state logic from the transport logic.
 *
 * Responsibilities:
 * 1. Listens for state changes from the StateManager.
 * 2. Formats state updates into standardized messages.
 * 3. Broadcasts these messages to all registered transport layers (servers).
 * 4. Receives incoming messages from transport layers.
 * 5. Parses these messages and invokes the appropriate actions on the StateManager.
 */
class StateMediator extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./state/StateManager.js').StateManager} options.stateManager - The central state manager instance.
   */
  constructor({ stateManager }) {
    super();

    if (!stateManager) {
      throw new Error('StateMediator requires a stateManager instance.');
    }

    /** @type {import('./state/StateManager.js').StateManager} */
    this.stateManager = stateManager;
    this.transports = [];
    this.relayClientCount = 0; // Specifically track clients connected to the relay

    this._setupStateListeners();
    log('StateMediator initialized.');
  }

  /**
   * Registers a transport layer (e.g., a server) to receive broadcasts.
   * The transport must be an EventEmitter that emits 'message', 'client:connected', and 'client:disconnected' events,
   * and it must expose a `broadcast(message)` method.
   * @param {EventEmitter} transport - The transport instance.
   */
  registerTransport(transport) {
    const transportName = transport.constructor.name || 'UnnamedTransport';
    log(`Registering new transport: ${transportName}`);
    this.transports.push(transport);

    // Listen for incoming messages from this transport
    transport.on('message', ({ clientId, message }) => {
      this.handleIncomingMessage(clientId, message);
    });

    transport.on('client:connected', ({ clientId, platform }) => {
        this.stateManager.emit('client:connected', clientId, platform);
    });

    transport.on('client:disconnected', ({ clientId }) => {
        this.stateManager.emit('client:disconnected', clientId);
    });

    // Listen for client count updates, specifically from relay servers
    transport.on('client-count:update', (count) => {
        log(`Received client count update from ${transportName}: ${count}`);
        this.relayClientCount = count;
    });
  }

  /**
   * Sets up listeners for events from the StateManager.
   * @private
   */
  _setupStateListeners() {
    this.stateManager.on('state:patch', (patch) => {
      const message = {
        type: 'state:patch',
        payload: patch,
      };
      this.broadcast(message);
    });

    this.stateManager.on('state:full-update', (state) => {
      const message = {
        type: 'state:full-update',
        payload: state,
      };
      this.broadcast(message);
    });

    this.stateManager.on('tide:update', (data) => {
        const message = {
            type: 'tide:update',
            payload: data,
        };
        this.broadcast(message);
    });

    this.stateManager.on('weather:update', (data) => {
        const message = {
            type: 'weather:update',
            payload: data,
        };
        this.broadcast(message);
    });

    log('State listeners configured.');
  }

  /**
   * Broadcasts a message to all registered transports.
   * @param {object} message - The message object to send.
   */
  broadcast(message) {
    const serializedMessage = JSON.stringify(message);
    log(`Broadcasting message of type ${message.type}`);

    this.transports.forEach(transport => {
        // The transport must have a broadcast method to be considered.
        if (typeof transport.broadcast !== 'function') {
            logError(`Transport ${transport.constructor.name} does not have a broadcast method.`);
            return;
        }

        // Identify relay servers. This is a simple check; could be made more robust.
        const isRelay = transport.constructor.name === 'RelayServer';

        if (isRelay) {
            // Only send to the relay if it has active clients.
            if (this.relayClientCount > 0) {
                log(`Forwarding to RelayServer (clients: ${this.relayClientCount})`);
                transport.broadcast(serializedMessage);
            } else {
                log(`Skipping broadcast to RelayServer (no clients connected)`);
            }
        } else {
            // Broadcast to all non-relay (i.e., direct) transports unconditionally.
            transport.broadcast(serializedMessage);
        }
    });
  }

  /**
   * Handles an incoming message from any transport layer.
   * @param {string} clientId - The ID of the client that sent the message.
   * @param {object} message - The parsed message object.
   */
  handleIncomingMessage(clientId, message) {
    log(`Handling incoming message of type ${message.type} from client ${clientId}`);
    try {
        switch (message.type) {
            case 'identity':
                this.stateManager.emit('identity:received', { ...message.payload, clientId });
                break;

            case 'state:patch':
                this.stateManager.applyPatchAndForward(message.payload);
                break;
            
            case 'anchor:update':
                this.stateManager.updateAnchorState(message.payload);
                break;

            default:
                logError(`Unknown message type received: ${message.type}`);
        }
    } catch (error) {
        logError(`Error processing message from client ${clientId}:`, error);
    }
  }
}

export { StateMediator };
