// Simple WebSocket client to test DirectServer state broadcasting
const WebSocket = require('ws');

// Configuration
const DIRECT_WS_PORT = process.env.DIRECT_WS_PORT || 3001; // Updated to match DirectServer2 port
const DIRECT_WS_HOST = process.env.DIRECT_WS_HOST || 'localhost';
const url = `ws://${DIRECT_WS_HOST}:${DIRECT_WS_PORT}`;

console.log(`Connecting to DirectServer at ${url}...`);

// Create WebSocket connection
const ws = new WebSocket(url);

// Connection opened
ws.on('open', () => {
  console.log('Connected to DirectServer!');
  
  // Send a test message
  const testMessage = {
    type: 'test',
    data: {
      clientInfo: 'test-direct-client',
      timestamp: Date.now()
    }
  };
  
  console.log('Sending test message:', testMessage);
  ws.send(JSON.stringify(testMessage));
});

// Listen for messages
ws.on('message', (data) => {
  try {
    const message = JSON.parse(data);
    console.log('\n========== RECEIVED MESSAGE ==========');
    console.log(`Message Type: ${message.type}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    
    // Format the output based on message type
    if (message.type === 'state:patch') {
      console.log('State Patch Data:');
      const patchData = message.data || (message.payload && message.payload.data);
      
      if (Array.isArray(patchData)) {
        console.log(`Patch contains ${patchData.length} operations:`);
        patchData.forEach((op, index) => {
          console.log(`  ${index + 1}. ${op.op} at path: ${op.path}`);
          console.log(`     Value: ${JSON.stringify(op.value)}`);
        });
      } else {
        console.log(JSON.stringify(patchData, null, 2));
      }
    } else if (message.type === 'state:full-update') {
      console.log('Full State Update Received');
      // Don't log the full state as it might be very large
      const stateData = message.data || message.payload || {};
      console.log('State keys:', Object.keys(stateData));
    } else if (message.type === 'system:welcome') {
      console.log('Welcome Message:');
      console.log(JSON.stringify(message.payload, null, 2));
    } else {
      console.log('Message Content:');
      console.log(JSON.stringify(message, null, 2));
    }
    console.log('======================================\n');
  } catch (error) {
    console.error('Error parsing message:', error);
    console.log('Raw message:', data.toString());
  }
});

// Error handling
ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});

// Connection closed
ws.on('close', (code, reason) => {
  console.log(`Connection closed: Code ${code}, Reason: ${reason}`);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('Closing connection...');
  ws.close();
  process.exit(0);
});

console.log('Test client running. Press Ctrl+C to exit.');
