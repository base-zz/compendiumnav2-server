import debug from 'debug';

/**
 * @typedef {Object} TransportRegistration
 * @property {(payload: any) => void} send
 * @property {(payload: any) => boolean} [shouldSend]
 */
const log = debug('client-sync');
const logWarn = debug('client-sync:warn');
const logError = debug('client-sync:error');

/**
 * Coordinates shared behavior between direct and relay servers.
 * Handles state manager event subscriptions, initial state dispatch,
 * and common inbound message processing.
 */
export class ClientSyncCoordinator {
  constructor(options) {
    const {
      stateManager,
      onClientCountChange,
    } = options || {};

    if (!stateManager) {
      throw new Error('ClientSyncCoordinator requires a stateManager');
    }

    this.stateManager = stateManager;
    this._clientCountListeners = new Set();
    this._transports = new Map();

    this._stateHandler = this._handleStateEvent.bind(this);
    this._tideHandler = this._handleTideUpdate.bind(this);
    this._weatherHandler = this._handleWeatherUpdate.bind(this);

    this._registerStateListeners();

    if (typeof onClientCountChange === 'function') {
      this.addClientCountListener(onClientCountChange);
    }
  }

  _registerStateListeners() {
    this.stateManager.on('state:patch', this._stateHandler);
    this.stateManager.on('state:full-update', this._stateHandler);
    this.stateManager.on('tide:update', this._tideHandler);
    this.stateManager.on('weather:update', this._weatherHandler);
  }

  _handleStateEvent(payload) {
    try {
      this._publish(payload);
    } catch (error) {
      logError('Failed to forward state event:', error);
    }
  }

  _handleTideUpdate(data) {
    try {
      console.log('[ClientSyncCoordinator] Received tide update, forwarding to clients');
      this._publish({
        type: 'tide:update',
        data,
        boatId: this.stateManager.boatId,
        timestamp: Date.now(),
      });
    } catch (error) {
      logError('Failed to forward tide update:', error);
    }
  }

  _handleWeatherUpdate(data) {
    try {
      console.log('[ClientSyncCoordinator] Received weather update, forwarding to clients');
      this._publish({
        type: 'weather:update',
        data,
        boatId: this.stateManager.boatId,
        timestamp: Date.now(),
      });
    } catch (error) {
      logError('Failed to forward weather update:', error);
    }
  }

  broadcastInitialState(send) {
    if (typeof send !== 'function') {
      throw new Error('broadcastInitialState requires a send function');
    }

    try {
      const state = this.stateManager.getState();
      send({
        type: 'state:full-update',
        data: state,
        boatId: this.stateManager.boatId,
        timestamp: Date.now(),
      });
    } catch (error) {
      logError('Failed to broadcast initial state:', error);
    }
  }

  normalizeInboundMessage(message) {
    if (!message || typeof message !== 'object') return message;

    if (
      message.serviceName === 'state' &&
      message.action &&
      message.data &&
      message.action.startsWith('bluetooth:')
    ) {
      const [, action] = message.action.split(':');
      return {
        type: `bluetooth:${action}`,
        ...message.data,
        boatId: message.boatId ?? message.data.boatId,
        source: message.source,
      };
    }

    if (
      message.type === 'command' &&
      message.service === 'bluetooth' &&
      message.action &&
      message.data
    ) {
      return {
        type: `bluetooth:${message.action}`,
        ...message.data,
        boatId: message.boatId ?? message.data.boatId,
        source: message.source,
      };
    }

    return message;
  }

