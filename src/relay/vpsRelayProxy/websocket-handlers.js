import {
  getDb,
  getBoatPublicKey,
  registerBoatKey,
  registerClientKey,
  getClientPublicKey,
} from "./database.js";
import { verifySignature, verifyClientSignature } from "./auth.js";

// Connection tracking using two separate maps
const clientConnections = new Map(); // boatId -> Set of client connections
const serverConnections = new Map(); // boatId -> Set of server connections

/**
 * Handle WebSocket connection
 */
export function handleConnection(ws, req) {
  ws.role = null; // Will be set when identified
  ws.boatIds = new Set(); // Tracks all boat IDs this connection is subscribed to
  ws.clientId = null; // Will be set for client connections
  const ip = req.socket.remoteAddress;

  // Generate a unique connection ID for tracking
  ws.connectionId = Math.random().toString(36).substring(2, 15);

  console.log(
    `[WS-DETAILED] New connection from ${ip} with headers:`,
    req.headers
  );
  console.log(
    `[WS-CONNECTION-DEBUG] New WebSocket connection established: connectionId=${ws.connectionId}, ip=${ip}`
  );

  // Log user agent if available
  if (req.headers["user-agent"]) {
    console.log(
      `[WS-CONNECTION-DEBUG] User agent: ${req.headers["user-agent"]}`
    );
  }

  ws.on("message", async (msg) => {
  // Convert Buffer to string if needed
  const messageString = msg.toString('utf8');
  
  // Skip if message is empty
  if (!messageString.trim()) {
    console.warn(`[WS] Received empty message from ${ip}`);
    return;
  }

    let message;
    try {
      message = JSON.parse(msg);
      // Log all incoming messages for debugging
      console.log(`[WS-MSG-DEBUG] Received message from ${ip}:`, {
        type: message.type,
        clientId: message.clientId || "unknown",
        boatId: message.boatId || "unknown",
        role: message.role || "unknown",
      });
    } catch (e) {
      console.warn(`[WS] Invalid JSON from ${ip}: ${msg}`, e);
      return;
    }

    // Handle boat key registration
    if (
      message.type === "register-key" &&
      message.boatId &&
      message.publicKey &&
      !message.clientId
    ) {
      await handleKeyRegistration(ws, message);
      return;
    }

    // Handle client key registration
    if (
      message.type === "register-client-key" &&
      message.clientId &&
      message.boatId &&
      message.publicKey
    ) {
      await handleClientKeyRegistration(ws, message);
      return;
    }

    // Handle identity/role declaration
    if (message.type === "identity" && message.role && message.boatId) {
      // Log the full identity message for debugging
      console.log(
        `[WS-IDENTITY-DEBUG] Full identity message from ${ip}:`,
        JSON.stringify(message)
      );

      console.log(`[WS-DETAILED] Identity message received from ${ip}:`, {
        boatId: message.boatId,
        role: message.role,
        clientId: message.clientId || "unknown",
        hasSignature: !!message.signature,
        hasTimestamp: !!message.timestamp,
      });
      await handleIdentity(ws, message);

      // If this is a client, automatically subscribe it to the boat
      if (message.role !== "boat-server" && message.boatId) {
        console.log(
          `[WS-DETAILED] Auto-subscribing client ${
            message.clientId || "unknown"
          } to boat ${message.boatId}`
        );
        handleSubscription(ws, {
          type: "subscribe",
          boatId: message.boatId,
          role: message.role,
          clientId: message.clientId,
        });
      }
      return;
    }

    // Handle subscription requests
    if (message.type === "register" || message.type === "subscribe") {
      if (Array.isArray(message.boatIds)) {
        // Handle multi-boat registration
        message.boatIds.forEach((boatId) => {
          handleSubscription(ws, {
            type: message.type,
            boatId: boatId,
            role: message.role || ws.role,
          });
        });
        return;
      } else if (message.boatId) {
        // Handle single-boat registration
        handleSubscription(ws, message);
        return;
      }
    }

    // Handle unsubscription
    if (message.type === "unsubscribe" && message.boatId) {
      handleUnsubscription(ws, message.boatId);
      return;
    }

    // Handle ping messages
    if (message.type === "ping") {
      // Respond with a pong message
      const pongMessage = JSON.stringify({
        type: "pong",
        timestamp: Date.now(),
        echo: message.timestamp, // Echo back the original timestamp for latency calculation
      });
      ws.send(pongMessage);
      return;
    }

    // Handle regular messages
    if (message.boatId) {
      handleMessageRouting(ws, message, msg);
    }
  });

  ws.on("close", () => {
    // Clean up all subscriptions
    if (ws.boatIds && ws.boatIds.size > 0) {
      ws.boatIds.forEach((boatId) => {
        // If this is a client disconnecting, notify the server
        if (ws.role !== "boat-server") {
          const clientId = ws.clientId || "unknown";
          notifyServerOfClientDisconnection(boatId, clientId);
        }

        // Then handle the unsubscription
        handleUnsubscription(ws, boatId);
      });
    }

    console.log(
      `[WS] Connection closed (${ws.role || "unidentified"} from ${ip})`
    );
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error from ${ip}:`, err);
  });
}

/**
 * Handle boat key registration message
 */
async function handleKeyRegistration(ws, message) {
  try {
    const success = await registerBoatKey(message.boatId, message.publicKey);

    // Send confirmation
    ws.send(
      JSON.stringify({
        type: "register-key-response",
        success: true,
        boatId: message.boatId,
      })
    );

    console.log(`[WS] Registered public key for boat ${message.boatId}`);
  } catch (error) {
    console.error(`[WS] Error registering boat key:`, error);
    ws.send(
      JSON.stringify({
        type: "register-key-response",
        success: false,
        error: error.message,
      })
    );
  }
}

/**
 * Handle client key registration message
 */
async function handleClientKeyRegistration(ws, message) {
  try {
    const success = await registerClientKey(
      message.clientId,
      message.publicKey,
      message.boatId
    );

    // Send confirmation
    ws.send(
      JSON.stringify({
        type: "register-client-key-response",
        success: true,
        clientId: message.clientId,
        boatId: message.boatId,
      })
    );

    console.log(
      `[WS] Registered client key for client ${message.clientId} on boat ${message.boatId}`
    );
  } catch (error) {
    console.error(`[WS] Error registering client key:`, error);
    ws.send(
      JSON.stringify({
        type: "register-client-key-response",
        success: false,
        error: error.message,
      })
    );
  }
}

/**
 * Handle identity message
 */
async function handleIdentity(ws, message) {
  // Check if this is a signed identity message (key-based auth)
  if (message.signature && message.timestamp) {
    console.log(
      `[AUTH-DETAILED] Processing signed identity for boat ${message.boatId}`
    );

    // Check if this is a client identity message
    if (message.clientId) {
      await handleClientIdentity(ws, message);
    } else {
      // This is a boat identity message
      await handleBoatIdentity(ws, message);
    }
  } else {
    // Legacy identity handling (without signature)
    ws.role = message.role;
    if (message.clientId) {
      ws.clientId = message.clientId; // Store client ID on the connection
      console.log(
        `[WS] ${ws.role} client ${message.clientId} identified for boat ${message.boatId} (LEGACY)`
      );
    } else {
      console.log(
        `[WS] ${ws.role} identified for boat ${message.boatId} (LEGACY)`
      );
    }
  }

  // Auto-subscribe if not already
  if (message.boatId && !ws.boatIds.has(message.boatId)) {
    console.log(
      `[WS-DETAILED] Auto-subscribing ${message.role} ${
        message.clientId || "unknown"
      } to boat ${message.boatId}`
    );
    handleSubscription(ws, message);
  } else if (
    message.boatId &&
    ws.boatIds.has(message.boatId) &&
    message.role !== "boat-server" &&
    message.clientId
  ) {
    // If already subscribed but this is a client (not boat-server), make sure to notify the server
    console.log(
      `[WS-DETAILED] Client ${message.clientId} already subscribed to boat ${message.boatId}, ensuring server notification`
    );

    // Notify the boat server about the client connection
    if (serverConnections.has(message.boatId)) {
      const servers = serverConnections.get(message.boatId);
      let notificationSent = false;

      console.log(
        `[WS-DETAILED] Found ${servers.size} server(s) for boat ${message.boatId} to notify about client ${message.clientId} connection`
      );

      servers.forEach((server) => {
        console.log(
          `[WS-DETAILED] Server readyState: ${server.readyState} (1=OPEN, 0=CONNECTING, 2=CLOSING, 3=CLOSED)`
        );

        if (server.readyState === 1) {
          try {
            const clientConnectedMsg = JSON.stringify({
              type: "client-connected",
              clientId: message.clientId,
              boatId: message.boatId,
              timestamp: new Date().toISOString(),
            });

            console.log(
              `[WS-DETAILED] Sending client-connected notification: ${clientConnectedMsg}`
            );
            server.send(clientConnectedMsg);
            console.log(
              `[WS-DETAILED] Successfully sent client-connected notification to server for client ${message.clientId}`
            );
            notificationSent = true;
          } catch (error) {
            console.error(
              `[WS] Error sending client-connected notification to server:`,
              error,
              error.stack
            );
          }
        } else {
          console.log(
            `[WS-DETAILED] Server not in OPEN state, cannot send notification`
          );
        }
      });

      if (!notificationSent) {
        console.log(
          `[WS] No active servers to notify about client ${message.clientId} connection`
        );
      }
    } else {
      console.log(
        `[WS-DETAILED] No server connections found for boat ${message.boatId}, cannot notify about client ${message.clientId} connection`
      );
    }
  }
}

/**
 * Handle boat identity message with signature verification
 */
async function handleBoatIdentity(ws, message) {
  try {
    const publicKey = await getBoatPublicKey(message.boatId);

    if (!publicKey) {
      console.warn(`[WS] No public key found for boat ${message.boatId}`);
      // Allow connection but log warning - the boat should register its key
      ws.role = message.role;
      console.log(
        `[WS] ${ws.role} identified for boat ${message.boatId} (NO KEY - INSECURE)`
      );
    } else {
      // Verify the signature
      console.log(
        `[AUTH-DETAILED] Found public key for boat ${message.boatId}, verifying signature`
      );

      const isValid = verifySignature(
        `${message.boatId}:${message.timestamp}`,
        message.signature,
        publicKey
      );

      if (!isValid) {
        console.warn(`[WS] Invalid signature from boat ${message.boatId}`);
        ws.close(4000, "Authentication failed: Invalid signature");
        return;
      } else {
        console.log(
          `[AUTH-DETAILED] Signature verification SUCCEEDED for boat ${message.boatId}`
        );

        // Signature verified, proceed with identity setup
        ws.role = message.role;
        console.log(
          `[WS] ${ws.role} authenticated for boat ${message.boatId} (SECURE)`
        );
      }
    }
  } catch (error) {
    console.error(`[WS] Error during boat key verification:`, error);
    // Fall back to regular identity handling
    ws.role = message.role;
    console.log(
      `[WS] ${ws.role} identified for boat ${message.boatId} (VERIFICATION ERROR)`
    );
  }
}

/**
 * Handle client identity message with signature verification
 */
async function handleClientIdentity(ws, message) {
  console.log(
    `[CLIENT-IDENTITY-DEBUG] Processing client identity for client ${message.clientId} and boat ${message.boatId}`
  );
  console.log(
    `[CLIENT-IDENTITY-DEBUG] Full client identity message:`,
    JSON.stringify(message)
  );

  try {
    console.log(
      `[CLIENT-IDENTITY-DEBUG] Looking up public key for client ${message.clientId} on boat ${message.boatId}`
    );
    const publicKey = await getClientPublicKey(
      message.clientId,
      message.boatId
    );

    if (!publicKey) {
      console.warn(
        `[WS] No client key found for client ${message.clientId} on boat ${message.boatId}`
      );
      // Allow connection but log warning - the client should register its key
      ws.role = message.role;
      ws.clientId = message.clientId; // Store client ID on the connection

      // Store the boat ID on the connection for easier access
      if (!ws.boatIds) ws.boatIds = new Set();
      if (message.boatId) ws.boatIds.add(message.boatId);

      console.log(
        `[WS] ${ws.role} client ${message.clientId} identified for boat ${message.boatId} (NO KEY - INSECURE)`
      );
      console.log(
        `[CLIENT-IDENTITY-DEBUG] Client connection properties: role=${
          ws.role
        }, clientId=${ws.clientId}, boatIds=${Array.from(ws.boatIds).join(",")}`
      );
    } else {
      // Verify the client signature
      console.log(
        `[AUTH-DETAILED] Found client key for client ${message.clientId} on boat ${message.boatId}, verifying signature`
      );
      console.log(
        `[CLIENT-IDENTITY-DEBUG] Public key found, proceeding with signature verification`
      );

      const isValid = verifyClientSignature(
        message.clientId,
        message.boatId,
        message.timestamp,
        message.signature,
        publicKey
      );

      if (!isValid) {
        console.warn(
          `[WS] Invalid signature from client ${message.clientId} for boat ${message.boatId}`
        );
        console.log(
          `[CLIENT-IDENTITY-DEBUG] Signature verification FAILED, closing connection`
        );
        ws.close(4000, "Authentication failed: Invalid client signature");
        return;
      } else {
        console.log(
          `[AUTH-DETAILED] Client signature verification SUCCEEDED for client ${message.clientId} on boat ${message.boatId}`
        );
        ws.role = message.role;
        ws.clientId = message.clientId; // Store client ID on the connection

        // Store the boat ID on the connection for easier access
        if (!ws.boatIds) ws.boatIds = new Set();
        if (message.boatId) ws.boatIds.add(message.boatId);

        console.log(
          `[WS] ${ws.role} client ${message.clientId} authenticated for boat ${message.boatId} (SECURE)`
        );
        console.log(
          `[CLIENT-IDENTITY-DEBUG] Client successfully authenticated. Connection properties: role=${
            ws.role
          }, clientId=${ws.clientId}, boatIds=${Array.from(ws.boatIds).join(
            ","
          )}`
        );
      }
    }
  } catch (error) {
    console.error(`[WS] Error during client key verification:`, error);
    // Fall back to regular identity handling
    ws.role = message.role;
    ws.clientId = message.clientId; // Store client ID on the connection
    console.log(
      `[WS] ${ws.role} client ${message.clientId} identified for boat ${message.boatId} (VERIFICATION ERROR)`
    );
  }
}

/**
 * Handle subscription message
 */
function handleSubscription(ws, message) {
  // Handle array of boat IDs
  const boatIds = Array.isArray(message.boatIds)
    ? message.boatIds
    : [message.boatId];

  boatIds.forEach((boatId) => {
    if (!boatId) return; // Skip empty boat IDs

    ws.boatIds.add(boatId);

    // Add to appropriate connection map
    if (message.role === "boat-server" || ws.role === "boat-server") {
      if (!serverConnections.has(boatId)) {
        serverConnections.set(boatId, new Set());
      }
      serverConnections.get(boatId).add(ws);
      console.log(`[WS] Server subscribed to ${boatId}`);
    } else {
      if (!clientConnections.has(boatId)) {
        clientConnections.set(boatId, new Set());
      }
      clientConnections.get(boatId).add(ws);

      // Log with client ID if available
      const clientId = ws.clientId || "unknown";
      if (ws.clientId) {
        console.log(`[WS] Client ${clientId} subscribed to ${boatId}`);
      } else {
        console.log(`[WS] Client subscribed to ${boatId}`);
      }

      // Notify the boat server about the new client connection
      if (serverConnections.has(boatId)) {
        const servers = serverConnections.get(boatId);
        let notificationSent = false;

        console.log(
          `[WS-DETAILED] Found ${servers.size} server(s) for boat ${boatId} to notify about client ${clientId} connection`
        );

        servers.forEach((server) => {
          console.log(
            `[WS-DETAILED] Server readyState: ${server.readyState} (1=OPEN, 0=CONNECTING, 2=CLOSING, 3=CLOSED)`
          );

          if (server.readyState === 1) {
            try {
              const clientConnectedMsg = JSON.stringify({
                type: "client-connected",
                clientId: clientId,
                boatId: boatId,
                timestamp: new Date().toISOString(),
              });

              console.log(
                `[WS-DETAILED] Sending client-connected notification: ${clientConnectedMsg}`
              );
              server.send(clientConnectedMsg);
              console.log(
                `[WS-DETAILED] Successfully sent client-connected notification to server for client ${clientId}`
              );
              notificationSent = true;
            } catch (error) {
              console.error(
                `[WS] Error sending client-connected notification to server:`,
                error,
                error.stack
              );
            }
          } else {
            console.log(
              `[WS-DETAILED] Server not in OPEN state, cannot send notification`
            );
          }
        });

        if (!notificationSent) {
          console.log(
            `[WS] No active servers to notify about client ${clientId} connection`
          );
        }
      } else {
        console.log(
          `[WS-DETAILED] No server connections found for boat ${boatId}, cannot notify about client ${clientId} connection`
        );
        if (message.role !== "boat-server" && ws.role !== "boat-server") {
          try {
            const statusMessage = JSON.stringify({
              type: "boat-status",
              boatId: boatId,
              status: serverConnections.has(boatId) ? "online" : "offline",
              timestamp: new Date().toISOString(),
            });
            ws.send(statusMessage);
          } catch (error) {
            console.error(`[WS] Error sending boat status to client:`, error);
          }
        }
      }
    }

    updateConnectionStatus(boatId);
  });
}

/**
 * Handle unsubscription
 */
function handleUnsubscription(ws, boatId) {
  ws.boatIds.delete(boatId);

  // Remove from connection maps
  if (ws.role === "boat-server" && serverConnections.has(boatId)) {
    serverConnections.get(boatId).delete(ws);
    if (serverConnections.get(boatId).size === 0) {
      serverConnections.delete(boatId);
    }
  } else if (clientConnections.has(boatId)) {
    clientConnections.get(boatId).delete(ws);
    if (clientConnections.get(boatId).size === 0) {
      clientConnections.delete(boatId);
    }
  }

  updateConnectionStatus(boatId);
  console.log(`[WS] ${ws.role || "unknown"} unsubscribed from ${boatId}`);
}

/**
 * Handle message routing
 */
function handleMessageRouting(ws, message, rawMsg) {
  const boatId = message.boatId;
  const msgType = message.type || "unknown";
  const msgSize = rawMsg.length || 0;

  // Log detailed message info
  console.log(
    `[WS-DETAILED] Routing message: type=${msgType}, boatId=${boatId}, size=${msgSize} bytes`
  );

  // Special logging for full state updates
  if (msgType === "state:full-update") {
    console.log(`[WS-DETAILED] Routing FULL STATE UPDATE for boat ${boatId}`);
    if (message.data) {
      const stateKeys = Object.keys(message.data);
      console.log(
        `[WS-DETAILED] Full state contains ${
          stateKeys.length
        } top-level keys: ${stateKeys.join(", ")}`
      );
    } else {
      console.warn(`[WS-DETAILED] Full state update has no data property!`);
    }
  }

  // Server sending to clients
  if (ws.role === "boat-server") {
    if (clientConnections.has(boatId)) {
      const clients = clientConnections.get(boatId);
      let sentCount = 0;
      let activeClients = 0;

      // Count active clients
      clients.forEach((client) => {
        if (client.readyState === 1) activeClients++;
      });

      // Send message to each client
      clients.forEach((client) => {
        if (client.readyState === 1 && client !== ws) {
          try {
            client.send(rawMsg);
            sentCount++;

            // Log client ID if available
            if (msgType === "state:full-update") {
              console.log(
                `[WS-DETAILED] Sent full state update to client ${
                  client.clientId || "unknown"
                }`
              );
            }
          } catch (error) {
            console.error(`[WS] Error sending message to client:`, error);
          }
        }
      });

      console.log(
        `[WS] Server message (${msgType}) routed to ${sentCount}/${activeClients} clients`
      );
    } else {
      console.log(
        `[WS] No clients to receive server message (${msgType}) for boat ${boatId}`
      );
    }
  }
  // Client sending to server
  else if (ws.role === "client") {
    if (serverConnections.has(boatId)) {
      const servers = serverConnections.get(boatId);
      let sentCount = 0;
      let activeServers = 0;

      // Count active servers
      servers.forEach((server) => {
        if (server.readyState === 1) activeServers++;
      });

      // Send message to each server
      servers.forEach((server) => {
        if (server.readyState === 1) {
          try {
            server.send(rawMsg);
            sentCount++;
          } catch (error) {
            console.error(`[WS] Error sending message to server:`, error);
          }
        }
      });

      console.log(
        `[WS] Client message (${msgType}) routed to ${sentCount}/${activeServers} servers`
      );
    } else {
      console.log(
        `[WS] No servers to receive client message (${msgType}) for boat ${boatId}`
      );
    }
  }
}

/**
 * Notify the boat server when a client disconnects
 */
function notifyServerOfClientDisconnection(boatId, clientId) {
  if (serverConnections.has(boatId)) {
    const servers = serverConnections.get(boatId);
    let notificationSent = false;

    servers.forEach((server) => {
      if (server.readyState === 1) {
        try {
          const clientDisconnectedMsg = JSON.stringify({
            type: "client-disconnected",
            clientId: clientId,
            boatId: boatId,
            timestamp: new Date().toISOString(),
          });

          server.send(clientDisconnectedMsg);
          console.log(
            `[WS-DETAILED] Sent client-disconnected notification to server for client ${clientId}`
          );
          notificationSent = true;
        } catch (error) {
          console.error(
            `[WS] Error sending client-disconnected notification to server:`,
            error
          );
        }
      }
    });

    if (!notificationSent) {
      console.log(
        `[WS] No active servers to notify about client ${clientId} disconnection`
      );
    }
  }
}

/**
 * Update connection status
 */
function updateConnectionStatus(boatId) {
  console.log(
    `[VPS-RELAY-DEBUG] Updating connection status for boat ${boatId}`
  );

  // Get client count for this boat
  const clientCount = clientConnections.has(boatId)
    ? clientConnections.get(boatId).size
    : 0;

  console.log(
    `[VPS-RELAY-DEBUG] Client connections for boat ${boatId}: ${clientCount}`
  );
  console.log(
    `[VPS-RELAY-DEBUG] Client connection details:`,
    clientConnections.has(boatId)
      ? Array.from(clientConnections.get(boatId)).map((c) => ({
          clientId: c.clientId || "unknown",
          readyState: c.readyState,
        }))
      : "none"
  );

  // Check if there are any servers for this boat
  const hasServers =
    serverConnections.has(boatId) && serverConnections.get(boatId).size > 0;

  console.log(
    `[VPS-RELAY-DEBUG] Server connections for boat ${boatId}: ${
      serverConnections.has(boatId) ? serverConnections.get(boatId).size : 0
    }`
  );

  // Notify servers about client connection changes
  if (hasServers) {
    const statusMessage = JSON.stringify({
      type: "connectionStatus",
      boatId,
      clientCount,
      timestamp: Date.now(),
    });

    console.log(
      `[VPS-RELAY-DEBUG] Sending connectionStatus message to servers:`,
      statusMessage
    );

    let sentCount = 0;
    serverConnections.get(boatId).forEach((server) => {
      if (server.readyState === 1) {
        console.log(
          `[VPS-RELAY-DEBUG] Sending connectionStatus to server with readyState: ${server.readyState}`
        );
        server.send(statusMessage);
        sentCount++;
      } else {
        console.log(
          `[VPS-RELAY-DEBUG] Skipping server with readyState: ${server.readyState}`
        );
      }
    });

    console.log(
      `[VPS-RELAY-DEBUG] Sent connectionStatus to ${sentCount} servers for boat ${boatId}`
    );
  } else {
    console.log(
      `[VPS-RELAY-DEBUG] No servers connected for boat ${boatId}, cannot send connectionStatus`
    );
  }

  console.log(
    `[WS] Status updated for ${boatId}: ${clientCount} clients, ${
      hasServers ? "server connected" : "no server"
    }`
  );
}

/**
 * Get connection statistics
 */
export function getConnectionStats() {
  const stats = {
    totalClients: 0,
    totalServers: 0,
    boats: [],
  };

  // Count all unique connections
  const allClientConns = new Set();
  const allServerConns = new Set();

  // Process client connections
  for (const [boatId, clients] of clientConnections.entries()) {
    clients.forEach((client) => allClientConns.add(client));

    const boatStats = {
      boatId,
      clientCount: clients.size,
      hasServer: serverConnections.has(boatId),
    };

    stats.boats.push(boatStats);
  }

  // Process server connections and add boats with no clients
  for (const [boatId, servers] of serverConnections.entries()) {
    servers.forEach((server) => allServerConns.add(server));

    if (!clientConnections.has(boatId)) {
      stats.boats.push({
        boatId,
        clientCount: 0,
        hasServer: true,
      });
    }
  }

  stats.totalClients = allClientConns.size;
  stats.totalServers = allServerConns.size;

  return stats;
}
