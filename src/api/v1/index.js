// src/server/api/v1/index.js
import express from 'express';
import routes from './routes.js';
import { setupWebSocketHandlers } from './websocket/handlers.js';

const router = express.Router();

// Apply routes
router.use(routes);

// WebSocket setup would be done at the server level
export { router, setupWebSocketHandlers };