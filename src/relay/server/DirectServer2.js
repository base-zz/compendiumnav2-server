import { WebSocket as WS, WebSocketServer } from "ws";
import EventEmitter from "events";
import debug from "debug";

const log = debug("direct");
const logError = debug("direct:error");
const logTrace = debug("direct:trace");
const logState = debug("direct:state");

/**
 * A complete, mediator-compliant WebSocket server for local clients.
 * This class preserves all original logic including heartbeats and graceful shutdowns,
 * while conforming to the StateMediator's transport interface.
 */
export class DirectServer extends EventEmitter {
  start() {
    // The server is already started in the constructor, so this is a no-op.
    return Promise.resolve();
  }

  constructor(config) {
    super();

    if (!config || !config.port || !config.host) {
      throw new Error(
        "DirectServer requires a config object with port and host."
      );
    }

    this.wss = new WebSocketServer({ port: config.port, host: config.host });
    this.clients = new Map();
    this.clientIdCounter = 0;

    this.wss.on("connection", this._handleConnection.bind(this));

    // Heartbeat mechanism to remove dead clients
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          log("Terminating dead client connection.");
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping(() => {});
      });
    }, 30000);

    // No test updates - we want real data only

    log(`Direct server listening on ws://${config.host}:${config.port}`);
  }

  _handleConnection(ws) {
    const clientId = `direct-${++this.clientIdCounter}`;
    ws.isAlive = true;
    ws.clientId = clientId; // Store clientId on the ws object for reference
    this.clients.set(clientId, ws);

    log(`==== NEW CLIENT CONNECTION: ${clientId} ====`);
    log(`Total clients after connection: ${this.clients.size}`);
    log(`Client readyState: ${ws.readyState}`); // 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED

    ws.on("pong", () => {
      ws.isAlive = true;
      logTrace(`Received pong from client ${clientId}`);
    });

    // Send a welcome message to confirm connection is working
    try {
      // Send welcome message in the format the client expects (without nesting in payload)
      const welcomeMsg = JSON.stringify({
        type: "system:welcome",
        message: "Welcome to DirectServer2",
        clientId: clientId,
        timestamp: Date.now(),
      });
      ws.send(welcomeMsg);
      log(`Sent welcome message to client ${clientId}`);
    } catch (error) {
      logError(`Failed to send welcome message to ${clientId}:`, error);
    }

    log(`New direct client connected: ${clientId}`);
    this.emit("client:connected", { clientId, platform: "direct" });

    // Request a full state update for this client
    setTimeout(() => {
      if (ws.isAlive && ws.readyState === WS.OPEN) {
        logState(`Requesting full state update for new client ${clientId}`);
        this.emit("client:ready", { clientId });
      }
    }, 1000);

    ws.on("message", (message) => {
      if (!ws.isAlive) {
        logTrace(`Ignoring message from non-alive client ${clientId}`);
        return;
      }
      try {
        const messageStr = message.toString();
        logTrace(`Received message from ${clientId}:`, messageStr);
        this.emit("message", { clientId, message: messageStr });
      } catch (error) {
        logError(`Error processing message from ${clientId}:`, error);
      }
    });

    ws.on("close", () => {
      this.clients.delete(clientId);
      log(`Direct client disconnected: ${clientId}`);
      log(`Total clients after disconnection: ${this.clients.size}`);
      this.emit("client:disconnected", { clientId });
    });

    ws.on("error", (error) => {
      logError(`Error with direct client ${clientId}:`, error);
      this.clients.delete(clientId);
      log(`Client ${clientId} removed due to error`);
      log(`Total clients after error: ${this.clients.size}`);
      this.emit("client:disconnected", { clientId });
    });
  }

  /**
   * Broadcasts a message to all connected, living clients.
   * @param {object|string} message The message to broadcast.
   */
  broadcast(message) {
    logState("==== DIRECT SERVER BROADCAST ====");

    // Handle string or object message
    let messageObj;
    let messageToSend;
    let serializedMessage;

    if (typeof message === "string") {
      try {
        messageObj = JSON.parse(message);
        // Keep the original message for now
        messageToSend = messageObj;
      } catch (error) {
        logError("Failed to parse string message:", error);
        messageObj = { type: "unknown" };
        messageToSend = messageObj;
      }
    } else {
      messageObj = message;

      // Fix for client compatibility: unwrap payload for state:patch messages
      if (messageObj.type === "state:patch" && messageObj.payload) {
        logState("Unwrapping state:patch payload for client compatibility");
        // The client expects the data to be directly in the message, not nested in payload
        messageToSend = {
          ...messageObj.payload, // This includes type, data, timestamp, etc.
        };
      } else {
        messageToSend = messageObj;
      }
    }

    try {
      serializedMessage = JSON.stringify(messageToSend);
    } catch (error) {
      logError("Failed to stringify message object:", error);
      return;
    }

    // Parse the message to get its type for logging
    let messageObjForLogging;
    try {
      messageObjForLogging = JSON.parse(serializedMessage);
    } catch (error) {
      logError("Failed to parse message for logging:", error);
      messageObjForLogging = {};
    }

    const messageType =
      messageObjForLogging.type ||
      (messageObjForLogging.payload && messageObjForLogging.payload.type) ||
      "unknown";

    logState(`Message type: ${messageType}`);
    logState(`Total connected clients: ${this.clients.size}`);
    logState(`Message size: ${serializedMessage.length} bytes`);

    // Count successful sends
    let sentCount = 0;
    let closedCount = 0;

    this.clients.forEach((clientWs, clientId) => {
      if (clientWs.isAlive && clientWs.readyState === WS.OPEN) {
        try {
          clientWs.send(serializedMessage);
          sentCount++;
          logState(`Sent to client ${clientId}`);
        } catch (error) {
          logError(`Failed to send to client ${clientId}:`, error);
        }
      } else {
        closedCount++;
        logState(`Skipped client ${clientId} - not alive or not in OPEN state`);
      }
    });

    logState(
      `Successfully sent to ${sentCount}/${this.clients.size} clients (${closedCount} skipped)`
    );
    logState("==== BROADCAST COMPLETE ====");
  }

  /**
   * Sends a message to a single specific client.
   * @param {string} clientId The ID of the client to send the message to.
   * @param {object} message The message to send.
   */
  send(clientId, message) {
    const clientWs = this.clients.get(clientId);
    if (!clientWs || !clientWs.isAlive || clientWs.readyState !== WS.OPEN) {
      log(`Cannot send to client ${clientId}: client not found or not ready.`);
      return false;
    }

    try {
      const serializedMessage =
        typeof message === "string" ? message : JSON.stringify(message);
      clientWs.send(serializedMessage);
      return true;
    } catch (error) {
      logError(`Error sending message to client ${clientId}:`, error);
      return false;
    }
  }

  getClientCount() {
    return this.clients.size;
  }

  shutdown() {
    return new Promise((resolve) => {
      log("Shutting down direct server...");
      clearInterval(this.heartbeatInterval);
      // No need to clear testUpdateInterval as it's been removed
      this.wss.close(() => {
        log("Direct server has been shut down.");
        resolve();
      });
    });
  }
}
