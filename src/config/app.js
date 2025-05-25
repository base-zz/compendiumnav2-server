// src/config/app.js
import { createServer } from 'net';

// Helper function to find an available port
const findAvailablePort = async (defaultPort, maxAttempts = 10) => {
  const isPortAvailable = (port) => {
    return new Promise((resolve) => {
      const server = createServer();
      server.unref();
      server.on('error', () => resolve(false));
      server.listen(port, '0.0.0.0', () => {
        server.close(() => resolve(true));
      });
    });
  };

  let port = defaultPort;
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    if (await isPortAvailable(port)) {
      return port;
    }
    port++;
    attempts++;
  }
  throw new Error(`Could not find available port after ${maxAttempts} attempts`);
};

// Async config initialization
const getConfig = async () => {
  // Validate required environment variables
  const requiredVars = [
    'NODE_ENV',
    'PORT',
    'INTERNAL_PORT',
    'AUTH_PORT',
    'FRONTEND_URL',
    'VPS_WS_PORT',
    'VPS_PATH',
    'VPS_HOST',
    'DIRECT_WS_PORT',
    'DIRECT_WS_HOST',
    'SIGNALK_URL',
    'RECONNECT_DELAY',
    'MAX_RECONNECT_ATTEMPTS',
    'CONNECTION_TIMEOUT',
    'MAX_RETRIES',
    'VPS_PING_INTERVAL',
    'VPS_CONNECTION_TIMEOUT'
  ];
  
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  // Parse ports from environment
  const httpPort = parseInt(process.env.PORT, 10);
  const wsPort = parseInt(process.env.VPS_WS_PORT, 10);
  
  if (isNaN(httpPort) || isNaN(wsPort)) {
    throw new Error('PORT and VPS_WS_PORT must be valid numbers');
  }

  return {
    // Server
    NODE_ENV: process.env.NODE_ENV,
    PORT: httpPort,
    INTERNAL_PORT: parseInt(process.env.INTERNAL_PORT, 10),
    AUTH_PORT: parseInt(process.env.AUTH_PORT, 10),
    FRONTEND_URL: process.env.FRONTEND_URL,
    DEBUG: process.env.DEBUG === 'true',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS?.split(',').filter(Boolean),
    TOKEN_EXPIRY: parseInt(process.env.TOKEN_EXPIRY, 10),

    // WebSocket
    WS: {
      VPS_PORT: wsPort,
      VPS_PATH: process.env.VPS_PATH,
      VPS_HOST: process.env.VPS_HOST,
      DIRECT_PORT: parseInt(process.env.DIRECT_WS_PORT, 10),
      DIRECT_HOST: process.env.DIRECT_WS_HOST,
      // VPS_URL is built dynamically based on NODE_ENV, VPS_HOST, VPS_WS_PORT and VPS_PATH
      // in the VPSConnector._buildVpsUrl method
    },

    // SignalK
    SIGNALK: {
      URL: process.env.SIGNALK_URL,
      TOKEN: process.env.SIGNALK_TOKEN || '', // Empty string is acceptable for no token
      ADAPTER: process.env.SIGNALK_ADAPTER || '', // Empty string is acceptable for default adapter
      RECONNECT_DELAY: parseInt(process.env.RECONNECT_DELAY, 10),
      MAX_RECONNECT_ATTEMPTS: parseInt(process.env.MAX_RECONNECT_ATTEMPTS, 10)
    },

    // Connection
    CONNECTION: {
      TIMEOUT: parseInt(process.env.CONNECTION_TIMEOUT, 10),
      MAX_RETRIES: parseInt(process.env.MAX_RETRIES, 10),
    }
  };
};

// Export a promise that resolves to the config
export default getConfig();