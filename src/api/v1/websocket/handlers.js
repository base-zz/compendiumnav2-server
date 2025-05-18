// src/server/api/v1/websocket/handlers.js
import { createServiceBridge } from '../../../bridges/serviceBridge.js';
import { stateService } from '../../../state/StateService.js';

export function setupWebSocketHandlers(wss) {
  wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection (direct)');

    ws.on('error', (err) => {
      console.error('[WS][ERROR]', err);
    });

    ws.on('close', (code, reason) => {
      console.log('[WS][CLOSE] code:', code, 'reason:', reason.toString());
    });

    // Anchor updates
    let anchorUnsubscribe = () => {};
    let navUnsubscribe = () => {};
    if (stateService.on) {
      anchorUnsubscribe = stateService.on('anchorUpdate', (data) => {
        console.log('[WS HANDLER] Sending anchor update to client:', data);
        try {
          console.log('[WS-BACKEND] Sending to client:', arguments[0]);
ws.send(JSON.stringify({
            type: 'anchor',
            data
          }));
        } catch (err) {
          console.warn('Failed to send anchor update:', err);
        }
      });
      navUnsubscribe = stateService.on('navigationUpdate', (data) => {
        console.log('[WS HANDLER] Sending navigation update to client:', data);
        try {
          console.log('[WS-BACKEND] Sending to client:', arguments[0]);
ws.send(JSON.stringify({
            type: 'navigation',
            data
          }));
        } catch (err) {
          console.warn('Failed to send navigation update:', err);
        }
      });
      // Ensure unsubscribe functions are valid
      anchorUnsubscribe = typeof anchorUnsubscribe === 'function' ? anchorUnsubscribe : () => {};
      navUnsubscribe = typeof navUnsubscribe === 'function' ? navUnsubscribe : () => {};
    } else {
      // TODO: Implement event emitters in stateService for real-time updates
      console.warn('stateService.on not implemented. Real-time updates will not work.');
    }
    ws.on('close', () => {
      if (typeof anchorUnsubscribe === 'function') anchorUnsubscribe();
      if (typeof navUnsubscribe === 'function') navUnsubscribe();
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