  handleClientMessage({ message, respond, broadcast }) {
    const respondFn = typeof respond === 'function' ? respond : () => {};
    const broadcastFn = typeof broadcast === 'function'
      ? broadcast
      : (payload) => this._publish(payload);

    const normalized = this.normalizeInboundMessage(message);
    if (!normalized || typeof normalized !== 'object') {
      return false;
    }

    if (normalized.type === 'test' || normalized.action === 'test') {
      respondFn({
        type: 'test:response',
        success: true,
        message: 'Server received your test message!',
        timestamp: Date.now(),
      });
      return true;
    }

    if (
      normalized.type === 'state:request-full-update' ||
      normalized.type === 'get-full-state' ||
      normalized.type === 'request-full-state'
    ) {
      try {
        const state = this.stateManager.getState();
        respondFn({
          type: 'state:full-update',
          data: state,
          boatId: this.stateManager.boatId,
          timestamp: Date.now(),
          requestId: normalized.requestId,
          clientId: normalized.clientId,
        });
      } catch (error) {
        logError('Failed to service full state request:', error);
        respondFn({
          type: 'error',
          error: 'Failed to retrieve state',
          details: error.message,
        });
      }
      return true;
    }

    if (normalized.type === 'state:full-update' || normalized.type === 'state:patch') {
      try {
        broadcastFn(normalized);
      } catch (error) {
        logError(`Failed to broadcast ${normalized.type}:`, error);
      }
      return true;
    }

    if (normalized.type === 'anchor:update') {
      try {
        const success = this.stateManager.updateAnchorState(normalized);
        respondFn({
          type: 'anchor:update:ack',
          success,
          timestamp: Date.now(),
          receivedData: normalized.data ?? null,
        });
      } catch (error) {
        logError('Error processing anchor update:', error);
        respondFn({
          type: 'anchor:update:ack',
          success: false,
          error: error.message,
          timestamp: Date.now(),
        });
      }
      return true;
    }

    if (normalized.type === 'anchor:reset') {
      try {
        const success = this.stateManager.resetAnchorState();
        respondFn({
          type: 'anchor:reset:ack',
          success,
          timestamp: Date.now(),
        });
      } catch (error) {
        logError('Error processing anchor reset:', error);
        respondFn({
          type: 'anchor:reset:ack',
          success: false,
          error: error.message,
          timestamp: Date.now(),
        });
      }
      return true;
    }

    if (typeof normalized.type === 'string' && normalized.type.startsWith('bluetooth:')) {
      return this._handleBluetoothCommand(normalized, respondFn);
    }

    if (normalized.type === 'tide:update' || normalized.type === 'weather:update') {
      // Allow upstream updates to flow into the state manager when needed
      const updateFn = normalized.type === 'tide:update'
        ? this.stateManager.updateTide?.bind(this.stateManager)
        : this.stateManager.updateWeather?.bind(this.stateManager);

      if (typeof updateFn === 'function') {
        try {
          updateFn(normalized.data);
        } catch (error) {
          logError(`Failed to process ${normalized.type}:`, error);
          respondFn({
            type: 'error',
            error: `Failed to process ${normalized.type}`,
            details: error.message,
          });
          return true;
        }
      }

      try {
        broadcastFn(normalized);
      } catch (error) {
        logError(`Failed to broadcast ${normalized.type}:`, error);
      }
      return true;
    }

    return false;
  }

  _handleBluetoothCommand(message, respondFn) {
    const send = (action, payload) => {
      respondFn({
        type: 'bluetooth:response',
        action,
        timestamp: Date.now(),
        ...payload,
      });
    };

    const handlers = {
      onToggle: ({ enabled }) => {
        if (typeof enabled !== 'boolean') {
          send('toggle', { success: false, error: 'enabled must be boolean' });
          return true;
        }
        const success = this.stateManager.toggleBluetooth(enabled);
        send('toggle', {
          success,
          message: `Bluetooth ${enabled ? 'enabled' : 'disabled'}`,
        });
        return true;
      },
      onScan: ({ scanning }) => {
        if (typeof scanning !== 'boolean') {
          send('scan', { success: false, error: 'scanning must be boolean' });
          return true;
        }
        const success = this.stateManager.updateBluetoothScanningStatus(scanning);
        send('scan', {
          success,
          message: `Bluetooth scanning ${scanning ? 'started' : 'stopped'}`,
        });
        return true;
      },
      onSelect: ({ deviceId }) => {
        if (!deviceId) {
          send('select-device', { success: false, error: 'deviceId is required' });
          return true;
        }
        this.stateManager
          .setBluetoothDeviceSelected(deviceId, true)
          .then((result) => {
            send('select-device', { success: result, deviceId });
          })
          .catch((error) => {
            send('select-device', {
              success: false,
              deviceId,
              error: error.message,
            });
          });
        return true;
      },
      onDeselect: ({ deviceId }) => {
        if (!deviceId) {
          send('deselect-device', { success: false, error: 'deviceId is required' });
          return true;
        }
        this.stateManager
          .setBluetoothDeviceSelected(deviceId, false)
          .then((result) => {
            send('deselect-device', { success: result, deviceId });
          })
          .catch((error) => {
            send('deselect-device', {
              success: false,
              deviceId,
              error: error.message,
            });
          });
        return true;
      },
      onRename: ({ deviceId, name }) => {
        if (!deviceId || !name) {
          send('rename-device', { success: false, error: 'deviceId and name are required' });
          return true;
        }
        this.stateManager
          .updateBluetoothDeviceMetadata(deviceId, { name })
          .then((result) => {
            send('rename-device', {
              success: result,
              deviceId,
              message: result
                ? `Device ${deviceId} renamed to ${name}`
                : `Failed to rename device ${deviceId}`,
            });
          })
          .catch((error) => {
            send('rename-device', {
              success: false,
              deviceId,
              error: error.message,
            });
          });
        return true;
      },
      onUpdateMetadata: ({ deviceId, metadata }) => {
        if (!deviceId || !metadata) {
          send('update-metadata', { success: false, error: 'deviceId and metadata are required' });
          return true;
        }
        this.stateManager
          .updateBluetoothDeviceMetadata(deviceId, metadata)
          .then((result) => {
            send('update-metadata', {
              success: result,
              deviceId,
              message: result
                ? `Device ${deviceId} metadata updated`
                : `Failed to update metadata for device ${deviceId}`,
            });
          })
          .catch((error) => {
            send('update-metadata', {
              success: false,
              deviceId,
              error: error.message,
            });
          });
        return true;
      },
    };

    switch (message.type) {
      case 'bluetooth:toggle':
        return handlers.onToggle(message);
      case 'bluetooth:scan':
        return handlers.onScan(message);
      case 'bluetooth:select-device':
        return handlers.onSelect(message);
      case 'bluetooth:deselect-device':
        return handlers.onDeselect(message);
      case 'bluetooth:rename-device':
        return handlers.onRename(message);
      case 'bluetooth:update-metadata':
        return handlers.onUpdateMetadata(message);
      default:
        logWarn(`Unhandled bluetooth message type: ${message.type}`);
        return false;
    }
  }

