import { WebSocket as WS, WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import debug from 'debug';
import { stateManager } from "../core/state/StateManager.js";

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

async function startDirectServer(stateManager, options = {}) {
  if (!stateManager) throw new Error('StateManager instance must be provided');

  

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
  const wsServerInstance = wss;
  
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

  // Single connection handler for WebSocket connections
  wss.on('connection', (/** @type {WebSocket & ExtendedWebSocket} */ ws, request) => {
    const clientId = Math.random().toString(36).substring(2, 10);
    const clientIp = request.socket.remoteAddress;
    const origin = request.headers.origin || 'unknown';
    let isAlive = true;
    
    console.log(`[DIRECT] *** NEW CONNECTION *** from ${clientIp} (${clientId}), Origin: ${origin}`);
    console.log(`[DIRECT] Active clients: ${wss.clients.size}`);
    console.log(`[DIRECT] Request URL: ${request.url}`);
    console.log(`[DIRECT] Request headers:`, request.headers);
    
    // Function to get a safe copy of the state
    const getSafeStateCopy = (state) => {
      try {
        return JSON.parse(JSON.stringify(state));
      } catch (error) {
        logError('Error cloning state:', error);
        return {};
      }
    };

    // Event handlers for state updates
    const onTideUpdate = (data) => {
      if (isAlive && ws.readyState === ws.OPEN) {
        const payload = {
          type: 'tide:update',
          data
        };
        log(`[DIRECT] Client ${clientId}: Sending tide:update with data keys: ${Object.keys(data).join(', ')}`);
        log(`[DIRECT] Client ${clientId}: Tide data structure: ${JSON.stringify(data, null, 2).substring(0, 500)}...`);
        ws.send(JSON.stringify(payload));
        log(`[DIRECT] Client ${clientId}: Successfully sent tide:update event`);
      } else {
        log(`[DIRECT] Client ${clientId}: Not sending tide:update - client not alive or connection not open`);
      }
    };
    
    const onWeatherUpdate = (data) => {
      if (isAlive && ws.readyState === ws.OPEN) {
        const payload = {
          type: 'weather:update',
          data
        };
        log(`[DIRECT] Client ${clientId}: Sending weather:update with data keys: ${Object.keys(data).join(', ')}`);
        log(`[DIRECT] Client ${clientId}: Weather data structure: ${JSON.stringify(data, null, 2).substring(0, 500)}...`);
        ws.send(JSON.stringify(payload));
        log(`[DIRECT] Client ${clientId}: Successfully sent weather:update event`);
      } else {
        log(`[DIRECT] Client ${clientId}: Not sending weather:update - client not alive or connection not open`);
      }
    };

    const onStateUpdate = (payload) => {
      logState("==== STATE UPDATE EVENT RECEIVED ====");
      logState(`Client ${clientId}: Received state update event type: ${payload?.type}`);
      logState(`Client ${clientId}: Client status - alive: ${isAlive}, readyState: ${ws.readyState}`);
      
      // Log detailed payload info without overwhelming the console
      if (payload?.data) {
        if (Array.isArray(payload.data)) {
          logState(`Client ${clientId}: State patch operations: ${payload.data.length}`);
          payload.data.forEach((op, i) => {
            logState(`Client ${clientId}: Operation ${i+1}: ${op.op} at path ${op.path}`);
          });
        } else if (typeof payload.data === 'object') {
          logState(`Client ${clientId}: State update keys: ${Object.keys(payload.data).join(', ')}`);
          
          // Check specifically for tide and weather data
          if (payload.data.tide) {
            logState(`Client ${clientId}: State includes tide data with keys: ${Object.keys(payload.data.tide).join(', ')}`);
          } else {
            logState(`Client ${clientId}: State does NOT include tide data`);
          }
          
          if (payload.data.tides) {
            logState(`Client ${clientId}: State includes tides data with keys: ${Object.keys(payload.data.tides).join(', ')}`);
          } else {
            logState(`Client ${clientId}: State does NOT include tides data`);
          }
          
          if (payload.data.forecast) {
            logState(`Client ${clientId}: State includes forecast data with keys: ${Object.keys(payload.data.forecast).join(', ')}`);
          } else {
            logState(`Client ${clientId}: State does NOT include forecast data`);
          }
        }
      }
      
      if (isAlive && ws.readyState === ws.OPEN) {
        try {
          const jsonString = JSON.stringify(payload);
          ws.send(jsonString);
          logState(`Client ${clientId}: Successfully sent state update (${jsonString.length} bytes)`);
        } catch (error) {
          logError(`Client ${clientId}: Failed to send state update:`, error);
        }
      } else {
        logState(`Client ${clientId}: State update NOT sent - client not alive or connection not open`);
      }
      logState("==== END STATE UPDATE EVENT ====");
    };

    // Register event listeners
    stateManager.on('tide:update', onTideUpdate);
    stateManager.on('weather:update', onWeatherUpdate);
    stateManager.on('state:patch', onStateUpdate);
    stateManager.on('state:full-update', onStateUpdate);
    
    // Log detailed listener information
    log(`[DIRECT] Client ${clientId}: Added state listeners.`);
    logState(`Client ${clientId}: Total 'state:patch' listeners: ${stateManager.listenerCount('state:patch')}`);
    logState(`Client ${clientId}: Total 'state:full-update' listeners: ${stateManager.listenerCount('state:full-update')}`);
    logState(`Client ${clientId}: Total 'tide:update' listeners: ${stateManager.listenerCount('tide:update')}`);
    logState(`Client ${clientId}: Total 'weather:update' listeners: ${stateManager.listenerCount('weather:update')}`);
    
    // Send initial state to the client
    setTimeout(() => {
      logState(`Sending initial full state to client ${clientId}`);
      stateManager.emitFullState();
      logState(`Initial full state sent to client ${clientId}`);
    }, 1000);

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
            logError(`Error sending initial state to ${clientId}:`, error);
          } else {
            log(`Sent initial state to ${clientId}`);
          }
        });
      } catch (error) {
        logError(`Error preparing initial state:`, error);
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
        
        logTrace(`Received message from ${ws._socket?.remoteAddress || 'unknown'}:`, messageStr);
        
        // Parse the message
        let data;
        try {
          data = JSON.parse(messageStr);
          log(`Parsed message type: ${data.type || 'unknown'}`);
          
          // Handle Bluetooth toggle (direct format)
          if (data.type === 'bluetooth:toggle') {
            log('Processing bluetooth:toggle message:', JSON.stringify(data, null, 2));
            
            // Convert to the standard command format and process it
            const commandData = { enabled: data.enabled === true };
            const success = stateManager.toggleBluetooth(commandData.enabled);
            
            // Send response
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'bluetooth:response',
                action: 'toggle',
                success,
                message: `Bluetooth ${commandData.enabled ? 'enabled' : 'disabled'}`,
                timestamp: Date.now()
              }));
            }
            return;
          }
          
          // Handle anchor updates
          if (data.type === 'anchor:update') {
            log('Processing anchor:update message:', JSON.stringify(data, null, 2));
            const success = stateManager.updateAnchorState(data);
            log(`Anchor update ${success ? 'succeeded' : 'failed'}`);
            
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
          
          // Handle Bluetooth commands
          if ((data.type === 'command' && data.service === 'bluetooth') || data.type === 'bluetooth:toggle') {
            log('Processing Bluetooth command:', JSON.stringify(data, null, 2));
            
            // Extract action and command data based on message format
            let action, commandData;
            
            if (data.type === 'bluetooth:toggle') {
              // Handle bluetooth:toggle format
              action = 'toggle';
              commandData = { enabled: data.enabled };
            } else {
              // Handle standard command format
              action = data.action;
              commandData = data.data;
            }
            let success = false;
            let response = {
              type: 'bluetooth:response',
              action,
              success: false,
              timestamp: Date.now()
            };
            
            try {
              switch (action) {
                case 'toggle':
                  // Toggle Bluetooth on/off
                  if (typeof commandData?.enabled === 'boolean') {
                    success = stateManager.toggleBluetooth(commandData.enabled);
                    response.message = `Bluetooth ${commandData.enabled ? 'enabled' : 'disabled'}`;
                  } else {
                    response.error = 'Invalid toggle parameter: enabled must be a boolean';
                  }
                  break;
                  
                case 'scan':
                  // Start/stop Bluetooth scanning
                  if (typeof commandData?.scanning === 'boolean') {
                    success = stateManager.updateBluetoothScanningStatus(commandData.scanning);
                    response.message = `Bluetooth scanning ${commandData.scanning ? 'started' : 'stopped'}`;
                  } else {
                    response.error = 'Invalid scan parameter: scanning must be a boolean';
                  }
                  break;
                  
                case 'select-device':
                  // Select a Bluetooth device
                  if (commandData?.deviceId) {
                    // Handle async method
                    stateManager.setBluetoothDeviceSelected(commandData.deviceId, true)
                      .then(result => {
                        response.success = result;
                        response.message = `Device ${commandData.deviceId} selected`;
                        response.deviceId = commandData.deviceId;
                        
                        if (ws.readyState === ws.OPEN) {
                          ws.send(JSON.stringify(response));
                        }
                      })
                      .catch(error => {
                        logError(`Error selecting device:`, error);
                        response.error = `Error selecting device: ${error.message}`;
                        response.success = false;
                        
                        if (ws.readyState === ws.OPEN) {
                          ws.send(JSON.stringify(response));
                        }
                      });
                    
                    // Return early since we're handling the response asynchronously
                    return;
                  } else {
                    response.error = 'Invalid parameter: deviceId is required';
                  }
                  break;
                  
                case 'deselect-device':
                  // Deselect a Bluetooth device
                  if (commandData?.deviceId) {
                    // Handle async method
                    stateManager.setBluetoothDeviceSelected(commandData.deviceId, false)
                      .then(result => {
                        response.success = result;
                        response.message = `Device ${commandData.deviceId} deselected`;
                        response.deviceId = commandData.deviceId;
                        
                        if (ws.readyState === ws.OPEN) {
                          ws.send(JSON.stringify(response));
                        }
                      })
                      .catch(error => {
                        logError(`Error deselecting device:`, error);
                        response.error = `Error deselecting device: ${error.message}`;
                        response.success = false;
                        
                        if (ws.readyState === ws.OPEN) {
                          ws.send(JSON.stringify(response));
                        }
                      });
                    
                    // Return early since we're handling the response asynchronously
                    return;
                  } else {
                    response.error = 'Invalid parameter: deviceId is required';
                  }
                  break;
                  
                case 'rename-device':
                  // Rename a Bluetooth device
                  if (commandData?.deviceId && commandData?.name) {
                    // Need to handle this asynchronously
                    stateManager.updateBluetoothDeviceMetadata(commandData.deviceId, { name: commandData.name })
                      .then(result => {
                        response.success = result;
                        response.message = result ? 
                          `Device ${commandData.deviceId} renamed to ${commandData.name}` : 
                          `Failed to rename device ${commandData.deviceId}`;
                        response.deviceId = commandData.deviceId;
                        
                        if (ws.readyState === ws.OPEN) {
                          ws.send(JSON.stringify(response));
                        }
                      })
                      .catch(error => {
                        logError(`Error renaming device:`, error);
                        response.error = `Error renaming device: ${error.message}`;
                        response.success = false;
                        
                        if (ws.readyState === ws.OPEN) {
                          ws.send(JSON.stringify(response));
                        }
                      });
                    
                    // Return early since we're handling the response asynchronously
                    return;
                  } else {
                    response.error = 'Invalid parameters: deviceId and name are required';
                  }
                  break;
                  
                default:
                  response.error = `Unknown Bluetooth action: ${action}`;
              }
            } catch (error) {
              logError(`Error handling Bluetooth command ${action}:`, error);
              response.error = `Error processing command: ${error.message}`;
            }
            
            // Update the success flag in the response
            response.success = success;
            
            // Send response back to the client
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(response));
            }
            return;
          }
          
          // Handle identity messages
          if (data.type === 'identity' && data.data) {
            // Store identity info on the WebSocket connection
            ws.clientId = data.data.clientId || clientId; // Use provided ID or fallback to generated ID
            ws.platform = data.data.platform;
            ws.role = data.data.role;
            
            log(`Identity received from ${clientId}:`, {
              clientId: ws.clientId,
              platform: ws.platform,
              role: ws.role,
              timestamp: new Date().toISOString(),
              clientIp: clientIp
            });
            return;
          }

          // Handle ping messages
          if (data.type === 'ping') {
            // Respond with a pong message
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'pong',
                timestamp: Date.now(),
                serverTime: new Date().toISOString(),
                echo: data.timestamp // Echo back the client timestamp for latency calculation
              }));
            }
            return;
          }
          
          // Handle other message types...
          
        } catch (parseError) {
          logError('Error parsing message:', parseError);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Invalid message format',
              details: parseError.message
            }));
          }
          return;
        }
        
        logWarn(`Unhandled message type: ${data.type || 'unknown'}`);
      } catch (error) {
        logError(`Error processing message from ${clientId}:`, error);
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
      
      log(`Client ${clientIp} (${clientId}) disconnected`);
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
    }, 45000); // 45 seconds (longer than 2x the heartbeat interval)
    
    ws.once('pong', () => {
      clearTimeout(connectionTimeout);
    });
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
    
    clients.forEach((/** @type {WebSocket & ExtendedWebSocket} */ client) => {
      // Check if client is an ExtendedWebSocket with clientId
      const clientId = client.clientId || 'unknown';
      
      if (client.readyState === 1) { // 1 = OPEN
        try {
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
  

  // Close all connections
  function closeAllConnections() {
    wss.clients.forEach(client => {
      if (client.readyState === 1) {  // 1 = OPEN
        client.close(1000, 'Server shutting down');
      }
    });
  }


  function shutdown() {
    log("[DIRECT] Shutting down...");

    // No need to remove global event listeners as they've been removed
    // We rely on per-connection handlers which are cleaned up when connections close

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
