import { createServiceBridge } from './bridges/serviceBridge';
import { BRIDGE_CONFIGS } from './config/bridges';
import WebSocket from 'ws';

const wss = new WebSocket.Server({ port: 3002 });

wss.on('connection', (ws, req) => {
  // Initialize all bridges
  Object.values(BRIDGE_CONFIGS).forEach(config => {
    const bridge = createServiceBridge(config.service, config);
    bridge.setup(ws, req);
  });
});