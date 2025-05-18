// DEPRECATED: All navigation logic migrated to state.controller.js

import { stateService } from '../../state/StateService.js';
import {
  transformPosition,
  transformHeading,
  transformSpeed,
  transformBatteries,
  transformTanks
} from '../transformers/navigation.transformer.js';

/**
 * @api {get} /navigation/snapshot Get Complete Navigation Snapshot
 * @apiName GetNavigationSnapshot
 * @apiGroup Navigation
 * @apiDescription Returns all available navigation data
 */
export const getNavigationSnapshot = async (req, res) => {
  try {
    const snapshot = stateService.stateData.navigation;
    if (!snapshot) {
      return res.status(503).json({
        status: 'unavailable',
        error: 'Navigation data not available'
      });
    }
    res.json({
      status: 'success',
      data: {
        position: transformPosition(snapshot.position),
        instruments: {
          heading: transformHeading(snapshot.instruments),
          speed: transformSpeed(snapshot.instruments),
          environment: {
            wind: {
              true: {
                speed: snapshot.instruments.windSpeedTrue,
                angle: snapshot.instruments.windAngleTrue
              },
              apparent: {
                speed: snapshot.instruments.windSpeedApparent,
                angle: snapshot.instruments.windAngleApparent
              }
            },
            depth: snapshot.instruments.depth
          }
        },
        batteries: transformBatteries(snapshot.batteries),
        tanks: transformTanks(snapshot.tanks),
        meta: snapshot.meta
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to retrieve navigation snapshot',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

/**
 * @api {get} /navigation/position Get Current Position
 * @apiName GetCurrentPosition
 * @apiGroup Navigation
 */
export const getCurrentPosition = async (req, res) => {
  try {
    const position = stateService.stateData.navigation?.position || {};
    if (!position.latitude || !position.longitude) {
      return res.status(503).json({
        status: 'unavailable',
        error: 'Position data not available',
        lastUpdated: position.timestamp
      });
    }
    res.json({
      status: 'success',
      data: transformPosition(position)
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to retrieve position',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

/**
 * @api {get} /navigation/heading Get Current Heading
 * @apiName GetCurrentHeading
 * @apiGroup Navigation
 */
export const getCurrentHeading = async (req, res) => {
  try {
    const heading = navigationService.getHeading();
    res.json({
      status: 'success',
      data: transformHeading(heading)
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to retrieve heading',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

/**
 * @api {get} /navigation/speed Get Current Speed
 * @apiName GetCurrentSpeed
 * @apiGroup Navigation
 */
export const getCurrentSpeed = async (req, res) => {
  try {
    const speed = navigationService.getSpeed();
    res.json({
      status: 'success',
      data: transformSpeed(speed)
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to retrieve speed data',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

/**
 * @api {get} /navigation/batteries Get Battery Status
 * @apiName GetBatteryStatus
 * @apiGroup Navigation
 */
export const getBatteryStatus = async (req, res) => {
  try {
    const batteries = navigationService.getBatteryStatus();
    res.json({
      status: 'success',
      data: transformBatteries(batteries)
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to retrieve battery status',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

/**
 * @api {get} /navigation/tanks Get Tank Levels
 * @apiName GetTankLevels
 * @apiGroup Navigation
 */
export const getTankLevels = async (req, res) => {
  try {
    const tanks = navigationService.getTankLevels();
    res.json({
      status: 'success',
      data: transformTanks(tanks)
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to retrieve tank levels',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

/**
 * @api {get} /navigation/status Get Navigation System Status
 * @apiName GetNavigationStatus
 * @apiGroup Navigation
 */
export const getNavigationStatus = async (req, res) => {
  try {
    const hasPosition = navigationService.hasValidPosition();
    const connection = navigationService.connectionState;
    
    res.json({
      status: 'success',
      data: {
        positionAvailable: hasPosition,
        signalKConnection: connection.websocket,
        lastUpdate: navigationService.getPosition().timestamp,
        services: {
          navigation: true,
          instruments: true,
          environment: true
        }
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to retrieve system status',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};