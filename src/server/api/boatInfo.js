/**
 * Boat Info API Endpoint
 * 
 * Provides endpoints for retrieving boat information including
 * the boat's unique ID and vessel details from SignalK
 */

import { getBoatInfo as getBoatInfoFromId } from '../uniqueAppId.js';
import { stateService } from '../../state/StateService.js';

// Re-export getBoatInfo with stateService pre-bound
export function getBoatInfo() {
  return getBoatInfoFromId(stateService);
}

/**
 * Registers boat info routes with the Express app
 * @param {Object} app - Express application instance
 */
export function registerBoatInfoRoutes(app) {
  /**
   * @openapi
   * /api/boat-info:
   *   get:
   *     tags: [Boat]
   *     summary: Get boat information
   *     description: Returns the boat's unique ID and vessel information
   *     responses:
   *       200:
   *         description: Boat information
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/BoatInfo'
   *       500:
   *         description: Server error
   */
  app.get('/api/boat-info', (req, res) => {
    try {
      const boatInfo = getBoatInfo(stateService);
      res.json(boatInfo);
    } catch (error) {
      console.error('Error getting boat info:', error);
      res.status(500).json({ 
        error: 'Failed to get boat information',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
}

/**
 * @openapi
 * components:
 *   schemas:
 *     BoatInfo:
 *       type: object
 *       properties:
 *         boatId:
 *           type: string
 *           description: Unique identifier for the boat
 *         name:
 *           type: string
 *           description: Vessel name
 *         mmsi:
 *           type: string
 *           nullable: true
 *           description: Maritime Mobile Service Identity number
 *         callsign:
 *           type: string
 *           nullable: true
 *           description: Vessel radio callsign
 *         dimensions:
 *           type: object
 *           properties:
 *             length:
 *               type: number
 *               nullable: true
 *             beam:
 *               type: number
 *               nullable: true
 *             draft:
 *               type: number
 *               nullable: true
 *         position:
 *           type: object
 *           nullable: true
 *           description: Current position information if available
 *         lastUpdated:
 *           type: string
 *           format: date-time
 *           description: ISO timestamp of when the information was last updated
 *         status:
 *           type: string
 *           enum: [online, offline]
 *           description: Current status of the boat's connection to SignalK
 *         signalK:
 *           type: object
 *           properties:
 *             connected:
 *               type: boolean
 *               description: Whether the boat is connected to SignalK
 *             error:
 *               type: string
 *               nullable: true
 *               description: Error message if connection to SignalK failed
 *             lastUpdate:
 *               type: string
 *               format: date-time
 *               nullable: true
 *               description: Timestamp of the last update from SignalK
 */
