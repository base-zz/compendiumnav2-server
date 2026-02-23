import { WebSocket as WS, WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import debug from 'debug';

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

const log = debug('direct-server');
const logWarn = debug('direct-server:warn');
const logError = debug('direct-server:error');
const logTrace = debug('direct-server:trace');
const logState = debug('direct-server:state');

/**
 * @param {Object} [options]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {boolean} [options.noServer]
 */

// Get the directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function startDirectServer({ coordinator } = {}, options = {}) {
  if (!coordinator) {
    throw new Error('startDirectServer requires a ClientSyncCoordinator instance');
  }

  const PORT = options.port || parseInt(process.env.DIRECT_WS_PORT, 10);
  if (!PORT) throw new Error("DIRECT_WS_PORT must be specified");
  
  // Use host from options, environment, or default to all interfaces (IPv4)
  const HOST = options.host || process.env.DIRECT_WS_HOST || '0.0.0.0';
  
  // Ensure we're binding to all interfaces for mDNS to work
  log(`Binding WebSocket server to ${HOST}:${PORT}`);
  
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

  log(`Starting WebSocket server on ws://${HOST}:${PORT}`);
  
  // Create WebSocket server attached to HTTP
  /** @type {WebSocketServer} */
  const wss = new WebSocketServer(serverOptions);
  
  // Start the HTTP server
  httpServer.listen(PORT, HOST, () => {
    console.log(`[DIRECT] HTTP server running on http://${HOST}:${PORT}`);
    console.log(`[DIRECT] WebSocket server should be available at ws://${HOST}:${PORT}`);
  });
  
  // Add connection attempt listener to HTTP server
  httpServer.on('upgrade', (request, socket, head) => {
    console.log(`[DIRECT] Upgrade request received from ${request.socket.remoteAddress}`);
  });
  
  // Store the server instance for later use
  /** @type {WebSocketServer} */
 
  
  wss.on('listening', () => {
    const address = wss.address();
    if (typeof address === 'string') {
      log(`WebSocket server listening on ${address}`);
    } else {
      log(`WebSocket server listening on ${address.address}:${address.port}`);
      log(`Server is bound to: ${address.family === 'IPv6' ? 'IPv6' : 'IPv4'}`);
    }
  });

  // Handle connection errors
  wss.on('error', (error) => {
    logError('WebSocket server error:', error);
  });

  const unregister = coordinator.registerTransport('direct', {
    send: (payload) => broadcast(payload),
  });

  // Single connection handler for WebSocket connections
  wss.on('connection', (/** @type {WebSocket & ExtendedWebSocket} */ ws, request) => {
    const clientId = Math.random().toString(36).substring(2, 10);
    const clientIp = request.socket.remoteAddress;
    const origin = request.headers.origin || 'unknown';
    let isAlive = true;
    
    console.log('');
    console.log('🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌');
    console.log('🔌  DIRECTSERVER: NEW CLIENT CONNECTED!  🔌');
    console.log('🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌');
    console.log(`[DIRECT] Client ID: ${clientId}`);
    console.log(`[DIRECT] Client IP: ${clientIp}`);
    console.log(`[DIRECT] Origin: ${origin}`);
    console.log(`[DIRECT] Active clients: ${wss.clients.size}`);
    console.log(`[DIRECT] Request URL: ${request.url}`);
    console.log(`[DIRECT] Request headers:`, request.headers);
    console.log('🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌🔌');
    console.log('');
    
    console.log(`[DIRECT] Step 1: Starting setup for client ${clientId}`);
    
    // Wrap everything in try-catch to see if there's an error
    try {
    
    // Log WebSocket state changes
    console.log(`[DIRECT] Client ${clientId}: Setting up connection handlers...`);
    
    // Log WebSocket state changes
    ws.on('open', () => {
      console.log(`[DIRECT] Client ${clientId}: WebSocket OPENED`);
    });
    
    ws.on('close', (code, reason) => {
      console.log(`[DIRECT] Client ${clientId}: WebSocket CLOSED (code: ${code}, reason: ${reason})`);
    });
    
    ws.on('error', (error) => {
      console.log(`[DIRECT] Client ${clientId}: WebSocket ERROR:`, error);
    });
    
    // Send a test ping every 5 seconds to verify connection
    const testPingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        // console.log(`[DIRECT] Client ${clientId}: Sending test ping...`);
        try {
          ws.send(JSON.stringify({ type: 'server:ping', timestamp: Date.now(), clientId }));
          // console.log(`[DIRECT] Client ${clientId}: Test ping sent successfully`);
        } catch (error) {
          console.log(`[DIRECT] Client ${clientId}: Failed to send test ping:`, error);
        }
      } else {
        console.log(`[DIRECT] Client ${clientId}: Cannot send test ping - connection not open (state: ${ws.readyState})`);
      }
    }, 5000);
    
    // Clean up interval on disconnect
    ws.on('close', () => {
      clearInterval(testPingInterval);
    });
    
    const sendInitialState = () => {
      if (!isAlive || ws.readyState !== ws.OPEN) return;

      coordinator.broadcastInitialState((message) => {
        if (!isAlive || ws.readyState !== ws.OPEN) return;
        try {
          console.log(`[DIRECT] Sending initial state to client ${clientId}`);
          ws.send(JSON.stringify(message));
        } catch (error) {
          logError(`Error sending initial state to ${clientId}:`, error);
        }
      });
    };

    console.log(`[DIRECT] Registering message handler for client ${clientId}`);
    
    // Handle incoming messages
    ws.on('message', (message) => {
      if (!isAlive) {
        console.log('[DIRECTSERVER] ❌ Connection not alive, ignoring message');
        return;
      }
      
      try {
        let messageStr;
        if (typeof message === 'string') {
          messageStr = message;
        } else {
          messageStr = message.toString();
        }
        
        logTrace(`Received message from ${ws._socket?.remoteAddress || 'unknown'}:`, messageStr);
        
        // Parse the message
        const parsed = JSON.parse(messageStr);
        const handled = coordinator.handleClientMessage({
          message: parsed,
          respond: (payload) => {
            if (!isAlive || ws.readyState !== ws.OPEN) return;
            try {
              ws.send(JSON.stringify(payload));
            } catch (sendError) {
              logError('Failed to send response:', sendError);
            }
          },
          broadcast: (payload) => broadcast(payload),
        });

        if (!handled) {
          if (parsed.type === 'identity' && parsed.data) {
            ws.clientId = parsed.data.clientId || clientId;
            ws.platform = parsed.data.platform;
            ws.role = parsed.data.role;

            log('Identity received from client', {
              clientId: ws.clientId,
              platform: ws.platform,
              role: ws.role,
              timestamp: new Date().toISOString(),
              clientIp,
            });
            return;
          }

          if (parsed.type === 'ping') {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'pong',
                timestamp: Date.now(),
                serverTime: new Date().toISOString(),
                echo: parsed.timestamp,
              }));
            }
            return;
          }

          logWarn('Unhandled message payload received from client');
        }
      } catch (parseError) {
        logError('Error parsing message:', parseError);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Invalid message format',
            details: parseError.message,
          }));
        }
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
      
      log(`Client ${clientIp} (${clientId}) disconnected`);
      log(`Active clients: ${wss.clients.size}`);
      log(`Active clients: ${wss.clients.size}`);
    };
    
    ws.on('close', cleanup);
    ws.on('error', (error) => {
      logError(`WebSocket error from ${clientIp} (${origin}):`, error);
      cleanup();
    });
    
    // Set up connection timeout
    const connectionTimeout = setTimeout(() => {
      if (isAlive) {
        logWarn(`Connection timeout for ${clientId}, terminating`);
        ws.terminate();
      }
    }, 180000); // 180 seconds (longer than 2x the heartbeat interval)
    
    ws.once('pong', () => {
      clearTimeout(connectionTimeout);
    });
    
    } catch (setupError) {
      console.error(`[DIRECT] ERROR during client ${clientId} setup:`, setupError);
      console.error(`[DIRECT] Error stack:`, setupError.stack);
    }
  });
  
  // Handle CORS headers for WebSocket upgrade
  wss.on('headers', (headers, request) => {
    const origin = request.headers.origin || 'unknown';
    log(`WebSocket upgrade from ${request.socket.remoteAddress}, Origin: ${origin}`);
    
    // Allow all origins in development
    headers.push('Access-Control-Allow-Origin: *');
    headers.push('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    headers.push('Access-Control-Allow-Headers: Content-Type');  });
  
  // Wait for the server to be ready
  await new Promise((resolve) => wss.on('listening', resolve));
  
  // Now it's safe to get the address
  const serverAddress = wss.address();
  if (typeof serverAddress === 'string') {
    log(`WebSocket server running on ${serverAddress}`);
  } else {
    const address = serverAddress.address === '::' ? '0.0.0.0' : serverAddress.address;
    log(`WebSocket server running on ${address}:${serverAddress.port}`);
  }

  // Broadcast to all connected clients
  function broadcast(message) {
    if (!wss) {
      logError('Cannot broadcast: WebSocket server not initialized');
      return;
    }
    
    const clients = wss.clients;
    if (!clients || clients.size === 0) {
      logState(`No clients connected to broadcast ${typeof message === 'string' ? message.substring(0, 50) : JSON.stringify(message).substring(0, 50)}...`);
      return;
    }
    
    let messageString;
    if (typeof message === 'string') {
      messageString = message;
    } else {
      try {
        messageString = JSON.stringify(message);
      } catch (error) {
        logError('Failed to stringify message for broadcast:', error);
        return;
      }
    }
    
    const messageType = typeof message === 'string' 
      ? 'unknown' 
      : (message.type || (message.payload && message.payload.type) || 'unknown');
    
    logState(`==== BROADCASTING TO CLIENTS ====`);
    logState(`Message type: ${messageType}`);
    logState(`Total clients: ${clients.size}`);
    logState(`Message size: ${messageString.length} bytes`);
    
    let sentCount = 0;
    let closedCount = 0;
    
    const maxBufferedAmountBytes = 25 * 1024 * 1024; // 25MB

    clients.forEach((/** @type {WebSocket & ExtendedWebSocket} */ client) => {
      // Check if client is an ExtendedWebSocket with clientId
      const clientId = client.clientId || 'unknown';
      
      if (client.readyState === 1) { // 1 = OPEN
        try {
          if (typeof client.bufferedAmount === 'number' && client.bufferedAmount > maxBufferedAmountBytes) {
            logWarn(
              `Terminating client ${clientId} - bufferedAmount ${(client.bufferedAmount / 1024 / 1024).toFixed(1)}MB exceeds 25MB`
            );
            client.terminate();
            return;
          }
          client.send(messageString);
          sentCount++;
          logState(`Sent to client ${clientId}`);
        } catch (error) {
          logError(`Failed to send to client ${clientId}:`, error);
        }
      } else {
        closedCount++;
        logState(`Skipped client ${clientId} - not in OPEN state (state: ${client.readyState})`);
      }
    });
    
    logState(`Successfully sent to ${sentCount}/${clients.size} clients (${closedCount} closed)`);
    logState(`==== BROADCAST COMPLETE ====`);
  }

  function shutdown() {
    log("[DIRECT] Shutting down...");

    // No need to remove global event listeners as they've been removed
    // We rely on per-connection handlers which are cleaned up when connections close

    // Close all connections
    wss.clients.forEach((client) => {
      client.terminate();
    });

    unregister();

    return new Promise((resolve) => wss.close(resolve));
  }

  return {
    wss,
    shutdown,
    getClientCount: () => wss.clients.size,
  };
}

export { startDirectServer };
