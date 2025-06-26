import { WebSocket as WS, WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

/**
 * @typedef {import('ws').WebSocket} WebSocket
 * @typedef {import('ws').RawData} RawData
 * @typedef {import('ws').AddressInfo} AddressInfo
 * @typedef {import('http').Server} HttpServer
 * @typedef {import('net').Socket} NetSocket
 *
 * @typedef {Object} ExtendedWebSocket
 * @property {string} [clientId]
 * @property {string} [platform]
 * @property {string} [role]
 * @property {NetSocket} [_socket]
 */
import { stateManager2 as stateManager } from "../core/state/StateManager2.js";

/**
 * @param {Object} [options]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {boolean} [options.noServer]
 */
// Get the directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function startDirectServer(options = {}) {
  const PORT = options.port || parseInt(process.env.DIRECT_WS_PORT, 10);
  if (!PORT) throw new Error("DIRECT_WS_PORT must be specified");
  
  // Use host from options, environment, or default to all interfaces (IPv4)
  const HOST = options.host || process.env.DIRECT_WS_HOST || '0.0.0.0';
  
  // Ensure we're binding to all interfaces for mDNS to work
  console.log(`[DIRECT] Binding WebSocket server to ${HOST}:${PORT}`);
  
  // Create HTTP server
  const httpServer = createServer((req, res) => {
    // Respond to HTTP requests (optional)
    res.writeHead(200);
    res.end('Compendium Navigation Server\n');
  });

  // WebSocket server options
  /** @type {import('ws').ServerOptions} */
  const serverOptions = {
    server: httpServer,  // Attach to HTTP server
    host: HOST,
    noServer: options.noServer,
    maxPayload: 1024 * 1024, // 1MB
    clientTracking: true
  };

  console.log(`[DIRECT] Starting WebSocket server on ws://${HOST}:${PORT}`);
  
  // Create WebSocket server attached to HTTP
  /** @type {WebSocketServer} */
  const wss = new WebSocketServer(serverOptions);
  
  // Start the HTTP server
  httpServer.listen(PORT, HOST, () => {
    console.log(`[DIRECT] HTTP server running on http://${HOST}:${PORT}`);
  });
  
  // Store the server instance for later use
  /** @type {WebSocketServer} */
  const wsServerInstance = wss;
  
  wss.on('listening', () => {
    const address = wss.address();
    if (typeof address === 'string') {
      console.log(`[DIRECT] WebSocket server listening on ${address}`);
    } else {
      console.log(`[DIRECT] WebSocket server listening on ${address.address}:${address.port}`);
      console.log(`[DIRECT] Server is bound to: ${address.family === 'IPv6' ? 'IPv6' : 'IPv4'}`);
    }
  });

  // Handle connection errors
  wss.on('error', (error) => {
    console.error('[DIRECT] WebSocket server error:', error);
  });

  // Single connection handler for WebSocket connections
  wss.on('connection', (/** @type {WebSocket & ExtendedWebSocket} */ ws, request) => {
    const clientId = Math.random().toString(36).substring(2, 10);
    const clientIp = request.socket.remoteAddress;
    const origin = request.headers.origin || 'unknown';
    let isAlive = true;
    
    console.log(`[DIRECT] New connection from ${clientIp} (${clientId}), Origin: ${origin}`);
    console.log(`[DIRECT] Active clients: ${wss.clients.size}`);
    
    // Function to get a safe copy of the state
    const getSafeStateCopy = (state) => {
      try {
        return JSON.parse(JSON.stringify(state));
      } catch (error) {
        console.error('[DIRECT] Error cloning state:', error);
        return {};
      }
    };

    // Event handlers for state updates
    const onTideUpdate = (data) => {
      if (isAlive && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'tide:update',
          data
        }));
      }
    };
    
    const onWeatherUpdate = (data) => {
      if (isAlive && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'weather:update',
          data
        }));
      }
    };

    const onStateUpdate = (payload) => {
      if (isAlive && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    // Register event listeners
    stateManager.on('tide:update', onTideUpdate);
    stateManager.on('weather:update', onWeatherUpdate);
    stateManager.on('state:full-update', onStateUpdate);
    stateManager.on('state:patch', onStateUpdate);

    // Function to send initial state
    const sendInitialState = () => {
      if (!isAlive || ws.readyState !== ws.OPEN) return;
      
      try {
        const state = {
          ...getSafeStateCopy(stateManager.getState()),
          ...(stateManager.tideData && { tides: stateManager.tideData }),
          ...(stateManager.weatherData && { forecast: stateManager.weatherData })
        };

        ws.send(JSON.stringify({
          type: 'state:full-update',
          data: state,
          boatId: stateManager.boatId,
          timestamp: Date.now()
        }), (error) => {
          if (error) {
            console.error(`[DIRECT] Error sending initial state to ${clientId}:`, error);
          } else {
            console.log(`[DIRECT] Sent initial state to ${clientId}`);
          }
        });
      } catch (error) {
        console.error(`[DIRECT] Error preparing initial state:`, error);
      }
    };
    
    // Handle incoming messages
    ws.on('message', (message) => {
      if (!isAlive) return;
      
      try {
        let messageStr;
        if (typeof message === 'string') {
          messageStr = message;
        } else {
          messageStr = message.toString();
        }
        
        console.log(`[DIRECT] Received message from ${ws._socket?.remoteAddress || 'unknown'}:`, messageStr);
        
        // Parse the message
        let data;
        try {
          data = JSON.parse(messageStr);
          console.log(`[DIRECT] Parsed message type: ${data.type || 'unknown'}`);
          
          // Handle anchor updates
          if (data.type === 'anchor:update') {

            console.log('[DIRECT] Processing anchor:update message:', JSON.stringify(data, null, 2));
            const success = stateManager.updateAnchorState(data);
            console.log(`[DIRECT] Anchor update ${success ? 'succeeded' : 'failed'}`);
            
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'anchor:update:ack',
                success,
                timestamp: Date.now(),
                receivedData: data.data // Echo back the received data for debugging
              }));
            }
            return;
          }
          
          // Handle other message types...
          
        } catch (parseError) {
          console.error('[DIRECT] Error parsing message:', parseError);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Invalid message format',
              details: parseError.message
            }));
          }
          return;
        }
        
        console.log(`[DIRECT] Unhandled message type: ${data.type || 'unknown'}`);
      } catch (error) {
        console.error(`[DIRECT] Error processing message from ${clientId}:`, error);
      }
    });
    
    // Setup heartbeat
    const heartbeatInterval = setInterval(() => {
      if (isAlive && ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, 30000);
    
    // Handle pongs for heartbeat
    const heartbeat = () => {
      isAlive = true;
    };
    
    ws.on('pong', heartbeat);
    
    // Send initial state after a short delay
    const initTimer = setTimeout(sendInitialState, 100);
    
    // Handle client disconnection
    const cleanup = () => {
      if (!isAlive) return;
      isAlive = false;
      
      clearTimeout(initTimer);
      clearInterval(heartbeatInterval);
      
      // Remove all event listeners
      stateManager.off('tide:update', onTideUpdate);
      stateManager.off('weather:update', onWeatherUpdate);
      stateManager.off('state:full-update', onStateUpdate);
      stateManager.off('state:patch', onStateUpdate);
      
      console.log(`[DIRECT] Client ${clientIp} (${clientId}) disconnected`);
      console.log(`[DIRECT] Active clients: ${wss.clients.size}`);
    };
    
    ws.on('close', cleanup);
    ws.on('error', (error) => {
      console.error(`[DIRECT] WebSocket error from ${clientIp} (${origin}):`, error);
      cleanup();
    });
    
    // Set up connection timeout
    const connectionTimeout = setTimeout(() => {
      if (isAlive) {
        console.log(`[DIRECT] Connection timeout for ${clientId}, terminating`);
        ws.terminate();
      }
    }, 45000); // 45 seconds (longer than 2x the heartbeat interval)
    
    ws.once('pong', () => {
      clearTimeout(connectionTimeout);
    });
  });
  
  // Handle CORS headers for WebSocket upgrade
  wss.on('headers', (headers, request) => {
    const origin = request.headers.origin || 'unknown';
    console.log(`[DIRECT] WebSocket upgrade from ${request.socket.remoteAddress}, Origin: ${origin}`);
    
    // Allow all origins in development
    headers.push('Access-Control-Allow-Origin: *');
    headers.push('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    headers.push('Access-Control-Allow-Headers: Content-Type');  });
  
  // Wait for the server to be ready
  await new Promise((resolve) => wss.on('listening', resolve));
  
  // Now it's safe to get the address
  const serverAddress = wss.address();
  if (typeof serverAddress === 'string') {
    console.log(`[DIRECT] WebSocket server running on ${serverAddress}`);
  } else {
    const address = serverAddress.address === '::' ? '0.0.0.0' : serverAddress.address;
    console.log(`[DIRECT] WebSocket server running on ${address}:${serverAddress.port}`);
  }

  // Broadcast to all connected clients
  function broadcast(message) {
    if (!wss) return;
    
    const clients = wss.clients;
    if (!clients || clients.size === 0) return;
    
    const messageString = JSON.stringify(message);
    // console.log(`[DIRECT] Broadcasting to ${clients.size} clients: ${messageString}`);
    
    clients.forEach((client) => {
      if (client.readyState === 1) { // 1 = OPEN
        client.send(messageString);
      }
    });
  }

  // Store handler references for proper cleanup
  // const fullUpdateHandler = (data) => broadcast('state:full-update', data);
  // const patchHandler = (patch) => broadcast('state:patch', patch);

  // Register state listeners
  const stateEventHandler = (payload) => {
    broadcast(payload);
    
    // Log after broadcast
    // setTimeout(() => {
    //   console.log(`[DIRECT] Active clients after broadcast: ${getActiveClientCount()}`);
    // }, 100);
  }

  stateManager.on('state:full-update', stateEventHandler);
  stateManager.on('state:patch', stateEventHandler);
  

  // Log active client count for debugging
  function getActiveClientCount() {
    let count = 0;
    wss.clients.forEach(client => {
      if (client.readyState === 1) {  // 1 = OPEN
        count++;
      }
    });
    return count;
  }
  
  wss.on("connection", (/** @type {WebSocket & ExtendedWebSocket} */ ws, req) => {
    console.log(`[DIRECT] New connection from ${req.socket.remoteAddress}`);
    
    // Log active client count
    console.log(`[DIRECT] Active clients: ${getActiveClientCount()}`);

    // Send initial state ONLY to this client
    ws.send(
      JSON.stringify({
        type: "state:full-update",
        data: stateManager.getState(),
        boatId: stateManager.boatId,
        timestamp: Date.now()
      }),
      (err) => {
        if (err) {
          console.error("[DIRECT] Initial state send failed:", err);
          ws.terminate();
          return;
        }
        console.log("[DIRECT] Initial state sent successfully");
      }
    );

    // Handle incoming messages
    // Type assertion for extended WebSocket properties
    const extendedWs = /** @type {WebSocket & ExtendedWebSocket} */ (ws);
    
    ws.on("message", (data) => {
      try {
        // Safely parse message data whether it's a string or buffer
        const rawMessage = data.toString();
        console.log(`[DIRECT] Raw message received: ${rawMessage}`);
        
        const message = JSON.parse(rawMessage);
        const socket = extendedWs._socket;
        const clientIp = (socket && socket.remoteAddress) ? 
          socket.remoteAddress : 'unknown';
        
        // Log all messages with more detail
        console.log(`[DIRECT] Message received:`, {
          type: message.type,
          clientIp,
          timestamp: new Date().toISOString(),
          data: message.data ? '[...]' : 'none',
          rawLength: rawMessage.length
        });
        
        // Special handling for identity messages
        if (message.type === 'identity' && message.data) {
          // Store identity info on the WebSocket connection
          extendedWs.clientId = message.data.clientId;
          extendedWs.platform = message.data.platform;
          extendedWs.role = message.data.role;
          
          console.log('[DIRECT] Identity received:', {
            clientId: extendedWs.clientId,
            platform: extendedWs.platform,
            role: extendedWs.role,
            timestamp: new Date().toISOString(),
            clientIp: clientIp
          });
        }
        
        // Handle ping messages
        if (message.type === 'ping') {
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
        }
        
        // Handle anchor state updates
        if (message.type === 'anchor:update' && message.data) {
          console.log('[DIRECT] Processing anchor:update message:', JSON.stringify(message.data, null, 2));
          try {
            const success = stateManager.updateAnchorState(message.data);
            console.log(`[DIRECT] Anchor update ${success ? 'succeeded' : 'failed'}`);
            
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'anchor:update:ack',
                success,
                timestamp: Date.now(),
                receivedData: message.data // Echo back the received data for debugging
              }));
            }
          } catch (error) {
            console.error('[DIRECT] Error processing anchor update:', error);
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Failed to process anchor update',
                details: error.message,
                timestamp: Date.now()
              }));
            }
          }
          return;
        }
      } catch (e) {
        console.warn("[DIRECT] Invalid message from client:", e);
      }
    });

    // Setup heartbeat
    const heartbeat = setInterval(() => {
      if (ws.readyState === 1) ws.ping();  // 1 = OPEN
    }, 30000);

    // Cleanup on disconnect
    ws.on("close", () => {
      clearInterval(heartbeat);
      console.log("[DIRECT] Client disconnected");
      
      // Log active client count
      console.log(`[DIRECT] Active clients: ${getActiveClientCount()}`);
    });

    ws.on("error", (err) => {
      console.warn("[DIRECT] Client error:", err);
    });
  });

  // Close all connections
  function closeAllConnections() {
    wss.clients.forEach(client => {
      if (client.readyState === 1) {  // 1 = OPEN
        client.close(1000, 'Server shutting down');
      }
    });
  }


  function shutdown() {
    console.log("[DIRECT] Shutting down...");

    stateManager.off('state:full-update', stateEventHandler);
    stateManager.off('state:patch', stateEventHandler);

    // Close all connections
    wss.clients.forEach((client) => {
      client.terminate();
    });

    return new Promise((resolve) => wss.close(resolve));
  }

  return {
    wss,
    shutdown,
    getClientCount: () => wss.clients.size,
  };
}

export { startDirectServer };
