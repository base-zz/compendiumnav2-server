import EventEmitter from 'events';
import debug from 'debug';

const log = debug('state-mediator');
const logError = debug('state-mediator:error');
const logState = debug('state-mediator:state');

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
      logState('Received state:patch event from StateManager');
      if (patch && patch.data) {
        logState(`Patch contains ${Array.isArray(patch.data) ? patch.data.length : 'unknown'} operations`);
      }
      
      // Ensure the patch has the correct type property
      if (typeof patch === 'object' && patch !== null) {
        // Make sure the type is explicitly 'state:patch' (not 'patch')
        patch.type = 'state:patch';
      }
      
      // Send the patch directly without nesting it in a payload property
      // This matches the format expected by the client
      this.broadcast(patch);
    });

    this.stateManager.on('state:full-update', (state) => {
      logState('Received state:full-update event from StateManager');
      if (state) {
        logState(`Full state update with keys: ${Object.keys(state).join(', ')}`);
      }
      
      // Make sure the state has the correct type property
      if (typeof state === 'object' && state !== null) {
        if (!state.type) {
          state.type = 'state:full-update';
        }
      }
      
      // Send the state directly without nesting it in a payload property
      // This matches the format expected by the client
      this.broadcast(state);
    });

    this.stateManager.on('tide:update', (data) => {
        logState('Received tide:update event from StateManager');
        
        // Ensure the data has the correct type property
        if (typeof data === 'object' && data !== null) {
            if (!data.type) {
                data.type = 'tide:update';
            }
        }
        
        // Send the data directly without nesting it in a payload property
        // This matches the format expected by the client
        this.broadcast(data);
    });

    this.stateManager.on('weather:update', (data) => {
        logState('Received weather:update event from StateManager');
        logState(`Weather data type: ${typeof data}, is null: ${data === null}`);
        
        if (typeof data === 'object' && data !== null) {
            logState(`Weather data keys: ${Object.keys(data).join(', ')}`);
            logState(`Weather data has current: ${!!data.current}, has hourly: ${!!data.hourly}`);
            
            // Ensure the data has the correct type property
            if (!data.type) {
                logState('Adding missing type property to weather data');
                data.type = 'weather:update';
            } else {
                logState(`Weather data already has type: ${data.type}`);
            }
        } else {
            logError('Weather data is not an object or is null!');
        }
        
        // Send the data directly without nesting it in a payload property
        // This matches the format expected by the client
        logState(`Broadcasting weather data with type: ${data.type}`);
        this.broadcast(data);
        logState('Weather data broadcast completed');
    });

    log('State listeners configured.');
  }

  /**
   * Broadcasts a message to all registered transports.
   * @param {object} message - The message object to send.
   */
  broadcast(message) {
    const serializedMessage = JSON.stringify(message);
    logState(`Broadcasting message of type ${message.type} (${serializedMessage.length} bytes)`);
    logState(`Active transports: ${this.transports.length}, Relay client count: ${this.relayClientCount}`);

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
                logState(`Forwarding ${message.type} to RelayServer (clients: ${this.relayClientCount})`);
                transport.broadcast(serializedMessage);
                logState(`Successfully sent to RelayServer`);
            } else {
                logState(`Skipping broadcast to RelayServer (no clients connected)`);
            }
        } else {
            // Broadcast to all non-relay (i.e., direct) transports unconditionally.
            const transportName = transport.constructor ? transport.constructor.name : 'UnknownTransport';
            logState(`Forwarding ${message.type} to ${transportName}`);
            transport.broadcast(serializedMessage);
            logState(`Successfully sent to ${transportName}`);
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
