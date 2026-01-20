import https from 'https';
import http from 'http';
import { getBoatInfo } from '../api/boatInfo.js';
import debug from 'debug';

console.log('[ROUTES] VPS registration module loaded');

const log = debug('server:vps:registration');

/**
 * Registers the boat with the VPS
 * @param {Object} options - Registration options
 * @param {string} options.vpsUrl - Base URL of the VPS (e.g., https://vps.example.com)
 * @param {string} options.boatId - The boat's unique ID
 * @param {Object} boatInfo - Additional boat information to register
 * @returns {Promise<Object>} The registration response
 */
async function registerWithVPS({ vpsUrl, boatId, boatInfo }) {
  return new Promise((resolve, reject) => {
    try {
      // Extract the hostname and protocol from the VPS URL
      const url = new URL(vpsUrl);
      const isHttps = url.protocol === 'https:' || url.protocol === 'wss:';
      const port = url.port || (isHttps ? 443 : 80);
      
      const postData = JSON.stringify({
        boatId,
        ...boatInfo,
        registrationTime: new Date().toISOString()
      });

      const options = {
        hostname: url.hostname,
        port: port,
        path: '/api/boats/register',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        rejectUnauthorized: process.env.NODE_ENV === 'production' // Only validate cert in production
      };

      log(`Registering boat with VPS at ${url.hostname}${options.path}`);
      
      const req = (isHttps ? https : http).request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              log(`Successfully registered with VPS: ${res.statusCode}`);
              resolve(response);
            } else {
              const error = new Error(`VPS registration failed with status ${res.statusCode}`);
              error.statusCode = res.statusCode;
              error.response = response;
              log(`VPS registration failed: ${error.message}`, response);
              reject(error);
            }
          } catch (error) {
            log('Error parsing VPS registration response:', error);
            reject(new Error('Invalid response from VPS'));
          }
        });
      });

      req.on('error', (error) => {
        log('Error during VPS registration:', error);
        reject(error);
      });

      req.write(postData);
      req.end();
    } catch (error) {
      log('Error in registerWithVPS:', error);
      reject(error);
    }
  });
}

/**
 * Creates API routes for VPS registration
 * @param {Object} app - Express app instance
 * @param {Object} options - Configuration options
 * @param {string} options.vpsUrl - Base URL of the VPS
 */
export function registerVpsRoutes(app, { vpsUrl }) {
  if (!vpsUrl) {
    console.warn('[VPS] No VPS URL provided, VPS registration will be disabled');
    return;
  }

  /**
   * @openapi
   * /api/vps/register:
   *   post:
   *     tags: [VPS]
   *     summary: Register this boat with the VPS
   *     description: Registers the boat's information with the VPS for remote access
   *     responses:
   *       200:
   *         description: Successfully registered with VPS
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 message:
   *                   type: string
   *                 data:
   *                   type: object
   *                   description: The response from the VPS
   *       500:
   *         description: Failed to register with VPS
   */
  app.post('/api/vps/register', async (req, res) => {
    try {
      // Get current boat info
      const boatInfo = getBoatInfo();
      
      if (!boatInfo.boatId) {
        return res.status(400).json({
          success: false,
          message: 'Boat ID is required'
        });
      }

      log(`Initiating VPS registration for boat ${boatInfo.boatId}`);
      
      // Register with VPS
      const response = await registerWithVPS({
        vpsUrl,
        boatId: boatInfo.boatId,
        boatInfo: {
          name: boatInfo.name,
          mmsi: boatInfo.mmsi,
          callsign: boatInfo.callsign,
          dimensions: boatInfo.dimensions,
          position: boatInfo.position,
          signalKStatus: boatInfo.signalK
        }
      });

      res.json({
        success: true,
        message: 'Successfully registered with VPS',
        data: response
      });
    } catch (error) {
      console.error('Error registering with VPS:', error);
      const status = error.statusCode || 500;
      res.status(status).json({
        success: false,
        message: error.message || 'Failed to register with VPS',
        error: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Add a health check endpoint for VPS connectivity
  app.get('/api/vps/health', async (req, res) => {
    try {
      const boatInfo = getBoatInfo();
      res.json({
        status: 'ok',
        boatId: boatInfo.boatId,
        vpsConfigured: !!vpsUrl,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: error.message
      });
    }
  });
}

/**
 * @openapi
 * components:
 *   schemas:
 *     VpsRegistrationRequest:
 *       type: object
 *       required:
 *         - boatId
 *       properties:
 *         boatId:
 *           type: string
 *           description: The boat's unique identifier
 *         name:
 *           type: string
 *           description: The boat's name
 *         mmsi:
 *           type: string
 *           description: The boat's MMSI number
 *         callsign:
 *           type: string
 *           description: The boat's radio callsign
 *         dimensions:
 *           type: object
 *           properties:
 *             length:
 *               type: number
 *             beam:
 *               type: number
 *             draft:
 *               type: number
 *         position:
 *           type: object
 *           description: Current position if available
 *         signalKStatus:
 *           type: object
 *           properties:
 *             connected:
 *               type: boolean
 *             lastUpdate:
 *               type: string
 *               format: date-time
 *             error:
 *               type: string
 */
