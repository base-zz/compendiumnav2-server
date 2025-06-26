import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3009');

ws.on('open', () => {
  console.log('Connected to WebSocket server');
  
  // Send anchor deployed message
  const anchorDeployedMsg = {
    type: 'anchor:update',
    data: {
      anchorDeployed: true,
      anchorLocation: {
        position: {
          latitude: 40.7128,
          longitude: -74.0060
        }
      },
      rode: {
        amount: 30,
        type: 'chain'
      },
      timestamp: new Date().toISOString()
    }
  };
  
  console.log('Sending anchor deployed message:', JSON.stringify(anchorDeployedMsg, null, 2));
  ws.send(JSON.stringify(anchorDeployedMsg));
  
  // Wait a bit, then send position update to trigger dragging alert
  setTimeout(() => {
    const positionUpdateMsg = {
      type: 'position:update',
      data: {
        position: {
          latitude: 40.7128,
          longitude: -74.0160  // 1km west of anchor position
        },
        timestamp: new Date().toISOString()
      }
    };
    
    console.log('\nSending position update message:', JSON.stringify(positionUpdateMsg, null, 2));
    ws.send(JSON.stringify(positionUpdateMsg));
    
    // Wait a bit, then retrieve anchor
    setTimeout(() => {
      const anchorRetrievedMsg = {
        type: 'anchor:update',
        data: {
          anchorDeployed: false,
          timestamp: new Date().toISOString()
        }
      };
      
      console.log('\nSending anchor retrieved message:', JSON.stringify(anchorRetrievedMsg, null, 2));
      ws.send(JSON.stringify(anchorRetrievedMsg));
      
      // Close connection after a short delay
      setTimeout(() => {
        ws.close();
        console.log('\nConnection closed');
      }, 1000);
      
    }, 2000);
    
  }, 2000);
});

ws.on('message', (data) => {
  console.log('\nReceived message from server:', data.toString());
});

ws.on('close', () => {
  console.log('Disconnected from WebSocket server');});
