// server/bridges/serviceBridge.js
import { EventEmitter } from 'events';

/**
 * Creates a protocol bridge for any service
 * @param {EventEmitter} service - Your service (anchor/navigation/etc)
 * @param {object} config - Service-specific configuration
 */
export function createServiceBridge(service, config) {
  return {
    setup(ws, req) {
      // 1. Authentication
      if (config.requiresAuth && !validateToken(req)) {
        ws.close(1008, 'Unauthorized');
        return;
      }

      console.log(`[SERVICE-BRIDGE] New direct client connected for service: ${config.serviceName}`);
      console.log(`[SERVICE-BRIDGE] Subscribing to events:`, config.events);

      // 2. Event Forwarding
      const subscriptions = config.events.map(event => {
        const handler = (data) => {
          console.log(`[SERVICE-BRIDGE] Event received for direct client:`, {
            service: config.serviceName,
            event,
            data: JSON.stringify(data).slice(0, 200) // avoid flooding logs
          });
          try {
            ws.send(JSON.stringify({
              service: config.serviceName,
              event,
              data
            }));
            console.log(`[SERVICE-BRIDGE] Successfully sent event '${event}' to client.`);
          } catch (sendErr) {
            console.error(`[SERVICE-BRIDGE] Failed to send event '${event}' to client:`, sendErr);
          }
        };
        service.on(event, handler);
        console.log(`[SERVICE-BRIDGE] Subscribed to event '${event}' on service '${config.serviceName}'.`);
        return { event, handler };
      });

      // Cleanup on disconnect
      ws.on('close', () => {
        console.log(`[SERVICE-BRIDGE] WebSocket closed for service: ${config.serviceName}. Cleaning up subscriptions...`);
        subscriptions.forEach(({ event, handler }) => {
          service.off(event, handler);
          console.log(`[SERVICE-BRIDGE] Unsubscribed from event '${event}' on service '${config.serviceName}'.`);
        });
      });

      // Command Handling
      ws.on('message', (raw) => {
        console.log(`[SERVICE-BRIDGE] Received message from client:`, raw);
        try {
          const { command, data } = JSON.parse(raw);
          if (config.commandHandlers[command]) {
            console.log(`[SERVICE-BRIDGE] Handling command '${command}' with data:`, data);
            config.commandHandlers[command](data);
          } else {
            console.warn(`[SERVICE-BRIDGE] Unknown command received:`, command);
          }
        } catch (err) {
          console.error(`[${config.serviceName}Bridge] Invalid message:`, raw, err);
        }
      });

    }
  };
}