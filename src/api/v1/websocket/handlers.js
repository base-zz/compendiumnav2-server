// src/server/api/v1/websocket/handlers.js
import { createServiceBridge } from '../../../bridges/serviceBridge.js';
import { requireService } from '../../../services/serviceLocator.js';

export function setupWebSocketHandlers(wss) {
  wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection (direct)');

    ws.on('error', (err) => {
      console.error('[WS][ERROR]', err);
    });

    ws.on('close', (code, reason) => {
      console.log('[WS][CLOSE] code:', code, 'reason:', reason.toString());
    });

    let stateService;
    try {
      stateService = requireService('state');
    } catch (error) {
      console.warn('[WS HANDLER] State service unavailable:', error.message);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'state-unavailable',
        message: 'State service is not ready. Please retry later.'
      }));
      ws.close();
      return;
    }

    const subscriptions = [];

    if (typeof stateService.on === 'function') {
      const anchorSub = stateService.on('anchorUpdate', (data) => {
        try {
          ws.send(JSON.stringify({
            type: 'anchor',
            data
          }));
        } catch (err) {
          console.warn('Failed to send anchor update:', err);
        }
      });
      if (typeof anchorSub === 'function') {
        subscriptions.push(anchorSub);
      }

      const navSub = stateService.on('navigationUpdate', (data) => {
        try {
          ws.send(JSON.stringify({
            type: 'navigation',
            data
          }));
        } catch (err) {
          console.warn('Failed to send navigation update:', err);
        }
      });
      if (typeof navSub === 'function') {
        subscriptions.push(navSub);
      }
    }

    ws.on('close', () => {
      subscriptions.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') {
          try {
            unsubscribe();
          } catch (err) {
            console.warn('Error unsubscribing from state event:', err);
          }
        }
      });
      console.log('WebSocket connection closed');
    });

    // --- Augment: Add serviceBridge for event harmony ---
    createServiceBridge(stateService, {
      serviceName: 'navigation',
      service: stateService,
      events: ['navigationUpdate'],
      requiresAuth: false,
      commandHandlers: {}
    }).setup(ws, req);

    createServiceBridge(stateService, {
      serviceName: 'anchor',
      service: stateService,
      events: ['anchorUpdate'],
      requiresAuth: false,
      commandHandlers: {}
    }).setup(ws, req);
    // Add more bridges for other domains as needed
  });
}

export default {
  setupWebSocketHandlers
};