import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import express from "express";
import { config } from "dotenv";
import { initDatabase } from './modules/database.js';
import { handleConnection } from './modules/websocket-handlers.js';
import apiRoutes from './modules/api-routes.js';

// Load environment variables
config();

// Configuration constants
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(",") || [];
const PORT = process.env.INTERNAL_PORT || 8080;
const AUTH_PORT = process.env.AUTH_PORT || 3001;

// Initialize the database
await initDatabase();

// Create Express app for the HTTP API
const app = express();
app.use(apiRoutes);

// Start the HTTP API server
app.listen(AUTH_PORT, () => {
  console.log(`Auth API running on port ${AUTH_PORT}`);
});

// Create HTTP server for WebSocket
const httpServer = createServer();
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade
httpServer.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const ip = req.socket.remoteAddress;
    console.log(`[WS] New connection from ${ip}`);
    wss.emit("connection", ws, req);
  });
});

// Handle WebSocket connections
wss.on("connection", handleConnection);

// Start the WebSocket server
httpServer.listen(PORT, () => {
  console.log(`[WS] VPS relay proxy listening on port ${PORT}`);
});

// Add readyState names for better debugging
WebSocket.readyStateNames = {
  [WebSocket.CONNECTING]: "CONNECTING",
  [WebSocket.OPEN]: "OPEN",
  [WebSocket.CLOSING]: "CLOSING",
  [WebSocket.CLOSED]: "CLOSED",
};

// Export for testing
export { app, httpServer, wss };
