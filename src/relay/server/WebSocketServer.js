import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

/**
 * RelayWebSocketServer
 * 
 * Handles WebSocket connections for the relay server
 */
export class RelayWebSocketServer {
  constructor(relayServer, options = {}) {
    this.relayServer = relayServer;
    
    // Ensure we prioritize the PORT environment variable
    this.port = parseInt(process.env.VPS_WS_PORT, 10);
    if (isNaN(this.port)) throw new Error('Invalid VPS_WS_PORT in .env.server');
    
    this.options = {
      port: this.port,
      path: process.env.VPS_PATH,
      ...options
    };
    
    console.log(`[WS-INIT] Configuring WebSocket server on port ${this.options.port}`);
    
    this.server = null;
    this.clients = new Map();
  }
  
  /**
   * Initialize the WebSocket server
   */
  initialize() {
    // Create HTTP server first
    const httpServer = createServer();
    
    // Create WebSocket server using the HTTP server
    this.server = new WebSocketServer({
      server: httpServer,
      path: this.options.path,
      // Enable ping/pong
      clientTracking: true,
      // Set ping interval to 30 seconds
      pingInterval: 30000,
      // Set ping timeout to 10 seconds
      pingTimeout: 10000
    });
    
    // Start HTTP server
    return new Promise((resolve, reject) => {
      httpServer.listen(this.options.port, () => {
        console.log(`[WS] WebSocket server started on port ${this.options.port} with path ${this.options.path}`);
        this._setupEventHandlers();
        resolve(this);
      });
      
      httpServer.on('error', (error) => {
        console.error('[WS] Failed to start server:', error);
        reject(error);
      });
    });
  }
  
  /**
   * Set up WebSocket event handlers
   */
  _setupEventHandlers() {
    // Set up ping interval
    this._setupPingInterval();
    
    // Listen for state events from the RelayServer's StateManager
    // This ensures that anchor updates and other state changes are broadcast to clients
    this.relayServer.stateManager.on('state:patch', (payload) => {
      console.log(`[WS] Received state patch event with ${payload.data?.length || 0} operations`);
      this._broadcastToSubscribers(payload);
    });
    
    this.relayServer.stateManager.on('state:full-update', (payload) => {
      console.log(`[WS] Received full state update event`);
      this._broadcastToSubscribers(payload);
    });
    
    this.server.on('connection', (ws, req) => {
      const clientId = uuidv4();
      
      // Extract token from URL parameters
      const url = new URL(`http://${req.headers.host}${req.url}`);
      const token = url.searchParams.get('token');
      
      // Validate token
      if (!token) {
        console.warn(`[WS] Client ${clientId} attempted to connect without token`);
        ws.close(4001, 'Authentication required');
        return;
      }
      
      // Validate the token
      const validation = this.relayServer.validateToken(token);
      if (!validation.valid) {
        console.warn(`[WS] Client ${clientId} provided invalid token: ${validation.reason}`);
        ws.close(4001, validation.reason);
        return;
      }
      
      // Set user context from token
      ws.userId = validation.userId;
      ws.vesselId = validation.vesselId;
      
      // Store client with user context
      this.clients.set(clientId, ws);
      
      // Set properties on the WebSocket object to track its state
      ws.isAlive = true;
      ws.clientId = clientId;
      
      // Handle pong messages to keep connection alive
      ws.on('pong', () => {
        ws.isAlive = true;
        console.log(`[WS] Received pong from client ${clientId}`);
      });
      
      // Register client with relay server
      this.relayServer.addClient(clientId);
      
      console.log(`[WS] Client ${clientId} connected from ${req.socket.remoteAddress}`);
      
      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connection',
        status: 'connected',
        clientId,
        timestamp: Date.now()
      }));
      
