import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3009');

ws.on('open', () => {
  console.log('Connected to WebSocket server');
  
  // Send anchor deployed message with the correct structure
  const anchorDeployedMsg = {
    type: 'anchor:update',
    data: {
      anchor: {
        anchorDeployed: true,
        anchorLocation: {
          position: {
            latitude: 40.7128,
            longitude: -74.0060
          },
          timestamp: new Date().toISOString()
        },
        rode: {
          amount: 30,
          type: 'chain',
          units: 'ft'
        },
        timestamp: new Date().toISOString(),
        criticalRange: {
          r: 100,
          units: 'ft'
        },
        warningRange: {
          r: 200,
          units: 'ft'
        },
        defaultScope: {
          value: 5,
          units: 'ratio'
        },
        dragging: false,
        aisWarning: false
      }
    }
  };
  
  console.log('Sending anchor deployed message:', JSON.stringify(anchorDeployedMsg, null, 2));
  ws.send(JSON.stringify(anchorDeployedMsg));
});

ws.on('message', (data) => {
  console.log('Received message from server:', data.toString());
  
  // Close connection after receiving response
  ws.close();
});

ws.on('close', () => {
  console.log('Disconnected from WebSocket server');
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});
