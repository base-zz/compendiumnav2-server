import { getDb, getBoatPublicKey, registerBoatKey } from './database.js';
import { verifySignature } from './auth.js';

// Connection tracking using two separate maps
const clientConnections = new Map(); // boatId -> Set of client connections
const serverConnections = new Map(); // boatId -> Set of server connections

/**
 * Handle WebSocket connection
 */
export function handleConnection(ws, req) {
  ws.role = null; // Will be set when identified
  ws.boatIds = new Set(); // Tracks all boat IDs this connection is subscribed to
  const ip = req.socket.remoteAddress;
  console.log(
    `[WS-DETAILED] New connection from ${ip} with headers:`,
    req.headers
  );

  ws.on("message", async (msg) => {
    let message;
    try {
      message = JSON.parse(msg);
    } catch {
      console.warn(`[WS] Invalid JSON from ${ip}: ${msg}`);
      return;
    }

    // Handle key registration
    if (message.type === "register-key" && message.boatId && message.publicKey) {
      await handleKeyRegistration(ws, message);
      return;
    }

    // Handle identity/role declaration
    if (message.type === "identity" && message.role && message.boatId) {
      console.log(`[WS-DETAILED] Identity message received from ${ip}:`, {
        boatId: message.boatId,
        role: message.role,
        hasSignature: !!message.signature,
        hasTimestamp: !!message.timestamp,
      });
      await handleIdentity(ws, message);
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
        echo: message.timestamp // Echo back the original timestamp for latency calculation
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
    ws.boatIds.forEach((boatId) => {
      handleUnsubscription(ws, boatId);
    });
    console.log(
      `[WS] Connection closed (${ws.role || "unidentified"} from ${ip})`
    );
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error from ${ip}:`, err);
  });
}

/**
 * Handle key registration message
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
    console.error(`[WS] Error registering key:`, error);
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
 * Handle identity message
 */
async function handleIdentity(ws, message) {
  // Check if this is a signed identity message (key-based auth)
  if (message.signature && message.timestamp) {
    console.log(
      `[AUTH-DETAILED] Processing signed identity for boat ${message.boatId}`
    );

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
      console.error(`[WS] Error during key verification:`, error);
      // Fall back to regular identity handling
      ws.role = message.role;
      console.log(
        `[WS] ${ws.role} identified for boat ${message.boatId} (VERIFICATION ERROR)`
      );
    }
  } else {
    // Legacy identity handling (without signature)
    ws.role = message.role;
    console.log(
      `[WS] ${ws.role} identified for boat ${message.boatId} (LEGACY)`
    );
  }

  // Auto-subscribe if not already
  if (!ws.boatIds.has(message.boatId)) {
    handleSubscription(ws, {
      type: "subscribe",
      boatId: message.boatId,
      role: message.role,
    });
  }
}

/**
 * Handle subscription message
 */
function handleSubscription(ws, message) {
  const boatId = message.boatId;
  ws.boatIds.add(boatId);

  // Add to appropriate connection map
  if (message.role === "boat-server") {
    if (!serverConnections.has(boatId)) {
      serverConnections.set(boatId, new Set());
    }
    serverConnections.get(boatId).add(ws);
  } else {
    if (!clientConnections.has(boatId)) {
      clientConnections.set(boatId, new Set());
    }
    clientConnections.get(boatId).add(ws);
  }

  console.log(`[WS] ${message.role} subscribed to ${boatId}`);
  updateConnectionStatus(boatId);
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
  console.log(`[WS] ${ws.role} unsubscribed from ${boatId}`);
}

/**
 * Handle message routing
 */
function handleMessageRouting(ws, message, rawMsg) {
  const boatId = message.boatId;

  // Server sending to clients
  if (ws.role === "boat-server") {
    if (clientConnections.has(boatId)) {
      const clients = clientConnections.get(boatId);
      let sentCount = 0;

      clients.forEach((client) => {
        if (client.readyState === 1 && client !== ws) {
          client.send(rawMsg);
          sentCount++;
        }
      });

      console.log(`[WS] Server message routed to ${sentCount} clients`);
    } else {
      console.log(`[WS] No clients to receive server message`);
    }
  }
  // Client sending to server
  else if (ws.role === "client") {
    if (serverConnections.has(boatId)) {
      const servers = serverConnections.get(boatId);
      let sentCount = 0;

      servers.forEach((server) => {
        if (server.readyState === 1) {
          server.send(rawMsg);
          sentCount++;
        }
      });

      console.log(`[WS] Client message routed to ${sentCount} servers`);
    } else {
      console.log(`[WS] No servers to receive client message`);
    }
  }
}

/**
 * Update connection status
 */
function updateConnectionStatus(boatId) {
  const clientCount = clientConnections.has(boatId)
    ? clientConnections.get(boatId).size
    : 0;
  const hasServers =
    serverConnections.has(boatId) && serverConnections.get(boatId).size > 0;

  // Notify servers about client connection changes
  if (hasServers) {
    const statusMessage = JSON.stringify({
      type: "connectionStatus",
      boatId,
      clientCount,
      timestamp: Date.now(),
    });

    serverConnections.get(boatId).forEach((server) => {
      if (server.readyState === 1) {
        server.send(statusMessage);
      }
    });
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
    boats: []
  };
  
  // Count all unique connections
  const allClientConns = new Set();
  const allServerConns = new Set();
  
  // Process client connections
  for (const [boatId, clients] of clientConnections.entries()) {
    clients.forEach(client => allClientConns.add(client));
    
    const boatStats = {
      boatId,
      clientCount: clients.size,
      hasServer: serverConnections.has(boatId)
    };
    
    stats.boats.push(boatStats);
  }
  
  // Process server connections and add boats with no clients
  for (const [boatId, servers] of serverConnections.entries()) {
    servers.forEach(server => allServerConns.add(server));
    
    if (!clientConnections.has(boatId)) {
      stats.boats.push({
        boatId,
        clientCount: 0,
        hasServer: true
      });
    }
  }
  
  stats.totalClients = allClientConns.size;
  stats.totalServers = allServerConns.size;
  
  return stats;
}