  dispose() {
    this.stateManager.off('state:patch', this._stateHandler);
    this.stateManager.off('state:full-update', this._stateHandler);
    this.stateManager.off('tide:update', this._tideHandler);
    this.stateManager.off('weather:update', this._weatherHandler);
    this._clientCountListeners.clear();
    this._transports.clear();
  }

  addClientCountListener(listener) {
    if (typeof listener === 'function') {
      this._clientCountListeners.add(listener);
    }
  }

  removeClientCountListener(listener) {
    if (typeof listener === 'function') {
      this._clientCountListeners.delete(listener);
    }
  }

  handleClientConnection({ clientId }) {
    this._updateClientCount(this.stateManager.clientCount + 1, { clientId });

    // Broadcast initial state to the newly connected client via transport
    this.broadcastInitialState((payload) => {
      const enriched = {
        ...payload,
        clientId: clientId || payload.clientId || 'unknown',
      };
      this._publish(enriched);
    });
  }

  handleClientDisconnection({ clientId }) {
    const nextCount = Math.max(0, (this.stateManager.clientCount || 1) - 1);
    this._updateClientCount(nextCount, { clientId });
  }

  handleClientCountUpdate({ boatId, clientCount }) {
    if (!this.stateManager || typeof this.stateManager.boatId === 'undefined') {
      return;
    }

    if (boatId && boatId !== this.stateManager.boatId) {
      return;
    }

    this._updateClientCount(clientCount);
  }

  hasConnectedClients() {
    return (this.stateManager?.clientCount ?? 0) > 0;
  }

  getClientCount() {
    return this.stateManager?.clientCount ?? 0;
  }

  _updateClientCount(count, context = {}) {
    if (typeof count !== 'number' || count < 0) {
      return;
    }

    const previous = this.stateManager.clientCount;
    if (typeof this.stateManager.updateClientCount === 'function') {
      this.stateManager.updateClientCount(count);
    }

    if (previous !== count) {
      const payload = {
        type: 'client-count:update',
        data: {
          boatId: this.stateManager.boatId,
          clientCount: count,
          previousCount: previous,
          ...context,
        },
        timestamp: Date.now(),
      };

      try {
        this._publish(payload);
      } catch (error) {
        logError('Failed to publish client count update:', error);
      }

      for (const listener of this._clientCountListeners) {
        try {
          listener(payload.data);
        } catch (listenerError) {
          logError('Client count listener failed:', listenerError);
        }
      }
    }
  }

  registerTransport(name, transport) {
    if (!name) {
      throw new Error('Transport name is required');
    }
    if (!transport || typeof transport.send !== 'function') {
      throw new Error('Transport send handler must be a function');
    }

    this._transports.set(name, {
      send: transport.send,
      shouldSend: typeof transport.shouldSend === 'function' ? transport.shouldSend : undefined,
    });

    return () => this.unregisterTransport(name);
  }

  unregisterTransport(name) {
    this._transports.delete(name);
  }

  _publish(payload) {
    console.log(`[ClientSyncCoordinator] Publishing message type: ${payload.type} to ${this._transports.size} transports`);
    this._transports.forEach(({ send, shouldSend }, name) => {
      try {
        if (typeof shouldSend === 'function' && !shouldSend(payload)) {
          return;
        }
        send(payload);
      } catch (error) {
        logError(`Transport '${name}' failed to send payload:`, error);
      }
    });
  }

  getBoatId() {
    return this.stateManager?.boatId;
  }
}

