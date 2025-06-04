import { WebSocketServer } from "ws";
import { stateManager } from "../core/state/StateManager.js";

async function startDirectServer(options = {}) {
  const PORT = options.port || parseInt(process.env.DIRECT_WS_PORT, 10);
  if (!PORT) throw new Error("DIRECT_WS_PORT must be specified");
  
  // Use host from options, environment, or default to all interfaces (IPv4)
  const HOST = options.host || process.env.DIRECT_WS_HOST || '0.0.0.0';
  
  // Ensure we're binding to all interfaces for mDNS to work
  console.log(`[DIRECT] Binding WebSocket server to ${HOST}:${PORT}`);
  
  const serverOptions = {
    port: PORT,
    host: HOST,
    maxPayload: options.maxPayload || 1024 * 1024, // 1MB default
    clientTracking: true
  };

  console.log(`[DIRECT] Starting WebSocket server on ${HOST}:${PORT}`);
  
  const wss = new WebSocketServer(serverOptions);
  
  // Log when the server is listening
  wss.on('listening', () => {
    const address = wss.address();
    console.log(`[DIRECT] WebSocket server listening on ${address.address}:${address.port}`);
    console.log(`[DIRECT] Server is bound to: ${address.family === 'IPv6' ? 'IPv6' : 'IPv4'}`);
  });

  // Handle connection errors
  wss.on('error', (error) => {
    console.error('[DIRECT] WebSocket server error:', error);
  });

  // Single connection handler for WebSocket connections
  wss.on('connection', (ws, request) => {
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
        const data = JSON.parse(message);
        
        // Handle ping messages
        if (data.type === 'ping') {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'pong',
              timestamp: Date.now()
            }));
          }
          return;
        }
        
        // Handle anchor state updates
        if (data.type === 'anchor:update' && data.data) {
          const success = stateManager.updateAnchorState(data.data);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'anchor:update:ack',
              success,
              timestamp: Date.now()
            }));
          }
          return;
        }
        
        console.log(`[DIRECT] Received message from ${clientId}:`, data.type || 'unknown type');
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
    headers.push('Access-Control-Allow-Headers: Content-Type');
  });
  
  // Wait for the server to be ready
  await new Promise((resolve) => wss.on('listening', resolve));
  
  // Now it's safe to get the address
  const serverAddress = wss.address();
  const address = serverAddress.address === '::' ? '0.0.0.0' : serverAddress.address;
  console.log(`[DIRECT] WebSocket server running on ${address}:${serverAddress.port}`);

  // Broadcast to all clients except specified ones
  function broadcast(payload, exclude = new Set()) {
    // console.log(`[DIRECT] Broadcasting ${payload.type} to ${wss.clients.size} clients`);
    const message = JSON.stringify(payload);
    
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && !exclude.has(client)) {
        client.send(message, (err) => {
          if (err) {
            console.warn("[DIRECT] Broadcast failed:", err);
            client.terminate();
          }
        });
      }
    });
    
    // Log after a short delay to allow send callbacks to complete
    // setTimeout(() => {
    //   console.log(`[DIRECT] Broadcast complete`);
    // }, 50);
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
      if (client.readyState === WebSocket.OPEN) {
        count++;
      }
    });
    return count;
  }
  
  wss.on("connection", (ws, req) => {
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
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        console.log(`[DIRECT] Received message from client: ${message.type}`);
        
        // Handle ping messages
        if (message.type === 'ping') {
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
        }
        
        // Handle anchor state updates
        if (message.type === 'anchor:update' && message.data) {
          console.log(`[DIRECT] Received anchor update from client`);
          
          // Forward the anchor data to the StateManager
          // The StateManager is the single source of truth for state changes
          const success = stateManager.updateAnchorState(message.data);
          
          // Acknowledge receipt
          ws.send(JSON.stringify({
            type: 'anchor:update:ack',
            success,
            timestamp: Date.now()
          }));
        }
      } catch (e) {
        console.warn("[DIRECT] Invalid message from client:", e);
      }
    });

    // Setup heartbeat
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
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