      // Handle client messages
      ws.on('message', (message) => {
        console.log(`[WS] Received raw message from client ${clientId}:`, message.toString());
        console.log(`[WS] Message type:`, typeof message);
        console.log(`[WS] Message length:`, message.length);
        
        try {
          const data = JSON.parse(message);
          console.log(`[WS] Parsed message from client ${clientId}:`, JSON.stringify(data));
          console.log(`[WS] Message type:`, data.type);
          console.log(`[WS] Message action:`, data.action);
          console.log(`[WS] Message data:`, JSON.stringify(data.data));
          this._handleClientMessage(clientId, data);
        } catch (error) {
          console.error(`[WS] Error parsing message from client ${clientId}:`, error);
          console.error(`[WS] Error message:`, error.message);
          console.error(`[WS] Error stack:`, error.stack);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format',
            timestamp: Date.now()
          }));
        }
      });
      
      // Handle client disconnection
      ws.on('close', () => {
        console.log(`[WS] Client ${clientId} disconnected`);
        this.relayServer.removeClient(clientId);
        this.clients.delete(clientId);
      });
      
      // Handle errors
      ws.on('error', (error) => {
        console.error(`[WS] Error with client ${clientId}:`, error);
      });
    });
    
    // Listen for data from the relay server to send to clients
    this.relayServer.on('dataToSend', (data) => {
      if (process.env.DEBUG === 'true') {
        console.log(`[WS] Received dataToSend event with type: ${data.type}`);
      }
      this._broadcastToSubscribers(data);
    });
  }
  
  /**
   * Handle messages from clients
   */
  _handleClientMessage(clientId, message) {
    const { type, action, data } = message;
    
    if (process.env.DEBUG === 'true') {
      console.log(`[WS-DEBUG] Received message from client ${clientId}:`, JSON.stringify(message));
    }
    
    switch (type) {
      case 'subscription':
        // Handle subscription changes
        if (action === 'update' && Array.isArray(data)) {
          console.log(`[WS] Client ${clientId} updated subscriptions to:`, data);
          this.relayServer.updateClientSubscriptions(clientId, data);
          this._sendToClient(clientId, {
            type: 'subscription',
            status: 'updated',
            subscriptions: data,
            timestamp: Date.now()
          });
        }
        break;
        
      case 'anchor:update':
        // Handle anchor state updates from clients
        if (data) {
          console.log(`[WS] Received anchor update from client ${clientId}`);
          
          // Forward the anchor data to the StateManager
          // The StateManager is the single source of truth for state changes
          const success = this.relayServer.stateManager.updateAnchorState(data);
          
          // Acknowledge receipt
          this._sendToClient(clientId, {
            type: 'anchor:update:ack',
            success,
            timestamp: Date.now()
          });
        }
        break;
        
      case 'command':
        // Handle commands (e.g., for anchor, navigation, alerts)
        console.log(`[WS] Received command from client ${clientId}:`, message);
        
        // Process command based on service and action
        if (message.service && message.action) {
          switch (message.service) {
            case 'alert':
              this._handleAlertCommand(clientId, message.action, message.data);
              break;
            // Other services would be handled here
            default:
              console.warn(`[WS] Unknown service in command from client ${clientId}:`, message.service);
          }
        }
        break;
        
      case 'ping':
        // Handle ping messages
        this._sendToClient(clientId, {
          type: 'pong',
          timestamp: Date.now()
        });
        break;
        
      case 'get-full-state':
        // Fetch the current state from the relay server's StateManager
        const fullState = this.relayServer.stateManager.getState();
        this._sendToClient(clientId, {
          type: 'state:full-update',
          data: fullState,
          timestamp: Date.now()
        });
        break;
      default:
        console.warn(`[WS] Unknown message type from client ${clientId}:`, message);
    }
  }

  
  /**
   * Send data to a specific client
   */
  _sendToClient(clientId, data) {
    const client = this.clients.get(clientId);
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    } else if (client) {
      console.warn(`[WS] Cannot send to client ${clientId} - readyState: ${client.readyState}`);
    }
  }
  
  /**
   * Send data to all clients
   */
  _sendToAllClients(message) {
    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }
  
  /**
   * Handle alert commands from clients
   * @param {string} clientId - The client ID
   * @param {string} action - The alert action (e.g., 'update')
   * @param {Object} data - The alert data
   * @private
   */
  _handleAlertCommand(clientId, action, data) {
    console.log(`[WS] Handling alert command from client ${clientId}:`, action, data);
    
    if (!data) {
      console.warn(`[WS] Missing data in alert command from client ${clientId}`);
      return;
    }
    
    switch (action) {
      case 'update':
        // Process the alert update
        this._processAlertUpdate(clientId, data);
        break;
      default:
        console.warn(`[WS] Unknown alert action from client ${clientId}:`, action);
    }
  }
  
  /**
   * Process an alert update from a client
   * @param {string} clientId - The client ID
   * @param {Object} alertData - The alert data
   * @private
   */
  _processAlertUpdate(clientId, alertData) {
    // Validate required fields
    if (!alertData.type || !alertData.status) {
      console.warn(`[WS] Invalid alert data from client ${clientId}:`, alertData);
      return;
    }
    
    // Create alert object based on the status
    if (alertData.status === 'triggered') {
      // Create a new alert
      const alert = {
        id: crypto.randomUUID(),
        type: 'system',
        category: 'anchor',
        source: alertData.type.includes('ais') ? 'ais_monitor' : 'anchor_monitor',
        level: alertData.data?.level || 'warning',
        label: this._getAlertLabel(alertData.type),
        message: alertData.data?.message || `Alert triggered: ${alertData.type}`,
        timestamp: alertData.timestamp || new Date().toISOString(),
        acknowledged: false,
        status: 'active',
        trigger: alertData.type,
        data: alertData.data || {},
        actions: ['acknowledge', 'mute'],
        phoneNotification: true,
        sticky: true,
        autoResolvable: alertData.autoResolvable !== undefined ? alertData.autoResolvable : true
      };
      
      // Add the alert to the state
      this._addAlertToState(alert);
      
      // Acknowledge receipt
      this._sendToClient(clientId, {
        type: 'alert:update:ack',
        success: true,
        alertId: alert.id,
        timestamp: Date.now()
      });
    } else if (alertData.status === 'resolved') {
      // Find and resolve the alert
      // This is handled by the StateManager's rule engine
      console.log(`[WS] Client ${clientId} requested to resolve alert of type: ${alertData.type}`);
    }
  }
  
  /**
   * Get a human-readable label for an alert type
   * @param {string} alertType - The alert type
   * @returns {string} The alert label
   * @private
   */
  _getAlertLabel(alertType) {
    switch (alertType) {
      case 'anchor_dragging':
        return 'Anchor Dragging';
      case 'critical_range':
        return 'Critical Range Exceeded';
      case 'ais_proximity':
        return 'AIS Proximity Warning';
      default:
        return 'Alert';
    }
  }
  
  /**
   * Add an alert to the state
   * @param {Object} alert - The alert to add
   * @private
   */
  _addAlertToState(alert) {
    // Ensure the alerts structure exists in the state
    const state = this.relayServer.stateManager.appState;
    if (!state.alerts) {
      state.alerts = { active: [], resolved: [] };
    }
    
    if (!state.alerts.active) {
      state.alerts.active = [];
    }
    
    // Add the alert to the active alerts
    state.alerts.active.push(alert);
    
    // Broadcast the updated state
    this.relayServer.stateManager.broadcastStateUpdate();
    
    console.log(`[WS] Added alert to state: ${alert.label}`);
  }
  
  /**
   * Broadcast data to all subscribed clients
   */
  _broadcastToSubscribers(data) {
    const { type } = data;
    
    // Debug: Log the data being broadcast
    if (process.env.DEBUG === 'true') {
      console.log(`[WS-DEBUG] Broadcasting ${type} data:`, JSON.stringify(data));
    }
    
    // For testing purposes, broadcast to all clients regardless of subscriptions
    console.log(`[WS] Broadcasting ${type} data to all clients`);
    console.log(`[WS] Number of clients: ${this.clients.size}`);
    
    if (this.clients.size === 0) {
      if (process.env.DEBUG === 'true') {
        console.log(`[WS-DEBUG] No clients connected, skipping broadcast`);
      }
      return;
    }
    
    this.clients.forEach((client, clientId) => {
      // Check if the client is open and ready to receive data
      if (client && client.readyState === WebSocket.OPEN) {
        if (process.env.DEBUG === 'true') {
          console.log(`[WS-DEBUG] Sending ${type} data to client ${clientId}`);
        }
        
        try {
          const jsonData = JSON.stringify(data);
          client.send(jsonData);
          
          if (process.env.DEBUG === 'true') {
            console.log(`[WS-DEBUG] Successfully sent ${type} data to client ${clientId}`);
          }
        } catch (error) {
          console.error(`[WS] Error sending data to client ${clientId}:`, error);
          console.error(`[WS] Error message:`, error.message);
        }
      } else if (client) {
        console.log(`[WS] Client ${clientId} not ready, readyState: ${client.readyState}`);
      } else {
        console.log(`[WS] Client ${clientId} is null or undefined`);
      }
    });
  }
  
  /**
   * Shutdown the WebSocket server
   */
  /**
   * Set up ping interval to keep connections alive
   */
  _setupPingInterval() {
    // Clear any existing interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    // Set up ping interval to check for dead connections
    this.pingInterval = setInterval(() => {
      console.log(`[WS] Checking connection status for ${this.clients.size} clients`);
      
      this.clients.forEach((ws, clientId) => {
        if (ws.isAlive === false) {
          console.log(`[WS] Client ${clientId} is not responding, terminating connection`);
          this.relayServer.removeClient(clientId);
          this.clients.delete(clientId);
          return ws.terminate();
        }
        
        // Mark as not alive, will be marked alive when pong is received
        ws.isAlive = false;
        console.log(`[WS] Sending ping to client ${clientId}`);
        
        // Send ping
        ws.ping((err) => {
          if (err) {
            console.error(`[WS] Error sending ping to client ${clientId}:`, err);
          }
        });
      });
    }, 30000); // Check every 30 seconds
    
    console.log('[WS] Ping interval set up');
  }
  
  /**
   * Shutdown the WebSocket server
   */
  shutdown() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    if (this.server) {
      this.server.close();
      console.log('[WS] WebSocket server shut down');
    }
  }
}
