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
  // Get ports from environment or use defaults
  const defaultHttpPort = parseInt(process.env.PORT, 10) || 8080;
  const defaultWsPort = parseInt(process.env.VPS_WS_PORT, 10) || 3009;
  
  // Find available ports if not explicitly set
  const [httpPort, wsPort] = await Promise.all([
    process.env.PORT ? Promise.resolve(defaultHttpPort) : findAvailablePort(defaultHttpPort),
    process.env.VPS_WS_PORT ? Promise.resolve(defaultWsPort) : findAvailablePort(defaultWsPort)
  ]);

  return {
    // Server
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: httpPort,
    INTERNAL_PORT: parseInt(process.env.INTERNAL_PORT, 10) || httpPort,
    AUTH_PORT: parseInt(process.env.AUTH_PORT, 10) || 3001,
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
    DEBUG: process.env.DEBUG === 'true',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS?.split(',').filter(Boolean) || [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:8080'
    ],

    // Authentication
    TOKEN_SECRET: process.env.TOKEN_SECRET || 'your-secret-key',
    TOKEN_EXPIRY: parseInt(process.env.TOKEN_EXPIRY, 10) || 86400,
    REQUIRE_AUTH: process.env.REQUIRE_AUTH === 'true',

    // WebSocket
    WS: {
      VPS_PORT: wsPort,
      VPS_PATH: process.env.VPS_PATH || '/relay',
      VPS_HOST: process.env.VPS_HOST || 'localhost',
      DIRECT_PORT: parseInt(process.env.DIRECT_WS_PORT, 10) || (wsPort + 1),
      DIRECT_HOST: process.env.DIRECT_WS_HOST || '0.0.0.0',
      VPS_URL: process.env.VPS_URL || `ws://localhost:${wsPort}`,
      VPS_PORT: wsPort
    },

    // SignalK
    SIGNALK: {
      URL: process.env.SIGNALK_URL || 'http://openplotter.local:3000/signalk',
      TOKEN: process.env.SIGNALK_TOKEN || '',
      ADAPTER: process.env.SIGNALK_ADAPTER || '',
      RECONNECT_DELAY: parseInt(process.env.RECONNECT_DELAY, 10) || 3000,
      MAX_RECONNECT_ATTEMPTS: parseInt(process.env.MAX_RECONNECT_ATTEMPTS, 10) || 10
    },

    // Connection
    CONNECTION: {
      TIMEOUT: parseInt(process.env.CONNECTION_TIMEOUT, 10) || 30000,
      MAX_RETRIES: parseInt(process.env.MAX_RETRIES, 10) || 5,
      MOCK_MODE: process.env.MOCK_MODE === 'true',
      FALLBACK_TO_MOCK: process.env.FALLBACK_TO_MOCK !== 'false'
    }
  };
};

// Export a promise that resolves to the config
export default getConfig();